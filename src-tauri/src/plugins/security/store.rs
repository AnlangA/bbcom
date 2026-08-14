use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use bbcom_plugin_broker::{
    AuthorizationGeneration, AuthorizationState, AuthorizationStore, AuthorizationStoreError,
    validate_authorization_key,
};
use bbcom_plugin_contracts::{AuthorizationKey, Permission, validate_persistent_grant};
use bbcom_plugin_manager::{
    ArtifactRevocationStore, AuthorizationFailure, PluginArtifact, PluginAuthorizationGrant,
    PluginAuthorizationStore, RevocationFailure,
};
use keyring::v1::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

const STORE_DIRECTORY: &str = "plugin-security-v1";
const CREDENTIAL_SERVICE: &str = "com.bbcom.app.plugin-security.v1";
const RECORD_FORMAT: &str = "bbcom-plugin-security-v1";
// Fits the most restrictive desktop credential backends with margin. The
// complete fixed permission vocabulary and bounded contract identifiers fit
// comfortably below this limit.
const MAX_RECORD_BYTES: usize = 2 * 1024;
const VERIFIED_WORKSPACE_FIXTURE: &str = "00000000-0000-4000-8000-000000000000";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum NativePluginSecurityError {
    #[error("plugin security input is invalid")]
    InvalidInput,
    #[error("plugin security storage is unavailable")]
    StorageUnavailable,
    #[error("plugin security record integrity check failed")]
    Integrity,
    #[error("plugin security record exceeds its fixed limit")]
    LimitExceeded,
}

pub(super) trait CredentialVault: Send + Sync {
    fn load(&self, account: &str) -> Result<Option<String>, NativePluginSecurityError>;
    fn save(&self, account: &str, value: &str) -> Result<(), NativePluginSecurityError>;
    fn clear(&self, account: &str) -> Result<(), NativePluginSecurityError>;
}

struct OsCredentialVault;

impl OsCredentialVault {
    fn entry(account: &str) -> Result<Entry, NativePluginSecurityError> {
        Entry::new(CREDENTIAL_SERVICE, account)
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)
    }
}

impl CredentialVault for OsCredentialVault {
    fn load(&self, account: &str) -> Result<Option<String>, NativePluginSecurityError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(NativePluginSecurityError::StorageUnavailable),
        }
    }

    fn save(&self, account: &str, value: &str) -> Result<(), NativePluginSecurityError> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)
    }

    fn clear(&self, account: &str) -> Result<(), NativePluginSecurityError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(NativePluginSecurityError::StorageUnavailable),
        }
    }
}

/// Process-safe native persistence adapter for both the G43 broker and plugin
/// manager. Clone shares the same operation lock and credential boundary.
#[derive(Clone)]
pub struct NativePluginSecurityStore {
    root: PathBuf,
    vault: Arc<dyn CredentialVault>,
    operation_lock: Arc<Mutex<()>>,
}

impl NativePluginSecurityStore {
    /// Opens the fixed private store below the native application-data root.
    /// Callers cannot select a record path or put grants in a project file.
    pub fn open(app_data_directory: impl AsRef<Path>) -> Result<Self, NativePluginSecurityError> {
        Self::open_with_vault(app_data_directory.as_ref(), Arc::new(OsCredentialVault))
    }

    pub(super) fn open_with_vault(
        app_data_directory: &Path,
        vault: Arc<dyn CredentialVault>,
    ) -> Result<Self, NativePluginSecurityError> {
        if app_data_directory.as_os_str().is_empty() {
            return Err(NativePluginSecurityError::InvalidInput);
        }
        let root = app_data_directory.join(STORE_DIRECTORY);
        create_private_directory(&root)?;
        for kind in RecordKind::ALL {
            create_private_directory(&root.join(kind.directory()))?;
        }
        Ok(Self {
            root,
            vault,
            operation_lock: Arc::new(Mutex::new(())),
        })
    }

