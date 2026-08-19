//! Native, pathless persistence for opaque plugin state.
//!
//! This module is intentionally not renderer-facing. The application setup
//! constructs the port from its already-resolved private data directory and
//! injects it into `SidecarHostLauncher`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
const UNINSTALL_MAGIC: &[u8; 8] = b"BBCUTM01";
const UNINSTALL_VERSION: u32 = 1;
const UNINSTALL_TOMBSTONES_FILE: &str = "uninstall-tombstones.bin";
const UNINSTALL_TEMP_PREFIX: &str = ".bbcom-plugin-uninstall-";
const MAX_UNINSTALL_TOMBSTONES: usize = 4_096;
const MAX_UNINSTALL_WORKSPACES: usize = 16_384;
const MAX_UNINSTALL_TOMBSTONES_BYTES: usize = 4 * 1024 * 1024;
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
    #[cfg(test)]
    fail_next_plugin_purge: bool,
}

/// Cloneable serialization boundary shared by the launcher (initial load) and
/// the protocol-v2 capability gateway (durable key/value commits).
#[derive(Clone)]
pub struct SharedNativePluginStatePersistencePort {
    inner: Arc<Mutex<NativePluginStatePersistencePort>>,
}

impl SharedNativePluginStatePersistencePort {
    pub fn open(application_private_directory: impl AsRef<Path>) -> Result<Self, HostFailure> {
        Ok(Self {
            inner: Arc::new(Mutex::new(NativePluginStatePersistencePort::open(
                application_private_directory,
            )?)),
        })
    }

    pub fn persist_scoped_storage(
        &self,
        workspace_id: &str,
        plugin_id: &str,
        storage_scope: &str,
        plugin_storage: &[u8],
    ) -> Result<(), HostFailure> {
        // The runtime-facing sink deliberately has no prepared-state write
        // path. Update preflight reads the active bytes through the launcher
        // and keeps every candidate write in memory; accepting a prepared
        // scope here would reintroduce orphaned quota-consuming records after
        // a crash or failed artifact commit.
        if storage_scope != "active" {
            return Err(HostFailure::Initialization);
        }
        let key = PluginStatePersistenceKey {
            plugin_id: plugin_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            artifact_slot: ArtifactSlot::Active,
            launch_mode: HostLaunchMode::Active,
        };
        let state = PluginPersistedState {
            plugin_storage: plugin_storage.to_vec(),
            // Portable project state is owned by the workspace service;
            // never duplicate it into the private-state record.
            project_state: None,
        };
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .persist_state(&key, &state)
    }

    /// Durably blocks all access to one plugin's private state before the
    /// package store crosses its irreversible uninstall boundary.
    pub fn stage_plugin_removal(&self, plugin_id: &str) -> Result<(), HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .stage_plugin_removal(plugin_id)
    }

    /// Compensates a package-uninstall failure. No state bytes have been
    /// deleted while the removal is merely staged.
    pub fn cancel_plugin_removal(&self, plugin_id: &str) -> Result<(), HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .cancel_plugin_removal(plugin_id)
    }

    /// Deletes every identity-verified record for a plugin and clears its
    /// tombstone only after the deletion is durably complete.
    pub fn remove_plugin(&self, plugin_id: &str) -> Result<(), HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .remove_plugin(plugin_id)
    }

    /// Retries tombstoned removals whose package is definitively absent.
    /// Tombstones for installed IDs remain blocked: an installed ID may be a
    /// same-ID reinstall and must never inherit the previous storage.
    pub fn retry_uninstalled_plugin_removals(
        &self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .retry_uninstalled_plugin_removals(installed_plugin_ids)
    }

    #[cfg(test)]
    fn fail_next_plugin_purge(&self) {
        self.inner.lock().unwrap().fail_next_plugin_purge = true;
    }
}

impl PluginStatePersistencePort for SharedNativePluginStatePersistencePort {
    fn load_plugin_storage(
        &mut self,
        key: &PluginStatePersistenceKey,
    ) -> Result<Option<Vec<u8>>, HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .load_plugin_storage(key)
    }

    fn workspace_total_bytes(&mut self, workspace_id: &str) -> Result<usize, HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .workspace_total_bytes(workspace_id)
    }

    fn persist_state(
        &mut self,
        key: &PluginStatePersistenceKey,
        state: &PluginPersistedState,
    ) -> Result<(), HostFailure> {
        self.inner
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .persist_state(key, state)
    }
}

