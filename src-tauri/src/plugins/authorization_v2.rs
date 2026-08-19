//! Durable capability consent for `bbcom:plugin@2`.
//!
//! The store is native-only. It records the exact sorted capability baseline
//! for a plugin identity; artifact version/digest changes are metadata and do
//! not trigger consent unless the requested set expands.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bbcom_contracts::{PluginAuthorizationRequestV2, PluginCapabilityV2};
use bbcom_plugin_contracts::generated_v2::Capability;
use bbcom_plugin_host::{AuthorizationRequest, PluginAuthorizationGate};
use serde::{Deserialize, Serialize};

const AUTHORIZATION_SCHEMA: u32 = 1;
const MAX_AUTHORIZATION_BYTES: u64 = 1024 * 1024;
const MAX_PLUGIN_ID_BYTES: usize = 128;
const DIGEST_HEX_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginAuthorizationError {
    Invalid,
    Missing,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginAuthorizationDecision {
    Granted,
    ConfirmationRequired {
        requested: BTreeSet<PluginCapabilityV2>,
        added: BTreeSet<PluginCapabilityV2>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginAuthorizationResolutionV2 {
    Approve,
    Reject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArtifactPresentation {
    display_name: String,
    development_source: bool,
}

/// Process-owned pending-consent state shared by the launch gate and plugin
/// center. A request is replaced only by a newer exact artifact request for
/// the same plugin; renderer decisions must echo every immutable field.
#[derive(Default)]
pub struct PluginAuthorizationCoordinatorV2 {
    pending: Mutex<BTreeMap<String, PluginAuthorizationRequestV2>>,
    presentation: Mutex<BTreeMap<String, ArtifactPresentation>>,
}

impl PluginAuthorizationCoordinatorV2 {
    /// Supplies trusted catalog/source presentation before a launch attempt.
    /// Missing metadata safely falls back to the plugin id and a non-dev badge.
    pub fn set_artifact_presentation(
        &self,
        plugin_id: &str,
        display_name: &str,
        development_source: bool,
    ) -> Result<(), PluginAuthorizationError> {
        validate_plugin_id(plugin_id)?;
        if display_name.is_empty()
            || display_name.len() > 256
            || display_name.chars().any(char::is_control)
        {
            return Err(PluginAuthorizationError::Invalid);
        }
        self.presentation
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .insert(
                plugin_id.to_owned(),
                ArtifactPresentation {
                    display_name: display_name.to_owned(),
                    development_source,
                },
            );
        Ok(())
    }

    #[must_use]
    pub fn requests(&self) -> Vec<PluginAuthorizationRequestV2> {
        self.pending
            .lock()
            .map(|pending| pending.values().cloned().collect())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn request(&self, plugin_id: &str) -> Option<PluginAuthorizationRequestV2> {
        self.pending
            .lock()
            .ok()
            .and_then(|pending| pending.get(plugin_id).cloned())
    }

    fn register(
        &self,
        request: &AuthorizationRequest,
        requested: BTreeSet<PluginCapabilityV2>,
        added: BTreeSet<PluginCapabilityV2>,
    ) -> Result<(), PluginAuthorizationError> {
        let presentation = self
            .presentation
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .get(&request.plugin_id)
            .cloned()
            .unwrap_or_else(|| ArtifactPresentation {
                display_name: request.plugin_id.clone(),
                development_source: false,
            });
        self.pending
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .insert(
                request.plugin_id.clone(),
                PluginAuthorizationRequestV2 {
                    plugin_id: request.plugin_id.clone(),
                    display_name: presentation.display_name,
                    version: request.plugin_version.clone(),
                    digest_sha256: request.component_sha256.clone(),
                    development_source: presentation.development_source,
                    requested_capabilities: requested.into_iter().collect(),
                    added_capabilities: added.into_iter().collect(),
                },
            );
        Ok(())
    }

    pub fn resolve(
        &self,
        store: &NativePluginAuthorizationStore,
        echoed: &PluginAuthorizationRequestV2,
        resolution: PluginAuthorizationResolutionV2,
    ) -> Result<(), PluginAuthorizationError> {
        let current = self
            .pending
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .get(&echoed.plugin_id)
            .cloned()
            .ok_or(PluginAuthorizationError::Missing)?;
        if &current != echoed {
            return Err(PluginAuthorizationError::Invalid);
        }
        if resolution == PluginAuthorizationResolutionV2::Approve {
            store.confirm(
                &current.plugin_id,
                &current.version,
                &current.digest_sha256,
                current.development_source,
                current.requested_capabilities.iter().copied(),
            )?;
        }
        self.pending
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .remove(&current.plugin_id);
        Ok(())
    }

    /// Uninstall clears both presentation and any stale prompt. Durable
    /// consent is removed separately by the store in the same operation.
    pub fn remove_plugin(&self, plugin_id: &str) -> Result<(), PluginAuthorizationError> {
        validate_plugin_id(plugin_id)?;
        self.pending
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .remove(plugin_id);
        self.presentation
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .remove(plugin_id);
        Ok(())
    }
}

/// Host launch gate backed by durable, exact capability receipts.
///
/// It runs before Wasmtime parses component bytes. A missing or expanded
/// grant records a renderer-facing request and returns false; a non-expanding
/// update refreshes the receipt metadata without another prompt.
pub struct NativePluginAuthorizationGateV2 {
    store: Arc<NativePluginAuthorizationStore>,
    coordinator: Arc<PluginAuthorizationCoordinatorV2>,
}

impl NativePluginAuthorizationGateV2 {
    #[must_use]
    pub fn new(
        store: Arc<NativePluginAuthorizationStore>,
        coordinator: Arc<PluginAuthorizationCoordinatorV2>,
    ) -> Self {
        Self { store, coordinator }
    }
}

impl PluginAuthorizationGate for NativePluginAuthorizationGateV2 {
    fn authorize(&self, request: &AuthorizationRequest) -> bool {
        let requested = match request
            .capabilities
            .iter()
            .copied()
            .map(contract_capability)
            .collect::<Result<BTreeSet<_>, _>>()
        {
            Ok(requested) => requested,
            Err(()) => return false,
        };
        match self
            .store
            .evaluate(&request.plugin_id, requested.iter().copied())
        {
            Ok(PluginAuthorizationDecision::Granted) => self
                .store
                .accept_non_expanding_update(
                    &request.plugin_id,
                    &request.plugin_version,
                    &request.component_sha256,
                    self.coordinator
                        .presentation
                        .lock()
                        .ok()
                        .and_then(|presentation| {
                            presentation
                                .get(&request.plugin_id)
                                .map(|value| value.development_source)
                        })
                        .unwrap_or(false),
                    requested,
                )
                .is_ok(),
            Ok(PluginAuthorizationDecision::ConfirmationRequired { requested, added }) => {
                let _ = self.coordinator.register(request, requested, added);
                false
            }
            Err(_) => false,
        }
    }
}

fn contract_capability(capability: Capability) -> Result<PluginCapabilityV2, ()> {
    Ok(match capability {
        Capability::UiWorkspace => PluginCapabilityV2::UiWorkspace,
        Capability::UiDetachedWindow => PluginCapabilityV2::UiDetachedWindow,
        Capability::SerialPortsRead => PluginCapabilityV2::SerialPortsRead,
        Capability::SerialSessionsManage => PluginCapabilityV2::SerialSessionsManage,
        Capability::SerialIo => PluginCapabilityV2::SerialIo,
        Capability::SerialControlLines => PluginCapabilityV2::SerialControlLines,
        Capability::SessionCaptureRead => PluginCapabilityV2::SessionCaptureRead,
        Capability::SessionCommandsReadWrite => PluginCapabilityV2::SessionCommandsReadWrite,
        Capability::FileOpenRead => PluginCapabilityV2::FileOpenRead,
        Capability::FileSaveWrite => PluginCapabilityV2::FileSaveWrite,
        Capability::PluginStorage => PluginCapabilityV2::PluginStorage,
        Capability::ProjectStateReadWrite => PluginCapabilityV2::ProjectStateReadWrite,
        Capability::Unspecified => return Err(()),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizationFile {
    schema: u32,
    grants: BTreeMap<String, AuthorizationRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizationRecord {
    capabilities: BTreeSet<PluginCapabilityV2>,
    version: String,
    digest_sha256: String,
    development_source: bool,
}

/// Process-owned capability receipt store. All writes validate and durably
/// replace the complete bounded file before updating memory.
pub struct NativePluginAuthorizationStore {
    path: PathBuf,
    file: Mutex<AuthorizationFile>,
    /// Exact receipts removed before an irreversible uninstall. Holding this
    /// entry also prevents a concurrent approval from recreating consent while
    /// package/contribution removal is in flight. It is intentionally
    /// process-local: after a crash, the durable receipt remains absent and a
    /// later reinstall must ask again.
    uninstall_revocations: Mutex<BTreeMap<String, Option<AuthorizationRecord>>>,
}

impl NativePluginAuthorizationStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, PluginAuthorizationError> {
        let path = path.into();
        let parent = path.parent().ok_or(PluginAuthorizationError::Invalid)?;
        fs::create_dir_all(parent).map_err(|_| PluginAuthorizationError::Io)?;
        let file = load(&path)?;
        validate_file(&file)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
            uninstall_revocations: Mutex::new(BTreeMap::new()),
        })
    }

    /// Read-only preflight used before enabling or starting a plugin.
    pub fn evaluate(
        &self,
        plugin_id: &str,
        requested: impl IntoIterator<Item = PluginCapabilityV2>,
    ) -> Result<PluginAuthorizationDecision, PluginAuthorizationError> {
        validate_plugin_id(plugin_id)?;
        let requested = requested.into_iter().collect::<BTreeSet<_>>();
        let revocations = self
            .uninstall_revocations
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?;
        if revocations.contains_key(plugin_id) {
            return Err(PluginAuthorizationError::Invalid);
        }
        let file = self.file.lock().map_err(|_| PluginAuthorizationError::Io)?;
        let Some(record) = file.grants.get(plugin_id) else {
            return Ok(PluginAuthorizationDecision::ConfirmationRequired {
                added: requested.clone(),
                requested,
            });
        };
        let added = requested
            .difference(&record.capabilities)
            .copied()
            .collect::<BTreeSet<_>>();
        if added.is_empty() {
            Ok(PluginAuthorizationDecision::Granted)
        } else {
            Ok(PluginAuthorizationDecision::ConfirmationRequired { requested, added })
        }
    }

    /// Commit an explicit user confirmation. The receipt replaces, rather
    /// than unions with, the previous baseline so removed capabilities cannot
    /// be silently reintroduced by a later version.
    pub fn confirm(
        &self,
        plugin_id: &str,
        version: &str,
        digest_sha256: &str,
        development_source: bool,
        capabilities: impl IntoIterator<Item = PluginCapabilityV2>,
    ) -> Result<(), PluginAuthorizationError> {
        validate_artifact(plugin_id, version, digest_sha256)?;
        let record = AuthorizationRecord {
            capabilities: capabilities.into_iter().collect(),
            version: version.to_owned(),
            digest_sha256: digest_sha256.to_ascii_lowercase(),
            development_source,
        };
        self.commit_unless_revoking(plugin_id, |file| {
            file.grants.insert(plugin_id.to_owned(), record);
            Ok(())
        })
    }

    /// Record a version/digest change that does not expand capabilities. This
    /// also shrinks the stored baseline when a plugin drops a capability.
    pub fn accept_non_expanding_update(
        &self,
        plugin_id: &str,
        version: &str,
        digest_sha256: &str,
        development_source: bool,
        capabilities: impl IntoIterator<Item = PluginCapabilityV2>,
    ) -> Result<(), PluginAuthorizationError> {
        validate_artifact(plugin_id, version, digest_sha256)?;
        let requested = capabilities.into_iter().collect::<BTreeSet<_>>();
        let decision = self.evaluate(plugin_id, requested.iter().copied())?;
        if !matches!(decision, PluginAuthorizationDecision::Granted) {
            return Err(PluginAuthorizationError::Invalid);
        }
        self.commit_unless_revoking(plugin_id, |file| {
            let record = file
                .grants
                .get_mut(plugin_id)
                .ok_or(PluginAuthorizationError::Missing)?;
            record.capabilities = requested;
            record.version = version.to_owned();
            record.digest_sha256 = digest_sha256.to_ascii_lowercase();
            record.development_source = development_source;
            Ok(())
        })
    }

    /// Uninstall revokes consent. Disable intentionally does not call this.
    pub fn remove(&self, plugin_id: &str) -> Result<(), PluginAuthorizationError> {
        self.revoke_for_uninstall(plugin_id)?;
        self.finish_uninstall(plugin_id)
    }

    /// Durably removes a receipt before package removal and retains its exact
    /// in-memory value for compensation if the downstream uninstall fails.
    pub fn revoke_for_uninstall(&self, plugin_id: &str) -> Result<(), PluginAuthorizationError> {
        validate_plugin_id(plugin_id)?;
        let mut revocations = self
            .uninstall_revocations
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?;
        if revocations.contains_key(plugin_id) {
            return Err(PluginAuthorizationError::Invalid);
        }
        let mut file = self.file.lock().map_err(|_| PluginAuthorizationError::Io)?;
        let receipt = file.grants.get(plugin_id).cloned();
        let mut candidate = file.clone();
        candidate.grants.remove(plugin_id);
        persist(&self.path, &candidate)?;
        *file = candidate;
        revocations.insert(plugin_id.to_owned(), receipt);
        Ok(())
    }

    /// Restores the exact pre-uninstall receipt after a reversible downstream
    /// failure. If persistence fails, the revocation guard remains installed
    /// and the durable store remains fail-closed without reusable consent.
    pub fn restore_after_failed_uninstall(
        &self,
        plugin_id: &str,
    ) -> Result<(), PluginAuthorizationError> {
        validate_plugin_id(plugin_id)?;
        let mut revocations = self
            .uninstall_revocations
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?;
        let receipt = revocations
            .get(plugin_id)
            .cloned()
            .ok_or(PluginAuthorizationError::Missing)?;
        let mut file = self.file.lock().map_err(|_| PluginAuthorizationError::Io)?;
        let mut candidate = file.clone();
        if let Some(receipt) = receipt {
            candidate.grants.insert(plugin_id.to_owned(), receipt);
        } else {
            candidate.grants.remove(plugin_id);
        }
        persist(&self.path, &candidate)?;
        *file = candidate;
        revocations.remove(plugin_id);
        Ok(())
    }

    /// Completes an uninstall after the artifact is gone. The receipt was
    /// already durably deleted by [`Self::revoke_for_uninstall`].
    pub fn finish_uninstall(&self, plugin_id: &str) -> Result<(), PluginAuthorizationError> {
        validate_plugin_id(plugin_id)?;
        self.uninstall_revocations
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .remove(plugin_id)
            .ok_or(PluginAuthorizationError::Missing)?;
        Ok(())
    }

    #[cfg(test)]
    fn capabilities(
        &self,
        plugin_id: &str,
    ) -> Result<Option<BTreeSet<PluginCapabilityV2>>, PluginAuthorizationError> {
        Ok(self
            .file
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?
            .grants
            .get(plugin_id)
            .map(|record| record.capabilities.clone()))
    }

    fn commit<F>(&self, mutate: F) -> Result<(), PluginAuthorizationError>
    where
        F: FnOnce(&mut AuthorizationFile) -> Result<(), PluginAuthorizationError>,
    {
        let mut file = self.file.lock().map_err(|_| PluginAuthorizationError::Io)?;
        let mut candidate = file.clone();
        mutate(&mut candidate)?;
        persist(&self.path, &candidate)?;
        *file = candidate;
        Ok(())
    }

    fn commit_unless_revoking<F>(
        &self,
        plugin_id: &str,
        mutate: F,
    ) -> Result<(), PluginAuthorizationError>
    where
        F: FnOnce(&mut AuthorizationFile) -> Result<(), PluginAuthorizationError>,
    {
        let revocations = self
            .uninstall_revocations
            .lock()
            .map_err(|_| PluginAuthorizationError::Io)?;
        if revocations.contains_key(plugin_id) {
            return Err(PluginAuthorizationError::Invalid);
        }
        self.commit(mutate)
    }
}

fn load(path: &Path) -> Result<AuthorizationFile, PluginAuthorizationError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AuthorizationFile {
                schema: AUTHORIZATION_SCHEMA,
                grants: BTreeMap::new(),
            });
        }
        Err(_) => return Err(PluginAuthorizationError::Io),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_AUTHORIZATION_BYTES
    {
        return Err(PluginAuthorizationError::Invalid);
    }
    let bytes = fs::read(path).map_err(|_| PluginAuthorizationError::Io)?;
    serde_json::from_slice(&bytes).map_err(|_| PluginAuthorizationError::Invalid)
}

fn persist(path: &Path, file: &AuthorizationFile) -> Result<(), PluginAuthorizationError> {
    validate_file(file)?;
    let bytes = serde_json::to_vec_pretty(file).map_err(|_| PluginAuthorizationError::Io)?;
    if bytes.len() as u64 > MAX_AUTHORIZATION_BYTES {
        return Err(PluginAuthorizationError::Invalid);
    }
    let parent = path.parent().ok_or(PluginAuthorizationError::Io)?;
    let temporary = parent.join(".plugin-authorizations-v2.json.part");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&temporary)
        .map_err(|_| PluginAuthorizationError::Io)?;
    let staged = output.write_all(&bytes).and_then(|_| output.sync_all());
    if staged.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(PluginAuthorizationError::Io);
    }
    if replace_file(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(PluginAuthorizationError::Io);
    }
    OpenOptions::new()
        .read(true)
        .open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PluginAuthorizationError::Io)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 buffers are NUL-terminated and live for the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn validate_file(file: &AuthorizationFile) -> Result<(), PluginAuthorizationError> {
    if file.schema != AUTHORIZATION_SCHEMA || file.grants.len() > 256 {
        return Err(PluginAuthorizationError::Invalid);
    }
    for (plugin_id, record) in &file.grants {
        validate_artifact(plugin_id, &record.version, &record.digest_sha256)?;
        if record.capabilities.len() > PluginCapabilityV2::ALL.len() {
            return Err(PluginAuthorizationError::Invalid);
        }
    }
    Ok(())
}

fn validate_artifact(
    plugin_id: &str,
    version: &str,
    digest_sha256: &str,
) -> Result<(), PluginAuthorizationError> {
    validate_plugin_id(plugin_id)?;
    if version.is_empty()
        || version.len() > 128
        || version.chars().any(char::is_control)
        || digest_sha256.len() != DIGEST_HEX_BYTES
        || !digest_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PluginAuthorizationError::Invalid);
    }
    Ok(())
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), PluginAuthorizationError> {
    if plugin_id.is_empty()
        || plugin_id.len() > MAX_PLUGIN_ID_BYTES
        || !plugin_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        Err(PluginAuthorizationError::Invalid)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn first_enable_and_capability_expansion_require_confirmation() {
        let directory = tempfile::tempdir().unwrap();
        let store =
            NativePluginAuthorizationStore::open(directory.path().join("grants.json")).unwrap();
        let plugin_id = "dev.bbcom.mcumgr";
        let initial = [
            PluginCapabilityV2::UiWorkspace,
            PluginCapabilityV2::SerialIo,
        ];
        assert!(matches!(
            store.evaluate(plugin_id, initial).unwrap(),
            PluginAuthorizationDecision::ConfirmationRequired { ref added, .. }
                if added.len() == 2
        ));
        store
            .confirm(plugin_id, "1.0.0", DIGEST_A, false, initial)
            .unwrap();
        assert_eq!(
            store.evaluate(plugin_id, initial).unwrap(),
            PluginAuthorizationDecision::Granted
        );
        let expanded = [
            PluginCapabilityV2::UiWorkspace,
            PluginCapabilityV2::SerialIo,
            PluginCapabilityV2::FileOpenRead,
        ];
        assert!(matches!(
            store.evaluate(plugin_id, expanded).unwrap(),
            PluginAuthorizationDecision::ConfirmationRequired { ref added, .. }
                if added == &BTreeSet::from([PluginCapabilityV2::FileOpenRead])
        ));
    }

    #[test]
    fn digest_change_does_not_prompt_but_a_removed_capability_cannot_return_silently() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("grants.json");
        let store = NativePluginAuthorizationStore::open(&path).unwrap();
        let plugin_id = "dev.bbcom.mcumgr";
        let original = [
            PluginCapabilityV2::UiWorkspace,
            PluginCapabilityV2::SerialIo,
            PluginCapabilityV2::FileOpenRead,
        ];
        store
            .confirm(plugin_id, "1.0.0", DIGEST_A, false, original)
            .unwrap();
        let reduced = [
            PluginCapabilityV2::UiWorkspace,
            PluginCapabilityV2::SerialIo,
        ];
        store
            .accept_non_expanding_update(plugin_id, "1.1.0", DIGEST_B, true, reduced)
            .unwrap();
        assert_eq!(
            store.capabilities(plugin_id).unwrap().unwrap(),
            BTreeSet::from(reduced)
        );
        assert!(matches!(
            store.evaluate(plugin_id, original).unwrap(),
            PluginAuthorizationDecision::ConfirmationRequired { ref added, .. }
                if added == &BTreeSet::from([PluginCapabilityV2::FileOpenRead])
        ));

        drop(store);
        let reopened = NativePluginAuthorizationStore::open(path).unwrap();
        assert_eq!(
            reopened.evaluate(plugin_id, reduced).unwrap(),
            PluginAuthorizationDecision::Granted
        );
    }

    #[test]
    fn uninstall_removes_the_receipt_while_disable_needs_no_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let store =
            NativePluginAuthorizationStore::open(directory.path().join("grants.json")).unwrap();
        let capabilities = [PluginCapabilityV2::UiWorkspace];
        store
            .confirm("example.plugin", "2.0.0", DIGEST_A, false, capabilities)
            .unwrap();
        // There is intentionally no disable API: leaving this store untouched
        // is the disable behavior.
        assert_eq!(
            store.evaluate("example.plugin", capabilities).unwrap(),
            PluginAuthorizationDecision::Granted
        );
        store.remove("example.plugin").unwrap();
        assert!(matches!(
            store.evaluate("example.plugin", capabilities).unwrap(),
            PluginAuthorizationDecision::ConfirmationRequired { .. }
        ));
    }

    #[test]
    fn failed_uninstall_restores_the_exact_durable_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("grants.json");
        let store = NativePluginAuthorizationStore::open(&path).unwrap();
        let plugin_id = "example.plugin";
        let capabilities = [
            PluginCapabilityV2::UiWorkspace,
            PluginCapabilityV2::SerialIo,
        ];
        store
            .confirm(plugin_id, "2.3.4", DIGEST_B, true, capabilities)
            .unwrap();
        let before = fs::read(&path).unwrap();

        store.revoke_for_uninstall(plugin_id).unwrap();
        assert!(matches!(
            store.evaluate(plugin_id, capabilities),
            Err(PluginAuthorizationError::Invalid)
        ));
        assert_ne!(fs::read(&path).unwrap(), before);

        store.restore_after_failed_uninstall(plugin_id).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            store.evaluate(plugin_id, capabilities).unwrap(),
            PluginAuthorizationDecision::Granted
        );
    }

    #[test]
    fn host_gate_registers_exact_consent_then_allows_only_the_approved_set() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(
            NativePluginAuthorizationStore::open(directory.path().join("grants.json")).unwrap(),
        );
        let coordinator = Arc::new(PluginAuthorizationCoordinatorV2::default());
        coordinator
            .set_artifact_presentation("dev.bbcom.mcumgr", "MCUmgr", true)
            .unwrap();
        let gate =
            NativePluginAuthorizationGateV2::new(Arc::clone(&store), Arc::clone(&coordinator));
        let mut launch = AuthorizationRequest {
            plugin_id: "dev.bbcom.mcumgr".to_owned(),
            plugin_version: "1.0.0".to_owned(),
            component_sha256: DIGEST_A.to_owned(),
            package_sha256: DIGEST_B.to_owned(),
            workspace_id: "workspace-1".to_owned(),
            instance_id: "instance-1".to_owned(),
            generation: 1,
            capabilities: vec![Capability::UiWorkspace, Capability::SerialIo],
        };

        assert!(!gate.authorize(&launch));
        let pending = coordinator.requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].display_name, "MCUmgr");
        assert!(pending[0].development_source);
        coordinator
            .resolve(
                &store,
                &pending[0],
                PluginAuthorizationResolutionV2::Approve,
            )
            .unwrap();
        assert!(gate.authorize(&launch));

        launch.capabilities.push(Capability::FileOpenRead);
        launch.capabilities.sort_unstable();
        assert!(!gate.authorize(&launch));
        let pending = coordinator.requests();
        assert_eq!(
            pending[0].added_capabilities,
            vec![PluginCapabilityV2::FileOpenRead]
        );
    }
}