    /// Persists the manager's complete reviewed receipt for one exact artifact.
    /// Its opaque generation must be the value returned by the complete
    /// decision-set replacement. A crash or concurrent replacement between
    /// those writes leaves a mismatch and therefore no usable grant.
    pub fn record_reviewed_grant(
        &self,
        key: &AuthorizationKey,
        artifact_version: &str,
        reviewed_permissions: BTreeSet<Permission>,
        revision: u64,
        decision_generation: AuthorizationGeneration,
    ) -> Result<(), NativePluginSecurityError> {
        validate_receipt(key, artifact_version, &reviewed_permissions, revision)?;
        let record = ReceiptRecord {
            format: RECORD_FORMAT.to_owned(),
            scope: StoredAuthorizationScope::from(key),
            artifact_version: artifact_version.to_owned(),
            reviewed_permissions,
            revision,
            decision_generation: *decision_generation.as_bytes(),
        };
        let locator = receipt_locator(key, artifact_version);
        self.write_record(RecordKind::Receipt, &locator, &record)
    }

    /// Removes only the receipt for the exact artifact. An interrupted removal
    /// leaves an orphan mismatch, which is treated as unavailable (fail closed).
    pub fn clear_reviewed_grant(
        &self,
        key: &AuthorizationKey,
        artifact_version: &str,
    ) -> Result<(), NativePluginSecurityError> {
        validate_artifact_for_key(key, artifact_version, BTreeSet::new())?;
        self.remove_record(RecordKind::Receipt, &receipt_locator(key, artifact_version))
    }

    /// Atomically records or clears an upstream-verified exact-artifact
    /// revocation. Store failure is never interpreted as "not revoked".
    pub fn set_artifact_revoked(
        &self,
        artifact: &PluginArtifact,
        revoked: bool,
    ) -> Result<(), NativePluginSecurityError> {
        let major = validate_artifact(artifact)?;
        let locator = revocation_locator(artifact, major);
        if !revoked {
            return self.remove_record(RecordKind::Revocation, &locator);
        }
        let record = RevocationRecord {
            format: RECORD_FORMAT.to_owned(),
            plugin_id: artifact.plugin_id.clone(),
            publisher_identity: artifact.publisher_identity.clone(),
            plugin_major: major,
            artifact_version: artifact.version.clone(),
            revoked: true,
        };
        self.write_record(RecordKind::Revocation, &locator, &record)
    }

    fn write_record<T: Serialize>(
        &self,
        kind: RecordKind,
        locator: &[u8],
        record: &T,
    ) -> Result<(), NativePluginSecurityError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        let encoded = serde_json::to_vec(record)
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err(NativePluginSecurityError::LimitExceeded);
        }
        let address = RecordAddress::new(&self.root, kind, locator);
        let credential =
            std::str::from_utf8(&encoded).map_err(|_| NativePluginSecurityError::Integrity)?;

        // The keyring copy is the trusted integrity reference. If the process
        // stops before the file commit, the mismatch fails closed on restart.
        self.vault.save(&address.account, credential)?;
        atomic_write_private(&address.path, &encoded)
    }

    fn remove_record(
        &self,
        kind: RecordKind,
        locator: &[u8],
    ) -> Result<(), NativePluginSecurityError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        let address = RecordAddress::new(&self.root, kind, locator);
        match fs::symlink_metadata(&address.path) {
            Ok(metadata) => {
                ensure_private_regular_file(&metadata)?;
                fs::remove_file(&address.path)
                    .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
                sync_directory(
                    address
                        .path
                        .parent()
                        .ok_or(NativePluginSecurityError::StorageUnavailable)?,
                )?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(NativePluginSecurityError::StorageUnavailable),
        }
        // File-first removal means every interrupted state is denied: a
        // missing file with a remaining credential is an integrity failure.
        self.vault.clear(&address.account)
    }

    fn read_record<T: for<'de> Deserialize<'de>>(
        &self,
        kind: RecordKind,
        locator: &[u8],
    ) -> Result<Option<T>, NativePluginSecurityError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        let address = RecordAddress::new(&self.root, kind, locator);
        let metadata = match fs::symlink_metadata(&address.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return match self.vault.load(&address.account)? {
                    None => Ok(None),
                    Some(_) => Err(NativePluginSecurityError::Integrity),
                };
            }
            Err(_) => return Err(NativePluginSecurityError::StorageUnavailable),
        };
        ensure_private_regular_file(&metadata)?;
        if metadata.len() > MAX_RECORD_BYTES as u64 {
            return Err(NativePluginSecurityError::LimitExceeded);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(&address.path)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        let credential = self
            .vault
            .load(&address.account)?
            .ok_or(NativePluginSecurityError::Integrity)?;
        if credential.as_bytes() != bytes {
            return Err(NativePluginSecurityError::Integrity);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| NativePluginSecurityError::Integrity)
    }
}