impl NativePluginStatePersistencePort {
    pub fn open(application_private_directory: impl AsRef<Path>) -> Result<Self, HostFailure> {
        let private = application_private_directory.as_ref();
        ensure_application_directory(private)?;
        let private = fs::canonicalize(private).map_err(|_| HostFailure::Initialization)?;
        let root = private.join(ROOT_DIRECTORY);
        ensure_private_directory(&root)?;
        sync_directory(&private)?;
        let port = Self {
            root,
            durability_uncertain: false,
            #[cfg(test)]
            fail_next_plugin_purge: false,
        };
        // Corrupt removal intent must fail application composition before any
        // plugin can read private state. Valid pending intents are retried
        // later with the authoritative installed-ID set.
        port.read_uninstall_tombstones()?;
        Ok(port)
    }

    fn ensure_available(&self) -> Result<(), HostFailure> {
        if self.durability_uncertain {
            Err(HostFailure::Initialization)
        } else {
            Ok(())
        }
    }

    fn read_uninstall_tombstones(&self) -> Result<UninstallTombstones, HostFailure> {
        let path = self.root.join(UNINSTALL_TOMBSTONES_FILE);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(UninstallTombstones::default());
            }
            Err(_) => return Err(HostFailure::Initialization),
        };
        ensure_private_file_metadata(&metadata)?;
        if metadata.len() > MAX_UNINSTALL_TOMBSTONES_BYTES as u64 {
            return Err(HostFailure::Initialization);
        }
        let expected = usize::try_from(metadata.len()).map_err(|_| HostFailure::Initialization)?;
        let file = File::open(path).map_err(|_| HostFailure::Initialization)?;
        let mut bytes = Vec::with_capacity(expected);
        file.take((MAX_UNINSTALL_TOMBSTONES_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| HostFailure::Initialization)?;
        if bytes.len() != expected {
            return Err(HostFailure::Initialization);
        }
        decode_uninstall_tombstones(&bytes)
    }

    fn commit_uninstall_tombstones(
        &mut self,
        tombstones: &UninstallTombstones,
    ) -> Result<(), HostFailure> {
        self.ensure_available()?;
        let bytes = encode_uninstall_tombstones(tombstones)?;
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = self.root.join(format!(
            "{UNINSTALL_TEMP_PREFIX}{}-{sequence}.part",
            std::process::id()
        ));
        let destination = self.root.join(UNINSTALL_TOMBSTONES_FILE);
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
            atomic_replace(&temporary, &destination)
        })();
        if staged.is_err() {
            let _ = fs::remove_file(&temporary);
            return staged;
        }
        if sync_directory(&self.root).is_err() {
            self.durability_uncertain = true;
            return Err(HostFailure::Initialization);
        }
        Ok(())
    }

    fn root_workspace_directories(&self) -> Result<Vec<PathBuf>, HostFailure> {
        let mut workspaces = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|_| HostFailure::Initialization)? {
            let entry = entry.map_err(|_| HostFailure::Initialization)?;
            let name = entry.file_name();
            let name = name.to_str().ok_or(HostFailure::Initialization)?;
            if name == UNINSTALL_TOMBSTONES_FILE
                || name.starts_with(UNINSTALL_TEMP_PREFIX) && name.ends_with(".part")
            {
                let metadata =
                    fs::symlink_metadata(entry.path()).map_err(|_| HostFailure::Initialization)?;
                ensure_private_file_metadata(&metadata)?;
                continue;
            }
            validate_locator_name(name)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| HostFailure::Initialization)?;
            ensure_private_directory_metadata(&metadata)?;
            workspaces.push(entry.path());
        }
        Ok(workspaces)
    }

    fn collect_plugin_workspaces(&self, plugin_id: &str) -> Result<BTreeSet<String>, HostFailure> {
        validate_identity(plugin_id)?;
        let plugin_locator = stable_locator(plugin_id.as_bytes());
        let mut workspaces = BTreeSet::new();
        for workspace_directory in self.root_workspace_directories()? {
            let plugin_directory = workspace_directory.join(&plugin_locator);
            let metadata = match fs::symlink_metadata(&plugin_directory) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(HostFailure::Initialization),
            };
            ensure_private_directory_metadata(&metadata)?;
            let mut workspace_identity = None;
            for slot_directory in strict_directories(&plugin_directory)? {
                let Some(record) = read_record_if_present(&slot_directory.join(STATE_FILE))? else {
                    ensure_directory_empty(&slot_directory)?;
                    continue;
                };
                validate_plugin_record_location(
                    &record,
                    &workspace_directory,
                    &plugin_directory,
                    &slot_directory,
                    plugin_id,
                )?;
                match &workspace_identity {
                    Some(existing) if existing != &record.identity.workspace_id => {
                        return Err(HostFailure::Initialization);
                    }
                    Some(_) => {}
                    None => workspace_identity = Some(record.identity.workspace_id.clone()),
                }
            }
            if let Some(workspace_id) = workspace_identity {
                workspaces.insert(workspace_id);
            }
        }
        Ok(workspaces)
    }

    fn stage_plugin_removal(&mut self, plugin_id: &str) -> Result<(), HostFailure> {
        self.ensure_available()?;
        validate_identity(plugin_id)?;
        let discovered = self.collect_plugin_workspaces(plugin_id)?;
        let mut tombstones = self.read_uninstall_tombstones()?;
        let existed = tombstones.plugins.contains_key(plugin_id);
        let entry = tombstones.plugins.entry(plugin_id.to_owned()).or_default();
        let before = entry.len();
        entry.extend(discovered);
        if existed && before == entry.len() {
            return Ok(());
        }
        self.commit_uninstall_tombstones(&tombstones)
    }

    fn cancel_plugin_removal(&mut self, plugin_id: &str) -> Result<(), HostFailure> {
        self.ensure_available()?;
        validate_identity(plugin_id)?;
        let mut tombstones = self.read_uninstall_tombstones()?;
        let changed = tombstones.plugins.remove(plugin_id).is_some();
        if changed {
            self.commit_uninstall_tombstones(&tombstones)?;
        }
        Ok(())
    }

    fn remove_plugin(&mut self, plugin_id: &str) -> Result<(), HostFailure> {
        // Idempotently establish the durable intent before the first delete,
        // and refresh the workspace set after the runtime has been stopped.
        self.stage_plugin_removal(plugin_id)?;
        let tombstones = self.read_uninstall_tombstones()?;
        let workspaces = tombstones
            .plugins
            .get(plugin_id)
            .cloned()
            .ok_or(HostFailure::Initialization)?;
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_plugin_purge) {
            return Err(HostFailure::Initialization);
        }
        self.purge_plugin_records(plugin_id, &workspaces)?;
        let mut tombstones = self.read_uninstall_tombstones()?;
        tombstones.plugins.remove(plugin_id);
        self.commit_uninstall_tombstones(&tombstones)
    }

    fn retry_uninstalled_plugin_removals(
        &mut self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), HostFailure> {
        self.ensure_available()?;
        for plugin_id in installed_plugin_ids {
            validate_identity(plugin_id)?;
        }
        let pending = self
            .read_uninstall_tombstones()?
            .plugins
            .keys()
            .filter(|plugin_id| !installed_plugin_ids.contains(*plugin_id))
            .cloned()
            .collect::<Vec<_>>();
        for plugin_id in pending {
            self.remove_plugin(&plugin_id)?;
        }
        Ok(())
    }

    fn ensure_plugin_not_tombstoned(&self, plugin_id: &str) -> Result<(), HostFailure> {
        if self
            .read_uninstall_tombstones()?
            .plugins
            .contains_key(plugin_id)
        {
            Err(HostFailure::Initialization)
        } else {
            Ok(())
        }
    }

    fn purge_plugin_records(
        &mut self,
        plugin_id: &str,
        workspace_ids: &BTreeSet<String>,
    ) -> Result<(), HostFailure> {
        let mut targets = Vec::new();
        for workspace_id in workspace_ids {
            validate_identity(workspace_id)?;
            let workspace_directory = self.root.join(stable_locator(workspace_id.as_bytes()));
            let plugin_directory = workspace_directory.join(stable_locator(plugin_id.as_bytes()));
            let metadata = match fs::symlink_metadata(&plugin_directory) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(HostFailure::Initialization),
            };
            ensure_private_directory_metadata(&metadata)?;
            let mut slots = Vec::new();
            for slot_directory in strict_directories(&plugin_directory)? {
                let state_path = slot_directory.join(STATE_FILE);
                let has_state = if let Some(record) = read_record_if_present(&state_path)? {
                    validate_plugin_record_location(
                        &record,
                        &workspace_directory,
                        &plugin_directory,
                        &slot_directory,
                        plugin_id,
                    )?;
                    if record.identity.workspace_id != *workspace_id {
                        return Err(HostFailure::Initialization);
                    }
                    ensure_slot_contains_only_state(&slot_directory)?;
                    true
                } else {
                    ensure_directory_empty(&slot_directory)?;
                    false
                };
                slots.push((slot_directory, state_path, has_state));
            }
            targets.push((workspace_directory, plugin_directory, slots));
        }

        for (workspace_directory, plugin_directory, slots) in targets {
            for (slot_directory, state_path, has_state) in slots {
                if has_state {
                    fs::remove_file(&state_path).map_err(|_| HostFailure::Initialization)?;
                    if sync_directory(&slot_directory).is_err() {
                        self.durability_uncertain = true;
                        return Err(HostFailure::Initialization);
                    }
                }
                remove_empty_directory(&slot_directory)?;
            }
            remove_empty_directory(&plugin_directory)?;
            if sync_directory(&workspace_directory).is_err() {
                self.durability_uncertain = true;
                return Err(HostFailure::Initialization);
            }
        }
        Ok(())
    }

    fn address(&self, key: &PluginStatePersistenceKey) -> Result<StateAddress, HostFailure> {
        validate_identity(&key.workspace_id)?;
        validate_identity(&key.plugin_id)?;
        let slot_identity = match (&key.artifact_slot, key.launch_mode) {
            (ArtifactSlot::Active, HostLaunchMode::Active) => "active".to_owned(),
            // Protocol-v2 update preflight is intentionally not a durable
            // state slot. The launcher remaps that read to Active/Active and
            // the gateway keeps candidate writes in memory.
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
        self.ensure_plugin_not_tombstoned(&key.plugin_id)?;
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
        self.ensure_plugin_not_tombstoned(&key.plugin_id)?;
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct UninstallTombstones {
    plugins: BTreeMap<String, BTreeSet<String>>,
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

fn validate_locator_name(value: &str) -> Result<(), HostFailure> {
    if value.len() == LOCATOR_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(HostFailure::Initialization)
    }
}

fn path_name(path: &Path) -> Result<&str, HostFailure> {
    path.file_name()
        .and_then(std::ffi::OsStr::to_str)
        .ok_or(HostFailure::Initialization)
}

fn validate_plugin_record_location(
    record: &PersistedRecord,
    workspace_directory: &Path,
    plugin_directory: &Path,
    slot_directory: &Path,
    expected_plugin_id: &str,
) -> Result<(), HostFailure> {
    let identity = &record.identity;
    let mode_matches_slot = match identity.launch_mode {
        HostLaunchMode::Active => identity.slot_identity == "active",
        HostLaunchMode::UpdatePreflight => identity
            .slot_identity
            .strip_prefix("prepared:")
            .is_some_and(|token| validate_identity(token).is_ok()),
    };
    if identity.plugin_id != expected_plugin_id
        || !mode_matches_slot
        || path_name(workspace_directory)? != stable_locator(identity.workspace_id.as_bytes())
        || path_name(plugin_directory)? != stable_locator(identity.plugin_id.as_bytes())
        || path_name(slot_directory)? != stable_locator(identity.slot_identity.as_bytes())
    {
        return Err(HostFailure::Initialization);
    }
    Ok(())
}

fn ensure_directory_empty(path: &Path) -> Result<(), HostFailure> {
    let mut entries = fs::read_dir(path).map_err(|_| HostFailure::Initialization)?;
    if entries
        .next()
        .transpose()
        .map_err(|_| HostFailure::Initialization)?
        .is_some()
    {
        Err(HostFailure::Initialization)
    } else {
        Ok(())
    }
}

fn ensure_slot_contains_only_state(path: &Path) -> Result<(), HostFailure> {
    let mut found_state = false;
    for entry in fs::read_dir(path).map_err(|_| HostFailure::Initialization)? {
        let entry = entry.map_err(|_| HostFailure::Initialization)?;
        if entry.file_name() != STATE_FILE || found_state {
            return Err(HostFailure::Initialization);
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| HostFailure::Initialization)?;
        ensure_private_file_metadata(&metadata)?;
        found_state = true;
    }
    if found_state {
        Ok(())
    } else {
        Err(HostFailure::Initialization)
    }
}

fn remove_empty_directory(path: &Path) -> Result<(), HostFailure> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(HostFailure::Initialization),
    }
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

fn encode_uninstall_tombstones(tombstones: &UninstallTombstones) -> Result<Vec<u8>, HostFailure> {
    if tombstones.plugins.len() > MAX_UNINSTALL_TOMBSTONES {
        return Err(HostFailure::Initialization);
    }
    let workspace_count = tombstones
        .plugins
        .values()
        .try_fold(0usize, |total, workspaces| {
            total.checked_add(workspaces.len())
        })
        .ok_or(HostFailure::Initialization)?;
    if workspace_count > MAX_UNINSTALL_WORKSPACES {
        return Err(HostFailure::Initialization);
    }
    let mut bytes = Vec::new();
    bytes.extend_from_slice(UNINSTALL_MAGIC);
    bytes.extend_from_slice(&UNINSTALL_VERSION.to_le_bytes());
    bytes.extend_from_slice(
        &u32::try_from(tombstones.plugins.len())
            .map_err(|_| HostFailure::Initialization)?
            .to_le_bytes(),
    );
    for (plugin_id, workspaces) in &tombstones.plugins {
        put_string(&mut bytes, plugin_id)?;
        bytes.extend_from_slice(
            &u32::try_from(workspaces.len())
                .map_err(|_| HostFailure::Initialization)?
                .to_le_bytes(),
        );
        for workspace_id in workspaces {
            put_string(&mut bytes, workspace_id)?;
        }
    }
    let checksum = CRC.checksum(&bytes);
    bytes.extend_from_slice(&checksum.to_le_bytes());
    if bytes.len() > MAX_UNINSTALL_TOMBSTONES_BYTES {
        return Err(HostFailure::Initialization);
    }
    Ok(bytes)
}

fn decode_uninstall_tombstones(bytes: &[u8]) -> Result<UninstallTombstones, HostFailure> {
    if bytes.len() < UNINSTALL_MAGIC.len() + 4 + 4 + 8
        || bytes.len() > MAX_UNINSTALL_TOMBSTONES_BYTES
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
    if cursor.take(UNINSTALL_MAGIC.len())? != UNINSTALL_MAGIC || cursor.u32()? != UNINSTALL_VERSION
    {
        return Err(HostFailure::Initialization);
    }
    let plugin_count = cursor.u32()? as usize;
    if plugin_count > MAX_UNINSTALL_TOMBSTONES {
        return Err(HostFailure::Initialization);
    }
    let mut plugins = BTreeMap::new();
    let mut workspace_count = 0usize;
    let mut previous_plugin: Option<String> = None;
    for _ in 0..plugin_count {
        let plugin_id = cursor.string()?;
        if previous_plugin
            .as_ref()
            .is_some_and(|previous| previous >= &plugin_id)
        {
            return Err(HostFailure::Initialization);
        }
        previous_plugin = Some(plugin_id.clone());
        let count = cursor.u32()? as usize;
        workspace_count = workspace_count
            .checked_add(count)
            .filter(|count| *count <= MAX_UNINSTALL_WORKSPACES)
            .ok_or(HostFailure::Initialization)?;
        let mut workspaces = BTreeSet::new();
        let mut previous_workspace: Option<String> = None;
        for _ in 0..count {
            let workspace_id = cursor.string()?;
            if previous_workspace
                .as_ref()
                .is_some_and(|previous| previous >= &workspace_id)
            {
                return Err(HostFailure::Initialization);
            }
            previous_workspace = Some(workspace_id.clone());
            workspaces.insert(workspace_id);
        }
        plugins.insert(plugin_id, workspaces);
    }
    if cursor.remaining() != 0 {
        return Err(HostFailure::Initialization);
    }
    Ok(UninstallTombstones { plugins })
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
    fn prepared_slots_are_rejected_without_changing_active_state() {
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
        assert_eq!(
            port.persist_state(
                &prepared,
                &PluginPersistedState {
                    plugin_storage: vec![2],
                    project_state: None,
                },
            ),
            Err(HostFailure::Initialization)
        );
        assert_eq!(port.load_plugin_storage(&active).unwrap(), Some(vec![1]));
        assert_eq!(
            port.load_plugin_storage(&prepared),
            Err(HostFailure::Initialization)
        );
    }

    #[test]
    fn plugin_removal_deletes_only_exact_records_across_workspaces_and_releases_quota() {
        let root = private_root();
        let shared = SharedNativePluginStatePersistencePort::open(root.path()).expect("port");
        shared
            .persist_scoped_storage("workspace-1", "dev.bbcom.target", "active", b"target-one")
            .unwrap();
        shared
            .persist_scoped_storage("workspace-2", "dev.bbcom.target", "active", b"target-two")
            .unwrap();
        shared
            .persist_scoped_storage("workspace-1", "dev.bbcom.other", "active", b"other")
            .unwrap();

        shared.stage_plugin_removal("dev.bbcom.target").unwrap();
        let mut reader = shared.clone();
        assert_eq!(
            reader.load_plugin_storage(&PluginStatePersistenceKey {
                plugin_id: "dev.bbcom.target".to_owned(),
                workspace_id: "workspace-1".to_owned(),
                artifact_slot: ArtifactSlot::Active,
                launch_mode: HostLaunchMode::Active,
            }),
            Err(HostFailure::Initialization)
        );

        shared.remove_plugin("dev.bbcom.target").unwrap();
        assert_eq!(
            reader.load_plugin_storage(&PluginStatePersistenceKey {
                plugin_id: "dev.bbcom.target".to_owned(),
                workspace_id: "workspace-1".to_owned(),
                artifact_slot: ArtifactSlot::Active,
                launch_mode: HostLaunchMode::Active,
            }),
            Ok(None)
        );
        assert_eq!(
            reader.load_plugin_storage(&PluginStatePersistenceKey {
                plugin_id: "dev.bbcom.target".to_owned(),
                workspace_id: "workspace-2".to_owned(),
                artifact_slot: ArtifactSlot::Active,
                launch_mode: HostLaunchMode::Active,
            }),
            Ok(None)
        );
        assert_eq!(
            reader.load_plugin_storage(&active_key("dev.bbcom.other")),
            Ok(Some(b"other".to_vec()))
        );
        assert_eq!(reader.workspace_total_bytes("workspace-1").unwrap(), 5);
        assert_eq!(reader.workspace_total_bytes("workspace-2").unwrap(), 0);
    }

    #[test]
    fn failed_artifact_uninstall_cancels_tombstone_and_restores_exact_state() {
        let root = private_root();
        let shared = SharedNativePluginStatePersistencePort::open(root.path()).expect("port");
        shared
            .persist_scoped_storage(
                "workspace-1",
                "dev.bbcom.fixture",
                "active",
                b"exact-old-state",
            )
            .unwrap();
        shared.stage_plugin_removal("dev.bbcom.fixture").unwrap();
        shared.cancel_plugin_removal("dev.bbcom.fixture").unwrap();

        let mut reader = shared.clone();
        assert_eq!(
            reader.load_plugin_storage(&active_key("dev.bbcom.fixture")),
            Ok(Some(b"exact-old-state".to_vec()))
        );
    }

    #[test]
    fn removal_rejects_a_hash_path_whose_authenticated_identity_does_not_match() {
        let root = private_root();
        let shared = SharedNativePluginStatePersistencePort::open(root.path()).expect("port");
        shared
            .persist_scoped_storage("workspace-1", "dev.bbcom.fixture", "active", b"old-state")
            .unwrap();
        shared.stage_plugin_removal("dev.bbcom.fixture").unwrap();
        let state_path = shared
            .inner
            .lock()
            .unwrap()
            .address(&active_key("dev.bbcom.fixture"))
            .unwrap()
            .path;
        let forged = encode_record(
            &StateIdentity {
                workspace_id: "workspace-1".to_owned(),
                plugin_id: "dev.bbcom.colliding-id".to_owned(),
                slot_identity: "active".to_owned(),
                launch_mode: HostLaunchMode::Active,
            },
            &PluginPersistedState {
                plugin_storage: b"must-survive-rejected-removal".to_vec(),
                project_state: None,
            },
        )
        .unwrap();
        fs::write(&state_path, forged).unwrap();

        assert_eq!(
            shared.remove_plugin("dev.bbcom.fixture"),
            Err(HostFailure::Initialization)
        );
        let retained = read_record_if_present(&state_path).unwrap().unwrap();
        assert_eq!(retained.identity.plugin_id, "dev.bbcom.colliding-id");
        assert_eq!(
            retained.state.plugin_storage,
            b"must-survive-rejected-removal"
        );
    }

    #[test]
    fn cleanup_failure_survives_restart_and_retries_when_artifact_is_absent() {
        let root = private_root();
        let shared = SharedNativePluginStatePersistencePort::open(root.path()).expect("port");
        shared
            .persist_scoped_storage("workspace-1", "dev.bbcom.fixture", "active", b"old-state")
            .unwrap();
        shared.stage_plugin_removal("dev.bbcom.fixture").unwrap();
        shared.fail_next_plugin_purge();
        assert_eq!(
            shared.remove_plugin("dev.bbcom.fixture"),
            Err(HostFailure::Initialization)
        );
        let mut blocked = shared.clone();
        assert_eq!(
            blocked.load_plugin_storage(&active_key("dev.bbcom.fixture")),
            Err(HostFailure::Initialization)
        );
        drop(blocked);
        drop(shared);

        let reopened = SharedNativePluginStatePersistencePort::open(root.path()).expect("reopen");
        reopened
            .retry_uninstalled_plugin_removals(&BTreeSet::new())
            .expect("retry cleanup for absent artifact");
        let mut reader = reopened.clone();
        assert_eq!(
            reader.load_plugin_storage(&active_key("dev.bbcom.fixture")),
            Ok(None)
        );
        assert_eq!(reader.workspace_total_bytes("workspace-1").unwrap(), 0);
    }

    #[test]
    fn ambiguous_restart_with_same_installed_id_stays_tombstoned_until_retry() {
        let root = private_root();
        let shared = SharedNativePluginStatePersistencePort::open(root.path()).expect("port");
        shared
            .persist_scoped_storage(
                "workspace-1",
                "dev.bbcom.fixture",
                "active",
                b"must-not-be-inherited",
            )
            .unwrap();
        shared.stage_plugin_removal("dev.bbcom.fixture").unwrap();
        drop(shared);

        let reopened = SharedNativePluginStatePersistencePort::open(root.path()).expect("reopen");
        reopened
            .retry_uninstalled_plugin_removals(&BTreeSet::from(["dev.bbcom.fixture".to_owned()]))
            .unwrap();
        let mut reader = reopened.clone();
        assert_eq!(
            reader.load_plugin_storage(&active_key("dev.bbcom.fixture")),
            Err(HostFailure::Initialization)
        );

        // Retrying the uninstall is the only automatic-free resolution for
        // this ambiguous crash window. It removes the old bytes before the ID
        // can be installed and launched again.
        reopened.remove_plugin("dev.bbcom.fixture").unwrap();
        assert_eq!(
            reader.load_plugin_storage(&active_key("dev.bbcom.fixture")),
            Ok(None)
        );
    }

    #[test]
    fn runtime_sink_rejects_repeated_prepared_writes_without_consuming_quota() {
        let root = private_root();
        let shared = SharedNativePluginStatePersistencePort::open(root.path()).expect("port");
        shared
            .persist_scoped_storage(
                "workspace-1",
                "dev.bbcom.fixture",
                "active",
                b"active-private",
            )
            .expect("seed active state");
        let mut quota_reader = shared.clone();
        let before = quota_reader
            .workspace_total_bytes("workspace-1")
            .expect("initial quota");

        for attempt in 0..16 {
            assert_eq!(
                shared.persist_scoped_storage(
                    "workspace-1",
                    "dev.bbcom.fixture",
                    &format!("prepared:failed-{attempt}"),
                    &[attempt as u8; 1024],
                ),
                Err(HostFailure::Initialization)
            );
        }

        assert_eq!(
            quota_reader
                .workspace_total_bytes("workspace-1")
                .expect("quota after failures"),
            before
        );
        assert_eq!(
            quota_reader
                .load_plugin_storage(&active_key("dev.bbcom.fixture"))
                .expect("active state remains readable"),
            Some(b"active-private".to_vec())
        );
    }
}
