//! Native, pathless persistence for opaque plugin state.
//!
//! This module is intentionally not renderer-facing. The application setup
//! constructs the port from its already-resolved private data directory and
//! injects it into `SidecarHostLauncher`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use bbcom_plugin_contracts::{
    MAX_PLUGIN_PERSISTED_STATE_BYTES, MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES,
};
use bbcom_plugin_manager::{ArtifactSlot, HostFailure, HostLaunchMode};
use crc::{CRC_64_ECMA_182, Crc};

use super::host_launcher::{
    PluginPersistedState, PluginStatePersistenceKey, PluginStatePersistencePort,
};

const ROOT_DIRECTORY: &str = "plugin-state-v2";
const STATE_FILE: &str = "state.bin";
const RECORD_MAGIC: &[u8; 8] = b"BBCPST01";
const RECORD_VERSION: u32 = 1;
const MAX_IDENTITY_BYTES: usize = 256;
const MAX_RECORD_OVERHEAD_BYTES: usize = 4 * 1024;
const LOCATOR_HEX_BYTES: usize = 32;
const CRC: Crc<u64> = Crc::<u64>::new(&CRC_64_ECMA_182);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Filesystem-backed implementation of the native plugin-state port.
///
/// `application_private_directory` is resolved by native application setup;
/// no command, event, DTO, or renderer string can select it. One process owns
/// one mutable instance so aggregate checks and commits cannot race locally.
pub struct NativePluginStatePersistencePort {
    root: PathBuf,
    durability_uncertain: bool,
}

impl NativePluginStatePersistencePort {
    pub fn open(application_private_directory: impl AsRef<Path>) -> Result<Self, HostFailure> {
        let private = application_private_directory.as_ref();
        ensure_application_directory(private)?;
        let private = fs::canonicalize(private).map_err(|_| HostFailure::Initialization)?;
        let root = private.join(ROOT_DIRECTORY);
        ensure_private_directory(&root)?;
        sync_directory(&private)?;
        Ok(Self {
            root,
            durability_uncertain: false,
        })
    }

    fn ensure_available(&self) -> Result<(), HostFailure> {
        if self.durability_uncertain {
            Err(HostFailure::Initialization)
        } else {
            Ok(())
        }
    }

    fn address(&self, key: &PluginStatePersistenceKey) -> Result<StateAddress, HostFailure> {
        validate_identity(&key.workspace_id)?;
        validate_identity(&key.plugin_id)?;
        let slot_identity = match (&key.artifact_slot, key.launch_mode) {
            (ArtifactSlot::Active, HostLaunchMode::Active) => "active".to_owned(),
            (ArtifactSlot::Prepared(token), HostLaunchMode::UpdatePreflight) => {
                validate_identity(token.as_str())?;
                format!("prepared:{}", token.as_str())
            }
            _ => return Err(HostFailure::Initialization),
        };
        let workspace = stable_locator(key.workspace_id.as_bytes());
        let plugin = stable_locator(key.plugin_id.as_bytes());
        let slot = stable_locator(slot_identity.as_bytes());
        let directory = self.root.join(workspace).join(plugin).join(slot);
        Ok(StateAddress {
            directory: directory.clone(),
            path: directory.join(STATE_FILE),
            identity: StateIdentity {
                workspace_id: key.workspace_id.clone(),
                plugin_id: key.plugin_id.clone(),
                slot_identity,
                launch_mode: key.launch_mode,
            },
        })
    }

    fn read_address(
        &self,
        address: &StateAddress,
    ) -> Result<Option<PluginPersistedState>, HostFailure> {
        let Some(record) = read_record_if_present(&address.path)? else {
            return Ok(None);
        };
        if record.identity != address.identity {
            return Err(HostFailure::Initialization);
        }
        Ok(Some(record.state))
    }

