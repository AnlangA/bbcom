use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use std::io::Cursor;

use bbcom_plugin_contracts::{
    MAX_PACKAGE_EXPANDED_BYTES, MAX_PACKAGE_FILES, PluginManifest, RepositoryPackage, Sha256Digest,
    generated_v2::Capability, parse_v2_capability, v2_capability_name,
};
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::archive::{INSTALL_MARKER_FILE, extract_and_verify};
use crate::{DownloadedPackage, LOCAL_INSTALL_ORIGIN, RepositoryError, Result};

pub const MAX_ROLLBACK_CANDIDATES: usize = 2;
pub const MAX_PLUGIN_DATA_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_PLUGIN_DATA_FILES: u32 = 4_096;

const INSTALL_STATE_SCHEMA: u32 = 1;
const INSTALL_STATE_FILE: &str = "install-state.json";
const ROLLBACK_JOURNAL_FILE: &str = "rollback-journal.json";
const ROLLBACK_DIRECTORY: &str = ".rollback";
const PREPARED_JOURNAL_FILE: &str = "prepared-installation.json";
const MAX_INSTALL_STATE_BYTES: u64 = 256 * 1024;
const MAX_MARKER_BYTES: u64 = 16 * 1024;
static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveInstallation {
    pub plugin_id: String,
    pub version: String,
    pub repository_origin: String,
    pub package_sha256: String,
    pub component_sha256: String,
    pub package_directory: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollbackCandidate {
    pub plugin_id: String,
    pub version: String,
    pub repository_origin: String,
    pub package_sha256: String,
    pub component_sha256: String,
    pub package_directory: PathBuf,
    pub data_snapshot_directory: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Activated {
        active: ActiveInstallation,
        previous_version: Option<String>,
    },
    AlreadyActive(ActiveInstallation),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollbackOutcome {
    pub active: ActiveInstallation,
    pub previous_version: String,
}

/// Repository-owned kind of a durable prepared installation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreparedInstallationKind {
    InitialInstall,
    ManualUpgrade,
    Rollback,
}

/// An opaque description of a verified package held by the repository.
///
/// This value deliberately contains no filesystem path. Native callers resolve
/// it through [`PluginInstaller::prepared_package_directory`], which re-reads
/// the repository journal before constructing a path below the private root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedPluginInstallation {
    token: String,
    plugin_id: String,
    version: String,
    package_sha256: String,
    component_sha256: String,
    repository_origin: String,
    requested_capabilities: BTreeSet<Capability>,
    kind: PreparedInstallationKind,
}