impl AuthorizationStore for NativePluginSecurityStore {
    fn state(
        &self,
        key: &AuthorizationKey,
        permission: Permission,
    ) -> Result<AuthorizationState, AuthorizationStoreError> {
        validate_authorization_key(key).map_err(|_| AuthorizationStoreError)?;
        validate_persistent_grant(permission).map_err(|_| AuthorizationStoreError)?;
        let locator = decision_set_locator(key);
        let record: Option<DecisionSetRecord> = self
            .read_record(RecordKind::Decision, &locator)
            .map_err(|_| AuthorizationStoreError)?;
        let Some(record) = record else {
            return Ok(AuthorizationState::Missing);
        };
        if record.format != RECORD_FORMAT || record.scope != StoredAuthorizationScope::from(key) {
            return Err(AuthorizationStoreError);
        }
        Ok(record.decisions.get(&permission).copied().map_or(
            AuthorizationState::Missing,
            |decision| match decision {
                StoredDecision::Granted => AuthorizationState::Granted,
                StoredDecision::Denied => AuthorizationState::Denied,
            },
        ))
    }

    fn replace_states(
        &self,
        key: &AuthorizationKey,
        decisions: &[(Permission, AuthorizationState)],
    ) -> Result<AuthorizationGeneration, AuthorizationStoreError> {
        validate_authorization_key(key).map_err(|_| AuthorizationStoreError)?;
        let mut stored = BTreeMap::new();
        for (permission, state) in decisions {
            validate_persistent_grant(*permission).map_err(|_| AuthorizationStoreError)?;
            let decision = match state {
                AuthorizationState::Missing => return Err(AuthorizationStoreError),
                AuthorizationState::Granted => StoredDecision::Granted,
                AuthorizationState::Denied => StoredDecision::Denied,
            };
            if stored.insert(*permission, decision).is_some() {
                return Err(AuthorizationStoreError);
            }
        }
        let mut generation = [0_u8; 32];
        getrandom::fill(&mut generation).map_err(|_| AuthorizationStoreError)?;
        let locator = decision_set_locator(key);
        self.write_record(
            RecordKind::Decision,
            &locator,
            &DecisionSetRecord {
                format: RECORD_FORMAT.to_owned(),
                scope: StoredAuthorizationScope::from(key),
                decisions: stored,
                generation,
            },
        )
        .map_err(|_| AuthorizationStoreError)?;
        Ok(AuthorizationGeneration::from_bytes(generation))
    }
}

impl PluginAuthorizationStore for NativePluginSecurityStore {
    fn current_grant(
        &self,
        key: &AuthorizationKey,
        artifact_version: &str,
    ) -> Result<Option<PluginAuthorizationGrant>, AuthorizationFailure> {
        validate_artifact_for_key(key, artifact_version, BTreeSet::new())
            .map_err(|_| AuthorizationFailure)?;
        let record: Option<ReceiptRecord> = self
            .read_record(RecordKind::Receipt, &receipt_locator(key, artifact_version))
            .map_err(|_| AuthorizationFailure)?;
        let Some(record) = record else {
            return Ok(None);
        };
        if validate_receipt(
            key,
            artifact_version,
            &record.reviewed_permissions,
            record.revision,
        )
        .is_err()
            || record.format != RECORD_FORMAT
            || record.scope != StoredAuthorizationScope::from(key)
            || record.artifact_version != artifact_version
        {
            return Err(AuthorizationFailure);
        }
        let decisions: Option<DecisionSetRecord> = self
            .read_record(RecordKind::Decision, &decision_set_locator(key))
            .map_err(|_| AuthorizationFailure)?;
        let Some(decisions) = decisions else {
            return Ok(None);
        };
        if decisions.format != RECORD_FORMAT
            || decisions.scope != StoredAuthorizationScope::from(key)
            || decisions.generation != record.decision_generation
        {
            return Ok(None);
        }
        if record
            .reviewed_permissions
            .iter()
            .copied()
            .filter(|permission| !permission.is_per_request_only() && !permission.is_implicit())
            .any(|permission| {
                decisions.decisions.get(&permission) != Some(&StoredDecision::Granted)
            })
        {
            return Ok(None);
        }
        Ok(Some(PluginAuthorizationGrant {
            key: key.clone(),
            artifact_version: record.artifact_version,
            reviewed_permissions: record.reviewed_permissions,
            revision: record.revision,
        }))
    }
}