    fn scan_workspace(&self, workspace_id: &str) -> Result<usize, HostFailure> {
        validate_identity(workspace_id)?;
        let directory = self.root.join(stable_locator(workspace_id.as_bytes()));
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(_) => return Err(HostFailure::Initialization),
        };
        ensure_private_directory_metadata(&metadata)?;
        let mut total = 0usize;
        for plugin in strict_directories(&directory)? {
            for slot in strict_directories(&plugin)? {
                let state_path = slot.join(STATE_FILE);
                let Some(record) = read_record_if_present(&state_path)? else {
                    continue;
                };
                if record.identity.workspace_id != workspace_id {
                    return Err(HostFailure::Initialization);
                }
                total = total
                    .checked_add(state_bytes(&record.state))
                    .ok_or(HostFailure::Initialization)?;
                if total > MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES {
                    return Err(HostFailure::Initialization);
                }
            }
        }
        Ok(total)
    }

    fn commit(
        &mut self,
        address: &StateAddress,
        state: &PluginPersistedState,
    ) -> Result<(), HostFailure> {
        let bytes = encode_record(&address.identity, state)?;
        ensure_private_directory_chain(&self.root, &address.directory)?;
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = address.directory.join(format!(
            ".bbcom-plugin-state-{}-{sequence}.part",
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
            .map_err(|_| HostFailure::Initialization)?;
        let staged = (|| {
            file.write_all(&bytes)
                .map_err(|_| HostFailure::Initialization)?;
            file.sync_all().map_err(|_| HostFailure::Initialization)?;
            drop(file);
            atomic_replace(&temporary, &address.path)
        })();
        if staged.is_err() {
            let _ = fs::remove_file(&temporary);
            return staged;
        }

        // Rename is the commit point. A directory-sync failure cannot safely
        // be reported as a failed write because the new value is already
        // atomically visible. Treat this call as committed, poison the port,
        // and fail closed on every later operation until application restart.
        if sync_directory(&address.directory).is_err() {
            self.durability_uncertain = true;
        }
        Ok(())
    }
}

impl PluginStatePersistencePort for NativePluginStatePersistencePort {
    fn load_plugin_storage(
        &mut self,
        key: &PluginStatePersistenceKey,
    ) -> Result<Option<Vec<u8>>, HostFailure> {
        self.ensure_available()?;
        let address = self.address(key)?;
        Ok(self
            .read_address(&address)?
            .map(|state| state.plugin_storage))
    }

    fn workspace_total_bytes(&mut self, workspace_id: &str) -> Result<usize, HostFailure> {
        self.ensure_available()?;
        self.scan_workspace(workspace_id)
    }

    fn persist_state(
        &mut self,
        key: &PluginStatePersistenceKey,
        state: &PluginPersistedState,
    ) -> Result<(), HostFailure> {
        self.ensure_available()?;
        let incoming_bytes = state_bytes(state);
        if incoming_bytes > MAX_PLUGIN_PERSISTED_STATE_BYTES {
            return Err(HostFailure::Initialization);
        }
        let address = self.address(key)?;
        let previous_bytes = self.read_address(&address)?.as_ref().map_or(0, state_bytes);
        let workspace_total = self.scan_workspace(&key.workspace_id)?;
        let projected = workspace_total
            .checked_sub(previous_bytes)
            .and_then(|bytes| bytes.checked_add(incoming_bytes))
            .ok_or(HostFailure::Initialization)?;
        if projected > MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES {
            return Err(HostFailure::Initialization);
        }
        self.commit(&address, state)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StateIdentity {
    workspace_id: String,
    plugin_id: String,
    slot_identity: String,
    launch_mode: HostLaunchMode,
}

struct StateAddress {
    directory: PathBuf,
    path: PathBuf,
    identity: StateIdentity,
}

struct PersistedRecord {
    identity: StateIdentity,
    state: PluginPersistedState,
}

fn validate_identity(value: &str) -> Result<(), HostFailure> {
    if value.is_empty()
        || value.len() > MAX_IDENTITY_BYTES
        || value.as_bytes().contains(&0)
        || value.chars().any(char::is_control)
    {
        Err(HostFailure::Initialization)
    } else {
        Ok(())
    }
}

// The locator is only a bounded directory key. The complete identity is stored
// in and verified from every authenticated record, so a collision fails closed.
fn stable_locator(bytes: &[u8]) -> String {
    fn fnv64(bytes: &[u8], offset: u64) -> u64 {
        bytes.iter().fold(offset, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }
    let first = fnv64(bytes, 0xcbf2_9ce4_8422_2325);
    let second = fnv64(bytes, 0x8422_2325_cbf2_9ce4);
    format!("{first:016x}{second:016x}")
}

fn state_bytes(state: &PluginPersistedState) -> usize {
    state
        .plugin_storage
        .len()
        .saturating_add(state.project_state.as_ref().map_or(0, Vec::len))
}

fn encode_record(
    identity: &StateIdentity,
    state: &PluginPersistedState,
) -> Result<Vec<u8>, HostFailure> {
    if state_bytes(state) > MAX_PLUGIN_PERSISTED_STATE_BYTES {
        return Err(HostFailure::Initialization);
    }
    let mut bytes = Vec::with_capacity(state_bytes(state) + 256);
    bytes.extend_from_slice(RECORD_MAGIC);
    bytes.extend_from_slice(&RECORD_VERSION.to_le_bytes());
    put_string(&mut bytes, &identity.workspace_id)?;
    put_string(&mut bytes, &identity.plugin_id)?;
    put_string(&mut bytes, &identity.slot_identity)?;
    bytes.push(match identity.launch_mode {
        HostLaunchMode::Active => 1,
        HostLaunchMode::UpdatePreflight => 2,
    });
    bytes.extend_from_slice(&(state.plugin_storage.len() as u64).to_le_bytes());
    bytes.push(u8::from(state.project_state.is_some()));
    bytes.extend_from_slice(
        &(state.project_state.as_ref().map_or(0, Vec::len) as u64).to_le_bytes(),
    );
    bytes.extend_from_slice(&state.plugin_storage);
    if let Some(project_state) = &state.project_state {
        bytes.extend_from_slice(project_state);
    }
    let checksum = CRC.checksum(&bytes);
    bytes.extend_from_slice(&checksum.to_le_bytes());
    Ok(bytes)
}

fn decode_record(bytes: &[u8]) -> Result<PersistedRecord, HostFailure> {
    if bytes.len() < RECORD_MAGIC.len() + 4 + 8
        || bytes.len() > MAX_PLUGIN_PERSISTED_STATE_BYTES + MAX_RECORD_OVERHEAD_BYTES
    {
        return Err(HostFailure::Initialization);
    }
    let (content, checksum_bytes) = bytes
        .split_at_checked(bytes.len().saturating_sub(8))
        .ok_or(HostFailure::Initialization)?;
    let expected = u64::from_le_bytes(
        checksum_bytes
            .try_into()
            .map_err(|_| HostFailure::Initialization)?,
    );
    if CRC.checksum(content) != expected {
        return Err(HostFailure::Initialization);
    }
    let mut cursor = RecordCursor::new(content);
    if cursor.take(RECORD_MAGIC.len())? != RECORD_MAGIC || cursor.u32()? != RECORD_VERSION {
        return Err(HostFailure::Initialization);
    }
    let workspace_id = cursor.string()?;
    let plugin_id = cursor.string()?;
    let slot_identity = cursor.string()?;
    let launch_mode = match cursor.byte()? {
        1 => HostLaunchMode::Active,
        2 => HostLaunchMode::UpdatePreflight,
        _ => return Err(HostFailure::Initialization),
    };
    let storage_bytes = usize::try_from(cursor.u64()?).map_err(|_| HostFailure::Initialization)?;
    let has_project = match cursor.byte()? {
        0 => false,
        1 => true,
        _ => return Err(HostFailure::Initialization),
    };
    let project_bytes = usize::try_from(cursor.u64()?).map_err(|_| HostFailure::Initialization)?;
    if (!has_project && project_bytes != 0)
        || storage_bytes.saturating_add(project_bytes) > MAX_PLUGIN_PERSISTED_STATE_BYTES
        || cursor.remaining() != storage_bytes.saturating_add(project_bytes)
    {
        return Err(HostFailure::Initialization);
    }
    let plugin_storage = cursor.take(storage_bytes)?.to_vec();
    let project_state = if has_project {
        Some(cursor.take(project_bytes)?.to_vec())
    } else {
        None
    };
    Ok(PersistedRecord {
        identity: StateIdentity {
            workspace_id,
            plugin_id,
            slot_identity,
            launch_mode,
        },
        state: PluginPersistedState {
            plugin_storage,
            project_state,
        },
    })
}

fn put_string(output: &mut Vec<u8>, value: &str) -> Result<(), HostFailure> {
    validate_identity(value)?;
    let length = u32::try_from(value.len()).map_err(|_| HostFailure::Initialization)?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

struct RecordCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> RecordCursor<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], HostFailure> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(HostFailure::Initialization)?;
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, HostFailure> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, HostFailure> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| HostFailure::Initialization)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, HostFailure> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| HostFailure::Initialization)?,
        ))
    }

    fn string(&mut self) -> Result<String, HostFailure> {
        let length = self.u32()? as usize;
        if length == 0 || length > MAX_IDENTITY_BYTES {
            return Err(HostFailure::Initialization);
        }
        let value = std::str::from_utf8(self.take(length)?)
            .map_err(|_| HostFailure::Initialization)?
            .to_owned();
        validate_identity(&value)?;
        Ok(value)
    }
}

