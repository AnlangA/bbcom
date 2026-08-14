use std::fs::{self, File};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use bbcom_contracts::{LegacyBackupContent, MAX_LEGACY_BACKUP_CONTENT_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::atomic::{
    PendingFile, atomic_replace, create_private_file, private_temp_path, sync_directory,
};
use super::cancellation::check_cancelled;
use super::{
    AgeScryptPassphraseStreams, CancellationCheck, ContainerCheckpoint,
    MAX_PROJECT_CONTAINER_BYTES, ProjectContainerError, ProjectContainerResult,
};

const LEGACY_CONTAINER_FORMAT: &str = "bbcom-legacy-backup-container-v1";
const LEGACY_CONTAINER_VERSION: u32 = 1;
const MAX_JSON_DEPTH: usize = 64;
const MAX_JSON_KEY_BYTES: usize = 256;
const MAX_ENVELOPE_OVERHEAD_BYTES: usize = 4 * 1024;

static COMMIT_LOCK: Mutex<()> = Mutex::new(());

/// Native-only encrypted backup path selected by the desktop file picker.
/// This type deliberately has no serde implementation, so an IPC string can
/// never be converted into a filesystem authority.
#[derive(Clone, Debug)]
pub struct LegacyBackupFile(PathBuf);

impl LegacyBackupFile {
    #[must_use]
    pub fn from_native_path(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEnvelopeRef<'a> {
    format: &'static str,
    container_version: u32,
    content_digest_sha256: &'a str,
    content: &'a LegacyBackupContent,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyEnvelope {
    format: String,
    container_version: u32,
    content_digest_sha256: String,
    content: LegacyBackupContent,
}

/// Encrypt a canonical v1 legacy backup directly into a private same-directory
/// staging file. The plaintext exists only in bounded memory. The staged
/// ciphertext is authenticated and decoded before the atomic rename commit.
pub fn write_encrypted_legacy_backup(
    destination: &LegacyBackupFile,
    content: &LegacyBackupContent,
    passphrase: &AgeScryptPassphraseStreams,
    cancellation: &(impl CancellationCheck + ?Sized),
) -> ProjectContainerResult<u64> {
    let destination = destination.as_path();
    validate_backup_path(destination, false)?;
    let parent = destination
        .parent()
        .ok_or(ProjectContainerError::InvalidInput {
            field: "destination",
        })?;

    let content_bytes = canonical_content(content)?;
    let digest = sha256_hex(&content_bytes);
    let envelope_bytes = serde_json::to_vec(&LegacyEnvelopeRef {
        format: LEGACY_CONTAINER_FORMAT,
        container_version: LEGACY_CONTAINER_VERSION,
        content_digest_sha256: &digest,
        content,
    })
    .map_err(|_| ProjectContainerError::Integrity)?;
    ensure_envelope_limit(envelope_bytes.len())?;

    let part_path = private_temp_path(parent, "legacy-backup");
    let mut part = PendingFile::new(part_path);
    let mut plaintext = Cursor::new(envelope_bytes);
    let mut ciphertext = create_private_file(part.path())?;
    passphrase.encrypt(&mut plaintext, &mut ciphertext, cancellation)?;
    ciphertext.sync_all()?;
    drop(ciphertext);
    let encrypted_bytes = validate_encrypted_file(part.path(), "encryptedFileBytes")?;

    if !verify_encrypted_path(part.path(), content, passphrase, cancellation)? {
        return Err(ProjectContainerError::Integrity);
    }

    sync_directory(parent)?;
    check_cancelled(cancellation, ContainerCheckpoint::LegacyBackupBeforeCommit)?;
    let _commit = COMMIT_LOCK.lock().map_err(|_| {
        ProjectContainerError::Io(std::io::Error::other("legacy backup commit lock poisoned"))
    })?;
    atomic_replace(part.path(), destination)?;
    part.disarm();
    let _ = sync_directory(parent);
    Ok(encrypted_bytes)
}

/// Reopen, authenticate and strictly parse the encrypted target, then compare
/// both canonical digest and typed content with the renderer's expectation.
/// A valid backup containing different content returns `false`; malformed,
/// oversized, non-canonical or unauthenticated artifacts are errors.
pub fn verify_encrypted_legacy_backup(
    source: &LegacyBackupFile,
    expected: &LegacyBackupContent,
    passphrase: &AgeScryptPassphraseStreams,
    cancellation: &(impl CancellationCheck + ?Sized),
) -> ProjectContainerResult<bool> {
    let source = source.as_path();
    validate_backup_path(source, true)?;
    validate_encrypted_file(source, "encryptedFileBytes")?;
    verify_encrypted_path(source, expected, passphrase, cancellation)
}

fn verify_encrypted_path(
    source: &Path,
    expected: &LegacyBackupContent,
    passphrase: &AgeScryptPassphraseStreams,
    cancellation: &(impl CancellationCheck + ?Sized),
) -> ProjectContainerResult<bool> {
    let expected_bytes = canonical_content(expected)?;
    let expected_digest = sha256_hex(&expected_bytes);

    // Age applies the absolute 512 MiB stream limit. The tighter legacy body
    // limit is checked immediately after authenticated decryption and again on
    // its canonical representation.
    let mut encrypted = File::open(source)?;
    let mut decrypted = Vec::new();
    passphrase.decrypt(&mut encrypted, &mut decrypted, cancellation)?;
    ensure_envelope_limit(decrypted.len())?;

    let envelope: LegacyEnvelope =
        serde_json::from_slice(&decrypted).map_err(|_| ProjectContainerError::Integrity)?;
    if envelope.format != LEGACY_CONTAINER_FORMAT
        || envelope.container_version != LEGACY_CONTAINER_VERSION
    {
        return Err(ProjectContainerError::Integrity);
    }

    // Re-serialization equality rejects duplicate keys, alternate field order,
    // trailing data and whitespace in addition to serde's unknown-field check.
    let canonical_envelope =
        serde_json::to_vec(&envelope).map_err(|_| ProjectContainerError::Integrity)?;
    if canonical_envelope != decrypted {
        return Err(ProjectContainerError::Integrity);
    }

    let actual_bytes = canonical_content(&envelope.content)?;
    let actual_digest = sha256_hex(&actual_bytes);
    if envelope.content_digest_sha256 != actual_digest {
        return Err(ProjectContainerError::Integrity);
    }

    Ok(actual_digest == expected_digest && envelope.content == *expected)
}

fn canonical_content(content: &LegacyBackupContent) -> ProjectContainerResult<Vec<u8>> {
    validate_content(content)?;
    let encoded = serde_json::to_vec(content).map_err(|_| ProjectContainerError::Integrity)?;
    if encoded.len() > MAX_LEGACY_BACKUP_CONTENT_BYTES {
        return Err(ProjectContainerError::LimitExceeded {
            field: "legacyContentBytes",
            limit: MAX_LEGACY_BACKUP_CONTENT_BYTES as u64,
            actual: encoded.len() as u64,
        });
    }
    Ok(encoded)
}

fn validate_content(content: &LegacyBackupContent) -> ProjectContainerResult<()> {
    if content.created_at_ms > 9_007_199_254_740_991 {
        return Err(ProjectContainerError::InvalidInput {
            field: "content.createdAtMs",
        });
    }
    validate_json_object(&content.snapshot, "content.snapshot")?;
    validate_json_object(&content.settings, "content.settings")?;
    validate_json_object(&content.presets, "content.presets")?;
    Ok(())
}

fn validate_json_object(
    value: &serde_json::Value,
    field: &'static str,
) -> ProjectContainerResult<()> {
    if !value.is_object() {
        return Err(ProjectContainerError::InvalidInput { field });
    }

    let mut stack = vec![(value, 1_usize)];
    while let Some((value, depth)) = stack.pop() {
        if depth > MAX_JSON_DEPTH {
            return Err(ProjectContainerError::InvalidInput { field });
        }
        match value {
            serde_json::Value::Object(object) => {
                for (key, child) in object {
                    if key.is_empty()
                        || key.len() > MAX_JSON_KEY_BYTES
                        || !key.is_ascii()
                        || is_unsafe_backup_key(key)
                    {
                        return Err(ProjectContainerError::InvalidInput { field });
                    }
                    stack.push((child, depth.saturating_add(1)));
                }
            }
            serde_json::Value::Array(array) => {
                stack.extend(array.iter().map(|child| (child, depth.saturating_add(1))));
            }
            serde_json::Value::Null
            | serde_json::Value::Bool(_)
            | serde_json::Value::Number(_)
            | serde_json::Value::String(_) => {}
        }
    }
    Ok(())
}

fn is_unsafe_backup_key(key: &str) -> bool {
    let normalized: String = key
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase() as char)
        .collect();
    matches!(
        normalized.as_str(),
        "accessgrant"
            | "apikey"
            | "authorization"
            | "credential"
            | "directory"
            | "grant"
            | "keyring"
            | "keyringentry"
            | "nativehandle"
            | "password"
            | "path"
            | "portname"
            | "permissiontoken"
            | "selectedport"
            | "secret"
            | "sourcegrant"
            | "sourcegrantid"
            | "targetgrant"
            | "targetgrantid"
            | "token"
    ) || normalized.contains("apikey")
        || normalized.contains("credential")
        || normalized.contains("keyring")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("grant")
        || normalized.ends_with("token")
        || normalized.ends_with("path")
        || normalized.ends_with("paths")
        || normalized.ends_with("directory")
        || normalized.ends_with("directories")
}

fn validate_backup_path(path: &Path, must_exist: bool) -> ProjectContainerResult<()> {
    if path.extension().and_then(|value| value.to_str()) != Some("age")
        || (must_exist && !path.is_file())
        || (!must_exist && path.parent().is_none_or(|parent| !parent.is_dir()))
        || path.is_dir()
    {
        return Err(ProjectContainerError::InvalidInput {
            field: if must_exist { "source" } else { "destination" },
        });
    }
    Ok(())
}

fn validate_encrypted_file(path: &Path, field: &'static str) -> ProjectContainerResult<u64> {
    let bytes = fs::metadata(path)?.len();
    if bytes == 0 {
        return Err(ProjectContainerError::InvalidInput { field });
    }
    if bytes > MAX_PROJECT_CONTAINER_BYTES {
        return Err(ProjectContainerError::LimitExceeded {
            field,
            limit: MAX_PROJECT_CONTAINER_BYTES,
            actual: bytes,
        });
    }
    Ok(bytes)
}

fn ensure_envelope_limit(actual: usize) -> ProjectContainerResult<()> {
    let limit = MAX_LEGACY_BACKUP_CONTENT_BYTES
        .checked_add(MAX_ENVELOPE_OVERHEAD_BYTES)
        .expect("legacy envelope limit fits usize");
    if actual > limit {
        Err(ProjectContainerError::LimitExceeded {
            field: "legacyEnvelopeBytes",
            limit: limit as u64,
            actual: actual as u64,
        })
    } else {
        Ok(())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}
