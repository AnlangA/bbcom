use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};

use crate::trust::{MAX_METADATA_BYTES, MetadataDecoder};
use crate::{CanonicalJsonDecoder, Error, RepositoryState, Result};

const STATE_SCHEMA: u32 = 1;
const MAX_STATE_BYTES: u64 = MAX_METADATA_BYTES * 2 + 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedTrustState {
    state: RepositoryState,
    trusted_root_envelope: Vec<u8>,
}

impl PersistedTrustState {
    pub fn new(state: RepositoryState, trusted_root_envelope: Vec<u8>) -> Result<Self> {
        validate_state(&state)?;
        validate_root_binding(&state, &trusted_root_envelope)?;
        Ok(Self {
            state,
            trusted_root_envelope,
        })
    }

    #[must_use]
    pub fn state(&self) -> &RepositoryState {
        &self.state
    }

    #[must_use]
    pub fn trusted_root_envelope(&self) -> &[u8] {
        &self.trusted_root_envelope
    }
}

#[derive(Clone, Debug)]
pub struct TrustedStateStore {
    directory: PathBuf,
    path: PathBuf,
}

impl TrustedStateStore {
    pub fn new(managed_root: impl AsRef<Path>, repository_id: &str) -> Result<Self> {
        if !valid_repository_id(repository_id) {
            return Err(Error::InvalidConfiguration);
        }
        let directory = managed_root.as_ref().join(repository_id);
        let path = directory.join("trusted-state-v1.json");
        Ok(Self { directory, path })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<PersistedTrustState>> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::StateIo),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_STATE_BYTES
        {
            return Err(Error::StateCorrupt);
        }
        validate_private_file(&metadata)?;
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
        File::open(&self.path)
            .and_then(|file| file.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes))
            .map_err(|_| Error::StateIo)?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_STATE_BYTES {
            return Err(Error::StateCorrupt);
        }
        let disk: DiskState = serde_json::from_slice(&bytes).map_err(|_| Error::StateCorrupt)?;
        if disk.schema != STATE_SCHEMA {
            return Err(Error::StateCorrupt);
        }
        let state = disk.state.into_state()?;
        let root = decode_hex(&disk.trusted_root_hex)?;
        PersistedTrustState::new(state, root).map(Some)
    }

    /// Atomically replaces the complete highest-version record. Callers must
    /// serialize access to one repository store within the application
    /// process; this method independently rejects every durable rollback or
    /// same-version content substitution observed on disk.
    pub fn commit(&self, next: &PersistedTrustState) -> Result<()> {
        validate_state(&next.state)?;
        validate_root_binding(&next.state, &next.trusted_root_envelope)?;
        prepare_private_directory(&self.directory)?;
        if let Some(current) = self.load()? {
            validate_forward(&current, next)?;
        }
        let disk = DiskState {
            schema: STATE_SCHEMA,
            state: DiskRepositoryState::from_state(&next.state),
            trusted_root_hex: encode_hex(&next.trusted_root_envelope),
        };
        let bytes = serde_json::to_vec(&disk).map_err(|_| Error::StateEncoding)?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_STATE_BYTES {
            return Err(Error::StateEncoding);
        }
        let mut options = AtomicWriteFile::options();
        configure_private_mode(&mut options);
        let mut file = options.open(&self.path).map_err(|_| Error::StateIo)?;
        file.write_all(&bytes).map_err(|_| Error::StateIo)?;
        file.commit().map_err(|_| Error::StateIo)?;
        sync_directory(&self.directory)?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskState {
    schema: u32,
    state: DiskRepositoryState,
    trusted_root_hex: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskRepositoryState {
    root_version: u64,
    timestamp_version: u64,
    timestamp_sha256: Option<String>,
    snapshot_version: u64,
    snapshot_sha256: Option<String>,
    targets_version: u64,
    targets_sha256: Option<String>,
}

impl DiskRepositoryState {
    fn from_state(state: &RepositoryState) -> Self {
        Self {
            root_version: state.root_version,
            timestamp_version: state.timestamp_version,
            timestamp_sha256: state.timestamp_sha256.map(|value| encode_hex(&value)),
            snapshot_version: state.snapshot_version,
            snapshot_sha256: state.snapshot_sha256.map(|value| encode_hex(&value)),
            targets_version: state.targets_version,
            targets_sha256: state.targets_sha256.map(|value| encode_hex(&value)),
        }
    }

    fn into_state(self) -> Result<RepositoryState> {
        Ok(RepositoryState {
            root_version: self.root_version,
            timestamp_version: self.timestamp_version,
            timestamp_sha256: decode_optional_digest(self.timestamp_sha256)?,
            snapshot_version: self.snapshot_version,
            snapshot_sha256: decode_optional_digest(self.snapshot_sha256)?,
            targets_version: self.targets_version,
            targets_sha256: decode_optional_digest(self.targets_sha256)?,
        })
    }
}

fn validate_root_binding(state: &RepositoryState, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_METADATA_BYTES {
        return Err(Error::StateCorrupt);
    }
    let root = CanonicalJsonDecoder
        .root(bytes)
        .map_err(|_| Error::StateCorrupt)?;
    if root.signed.version != state.root_version {
        return Err(Error::StateCorrupt);
    }
    Ok(())
}

fn validate_state(state: &RepositoryState) -> Result<()> {
    if state.root_version == 0
        || !version_hash_valid(state.timestamp_version, state.timestamp_sha256)
        || !version_hash_valid(state.snapshot_version, state.snapshot_sha256)
        || !version_hash_valid(state.targets_version, state.targets_sha256)
    {
        return Err(Error::StateCorrupt);
    }
    Ok(())
}

fn version_hash_valid(version: u64, hash: Option<[u8; 32]>) -> bool {
    (version == 0) == hash.is_none()
}

fn validate_forward(current: &PersistedTrustState, next: &PersistedTrustState) -> Result<()> {
    if next.state.root_version < current.state.root_version {
        return Err(Error::VersionRollback);
    }
    if next.state.root_version == current.state.root_version
        && next.trusted_root_envelope != current.trusted_root_envelope
    {
        return Err(Error::FreezeAttack);
    }
    validate_role_forward(
        current.state.timestamp_version,
        current.state.timestamp_sha256,
        next.state.timestamp_version,
        next.state.timestamp_sha256,
    )?;
    validate_role_forward(
        current.state.snapshot_version,
        current.state.snapshot_sha256,
        next.state.snapshot_version,
        next.state.snapshot_sha256,
    )?;
    validate_role_forward(
        current.state.targets_version,
        current.state.targets_sha256,
        next.state.targets_version,
        next.state.targets_sha256,
    )?;
    Ok(())
}

fn validate_role_forward(
    current_version: u64,
    current_hash: Option<[u8; 32]>,
    next_version: u64,
    next_hash: Option<[u8; 32]>,
) -> Result<()> {
    if next_version < current_version {
        return Err(Error::VersionRollback);
    }
    if next_version == current_version && next_hash != current_hash {
        return Err(Error::FreezeAttack);
    }
    Ok(())
}

fn prepare_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| Error::StateIo)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::StateIo)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::StateCorrupt);
    }
    set_private_directory_mode(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| Error::StateIo)
}

#[cfg(not(unix))]
fn set_private_directory_mode(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn configure_private_mode(options: &mut atomic_write_file::OpenOptions) {
    use atomic_write_file::unix::OpenOptionsExt as AtomicOpenOptionsExt;
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600).preserve_mode(false);
}

#[cfg(not(unix))]
fn configure_private_mode(_options: &mut atomic_write_file::OpenOptions) {}

#[cfg(unix)]
fn validate_private_file(metadata: &fs::Metadata) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o077 != 0 {
        Err(Error::StateCorrupt)
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn validate_private_file(_metadata: &fs::Metadata) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::StateIo)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn decode_optional_digest(value: Option<String>) -> Result<Option<[u8; 32]>> {
    value
        .map(|value| {
            let bytes = decode_hex(&value)?;
            bytes.try_into().map_err(|_| Error::StateCorrupt)
        })
        .transpose()
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(Error::StateCorrupt);
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok((decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?))
        .collect()
}

fn decode_nibble(value: u8) -> Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(Error::StateCorrupt),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn valid_repository_id(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'-' => index > 0 && index + 1 < value.len(),
            _ => false,
        })
}