fn read_record_if_present(path: &Path) -> Result<Option<PersistedRecord>, HostFailure> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(HostFailure::Initialization),
    };
    ensure_private_file_metadata(&metadata)?;
    if metadata.len() > (MAX_PLUGIN_PERSISTED_STATE_BYTES + MAX_RECORD_OVERHEAD_BYTES) as u64 {
        return Err(HostFailure::Initialization);
    }
    let record_bytes = usize::try_from(metadata.len()).map_err(|_| HostFailure::Initialization)?;
    let file = File::open(path).map_err(|_| HostFailure::Initialization)?;
    let mut bytes = Vec::with_capacity(record_bytes);
    file.take((MAX_PLUGIN_PERSISTED_STATE_BYTES + MAX_RECORD_OVERHEAD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| HostFailure::Initialization)?;
    if bytes.len() != record_bytes {
        return Err(HostFailure::Initialization);
    }
    decode_record(&bytes).map(Some)
}

fn strict_directories(path: &Path) -> Result<Vec<PathBuf>, HostFailure> {
    let mut directories = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| HostFailure::Initialization)? {
        let entry = entry.map_err(|_| HostFailure::Initialization)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(HostFailure::Initialization)?;
        if name.starts_with(".bbcom-plugin-state-") && name.ends_with(".part") {
            continue;
        }
        if name.len() != LOCATOR_HEX_BYTES
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(HostFailure::Initialization);
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| HostFailure::Initialization)?;
        ensure_private_directory_metadata(&metadata)?;
        directories.push(entry.path());
    }
    Ok(directories)
}