impl ArtifactRevocationStore for NativePluginSecurityStore {
    fn is_revoked(&self, artifact: &PluginArtifact) -> Result<bool, RevocationFailure> {
        let major = validate_artifact(artifact).map_err(|_| RevocationFailure)?;
        let record: Option<RevocationRecord> = self
            .read_record(RecordKind::Revocation, &revocation_locator(artifact, major))
            .map_err(|_| RevocationFailure)?;
        let Some(record) = record else {
            return Ok(false);
        };
        if record.format != RECORD_FORMAT
            || record.plugin_id != artifact.plugin_id
            || record.publisher_identity != artifact.publisher_identity
            || record.plugin_major != major
            || record.artifact_version != artifact.version
            || !record.revoked
        {
            return Err(RevocationFailure);
        }
        Ok(true)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredAuthorizationScope {
    plugin_id: String,
    publisher_identity: String,
    plugin_major: u64,
    workspace_id: String,
}

impl From<&AuthorizationKey> for StoredAuthorizationScope {
    fn from(key: &AuthorizationKey) -> Self {
        Self {
            plugin_id: key.plugin_id.clone(),
            publisher_identity: key.publisher_identity.clone(),
            plugin_major: key.plugin_major,
            workspace_id: key.workspace_id.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StoredDecision {
    Granted,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionSetRecord {
    format: String,
    scope: StoredAuthorizationScope,
    decisions: BTreeMap<Permission, StoredDecision>,
    generation: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptRecord {
    format: String,
    scope: StoredAuthorizationScope,
    artifact_version: String,
    reviewed_permissions: BTreeSet<Permission>,
    revision: u64,
    decision_generation: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevocationRecord {
    format: String,
    plugin_id: String,
    publisher_identity: String,
    plugin_major: u64,
    artifact_version: String,
    revoked: bool,
}

#[derive(Clone, Copy)]
enum RecordKind {
    Decision,
    Receipt,
    Revocation,
}

impl RecordKind {
    const ALL: [Self; 3] = [Self::Decision, Self::Receipt, Self::Revocation];

    const fn directory(self) -> &'static str {
        match self {
            Self::Decision => "decisions",
            Self::Receipt => "receipts",
            Self::Revocation => "revocations",
        }
    }
}

struct RecordAddress {
    path: PathBuf,
    account: String,
}

impl RecordAddress {
    fn new(root: &Path, kind: RecordKind, locator: &[u8]) -> Self {
        let id = stable_locator_id(locator);
        Self {
            path: root.join(kind.directory()).join(format!("{id}.json")),
            account: format!("{}-{id}", kind.directory()),
        }
    }
}

fn validate_receipt(
    key: &AuthorizationKey,
    artifact_version: &str,
    reviewed_permissions: &BTreeSet<Permission>,
    revision: u64,
) -> Result<(), NativePluginSecurityError> {
    if revision == 0 {
        return Err(NativePluginSecurityError::InvalidInput);
    }
    validate_artifact_for_key(key, artifact_version, reviewed_permissions.clone())
}

fn validate_artifact_for_key(
    key: &AuthorizationKey,
    artifact_version: &str,
    permissions: BTreeSet<Permission>,
) -> Result<(), NativePluginSecurityError> {
    validate_authorization_key(key).map_err(|_| NativePluginSecurityError::InvalidInput)?;
    let artifact = PluginArtifact::new(
        key.plugin_id.clone(),
        artifact_version.to_owned(),
        key.publisher_identity.clone(),
        permissions,
    )
    .map_err(|_| NativePluginSecurityError::InvalidInput)?;
    if parse_major(&artifact.version)? != key.plugin_major {
        return Err(NativePluginSecurityError::InvalidInput);
    }
    Ok(())
}

fn validate_artifact(artifact: &PluginArtifact) -> Result<u64, NativePluginSecurityError> {
    let validated = PluginArtifact::new(
        artifact.plugin_id.clone(),
        artifact.version.clone(),
        artifact.publisher_identity.clone(),
        artifact.requested_permissions.iter().copied(),
    )
    .map_err(|_| NativePluginSecurityError::InvalidInput)?;
    let major = parse_major(&validated.version)?;
    let key = AuthorizationKey {
        plugin_id: validated.plugin_id,
        publisher_identity: validated.publisher_identity,
        plugin_major: major,
        workspace_id: VERIFIED_WORKSPACE_FIXTURE.to_owned(),
    };
    validate_authorization_key(&key).map_err(|_| NativePluginSecurityError::InvalidInput)?;
    Ok(major)
}

fn parse_major(version: &str) -> Result<u64, NativePluginSecurityError> {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
        .filter(|major| *major > 0)
        .ok_or(NativePluginSecurityError::InvalidInput)
}

fn decision_set_locator(key: &AuthorizationKey) -> Vec<u8> {
    format!(
        "decision-set\0{}\0{}\0{}\0{}",
        key.plugin_id, key.publisher_identity, key.plugin_major, key.workspace_id,
    )
    .into_bytes()
}

fn receipt_locator(key: &AuthorizationKey, artifact_version: &str) -> Vec<u8> {
    format!(
        "receipt\0{}\0{}\0{}\0{}\0{}",
        key.plugin_id, key.publisher_identity, key.plugin_major, key.workspace_id, artifact_version,
    )
    .into_bytes()
}

fn revocation_locator(artifact: &PluginArtifact, major: u64) -> Vec<u8> {
    format!(
        "revocation\0{}\0{}\0{}\0{}",
        artifact.plugin_id, artifact.publisher_identity, major, artifact.version,
    )
    .into_bytes()
}

// This hash is only a bounded filesystem/keyring locator. Record identity and
// integrity are verified from the complete canonical content, so a collision
// can cause only a fail-closed availability error, never grant reuse.
fn stable_locator_id(locator: &[u8]) -> String {
    fn fnv64(bytes: &[u8], offset: u64) -> u64 {
        bytes.iter().fold(offset, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }
    let first = fnv64(locator, 0xcbf2_9ce4_8422_2325);
    let second = fnv64(locator, 0x8422_2325_cbf2_9ce4);
    format!("{first:016x}{second:016x}")
}

fn create_private_directory(path: &Path) -> Result<(), NativePluginSecurityError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(NativePluginSecurityError::Integrity);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        }
        Err(_) => return Err(NativePluginSecurityError::StorageUnavailable),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
    }
    Ok(())
}

fn atomic_write_private(path: &Path, bytes: &[u8]) -> Result<(), NativePluginSecurityError> {
    let parent = path
        .parent()
        .ok_or(NativePluginSecurityError::StorageUnavailable)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".bbcom-plugin-security-{}-{sequence}.part",
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        file.sync_all()
            .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
        drop(file);
        atomic_replace(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_replace(source: &Path, destination: &Path) -> Result<(), NativePluginSecurityError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
        source_wide.push(0);
        let mut destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
        destination_wide.push(0);
        let moved = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(NativePluginSecurityError::StorageUnavailable);
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, destination).map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), NativePluginSecurityError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| NativePluginSecurityError::StorageUnavailable)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn ensure_private_regular_file(metadata: &fs::Metadata) -> Result<(), NativePluginSecurityError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativePluginSecurityError::Integrity);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(NativePluginSecurityError::Integrity);
        }
    }
    Ok(())
}