impl PreparedPluginInstallation {
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }

    #[must_use]
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    #[must_use]
    pub fn component_sha256(&self) -> &str {
        &self.component_sha256
    }

    #[must_use]
    pub fn repository_origin(&self) -> &str {
        &self.repository_origin
    }

    #[must_use]
    pub fn requested_capabilities(&self) -> &BTreeSet<Capability> {
        &self.requested_capabilities
    }

    #[must_use]
    pub const fn kind(&self) -> PreparedInstallationKind {
        self.kind
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedInstallationJournal {
    schema: u32,
    token: String,
    plugin_id: String,
    version: String,
    repository_origin: String,
    package_sha256: String,
    component_sha256: String,
    requested_capabilities: BTreeSet<String>,
    kind: PreparedInstallationKind,
    previous_version: Option<String>,
    has_data_snapshot: bool,
}

impl PreparedInstallationJournal {
    fn descriptor(&self) -> Result<PreparedPluginInstallation> {
        let requested_capabilities = self
            .requested_capabilities
            .iter()
            .map(|name| parse_v2_capability(name))
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        Ok(PreparedPluginInstallation {
            token: self.token.clone(),
            plugin_id: self.plugin_id.clone(),
            version: self.version.clone(),
            package_sha256: self.package_sha256.clone(),
            component_sha256: self.component_sha256.clone(),
            repository_origin: self.repository_origin.clone(),
            requested_capabilities,
            kind: self.kind,
        })
    }
}

#[derive(Debug)]
pub struct PluginInstaller {
    package_root: PathBuf,
    data_root: PathBuf,
    gate: Mutex<()>,
}

impl PluginInstaller {
    pub fn new(package_root: impl Into<PathBuf>, data_root: impl Into<PathBuf>) -> Result<Self> {
        let package_root = package_root.into();
        let data_root = data_root.into();
        ensure_safe_directory(&package_root)?;
        ensure_safe_directory(&data_root)?;
        ensure_safe_directory(&package_root.join("plugins"))?;
        ensure_safe_directory(&package_root.join(".staging"))?;
        Ok(Self {
            package_root,
            data_root,
            gate: Mutex::new(()),
        })
    }

    /// Development-mode local install: builds a package from a local package
    /// directory (plugin.toml + its declared component), enforces the
    /// manifest's component digest, and stages it through the exact same
    /// prepared-installation pipeline as repository packages. No HTTPS, TUF,
    /// or publisher-signature boundary is involved — the caller must only
    /// pass user-selected local paths.
    pub fn prepare_local_install(&self, package_root: &Path) -> Result<PreparedPluginInstallation> {
        let download = build_local_package(package_root)?;
        self.prepare_install(&download)
    }

    /// Every durable active installation below the package root, for restart
    /// discovery. Corrupt or partial states are skipped, never fatal.
    pub fn active_installations(&self) -> Vec<ActiveInstallation> {
        let plugins_root = self.package_root.join("plugins");
        let Ok(entries) = fs::read_dir(&plugins_root) else {
            return Vec::new();
        };
        let mut active = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(plugin_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_plugin_id(&plugin_id).is_err() {
                continue;
            }
            let plugin_root = self.plugin_root(&plugin_id);
            let Ok(state) = self.load_recovered_state(&plugin_root, &plugin_id) else {
                continue;
            };
            if let Ok(Some(record)) = state.active_record() {
                active.push(to_active(&plugin_root, &state, record));
            }
        }
        active.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
        active
    }

    /// Removes one plugin's durable installation entirely: active version,
    /// verified history, snapshots, and private data copies. Stopping hosts
    /// and clearing grants/state remains the caller's responsibility.
    pub fn remove_installation(&self, plugin_id: &str) -> Result<()> {
        validate_plugin_id(plugin_id)?;
        let plugin_root = self.plugin_root(plugin_id);
        if !plugin_root.exists() {
            return Ok(());
        }
        // Package files are deliberately read-only; clear before removal.
        clear_read_only_tree(&plugin_root);
        fs::remove_dir_all(&plugin_root).map_err(|_| RepositoryError::CorruptInstallState)?;
        sync_directory(&self.package_root.join("plugins"))?;
        Ok(())
    }

    /// Verifies and durably stages a downloaded package without changing the
    /// active installation. The returned token is allocated by this installer;
    /// callers cannot select or inject a staging path.
    pub fn prepare_install(
        &self,
        download: &DownloadedPackage,
    ) -> Result<PreparedPluginInstallation> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        validate_plugin_id(download.plugin_id())?;
        let new_version = Version::parse(&download.package().version)
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        let plugin_root = self.plugin_root(download.plugin_id());
        prepare_plugin_directories(&plugin_root)?;
        let state = self.load_recovered_state(&plugin_root, download.plugin_id())?;
        let (kind, previous_version) = match state.active_record()? {
            Some(active) => {
                let active_version = Version::parse(&active.version)
                    .map_err(|_| RepositoryError::CorruptInstallState)?;
                if new_version == active_version {
                    return if active.package_sha256 == download.package().sha256 {
                        Err(RepositoryError::AlreadyPreparedOrActive)
                    } else {
                        Err(RepositoryError::VersionDigestConflict)
                    };
                }
                if new_version <= active_version
                    || state
                        .verified
                        .iter()
                        .any(|record| record.version == download.package().version)
                {
                    return Err(RepositoryError::NotANewerVersion);
                }
                (
                    PreparedInstallationKind::ManualUpgrade,
                    Some(active.version.clone()),
                )
            }
            None => (PreparedInstallationKind::InitialInstall, None),
        };

        let staging = StagingDirectory::create(&self.package_root.join(".staging"))?;
        let staged_package = staging.path.join("package");
        fs::create_dir(&staged_package)?;
        let verified = extract_and_verify(download, &staged_package)?;
        let requested_capabilities = manifest_capabilities(&verified.manifest)?;
        let has_data_snapshot = previous_version.is_some()
            && self
                .stage_plugin_data(download.plugin_id(), &staging)?
                .is_some();
        let marker = InstallMarker {
            schema: INSTALL_STATE_SCHEMA,
            plugin_id: download.plugin_id().to_owned(),
            version: download.package().version.clone(),
            package_sha256: download.package().sha256.clone(),
        };
        write_json_atomic(&staged_package.join(INSTALL_MARKER_FILE), &marker)?;
        let journal = PreparedInstallationJournal {
            schema: INSTALL_STATE_SCHEMA,
            token: staging.token.clone(),
            plugin_id: download.plugin_id().to_owned(),
            version: download.package().version.clone(),
            repository_origin: download.repository_origin().to_owned(),
            package_sha256: download.package().sha256.clone(),
            component_sha256: verified.manifest.component.sha256.clone(),
            requested_capabilities: capability_names(&requested_capabilities),
            kind,
            previous_version,
            has_data_snapshot,
        };
        validate_prepared_journal(&journal)?;
        sync_directory(&staged_package)?;
        write_json_atomic(&staging.path.join(PREPARED_JOURNAL_FILE), &journal)?;
        sync_directory(&self.package_root.join(".staging"))?;
        let descriptor = journal.descriptor()?;
        staging.persist();
        Ok(descriptor)
    }

    /// Creates a private preflight copy of the newest eligible rollback
    /// package. Activation remains a separate explicit commit.
    pub fn prepare_rollback(
        &self,
        plugin_id: &str,
        current_version: &str,
    ) -> Result<Option<PreparedPluginInstallation>> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        validate_plugin_id(plugin_id)?;
        Version::parse(current_version).map_err(|_| RepositoryError::RollbackUnavailable)?;
        let plugin_root = self.plugin_root(plugin_id);
        prepare_plugin_directories(&plugin_root)?;
        let state = self.load_recovered_state(&plugin_root, plugin_id)?;
        if state.active_version.as_deref() != Some(current_version) {
            return Err(RepositoryError::RollbackUnavailable);
        }
        let Some(target) = state
            .verified
            .iter()
            .filter(|record| record.version != current_version)
            .take(MAX_ROLLBACK_CANDIDATES)
            .next()
        else {
            return Ok(None);
        };
        validate_version_directory(&plugin_root, plugin_id, target)?;
        let source = plugin_root.join("versions").join(&target.version);
        let staging = StagingDirectory::create(&self.package_root.join(".staging"))?;
        let staged_package = staging.path.join("package");
        copy_package_tree(&source, &staged_package)?;
        let manifest = load_package_manifest(&staged_package)?;
        if manifest.id != plugin_id || manifest.version != target.version {
            return Err(RepositoryError::CorruptInstallState);
        }
        let requested_capabilities = manifest_capabilities(&manifest)?;
        let journal = PreparedInstallationJournal {
            schema: INSTALL_STATE_SCHEMA,
            token: staging.token.clone(),
            plugin_id: plugin_id.to_owned(),
            version: target.version.clone(),
            repository_origin: target.repository_origin.clone(),
            package_sha256: target.package_sha256.clone(),
            component_sha256: manifest.component.sha256.clone(),
            requested_capabilities: capability_names(&requested_capabilities),
            kind: PreparedInstallationKind::Rollback,
            previous_version: Some(current_version.to_owned()),
            has_data_snapshot: target.data_snapshot_token.is_some(),
        };
        validate_prepared_journal(&journal)?;
        write_json_atomic(&staging.path.join(PREPARED_JOURNAL_FILE), &journal)?;
        sync_directory(&self.package_root.join(".staging"))?;
        let descriptor = journal.descriptor()?;
        staging.persist();
        Ok(Some(descriptor))
    }

    /// Reloads a prepared descriptor by repository-issued token.
    pub fn prepared_installation(&self, token: &str) -> Result<PreparedPluginInstallation> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        self.load_prepared_journal(token)?.descriptor()
    }

    /// Resolves a verified prepared package. All path components come from the
    /// validated journal and are matched against the supplied descriptor.
    pub fn prepared_package_directory(
        &self,
        prepared: &PreparedPluginInstallation,
    ) -> Result<PathBuf> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        let journal = self.load_prepared_journal(prepared.token())?;
        if journal.descriptor()? != *prepared {
            return Err(RepositoryError::PreparedDescriptorMismatch);
        }
        let package = self.prepared_root(&journal.token).join("package");
        validate_existing_version(
            &package,
            &InstallMarker {
                schema: INSTALL_STATE_SCHEMA,
                plugin_id: journal.plugin_id,
                version: journal.version,
                package_sha256: journal.package_sha256,
            },
        )?;
        Ok(package)
    }

    /// Resolves an active package only after matching it to durable install
    /// state. A caller-supplied version can never select an arbitrary path.
    pub fn active_package_directory(&self, plugin_id: &str, version: &str) -> Result<PathBuf> {
        let active = self
            .active_installation(plugin_id)?
            .ok_or(RepositoryError::PackageNotFound)?;
        if active.version != version {
            return Err(RepositoryError::PackageNotFound);
        }
        Ok(active.package_directory)
    }

    /// Atomically activates an exact prepared descriptor. Repeating commit
    /// after a process interruption is idempotent: durable state determines
    /// whether activation must be completed or only staging cleanup remains.
    pub fn commit_prepared(
        &self,
        prepared: &PreparedPluginInstallation,
    ) -> Result<ActiveInstallation> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        let journal = self.load_prepared_journal(prepared.token())?;
        if journal.descriptor()? != *prepared {
            return Err(RepositoryError::PreparedDescriptorMismatch);
        }
        let active = match journal.kind {
            PreparedInstallationKind::InitialInstall | PreparedInstallationKind::ManualUpgrade => {
                self.commit_prepared_install(&journal)?
            }
            PreparedInstallationKind::Rollback => {
                let plugin_root = self.plugin_root(&journal.plugin_id);
                let state = self.load_recovered_state(&plugin_root, &journal.plugin_id)?;
                if state.active_version.as_deref() == Some(journal.version.as_str()) {
                    let record = state
                        .active_record()?
                        .ok_or(RepositoryError::CorruptInstallState)?;
                    if record.package_sha256 != journal.package_sha256 {
                        return Err(RepositoryError::PreparedDescriptorMismatch);
                    }
                    to_active(&plugin_root, &state, record)
                } else {
                    self.activate_rollback_locked(&journal.plugin_id, &journal.version)?
                        .active
                }
            }
        };
        // Activation is already durable. Cleanup cannot be allowed to turn a
        // successful commit into a retry that no longer has a staging token.
        let _ = self.remove_prepared(&journal.token);
        Ok(active)
    }

    /// Discards an exact prepared descriptor. Missing staging is treated as an
    /// already completed discard, while a reused token with different metadata
    /// is always rejected.
    pub fn discard_prepared(&self, prepared: &PreparedPluginInstallation) -> Result<()> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        let root = self.prepared_root(prepared.token());
        if !root.exists() {
            return Ok(());
        }
        let journal = self.load_prepared_journal(prepared.token())?;
        if journal.descriptor()? != *prepared {
            return Err(RepositoryError::PreparedDescriptorMismatch);
        }
        self.remove_prepared(&journal.token)
    }

    pub fn install(&self, download: &DownloadedPackage) -> Result<InstallOutcome> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        validate_plugin_id(download.plugin_id())?;
        let new_version = Version::parse(&download.package().version)
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        let plugin_root = self.plugin_root(download.plugin_id());
        prepare_plugin_directories(&plugin_root)?;
        let mut state = self.load_recovered_state(&plugin_root, download.plugin_id())?;

        if let Some(active) = state.active_record()? {
            let active_version = Version::parse(&active.version)
                .map_err(|_| RepositoryError::CorruptInstallState)?;
            if active_version == new_version {
                if active.package_sha256 != download.package().sha256 {
                    return Err(RepositoryError::VersionDigestConflict);
                }
                return Ok(InstallOutcome::AlreadyActive(to_active(
                    &plugin_root,
                    &state,
                    active,
                )));
            }
            if new_version <= active_version {
                return Err(RepositoryError::NotANewerVersion);
            }
            if state
                .verified
                .iter()
                .any(|record| record.version == download.package().version)
            {
                return Err(RepositoryError::NotANewerVersion);
            }
        }

        let staging = StagingDirectory::create(&self.package_root.join(".staging"))?;
        let staged_package = staging.path.join("package");
        fs::create_dir(&staged_package)?;
        let verified = extract_and_verify(download, &staged_package)?;
        debug_assert_eq!(verified.manifest.id, download.plugin_id());

        let previous_version = state.active_version.clone();
        let snapshot_token = if previous_version.is_some() {
            self.stage_plugin_data(download.plugin_id(), &staging)?
        } else {
            None
        };

        let marker = InstallMarker {
            schema: INSTALL_STATE_SCHEMA,
            plugin_id: download.plugin_id().to_owned(),
            version: download.package().version.clone(),
            package_sha256: download.package().sha256.clone(),
        };
        write_json_atomic(&staged_package.join(INSTALL_MARKER_FILE), &marker)?;

        let final_version_directory = plugin_root
            .join("versions")
            .join(&download.package().version);
        if final_version_directory.exists() {
            validate_existing_version(&final_version_directory, &marker)?;
        } else {
            fs::rename(&staged_package, &final_version_directory)?;
            sync_directory(&plugin_root.join("versions"))?;
        }

        let snapshot_token = if let Some(token) = snapshot_token {
            let staged_snapshot = staging.path.join("data-before-upgrade");
            let final_snapshot = plugin_root.join("snapshots").join(&token);
            if final_snapshot.exists() {
                return Err(RepositoryError::CorruptInstallState);
            }
            fs::rename(staged_snapshot, final_snapshot)?;
            sync_directory(&plugin_root.join("snapshots"))?;
            Some(token)
        } else {
            None
        };

        if let Some(previous) = previous_version.as_deref()
            && let Some(record) = state
                .verified
                .iter_mut()
                .find(|record| record.version == previous)
        {
            record.data_snapshot_token = snapshot_token;
        }

        let record = VerifiedVersion {
            version: download.package().version.clone(),
            package_sha256: download.package().sha256.clone(),
            component_sha256: verified.manifest.component.sha256.clone(),
            repository_origin: download.repository_origin().to_owned(),
            sequence: state.next_sequence,
            data_snapshot_token: None,
        };
        state.next_sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or(RepositoryError::CorruptInstallState)?;
        state.verified.insert(0, record);
        state.active_version = Some(download.package().version.clone());
        state
            .verified
            .truncate(MAX_ROLLBACK_CANDIDATES.saturating_add(1));
        validate_state(&state, download.plugin_id())?;
        write_json_atomic(&plugin_root.join(INSTALL_STATE_FILE), &state)?;

        let active_record = state
            .active_record()?
            .ok_or(RepositoryError::CorruptInstallState)?;
        Ok(InstallOutcome::Activated {
            active: to_active(&plugin_root, &state, active_record),
            previous_version,
        })
    }

    pub fn active_installation(&self, plugin_id: &str) -> Result<Option<ActiveInstallation>> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        validate_plugin_id(plugin_id)?;
        let plugin_root = self.plugin_root(plugin_id);
        prepare_plugin_directories(&plugin_root)?;
        let state = self.load_recovered_state(&plugin_root, plugin_id)?;
        state
            .active_record()?
            .map(|record| {
                validate_version_directory(&plugin_root, plugin_id, record)?;
                Ok(to_active(&plugin_root, &state, record))
            })
            .transpose()
    }

    pub fn rollback_candidates(&self, plugin_id: &str) -> Result<Vec<RollbackCandidate>> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        validate_plugin_id(plugin_id)?;
        let plugin_root = self.plugin_root(plugin_id);
        prepare_plugin_directories(&plugin_root)?;
        let state = self.load_recovered_state(&plugin_root, plugin_id)?;
        let active = state.active_version.as_deref();
        state
            .verified
            .iter()
            .filter(|record| Some(record.version.as_str()) != active)
            .take(MAX_ROLLBACK_CANDIDATES)
            .map(|record| {
                validate_version_directory(&plugin_root, plugin_id, record)?;
                let data_snapshot_directory = record
                    .data_snapshot_token
                    .as_deref()
                    .map(|token| plugin_root.join("snapshots").join(token));
                if data_snapshot_directory
                    .as_ref()
                    .is_some_and(|path| !is_safe_directory(path))
                {
                    return Err(RepositoryError::CorruptInstallState);
                }
                Ok(RollbackCandidate {
                    plugin_id: plugin_id.to_owned(),
                    version: record.version.clone(),
                    repository_origin: record.repository_origin.clone(),
                    package_sha256: record.package_sha256.clone(),
                    component_sha256: record.component_sha256.clone(),
                    package_directory: plugin_root.join("versions").join(&record.version),
                    data_snapshot_directory,
                })
            })
            .collect()
    }

    /// Atomically selects a verified rollback package and restores the data
    /// snapshot captured when that package was last active.
    ///
    /// The package pointer and live data directory are protected by a durable
    /// journal. If the process stops between their two filesystem commits, the
    /// next operation for this plugin completes or reverses the transaction
    /// from the atomically-written install state; it never guesses from a
    /// caller-provided path.
    pub fn activate_rollback(
        &self,
        plugin_id: &str,
        target_version: &str,
    ) -> Result<RollbackOutcome> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| RepositoryError::CorruptInstallState)?;
        self.activate_rollback_locked(plugin_id, target_version)
    }

    fn activate_rollback_locked(
        &self,
        plugin_id: &str,
        target_version: &str,
    ) -> Result<RollbackOutcome> {
        validate_plugin_id(plugin_id)?;
        Version::parse(target_version).map_err(|_| RepositoryError::RollbackUnavailable)?;
        let plugin_root = self.plugin_root(plugin_id);
        prepare_plugin_directories(&plugin_root)?;
        let mut state = self.load_recovered_state(&plugin_root, plugin_id)?;
        let previous_version = state
            .active_version
            .clone()
            .ok_or(RepositoryError::RollbackUnavailable)?;
        if previous_version == target_version {
            return Err(RepositoryError::RollbackUnavailable);
        }

        let target_index = state
            .verified
            .iter()
            .enumerate()
            .filter(|(_, record)| record.version != previous_version)
            .take(MAX_ROLLBACK_CANDIDATES)
            .find_map(|(index, record)| (record.version == target_version).then_some(index))
            .ok_or(RepositoryError::RollbackUnavailable)?;
        validate_version_directory(&plugin_root, plugin_id, &state.verified[target_index])?;

        let target_snapshot = state.verified[target_index]
            .data_snapshot_token
            .as_deref()
            .map(|token| plugin_root.join("snapshots").join(token));
        if target_snapshot
            .as_ref()
            .is_some_and(|path| !is_safe_directory(path))
        {
            return Err(RepositoryError::CorruptInstallState);
        }

        let transaction =
            RollbackDataTransaction::prepare(&self.data_root, target_snapshot.as_deref())?;
        let current_snapshot_token = match self.snapshot_current_data_for_rollback(
            plugin_id,
            &plugin_root,
            &transaction.token,
        ) {
            Ok(token) => token,
            Err(error) => {
                let _ = fs::remove_dir_all(&transaction.directory);
                return Err(error);
            }
        };
        let journal = RollbackJournal {
            schema: INSTALL_STATE_SCHEMA,
            plugin_id: plugin_id.to_owned(),
            previous_version: previous_version.clone(),
            target_version: target_version.to_owned(),
            transaction_token: transaction.token.clone(),
            current_snapshot_token: current_snapshot_token.clone(),
        };
        if let Err(error) = write_json_atomic(&plugin_root.join(ROLLBACK_JOURNAL_FILE), &journal) {
            remove_optional_snapshot(&plugin_root, current_snapshot_token.as_deref());
            let _ = fs::remove_dir_all(&transaction.directory);
            return Err(error);
        }

        let previous_state = state.clone();
        if let Some(previous) = state
            .verified
            .iter_mut()
            .find(|record| record.version == previous_version)
        {
            previous.data_snapshot_token = current_snapshot_token;
        } else {
            let _ = recover_rollback(&plugin_root, &self.data_root, plugin_id, &previous_state);
            return Err(RepositoryError::CorruptInstallState);
        }
        state.active_version = Some(target_version.to_owned());
        if let Err(error) = validate_state(&state, plugin_id) {
            let _ = recover_rollback(&plugin_root, &self.data_root, plugin_id, &previous_state);
            return Err(error);
        }
        if let Err(error) = transaction.activate(&self.data_root, plugin_id) {
            let _ = recover_rollback(&plugin_root, &self.data_root, plugin_id, &previous_state);
            return Err(error);
        }
        if let Err(error) = write_json_atomic(&plugin_root.join(INSTALL_STATE_FILE), &state) {
            let _ = recover_rollback(&plugin_root, &self.data_root, plugin_id, &previous_state);
            return Err(error);
        }

        // Activation is already committed. Cleanup is deliberately best-effort:
        // a leftover journal is safe and will be finalized on the next call.
        let _ = finalize_rollback(&plugin_root, &self.data_root, &journal);
        let active_record = state
            .active_record()?
            .ok_or(RepositoryError::CorruptInstallState)?;
        Ok(RollbackOutcome {
            active: to_active(&plugin_root, &state, active_record),
            previous_version,
        })
    }

    fn load_recovered_state(&self, plugin_root: &Path, plugin_id: &str) -> Result<InstallState> {
        let state = load_state(plugin_root, plugin_id)?;
        recover_rollback(plugin_root, &self.data_root, plugin_id, &state)?;
        load_state(plugin_root, plugin_id)
    }

    fn snapshot_current_data_for_rollback(
        &self,
        plugin_id: &str,
        plugin_root: &Path,
        token: &str,
    ) -> Result<Option<String>> {
        let source = self.data_root.join(plugin_id);
        if !source.exists() {
            return Ok(None);
        }
        if !is_safe_directory(&source) {
            return Err(RepositoryError::UnsafeFilesystemRoot);
        }
        let destination = plugin_root.join("snapshots").join(token);
        if destination.exists() {
            return Err(RepositoryError::CorruptInstallState);
        }
        copy_data_tree(&source, &destination)?;
        sync_directory(&plugin_root.join("snapshots"))?;
        Ok(Some(token.to_owned()))
    }

    fn plugin_root(&self, plugin_id: &str) -> PathBuf {
        self.package_root.join("plugins").join(plugin_id)
    }

    fn stage_plugin_data(
        &self,
        plugin_id: &str,
        staging: &StagingDirectory,
    ) -> Result<Option<String>> {
        let source = self.data_root.join(plugin_id);
        if !source.exists() {
            return Ok(None);
        }
        let destination = staging.path.join("data-before-upgrade");
        copy_data_tree(&source, &destination)?;
        Ok(Some(staging.token.clone()))
    }

    fn commit_prepared_install(
        &self,
        journal: &PreparedInstallationJournal,
    ) -> Result<ActiveInstallation> {
        let plugin_root = self.plugin_root(&journal.plugin_id);
        prepare_plugin_directories(&plugin_root)?;
        let mut state = self.load_recovered_state(&plugin_root, &journal.plugin_id)?;
        if state.active_version.as_deref() == Some(journal.version.as_str()) {
            let record = state
                .active_record()?
                .ok_or(RepositoryError::CorruptInstallState)?;
            if record.package_sha256 != journal.package_sha256 {
                return Err(RepositoryError::PreparedDescriptorMismatch);
            }
            validate_version_directory(&plugin_root, &journal.plugin_id, record)?;
            return Ok(to_active(&plugin_root, &state, record));
        }
        if state.active_version != journal.previous_version {
            return Err(RepositoryError::PreparedStateChanged);
        }
        match journal.kind {
            PreparedInstallationKind::InitialInstall if state.active_version.is_some() => {
                return Err(RepositoryError::PreparedStateChanged);
            }
            PreparedInstallationKind::ManualUpgrade => {}
            PreparedInstallationKind::InitialInstall => {}
            PreparedInstallationKind::Rollback => {
                return Err(RepositoryError::PreparedDescriptorMismatch);
            }
        }

        let staging = self.prepared_root(&journal.token);
        let staged_package = staging.join("package");
        let marker = InstallMarker {
            schema: INSTALL_STATE_SCHEMA,
            plugin_id: journal.plugin_id.clone(),
            version: journal.version.clone(),
            package_sha256: journal.package_sha256.clone(),
        };
        let final_version_directory = plugin_root.join("versions").join(&journal.version);
        if final_version_directory.exists() {
            validate_existing_version(&final_version_directory, &marker)?;
        } else {
            validate_existing_version(&staged_package, &marker)?;
            fs::rename(&staged_package, &final_version_directory)?;
            sync_directory(&plugin_root.join("versions"))?;
        }

        let snapshot_token = if journal.has_data_snapshot {
            let staged_snapshot = staging.join("data-before-upgrade");
            let final_snapshot = plugin_root.join("snapshots").join(&journal.token);
            if final_snapshot.exists() {
                if !is_safe_directory(&final_snapshot) {
                    return Err(RepositoryError::CorruptInstallState);
                }
            } else {
                if !is_safe_directory(&staged_snapshot) {
                    return Err(RepositoryError::CorruptInstallState);
                }
                fs::rename(staged_snapshot, &final_snapshot)?;
                sync_directory(&plugin_root.join("snapshots"))?;
            }
            Some(journal.token.clone())
        } else {
            None
        };
        if let Some(previous_version) = journal.previous_version.as_deref() {
            let previous = state
                .verified
                .iter_mut()
                .find(|record| record.version == previous_version)
                .ok_or(RepositoryError::CorruptInstallState)?;
            previous.data_snapshot_token = snapshot_token;
        }
        if state
            .verified
            .iter()
            .any(|record| record.version == journal.version)
        {
            return Err(RepositoryError::PreparedStateChanged);
        }
        state.verified.insert(
            0,
            VerifiedVersion {
                version: journal.version.clone(),
                package_sha256: journal.package_sha256.clone(),
                component_sha256: journal.component_sha256.clone(),
                repository_origin: journal.repository_origin.clone(),
                sequence: state.next_sequence,
                data_snapshot_token: None,
            },
        );
        state.next_sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or(RepositoryError::CorruptInstallState)?;
        state.active_version = Some(journal.version.clone());
        state
            .verified
            .truncate(MAX_ROLLBACK_CANDIDATES.saturating_add(1));
        validate_state(&state, &journal.plugin_id)?;
        write_json_atomic(&plugin_root.join(INSTALL_STATE_FILE), &state)?;
        let record = state
            .active_record()?
            .ok_or(RepositoryError::CorruptInstallState)?;
        Ok(to_active(&plugin_root, &state, record))
    }

    fn load_prepared_journal(&self, token: &str) -> Result<PreparedInstallationJournal> {
        if !valid_staging_token(token) {
            return Err(RepositoryError::PreparedTokenInvalid);
        }
        let root = self.prepared_root(token);
        if !is_safe_directory(&root) {
            return Err(RepositoryError::PreparedInstallationUnavailable);
        }
        let bytes = read_bounded(&root.join(PREPARED_JOURNAL_FILE), MAX_INSTALL_STATE_BYTES)
            .map_err(|_| RepositoryError::PreparedInstallationUnavailable)?;
        let journal: PreparedInstallationJournal = serde_json::from_slice(&bytes)
            .map_err(|_| RepositoryError::PreparedInstallationUnavailable)?;
        validate_prepared_journal(&journal)?;
        if journal.token != token {
            return Err(RepositoryError::PreparedDescriptorMismatch);
        }
        let staged_package = root.join("package");
        let final_package = self
            .plugin_root(&journal.plugin_id)
            .join("versions")
            .join(&journal.version);
        let package = if staged_package.exists() {
            staged_package
        } else if final_package.exists() {
            final_package
        } else {
            return Err(RepositoryError::PreparedInstallationUnavailable);
        };
        validate_existing_version(
            &package,
            &InstallMarker {
                schema: INSTALL_STATE_SCHEMA,
                plugin_id: journal.plugin_id.clone(),
                version: journal.version.clone(),
                package_sha256: journal.package_sha256.clone(),
            },
        )
        .map_err(|_| RepositoryError::PreparedInstallationUnavailable)?;
        let manifest = load_package_manifest(&package)
            .map_err(|_| RepositoryError::PreparedInstallationUnavailable)?;
        let capabilities = manifest_capabilities(&manifest)
            .map_err(|_| RepositoryError::PreparedInstallationUnavailable)?;
        if manifest.id != journal.plugin_id
            || manifest.version != journal.version
            || capability_names(&capabilities) != journal.requested_capabilities
        {
            return Err(RepositoryError::PreparedDescriptorMismatch);
        }
        Ok(journal)
    }

    fn prepared_root(&self, token: &str) -> PathBuf {
        self.package_root.join(".staging").join(token)
    }

    fn remove_prepared(&self, token: &str) -> Result<()> {
        if !valid_staging_token(token) {
            return Err(RepositoryError::PreparedTokenInvalid);
        }
        let root = self.prepared_root(token);
        if root.exists() {
            if !is_safe_directory(&root) {
                return Err(RepositoryError::PreparedInstallationUnavailable);
            }
            fs::remove_dir_all(root)?;
            sync_directory(&self.package_root.join(".staging"))?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RollbackJournal {
    schema: u32,
    plugin_id: String,
    previous_version: String,
    target_version: String,
    transaction_token: String,
    current_snapshot_token: Option<String>,
}

#[derive(Debug)]
struct RollbackDataTransaction {
    token: String,
    directory: PathBuf,
}

impl RollbackDataTransaction {
    fn prepare(data_root: &Path, snapshot: Option<&Path>) -> Result<Self> {
        let rollback_root = data_root.join(ROLLBACK_DIRECTORY);
        ensure_safe_directory(&rollback_root)?;
        let staging = StagingDirectory::create(&rollback_root)?;
        let path = staging.path.clone();
        let token = staging.token.clone();
        let next = path.join("next");
        match snapshot {
            Some(source) => copy_data_tree(source, &next)?,
            None => fs::create_dir(&next)?,
        }
        sync_directory(&path)?;
        // Ownership moves to the durable journal rather than the staging Drop.
        staging.persist();
        Ok(Self {
            token,
            directory: path,
        })
    }

    fn activate(&self, data_root: &Path, plugin_id: &str) -> Result<()> {
        let active = data_root.join(plugin_id);
        let next = self.directory.join("next");
        let previous = self.directory.join("previous");
        if !is_safe_directory(&self.directory) || !is_safe_directory(&next) || previous.exists() {
            return Err(RepositoryError::RollbackRecoveryRequired);
        }
        if active.exists() {
            if !is_safe_directory(&active) {
                return Err(RepositoryError::UnsafeFilesystemRoot);
            }
            fs::rename(&active, &previous)?;
        }
        if let Err(error) = fs::rename(&next, &active) {
            if previous.exists() {
                let _ = fs::rename(&previous, &active);
            }
            return Err(error.into());
        }
        sync_directory(data_root)?;
        sync_directory(&self.directory)?;
        Ok(())
    }
}

fn recover_rollback(
    plugin_root: &Path,
    data_root: &Path,
    plugin_id: &str,
    state: &InstallState,
) -> Result<()> {
    let journal_path = plugin_root.join(ROLLBACK_JOURNAL_FILE);
    if !journal_path.exists() {
        return Ok(());
    }
    let bytes = read_bounded(&journal_path, MAX_INSTALL_STATE_BYTES)
        .map_err(|_| RepositoryError::RollbackRecoveryRequired)?;
    let journal: RollbackJournal =
        serde_json::from_slice(&bytes).map_err(|_| RepositoryError::RollbackRecoveryRequired)?;
    if journal.schema != INSTALL_STATE_SCHEMA
        || journal.plugin_id != plugin_id
        || !valid_staging_token(&journal.transaction_token)
        || journal
            .current_snapshot_token
            .as_deref()
            .is_some_and(|token| token != journal.transaction_token)
        || Version::parse(&journal.previous_version).is_err()
        || Version::parse(&journal.target_version).is_err()
    {
        return Err(RepositoryError::RollbackRecoveryRequired);
    }
    match state.active_version.as_deref() {
        Some(version) if version == journal.target_version => {
            let active = data_root.join(plugin_id);
            if !is_safe_directory(&active) {
                return Err(RepositoryError::RollbackRecoveryRequired);
            }
            finalize_rollback(plugin_root, data_root, &journal)
        }
        Some(version) if version == journal.previous_version => {
            reverse_rollback(plugin_root, data_root, plugin_id, &journal)
        }
        _ => Err(RepositoryError::RollbackRecoveryRequired),
    }
}

fn reverse_rollback(
    plugin_root: &Path,
    data_root: &Path,
    plugin_id: &str,
    journal: &RollbackJournal,
) -> Result<()> {
    let transaction = rollback_transaction_directory(data_root, &journal.transaction_token)?;
    let active = data_root.join(plugin_id);
    let next = transaction.join("next");
    let previous = transaction.join("previous");
    if previous.exists() {
        if !is_safe_directory(&previous) {
            return Err(RepositoryError::RollbackRecoveryRequired);
        }
        if active.exists() {
            if !is_safe_directory(&active) {
                return Err(RepositoryError::RollbackRecoveryRequired);
            }
            fs::remove_dir_all(&active)?;
        }
        fs::rename(&previous, &active)?;
    } else if !next.exists() && active.exists() {
        // No previous live data existed and `next` was already activated.
        if !is_safe_directory(&active) {
            return Err(RepositoryError::RollbackRecoveryRequired);
        }
        fs::remove_dir_all(&active)?;
    }
    sync_directory(data_root)?;
    remove_optional_snapshot(plugin_root, journal.current_snapshot_token.as_deref());
    remove_transaction_and_journal(plugin_root, &transaction)
}

fn finalize_rollback(
    plugin_root: &Path,
    data_root: &Path,
    journal: &RollbackJournal,
) -> Result<()> {
    let transaction = rollback_transaction_directory(data_root, &journal.transaction_token)?;
    remove_transaction_and_journal(plugin_root, &transaction)
}

fn rollback_transaction_directory(data_root: &Path, token: &str) -> Result<PathBuf> {
    if !valid_staging_token(token) {
        return Err(RepositoryError::RollbackRecoveryRequired);
    }
    let rollback_root = data_root.join(ROLLBACK_DIRECTORY);
    if !is_safe_directory(&rollback_root) {
        return Err(RepositoryError::RollbackRecoveryRequired);
    }
    let transaction = rollback_root.join(token);
    if !is_safe_directory(&transaction) {
        return Err(RepositoryError::RollbackRecoveryRequired);
    }
    Ok(transaction)
}

fn remove_transaction_and_journal(plugin_root: &Path, transaction: &Path) -> Result<()> {
    if !is_safe_directory(transaction) {
        return Err(RepositoryError::RollbackRecoveryRequired);
    }
    let journal = plugin_root.join(ROLLBACK_JOURNAL_FILE);
    if journal.exists() {
        let metadata = fs::symlink_metadata(&journal)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RepositoryError::RollbackRecoveryRequired);
        }
        fs::remove_file(journal)?;
    }
    sync_directory(plugin_root)?;
    fs::remove_dir_all(transaction)?;
    Ok(())
}