fn ensure_application_directory(path: &Path) -> Result<(), HostFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|_| HostFailure::Initialization)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        Err(HostFailure::Initialization)
    } else {
        Ok(())
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), HostFailure> {
    let mut created = false;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            // Symlinks and non-directories stay fatal (escape guard).
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(HostFailure::Initialization);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    // Self-heal a real directory with loose group/other bits
                    // instead of rejecting it: composition creates sibling
                    // roots under the process umask (e.g. 0775), and such a
                    // directory is recoverable precisely because we can
                    // chmod it. A failed chmod (read-only fs, foreign owner)
                    // remains the hard failure it always was.
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                        .map_err(|_| HostFailure::Initialization)?;
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| HostFailure::Initialization)?;
            created = true;
        }
        Err(_) => return Err(HostFailure::Initialization),
    }
    set_private_directory_permissions(path)?;
    // Re-verify the final mode so both the healed and freshly created paths
    // land on the strict contract before anything is stored inside.
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure_private_directory_metadata(&metadata)?;
    }
    if created && let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn ensure_private_directory_chain(root: &Path, target: &Path) -> Result<(), HostFailure> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| HostFailure::Initialization)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(HostFailure::Initialization);
        };
        current.push(component);
        ensure_private_directory(&current)?;
    }
    Ok(())
}

fn ensure_private_directory_metadata(metadata: &fs::Metadata) -> Result<(), HostFailure> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(HostFailure::Initialization);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(HostFailure::Initialization);
        }
    }
    Ok(())
}

fn ensure_private_file_metadata(metadata: &fs::Metadata) -> Result<(), HostFailure> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HostFailure::Initialization);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(HostFailure::Initialization);
        }
    }
    Ok(())
}

fn set_private_directory_permissions(path: &Path) -> Result<(), HostFailure> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| HostFailure::Initialization)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn atomic_replace(source: &Path, destination: &Path) -> Result<(), HostFailure> {
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
        if unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(HostFailure::Initialization);
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, destination).map_err(|_| HostFailure::Initialization)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), HostFailure> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| HostFailure::Initialization)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bbcom_plugin_manager::PreparationToken;

    fn private_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("private root");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
                .expect("private permissions");
        }
        root
    }

    fn active_key(plugin_id: &str) -> PluginStatePersistenceKey {
        PluginStatePersistenceKey {
            plugin_id: plugin_id.to_owned(),
            workspace_id: "workspace-1".to_owned(),
            artifact_slot: ArtifactSlot::Active,
            launch_mode: HostLaunchMode::Active,
        }
    }

    #[cfg(unix)]
    fn directory_mode(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    #[test]
    #[cfg(unix)]
    fn existing_loose_state_root_is_self_healed_to_strict_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = private_root();
        // Reproduce the umask-created sibling: a real directory with group
        // write/read bits, exactly what `create_dir_all` produced under
        // umask 022/002 before the bootstrap-ordering fix.
        let state_root = root.path().join(ROOT_DIRECTORY);
        fs::create_dir(&state_root).expect("create loose root");
        fs::set_permissions(&state_root, fs::Permissions::from_mode(0o775)).expect("loosen");
        let port = NativePluginStatePersistencePort::open(root.path())
            .expect("loose state root must self-heal instead of failing");
        assert_eq!(directory_mode(&state_root), 0o700);
        drop(port);
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_state_root_still_fails_closed() {
        let root = private_root();
        let target = private_root();
        #[cfg(unix)]
        std::os::unix::fs::symlink(target.path(), root.path().join(ROOT_DIRECTORY))
            .expect("symlink");
        assert!(NativePluginStatePersistencePort::open(root.path()).is_err());
    }

    #[test]
    fn opaque_state_round_trips_without_exposing_identity_as_a_path() {
        let root = private_root();
        let mut port = NativePluginStatePersistencePort::open(root.path()).expect("port");
        let key = active_key("dev.bbcom.fixture");
        let state = PluginPersistedState {
            plugin_storage: vec![1, 2, 3],
            project_state: Some(vec![4, 5]),
        };
        port.persist_state(&key, &state).expect("persist");
        assert_eq!(
            port.load_plugin_storage(&key).expect("load"),
            Some(vec![1, 2, 3])
        );
        assert_eq!(port.workspace_total_bytes("workspace-1").unwrap(), 5);
        let rendered = port
            .address(&key)
            .unwrap()
            .path
            .to_string_lossy()
            .to_string();
        assert!(!rendered.contains("workspace-1"));
        assert!(!rendered.contains("dev.bbcom.fixture"));
    }

    #[test]
    fn corrupt_or_cross_identity_records_fail_closed() {
        let root = private_root();
        let mut port = NativePluginStatePersistencePort::open(root.path()).expect("port");
        let key = active_key("dev.bbcom.fixture");
        let state = PluginPersistedState {
            plugin_storage: vec![1],
            project_state: None,
        };
        port.persist_state(&key, &state).unwrap();
        let address = port.address(&key).unwrap();
        let mut bytes = fs::read(&address.path).unwrap();
        bytes[0] ^= 0xff;
        fs::write(&address.path, bytes).unwrap();
        assert_eq!(
            port.load_plugin_storage(&key),
            Err(HostFailure::Initialization)
        );
    }

    #[test]
    fn limits_and_slot_mode_mismatch_are_rejected_before_commit() {
        let root = private_root();
        let mut port = NativePluginStatePersistencePort::open(root.path()).expect("port");
        let key = active_key("dev.bbcom.fixture");
        let original = PluginPersistedState {
            plugin_storage: vec![7],
            project_state: None,
        };
        port.persist_state(&key, &original).unwrap();
        let oversized = PluginPersistedState {
            plugin_storage: vec![0; MAX_PLUGIN_PERSISTED_STATE_BYTES],
            project_state: Some(vec![1]),
        };
        assert_eq!(
            port.persist_state(&key, &oversized),
            Err(HostFailure::Initialization)
        );
        assert_eq!(port.load_plugin_storage(&key).unwrap(), Some(vec![7]));

        let mismatched = PluginStatePersistenceKey {
            plugin_id: "dev.bbcom.fixture".to_owned(),
            workspace_id: "workspace-1".to_owned(),
            artifact_slot: ArtifactSlot::Prepared(PreparationToken::new("upgrade-1").unwrap()),
            launch_mode: HostLaunchMode::Active,
        };
        assert_eq!(
            port.load_plugin_storage(&mismatched),
            Err(HostFailure::Initialization)
        );
    }

    #[test]
    fn active_and_prepared_slots_never_alias() {
        let root = private_root();
        let mut port = NativePluginStatePersistencePort::open(root.path()).expect("port");
        let active = active_key("dev.bbcom.fixture");
        let prepared = PluginStatePersistenceKey {
            plugin_id: active.plugin_id.clone(),
            workspace_id: active.workspace_id.clone(),
            artifact_slot: ArtifactSlot::Prepared(PreparationToken::new("upgrade-1").unwrap()),
            launch_mode: HostLaunchMode::UpdatePreflight,
        };
        port.persist_state(
            &active,
            &PluginPersistedState {
                plugin_storage: vec![1],
                project_state: None,
            },
        )
        .unwrap();
        port.persist_state(
            &prepared,
            &PluginPersistedState {
                plugin_storage: vec![2],
                project_state: None,
            },
        )
        .unwrap();
        assert_eq!(port.load_plugin_storage(&active).unwrap(), Some(vec![1]));
        assert_eq!(port.load_plugin_storage(&prepared).unwrap(), Some(vec![2]));
    }
}