fn remove_optional_snapshot(plugin_root: &Path, token: Option<&str>) {
    let Some(token) = token else {
        return;
    };
    if !valid_staging_token(token) {
        return;
    }
    let snapshot = plugin_root.join("snapshots").join(token);
    if is_safe_directory(&snapshot) {
        let _ = fs::remove_dir_all(snapshot);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallState {
    schema: u32,
    plugin_id: String,
    next_sequence: u64,
    active_version: Option<String>,
    verified: Vec<VerifiedVersion>,
}

impl InstallState {
    fn empty(plugin_id: &str) -> Self {
        Self {
            schema: INSTALL_STATE_SCHEMA,
            plugin_id: plugin_id.to_owned(),
            next_sequence: 1,
            active_version: None,
            verified: Vec::new(),
        }
    }

    fn active_record(&self) -> Result<Option<&VerifiedVersion>> {
        let Some(active) = self.active_version.as_deref() else {
            return Ok(None);
        };
        self.verified
            .iter()
            .find(|record| record.version == active)
            .map(Some)
            .ok_or(RepositoryError::CorruptInstallState)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifiedVersion {
    version: String,
    package_sha256: String,
    #[serde(default)]
    component_sha256: String,
    repository_origin: String,
    sequence: u64,
    data_snapshot_token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallMarker {
    schema: u32,
    plugin_id: String,
    version: String,
    package_sha256: String,
}

#[derive(Debug)]
struct StagingDirectory {
    path: PathBuf,
    token: String,
    persisted: bool,
}

impl StagingDirectory {
    fn create(root: &Path) -> Result<Self> {
        ensure_safe_directory(root)?;
        for _ in 0..32 {
            let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let token = format!("{}-{nanos}-{sequence}", std::process::id());
            let path = root.join(&token);
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        token,
                        persisted: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(RepositoryError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not allocate staging directory",
        )))
    }

    fn persist(mut self) {
        self.persisted = true;
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if !self.persisted {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn prepare_plugin_directories(plugin_root: &Path) -> Result<()> {
    ensure_safe_directory(plugin_root)?;
    ensure_safe_directory(&plugin_root.join("versions"))?;
    ensure_safe_directory(&plugin_root.join("snapshots"))?;
    Ok(())
}

fn ensure_safe_directory(path: &Path) -> Result<()> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(RepositoryError::UnsafeFilesystemRoot);
        }
    } else {
        fs::create_dir_all(path)?;
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(RepositoryError::UnsafeFilesystemRoot);
        }
    }
    Ok(())
}

fn is_safe_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn load_state(plugin_root: &Path, plugin_id: &str) -> Result<InstallState> {
    let path = plugin_root.join(INSTALL_STATE_FILE);
    if !path.exists() {
        return Ok(InstallState::empty(plugin_id));
    }
    let bytes = read_bounded(&path, MAX_INSTALL_STATE_BYTES)
        .map_err(|_| RepositoryError::CorruptInstallState)?;
    let state: InstallState =
        serde_json::from_slice(&bytes).map_err(|_| RepositoryError::CorruptInstallState)?;
    validate_state(&state, plugin_id)?;
    Ok(state)
}

fn validate_state(state: &InstallState, plugin_id: &str) -> Result<()> {
    if state.schema != INSTALL_STATE_SCHEMA
        || state.plugin_id != plugin_id
        || state.next_sequence == 0
        || state.verified.len() > MAX_ROLLBACK_CANDIDATES + 1
        || (state.active_version.is_none() && !state.verified.is_empty())
    {
        return Err(RepositoryError::CorruptInstallState);
    }
    let mut versions = BTreeSet::new();
    let mut sequences = BTreeSet::new();
    for record in &state.verified {
        Version::parse(&record.version).map_err(|_| RepositoryError::CorruptInstallState)?;
        if !versions.insert(record.version.as_str())
            || !sequences.insert(record.sequence)
            || record.sequence >= state.next_sequence
            || record.repository_origin.is_empty()
            || !is_sha256(&record.package_sha256)
            || (!record.component_sha256.is_empty() && !is_sha256(&record.component_sha256))
            || record
                .data_snapshot_token
                .as_deref()
                .is_some_and(|token| !valid_staging_token(token))
        {
            return Err(RepositoryError::CorruptInstallState);
        }
    }
    if state.active_record()?.is_none() && state.active_version.is_some() {
        return Err(RepositoryError::CorruptInstallState);
    }
    Ok(())
}

fn validate_prepared_journal(journal: &PreparedInstallationJournal) -> Result<()> {
    validate_plugin_id(&journal.plugin_id)?;
    if journal.schema != INSTALL_STATE_SCHEMA
        || !valid_staging_token(&journal.token)
        || Version::parse(&journal.version).is_err()
        || journal.repository_origin.is_empty()
        || !is_sha256(&journal.package_sha256)
        || !is_sha256(&journal.component_sha256)
        || !valid_journal_capabilities(journal)
        || journal
            .previous_version
            .as_deref()
            .is_some_and(|version| Version::parse(version).is_err())
        || matches!(journal.kind, PreparedInstallationKind::InitialInstall)
            && journal.previous_version.is_some()
        || matches!(
            journal.kind,
            PreparedInstallationKind::ManualUpgrade | PreparedInstallationKind::Rollback
        ) && journal.previous_version.is_none()
    {
        return Err(RepositoryError::PreparedInstallationUnavailable);
    }
    Ok(())
}

fn manifest_capabilities(manifest: &PluginManifest) -> Result<BTreeSet<Capability>> {
    Ok(manifest.v2_capabilities()?.into_iter().collect())
}

fn capability_names(capabilities: &BTreeSet<Capability>) -> BTreeSet<String> {
    capabilities
        .iter()
        .copied()
        .map(v2_capability_name)
        .map(str::to_owned)
        .collect()
}

fn valid_journal_capabilities(journal: &PreparedInstallationJournal) -> bool {
    journal.requested_capabilities.len() <= 12
        && journal
            .requested_capabilities
            .iter()
            .all(|name| parse_v2_capability(name).is_ok() && !name.is_empty())
}

fn load_package_manifest(package_directory: &Path) -> Result<PluginManifest> {
    if !is_safe_directory(package_directory) {
        return Err(RepositoryError::PreparedInstallationUnavailable);
    }
    let bytes = read_bounded(
        &package_directory.join(crate::archive::MANIFEST_FILE),
        crate::archive::MAX_MANIFEST_BYTES,
    )
    .map_err(|_| RepositoryError::ManifestUnavailable)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| RepositoryError::ManifestUnavailable)?;
    PluginManifest::parse(text).map_err(Into::into)
}

fn validate_existing_version(path: &Path, expected: &InstallMarker) -> Result<()> {
    if !is_safe_directory(path) {
        return Err(RepositoryError::VersionDigestConflict);
    }
    let bytes = read_bounded(&path.join(INSTALL_MARKER_FILE), MAX_MARKER_BYTES)
        .map_err(|_| RepositoryError::VersionDigestConflict)?;
    let marker: InstallMarker =
        serde_json::from_slice(&bytes).map_err(|_| RepositoryError::VersionDigestConflict)?;
    if marker.schema != expected.schema
        || marker.plugin_id != expected.plugin_id
        || marker.version != expected.version
        || marker.package_sha256 != expected.package_sha256
    {
        return Err(RepositoryError::VersionDigestConflict);
    }
    Ok(())
}

fn validate_version_directory(
    plugin_root: &Path,
    plugin_id: &str,
    record: &VerifiedVersion,
) -> Result<()> {
    validate_existing_version(
        &plugin_root.join("versions").join(&record.version),
        &InstallMarker {
            schema: INSTALL_STATE_SCHEMA,
            plugin_id: plugin_id.to_owned(),
            version: record.version.clone(),
            package_sha256: record.package_sha256.clone(),
        },
    )
    .map_err(|_| RepositoryError::CorruptInstallState)
}

/// Builds a `DownloadedPackage` from a local package directory. The
/// manifest's component digest is the integrity boundary in local mode.
fn build_local_package(package_root: &Path) -> Result<DownloadedPackage> {
    use std::io::Read as _;

    let manifest_path = package_root.join("plugin.toml");
    let metadata =
        fs::symlink_metadata(&manifest_path).map_err(|_| RepositoryError::ManifestUnavailable)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(RepositoryError::ManifestUnavailable);
    }
    let manifest_text =
        fs::read_to_string(&manifest_path).map_err(|_| RepositoryError::ManifestUnavailable)?;
    let manifest = PluginManifest::parse(&manifest_text)?;

    let component_relative = Path::new(&manifest.component.path);
    if component_relative.is_absolute()
        || component_relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(RepositoryError::ManifestMismatch("component.path"));
    }
    let component_path = package_root.join(component_relative);
    let component_metadata =
        fs::symlink_metadata(&component_path).map_err(|_| RepositoryError::PackageNotFound)?;
    if !component_metadata.is_file() {
        return Err(RepositoryError::PackageNotFound);
    }
    let mut component = Vec::new();
    File::open(&component_path)
        .and_then(|mut file| file.read_to_end(&mut component))
        .map_err(|_| RepositoryError::PackageNotFound)?;
    if component.len() > MAX_PACKAGE_EXPANDED_BYTES as usize {
        return Err(RepositoryError::ResponseTooLarge {
            limit: MAX_PACKAGE_EXPANDED_BYTES,
        });
    }
    let expected = Sha256Digest::parse_hex(&manifest.component.sha256, "component.sha256")?;
    if !expected.verifies(&component) {
        return Err(RepositoryError::PackageDigestMismatch);
    }

    // Deterministic archive: manifest first, then directories and component.
    let parent = component_relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let mut directories: Vec<String> = Vec::new();
    if let Some(parent) = parent {
        let mut prefix = String::new();
        for component in parent.components() {
            let Some(part) = component.as_os_str().to_str() else {
                return Err(RepositoryError::ManifestMismatch("component.path"));
            };
            prefix.push_str(part);
            prefix.push('/');
            directories.push(prefix.clone());
        }
    }

    let mut cursor = Cursor::new(Vec::new());
    {
        use zip::ZipWriter;
        use zip::write::SimpleFileOptions;
        let mut archive = ZipWriter::new(&mut cursor);
        let file_options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let dir_options = SimpleFileOptions::default().unix_permissions(0o755);
        for directory in &directories {
            archive
                .add_directory(directory.clone(), dir_options)
                .map_err(|_| RepositoryError::InvalidArchive("write"))?;
        }
        archive
            .start_file("plugin.toml", file_options)
            .map_err(|_| RepositoryError::InvalidArchive("write"))?;
        archive
            .write_all(manifest_text.as_bytes())
            .map_err(|_| RepositoryError::InvalidArchive("write"))?;
        archive
            .start_file(
                component_relative
                    .to_str()
                    .ok_or(RepositoryError::ManifestMismatch("component.path"))?,
                file_options,
            )
            .map_err(|_| RepositoryError::InvalidArchive("write"))?;
        archive
            .write_all(&component)
            .map_err(|_| RepositoryError::InvalidArchive("write"))?;
        archive
            .finish()
            .map_err(|_| RepositoryError::InvalidArchive("write"))?;
    }
    let bytes = cursor.into_inner();
    let digest = Sha256Digest::calculate(&bytes);
    let package = RepositoryPackage {
        version: manifest.version.clone(),
        url: format!("{LOCAL_INSTALL_ORIGIN}/packages/{}.zip", manifest.id),
        sha256: hex(digest.as_bytes()),
        download_bytes: bytes.len() as u64,
        expanded_bytes: component.len() as u64 + manifest_text.len() as u64,
        files: 2,
    };
    DownloadedPackage::from_local_package(manifest.id.clone(), package, bytes)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn clear_read_only_tree(root: &Path) {
    fn visit(path: &Path) {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return;
        };
        if metadata.is_dir() {
            let _ = fs::read_dir(path).map(|entries| {
                for entry in entries.flatten() {
                    visit(&entry.path());
                }
            });
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = match fs::metadata(path) {
                Ok(meta) => meta.permissions(),
                Err(_) => return,
            };
            permissions.set_mode(permissions.mode() | 0o200);
            let _ = fs::set_permissions(path, permissions);
        }
    }
    visit(root);
}

fn to_active(
    plugin_root: &Path,
    state: &InstallState,
    record: &VerifiedVersion,
) -> ActiveInstallation {
    ActiveInstallation {
        plugin_id: state.plugin_id.clone(),
        version: record.version.clone(),
        repository_origin: record.repository_origin.clone(),
        package_sha256: record.package_sha256.clone(),
        component_sha256: record.component_sha256.clone(),
        package_directory: plugin_root.join("versions").join(&record.version),
    }
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(RepositoryError::StateEncoding)?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(&bytes)?;
    file.commit()?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    // Atomic rename is still used on Windows. Opening a directory for flush
    // requires platform-specific flags supplied by the eventual launcher.
    Ok(())
}

fn copy_data_tree(source: &Path, destination: &Path) -> Result<()> {
    copy_tree_bounded(
        source,
        destination,
        MAX_PLUGIN_DATA_FILES,
        MAX_PLUGIN_DATA_BYTES,
    )
}

fn copy_package_tree(source: &Path, destination: &Path) -> Result<()> {
    copy_tree_bounded(
        source,
        destination,
        MAX_PACKAGE_FILES.saturating_add(1),
        MAX_PACKAGE_EXPANDED_BYTES.saturating_add(MAX_MARKER_BYTES),
    )
}

fn copy_tree_bounded(
    source: &Path,
    destination: &Path,
    max_files: u32,
    max_bytes: u64,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RepositoryError::UnsafeFilesystemRoot);
    }
    fs::create_dir(destination)?;
    let mut directories = vec![(source.to_owned(), destination.to_owned())];
    let mut files = 0_u32;
    let mut bytes = 0_u64;
    while let Some((source_directory, destination_directory)) = directories.pop() {
        for entry in fs::read_dir(source_directory)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                return Err(RepositoryError::UnsafeFilesystemRoot);
            }
            let target = destination_directory.join(entry.file_name());
            if metadata.is_dir() {
                fs::create_dir(&target)?;
                directories.push((entry.path(), target));
            } else if metadata.is_file() {
                files = files
                    .checked_add(1)
                    .ok_or(RepositoryError::PluginDataLimitExceeded)?;
                bytes = bytes
                    .checked_add(metadata.len())
                    .ok_or(RepositoryError::PluginDataLimitExceeded)?;
                if files > max_files || bytes > max_bytes {
                    return Err(RepositoryError::PluginDataLimitExceeded);
                }
                copy_regular_file(&entry.path(), &target, metadata.len())?;
            } else {
                return Err(RepositoryError::UnsafeFilesystemRoot);
            }
        }
        sync_directory(&destination_directory)?;
    }
    Ok(())
}

fn copy_regular_file(source: &Path, destination: &Path, expected_len: u64) -> Result<()> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copied = std::io::copy(&mut input, &mut output)?;
    if copied != expected_len {
        return Err(RepositoryError::Io(std::io::Error::other(
            "plugin data changed during snapshot",
        )));
    }
    output.sync_all()?;
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(std::io::Error::other("file limit exceeded"));
    }
    Ok(bytes)
}

fn validate_plugin_id(value: &str) -> Result<()> {
    if value.len() < 3
        || value.len() > 128
        || value.starts_with('.')
        || value.ends_with('.')
        || !value.contains('.')
        || value.split('.').any(|part| {
            part.is_empty()
                || !part.bytes().enumerate().all(|(index, byte)| match byte {
                    b'a'..=b'z' | b'0'..=b'9' => true,
                    b'-' => index > 0 && index + 1 < part.len(),
                    _ => false,
                })
        })
    {
        return Err(RepositoryError::CorruptInstallState);
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_staging_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
}
