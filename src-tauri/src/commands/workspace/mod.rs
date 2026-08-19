//! Main-window workspace command boundary.
//!
//! Rust owns the managed project directory, the single active SQLite writer,
//! and all native file paths. The renderer receives only generated DTOs and
//! short-lived opaque grants.
//!
//! This module owns [`WorkspaceManager`] and the mutating/catalog commands;
//! the mechanics live in focused submodules:
//!   - [`operations`] — operation cancel-state machine + registry
//!   - [`grants`]     — source/target path grants + the grant dialog commands
//!   - [`hydration`]  — page-hydration command pairs (re-exported here so the
//!     `commands::workspace::...` paths registered in `lib.rs` stay stable)

mod grants;
mod hydration;
mod operations;

// Re-export the moved commands together with the hidden command macros
// `tauri::generate_handler!` resolves next to each registered path, so the
// `commands::workspace::...` paths registered in `lib.rs` stay unchanged.
pub use grants::{
    __cmd__request_project_source_grant, __cmd__request_project_target_grant,
    __tauri_command_name_request_project_source_grant,
    __tauri_command_name_request_project_target_grant, request_project_source_grant,
    request_project_target_grant,
};
pub use hydration::{
    __cmd__hydrate_workspace_ai_messages, __cmd__hydrate_workspace_collections,
    __cmd__hydrate_workspace_frames, __cmd__hydrate_workspace_sessions,
    __cmd__hydrate_workspace_waveform, __tauri_command_name_hydrate_workspace_ai_messages,
    __tauri_command_name_hydrate_workspace_collections,
    __tauri_command_name_hydrate_workspace_frames, __tauri_command_name_hydrate_workspace_sessions,
    __tauri_command_name_hydrate_workspace_waveform, hydrate_workspace_ai_messages,
    hydrate_workspace_collections, hydrate_workspace_frames, hydrate_workspace_sessions,
    hydrate_workspace_waveform,
};

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    AppErrorCode, ApplyWorkspaceBatchRequest, ApplyWorkspaceBatchResponse,
    CancelWorkspaceOperationRequest, CancelWorkspaceOperationResponse,
    CreateWorkspaceCommandRequest, CreateWorkspaceCommandResponse, DeleteWorkspaceRequest,
    DeleteWorkspaceResponse, ExportProjectRequest, ExportProjectResponse, FlushWorkspaceRequest,
    FlushWorkspaceResponse, ImportProjectRequest, ImportProjectResponse, IpcError,
    OpenWorkspaceRequest, OpenWorkspaceResponse, ProjectEncryptionMode, ProjectEncryptionOptions,
    WorkspaceCatalogRequest, WorkspaceCatalogResponse, WorkspaceMacro, WorkspaceQuickCommand,
};
use bbcom_workspace::WorkspaceService;
use bbcom_workspace::container::{
    AgeScryptPassphraseStreams, NativeProjectDestination, NativeProjectSource,
    ProjectContainerError, ProjectLibrary, WorkspaceUuid,
};
use grants::{ProjectGrant, ProjectGrantKind};
use operations::WorkspaceOperationControl;
use tauri::{Manager, State, WebviewWindow};
use tokio::sync::Mutex as AsyncMutex;

const MAX_PASSPHRASE_CHARS: usize = 1_024;
const ACTIVE_WORKSPACE_FILE: &str = ".active-workspace-v1";
const MAX_ACTIVE_WORKSPACE_FILE_BYTES: u64 = 256;
const PLUGIN_CONTRIBUTION_INTENT_FILE: &str = ".plugin-contribution-uninstall-v2.json";
const PLUGIN_CONTRIBUTION_INTENT_FORMAT: &str = "bbcom-plugin-contribution-uninstall-v2";
const MAX_PLUGIN_CONTRIBUTION_INTENT_BYTES: u64 = 4 * 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum DurablePluginContributionDisposition {
    Delete,
    ConvertToUser,
}

impl From<bbcom_workspace::PluginContributionDisposition> for DurablePluginContributionDisposition {
    fn from(value: bbcom_workspace::PluginContributionDisposition) -> Self {
        match value {
            bbcom_workspace::PluginContributionDisposition::Delete => Self::Delete,
            bbcom_workspace::PluginContributionDisposition::ConvertToUser => Self::ConvertToUser,
        }
    }
}

impl From<DurablePluginContributionDisposition> for bbcom_workspace::PluginContributionDisposition {
    fn from(value: DurablePluginContributionDisposition) -> Self {
        match value {
            DurablePluginContributionDisposition::Delete => Self::Delete,
            DurablePluginContributionDisposition::ConvertToUser => Self::ConvertToUser,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginContributionUninstallIntent {
    format: String,
    plugin_id: String,
    disposition: DurablePluginContributionDisposition,
}

#[derive(Debug)]
pub struct WorkspaceManager {
    library: ProjectLibrary,
    active: Mutex<Option<WorkspaceService>>,
    active_marker: PathBuf,
    plugin_contribution_intent: PathBuf,
    grants: AsyncMutex<HashMap<String, ProjectGrant>>,
    operations: Mutex<HashMap<String, Arc<WorkspaceOperationControl>>>,
}

#[derive(Clone, Debug)]
pub(crate) struct NativePluginWorkspaceSnapshot {
    pub workspace_id: String,
    pub bindings: Vec<bbcom_plugin_manager::WorkspacePluginBinding>,
    pub states: Vec<bbcom_plugin_manager::OpaqueProjectPluginState>,
}

impl WorkspaceManager {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, ProjectContainerError> {
        let root = root.as_ref().to_path_buf();
        let library = ProjectLibrary::open(&root)?;
        let root = fs::canonicalize(&root)?;
        let active_marker = root.join(ACTIVE_WORKSPACE_FILE);
        let plugin_contribution_intent = root.join(PLUGIN_CONTRIBUTION_INTENT_FILE);
        let active = read_active_workspace(&library, &active_marker)?;
        Ok(Self {
            library,
            active: Mutex::new(active),
            active_marker,
            plugin_contribution_intent,
            grants: AsyncMutex::new(HashMap::new()),
            operations: Mutex::new(HashMap::new()),
        })
    }

    // --- plugin runtime wiring (additive, native-only) ---
    /// Identity of the active workspace for plugin bootstrap. Opaque
    /// per-project plugin state and repository-derived installed artifact
    /// descriptors stay empty until a reviewed repository configuration ships
    /// (ADR-0004); nothing here exposes native paths.
    pub(crate) fn plugin_workspace_snapshot(&self) -> Option<NativePluginWorkspaceSnapshot> {
        let active = self.active.lock().ok()?;
        let service = active.as_ref()?;
        let workspace_id = service.summary().ok()?.workspace_id;
        let persisted = service.plugin_bindings().ok()?;
        let mut bindings = Vec::with_capacity(persisted.len());
        let mut states = Vec::new();
        // A single malformed binding must not silently drop plugin activation
        // for the whole workspace: skip it, keep the rest, and leave a trail.
        let mut skipped = 0usize;
        for item in persisted {
            match bbcom_plugin_manager::WorkspacePluginBinding::new(
                item.plugin_id.clone(),
                item.expected_enabled,
                item.version_requirement,
            ) {
                Ok(binding) => {
                    bindings.push(binding);
                    match (
                        item.project_state,
                        item.project_state_api_generation,
                        item.project_state_schema_version,
                    ) {
                        (Some(bytes), Some(2), Some(schema_version @ 1..=u32::MAX)) => {
                            match bbcom_plugin_manager::OpaqueProjectPluginState::new_with_versions(
                                item.plugin_id,
                                bytes,
                                2,
                                Some(schema_version),
                            ) {
                                Ok(state) => states.push(state),
                                Err(_) => skipped += 1,
                            }
                        }
                        (None, None, None) => {}
                        _ => skipped += 1,
                    }
                }
                Err(_) => skipped += 1,
            }
        }
        if skipped > 0 {
            tracing::warn!(
                "skipped {skipped} malformed plugin binding(s) for workspace {workspace_id}"
            );
        }
        Some(NativePluginWorkspaceSnapshot {
            workspace_id,
            bindings,
            states,
        })
    }

    pub(crate) fn set_plugin_expected_enabled(
        &self,
        plugin_id: &str,
        expected_enabled: bool,
    ) -> Result<(), ()> {
        let mut active = self.active.lock().map_err(|_| ())?;
        active
            .as_mut()
            .ok_or(())?
            .set_plugin_expected_enabled(plugin_id, expected_enabled)
            .map_err(|_| ())
    }

    pub(crate) fn set_plugin_project_state(
        &self,
        workspace_id: &str,
        plugin_id: &str,
        state: &[u8],
        api_generation: u32,
        schema_version: Option<u32>,
    ) -> Result<(), bbcom_workspace::WorkspaceError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| bbcom_workspace::WorkspaceError::Busy)?;
        let service = active
            .as_mut()
            .ok_or(bbcom_workspace::WorkspaceError::NotFound)?;
        if service.summary()?.workspace_id != workspace_id {
            return Err(bbcom_workspace::WorkspaceError::NotFound);
        }
        service.set_plugin_project_state(plugin_id, state, api_generation, schema_version)
    }

    pub(crate) fn upsert_plugin_quick_command(
        &self,
        workspace_id: &str,
        session_id: &str,
        command: &WorkspaceQuickCommand,
    ) -> Result<(), bbcom_workspace::WorkspaceError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| bbcom_workspace::WorkspaceError::Busy)?;
        let service = active
            .as_mut()
            .ok_or(bbcom_workspace::WorkspaceError::NotFound)?;
        if service.summary()?.workspace_id != workspace_id {
            return Err(bbcom_workspace::WorkspaceError::NotFound);
        }
        service.upsert_plugin_quick_command(session_id, command)
    }

    pub(crate) fn delete_plugin_quick_command(
        &self,
        workspace_id: &str,
        session_id: &str,
        contribution_id: &str,
        plugin_id: &str,
    ) -> Result<(), bbcom_workspace::WorkspaceError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| bbcom_workspace::WorkspaceError::Busy)?;
        let service = active
            .as_mut()
            .ok_or(bbcom_workspace::WorkspaceError::NotFound)?;
        if service.summary()?.workspace_id != workspace_id {
            return Err(bbcom_workspace::WorkspaceError::NotFound);
        }
        service.delete_plugin_quick_command(session_id, contribution_id, plugin_id)
    }

    pub(crate) fn upsert_plugin_macro(
        &self,
        workspace_id: &str,
        session_id: &str,
        value: &WorkspaceMacro,
    ) -> Result<(), bbcom_workspace::WorkspaceError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| bbcom_workspace::WorkspaceError::Busy)?;
        let service = active
            .as_mut()
            .ok_or(bbcom_workspace::WorkspaceError::NotFound)?;
        if service.summary()?.workspace_id != workspace_id {
            return Err(bbcom_workspace::WorkspaceError::NotFound);
        }
        service.upsert_plugin_macro(session_id, value)
    }

    pub(crate) fn delete_plugin_macro(
        &self,
        workspace_id: &str,
        session_id: &str,
        contribution_id: &str,
        plugin_id: &str,
    ) -> Result<(), bbcom_workspace::WorkspaceError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| bbcom_workspace::WorkspaceError::Busy)?;
        let service = active
            .as_mut()
            .ok_or(bbcom_workspace::WorkspaceError::NotFound)?;
        if service.summary()?.workspace_id != workspace_id {
            return Err(bbcom_workspace::WorkspaceError::NotFound);
        }
        service.delete_plugin_macro(session_id, contribution_id, plugin_id)
    }

    pub(crate) fn cleanup_plugin_contributions(
        &self,
        plugin_id: &str,
        disposition: bbcom_workspace::PluginContributionDisposition,
    ) -> Result<bbcom_workspace::PluginContributionCleanupReport, ()> {
        let mut active = self.active.lock().map_err(|_| ())?;
        let active_id = active
            .as_ref()
            .and_then(|service| service.summary().ok())
            .map(|summary| summary.workspace_id);
        let mut report = bbcom_workspace::PluginContributionCleanupReport::default();
        if let Some(service) = active.as_mut() {
            let cleaned = service
                .cleanup_plugin_contributions(plugin_id, disposition)
                .map_err(|_| ())?;
            report.quick_commands = report
                .quick_commands
                .checked_add(cleaned.quick_commands)
                .ok_or(())?;
            report.macros = report.macros.checked_add(cleaned.macros).ok_or(())?;
        }
        for workspace_id in self.library.list_workspace_ids().map_err(|_| ())? {
            if active_id.as_deref() == Some(workspace_id.as_str()) {
                continue;
            }
            let mut service = self.library.open_project(&workspace_id).map_err(|_| ())?;
            let cleaned = service
                .cleanup_plugin_contributions(plugin_id, disposition)
                .map_err(|_| ())?;
            report.quick_commands = report
                .quick_commands
                .checked_add(cleaned.quick_commands)
                .ok_or(())?;
            report.macros = report.macros.checked_add(cleaned.macros).ok_or(())?;
        }
        Ok(report)
    }

    /// Executes package removal while every managed workspace contribution
    /// cleanup remains inside an uncommitted SQLite transaction. The caller's
    /// `false` result rolls every workspace back; `true` commits every cleanup.
    ///
    /// A fixed, native-owned intent is fsynced before the first transaction.
    /// If the process stops in the narrow package-removal/commit interval,
    /// startup recovery uses authoritative installer inventory: an installed
    /// plugin means SQLite already rolled back, while an absent plugin means
    /// cleanup is replayed idempotently before any guest can launch.
    pub(crate) fn with_plugin_contribution_uninstall(
        &self,
        plugin_id: &str,
        disposition: bbcom_workspace::PluginContributionDisposition,
        action: impl FnOnce() -> bool,
    ) -> Result<bool, ()> {
        if self.plugin_contribution_intent.exists() {
            return Err(());
        }

        let mut active = self.active.lock().map_err(|_| ())?;
        let active_id = active
            .as_ref()
            .and_then(|service| service.summary().ok())
            .map(|summary| summary.workspace_id);
        let mut closed = Vec::new();
        for workspace_id in self.library.list_workspace_ids().map_err(|_| ())? {
            if active_id.as_deref() == Some(workspace_id.as_str()) {
                continue;
            }
            closed.push(self.library.open_project(&workspace_id).map_err(|_| ())?);
        }

        let intent = PluginContributionUninstallIntent {
            format: PLUGIN_CONTRIBUTION_INTENT_FORMAT.to_owned(),
            plugin_id: plugin_id.to_owned(),
            disposition: disposition.into(),
        };
        persist_plugin_contribution_intent(&self.plugin_contribution_intent, &intent)
            .map_err(|_| ())?;

        let mut action_outcome = None;
        let mut action = Some(|| {
            let outcome = action();
            action_outcome = Some(outcome);
            outcome
        });
        let staged = if let Some(service) = active.as_mut() {
            let mut nested_error = None;
            let stage =
                service.with_staged_plugin_contribution_cleanup(plugin_id, disposition, || {
                    match stage_closed_plugin_contribution_cleanup(
                        &mut closed,
                        plugin_id,
                        disposition,
                        &mut action,
                    ) {
                        Ok(committed) => committed,
                        Err(error) => {
                            nested_error = Some(error);
                            false
                        }
                    }
                });
            match stage {
                Ok((committed, _)) if nested_error.is_none() => Ok(committed),
                Ok(_) | Err(_) => Err(()),
            }
        } else {
            stage_closed_plugin_contribution_cleanup(
                &mut closed,
                plugin_id,
                disposition,
                &mut action,
            )
            .map_err(|_| ())
        };

        match staged {
            Ok(committed) => {
                if let Err(error) =
                    remove_plugin_contribution_intent(&self.plugin_contribution_intent)
                {
                    // The authoritative result is already committed/rolled
                    // back. Keep a durable, idempotent recovery marker rather
                    // than changing an irreversible package result to Failed.
                    tracing::warn!(
                        plugin_id,
                        %error,
                        "plugin contribution uninstall intent removal deferred"
                    );
                }
                Ok(committed)
            }
            Err(()) => {
                // If the callback was never consumed, package removal never
                // crossed its irreversible boundary. Every opened SQLite
                // transaction has rolled back (explicitly or by RAII), so the
                // durable intent can be removed and a same-process retry is
                // safe. Once the callback ran, retain the intent: recovery
                // must consult authoritative installer inventory.
                let action_not_run = action.is_some();
                drop(action);
                drop(closed);
                drop(active);
                if action_not_run {
                    let _ = remove_plugin_contribution_intent(&self.plugin_contribution_intent);
                    return Err(());
                }
                if action_outcome == Some(true) {
                    // Package removal succeeded but at least one SQLite commit
                    // failed. Replay cleanup outside the staged connections;
                    // it is idempotent for already-committed workspaces. A
                    // remaining failure retains the intent for startup.
                    if self
                        .cleanup_plugin_contributions(plugin_id, disposition)
                        .is_ok()
                    {
                        let _ = remove_plugin_contribution_intent(&self.plugin_contribution_intent);
                        return Ok(true);
                    }
                }
                Err(())
            }
        }
    }

    /// Resolves a durable uninstall intent before plugin workspace activation.
    /// Malformed or unrecoverable state fails closed so no guest is launched
    /// against ambiguous contribution ownership.
    pub(crate) fn recover_plugin_contribution_uninstall(
        &self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), ()> {
        let Some(intent) =
            read_plugin_contribution_intent(&self.plugin_contribution_intent).map_err(|_| ())?
        else {
            return Ok(());
        };
        if !installed_plugin_ids.contains(&intent.plugin_id) {
            self.cleanup_plugin_contributions(&intent.plugin_id, intent.disposition.into())?;
        }
        remove_plugin_contribution_intent(&self.plugin_contribution_intent).map_err(|_| ())
    }

    /// Native reset-only primitive. The durable reset journal supplies the
    /// fixed UUID; renderer commands can never select it. Re-entry after a
    /// crash either creates that exact project or validates the already
    /// created empty schema-v1 project without replacing it.
    pub(crate) fn ensure_empty_reset_workspace(
        &self,
        workspace_id: &str,
        name: &str,
        expected_revision: u64,
        created_at_ms: u64,
        operation: &'static str,
    ) -> Result<(), IpcError> {
        let workspace_id =
            WorkspaceUuid::parse(workspace_id).map_err(|error| project_error(error, operation))?;
        let service = if self.library.contains(&workspace_id) {
            self.library.open_project(&workspace_id)
        } else {
            match self
                .library
                .create_project(&workspace_id, name.to_owned(), created_at_ms)
            {
                Ok(service) => Ok(service),
                // A competing/resumed prepare may have committed between the
                // contains check and create. Validate the winner below.
                Err(ProjectContainerError::AlreadyExists) => {
                    self.library.open_project(&workspace_id)
                }
                Err(error) => Err(error),
            }
        }
        .map_err(|error| project_error(error, operation))?;
        validate_empty_reset_workspace(
            &service,
            workspace_id.as_str(),
            name,
            expected_revision,
            operation,
        )
    }

    pub(crate) fn verify_empty_reset_workspace(
        &self,
        workspace_id: &str,
        name: &str,
        expected_revision: u64,
        operation: &'static str,
    ) -> Result<(), IpcError> {
        let workspace_id =
            WorkspaceUuid::parse(workspace_id).map_err(|error| project_error(error, operation))?;
        let service = self
            .library
            .open_project(&workspace_id)
            .map_err(|error| project_error(error, operation))?;
        validate_empty_reset_workspace(
            &service,
            workspace_id.as_str(),
            name,
            expected_revision,
            operation,
        )
    }
}

fn validate_empty_reset_workspace(
    service: &WorkspaceService,
    workspace_id: &str,
    name: &str,
    expected_revision: u64,
    operation: &'static str,
) -> Result<(), IpcError> {
    let header = service
        .header()
        .map_err(|error| error.to_ipc_error(operation))?;
    if header.workspace_id != workspace_id
        || header.name != name
        || header.revision != expected_revision
        || header.active_session_id.is_some()
        || !header.session_ids.is_empty()
    {
        return Err(IpcError::new(
            AppErrorCode::WorkspaceCorrupt,
            "error.workspace_corrupt",
            false,
            operation,
        )
        .with_field("workspaceId"));
    }
    Ok(())
}

/// Runs one main-window workspace core on the blocking pool: the active
/// workspace's SQLite work must stay off the async runtime workers.
async fn dispatch_workspace_core<T, F>(
    app: tauri::AppHandle,
    label: String,
    operation: &'static str,
    core: F,
) -> Result<T, IpcError>
where
    T: Send + 'static,
    F: FnOnce(&WorkspaceManager, &str) -> Result<T, IpcError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<WorkspaceManager>();
        core(manager.inner(), &label)
    })
    .await
    .map_err(|_| io_failure(operation, true))?
}

#[tauri::command]
pub async fn workspace_catalog(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: WorkspaceCatalogRequest,
) -> Result<WorkspaceCatalogResponse, IpcError> {
    const OPERATION: &str = "workspace_catalog";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        workspace_catalog_from_label(manager, label, request)
    })
    .await
}

fn workspace_catalog_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: WorkspaceCatalogRequest,
) -> Result<WorkspaceCatalogResponse, IpcError> {
    const OPERATION: &str = "workspace_catalog";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;

    let active_summary = {
        let active = lock_active(manager, OPERATION)?;
        active
            .as_ref()
            .map(WorkspaceService::summary)
            .transpose()
            .map_err(|error| error.to_ipc_error(OPERATION))?
    };
    let active_workspace_id = active_summary
        .as_ref()
        .map(|summary| summary.workspace_id.clone());
    let mut workspaces = Vec::new();
    for workspace_id in manager
        .library
        .list_workspace_ids()
        .map_err(|error| project_error(error, OPERATION))?
    {
        if active_workspace_id.as_deref() == Some(workspace_id.as_str()) {
            workspaces.push(active_summary.clone().expect("active summary exists"));
        } else {
            let summary = manager
                .library
                .open_project(&workspace_id)
                .and_then(|service| service.summary().map_err(ProjectContainerError::from));
            match summary {
                Ok(summary) => workspaces.push(summary),
                Err(_) => {
                    // One damaged managed file must not make every healthy
                    // workspace inaccessible. Keep its opaque UUID out of the
                    // renderer catalog and leave the file untouched for a
                    // future recovery flow.
                    tracing::warn!(workspace_id = %workspace_id.as_str(), "skipping unreadable managed workspace");
                }
            }
        }
    }
    workspaces.sort_by(|left, right| {
        right
            .updated_at_ms
            .total_cmp(&left.updated_at_ms)
            .then_with(|| left.workspace_id.cmp(&right.workspace_id))
    });
    Ok(WorkspaceCatalogResponse {
        request_id: request.request_id,
        workspaces,
        active_workspace_id,
    })
}

#[tauri::command]
pub async fn delete_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: DeleteWorkspaceRequest,
) -> Result<DeleteWorkspaceResponse, IpcError> {
    const OPERATION: &str = "delete_workspace";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        delete_workspace_from_label(manager, label, request)
    })
    .await
}

fn delete_workspace_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: DeleteWorkspaceRequest,
) -> Result<DeleteWorkspaceResponse, IpcError> {
    const OPERATION: &str = "delete_workspace";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let workspace_id = WorkspaceUuid::parse(&request.workspace_id)
        .map_err(|error| project_error(error, OPERATION))?;

    // Keep the active lock through the library commit. The application service
    // quiesces persistence before requesting deletion; taking the service out
    // of this slot closes the SQLite writer before Windows removes the file.
    let mut active = lock_active(manager, OPERATION)?;
    let active_workspace_id = active
        .as_ref()
        .map(WorkspaceService::summary)
        .transpose()
        .map_err(|error| error.to_ipc_error(OPERATION))?
        .map(|summary| summary.workspace_id);
    let deletes_active = active_workspace_id.as_deref() == Some(request.workspace_id.as_str());
    let closed_active = deletes_active.then(|| active.take()).flatten();
    drop(closed_active);
    if let Err(error) = manager.library.delete_project(&workspace_id) {
        if deletes_active && manager.library.contains(&workspace_id) {
            *active = manager.library.open_project(&workspace_id).ok();
        }
        return Err(project_error(error, OPERATION));
    }
    if deletes_active {
        // A stale marker is harmless (startup validates existence), but remove
        // it eagerly so the empty-library state survives a clean restart.
        let _ = fs::remove_file(&manager.active_marker);
        if let Some(parent) = manager.active_marker.parent() {
            let _ = sync_native_directory(parent);
        }
    }
    drop(active);
    Ok(DeleteWorkspaceResponse {
        request_id: request.request_id,
        workspace_id: request.workspace_id,
    })
}

/// After a workspace switch attempt, activate the plugin runtime for the
/// workspace that is active when the dust settles: the new one on success, or
/// the unchanged previous one on failure — the plugin project closed up front
/// must never stay closed because a switch happened to fail. When no runtime
/// was ever composed (a failed setup composition), retry composition first so
/// transient bootstrap failures heal without an application restart.
fn activate_plugin_runtime_after_attempt<T>(
    app: &tauri::AppHandle,
    result: Result<T, IpcError>,
) -> Result<T, IpcError> {
    let app = app.clone();
    // Detached: the workspace response never waits on plugin composition.
    let _detached = tauri::async_runtime::spawn_blocking(move || {
        crate::plugins::ensure_plugin_runtime(&app);
        crate::plugins::activate_plugin_workspace(&app);
    });
    result
}

#[tauri::command]
pub async fn create_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: CreateWorkspaceCommandRequest,
) -> Result<CreateWorkspaceCommandResponse, IpcError> {
    const OPERATION: &str = "create_workspace";
    let label = window.label().to_string();
    // Reject invalid requests before tearing down the plugin project — label
    // and requestId checks never depend on workspace state.
    require_main_window_label(&label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    // Close the plugin project before the active workspace is replaced.
    crate::plugins::close_plugin_project(&app);
    let result = dispatch_workspace_core(app.clone(), label, OPERATION, |manager, label| {
        create_workspace_from_label(manager, label, request)
    })
    .await;
    activate_plugin_runtime_after_attempt(&app, result)
}

fn create_workspace_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: CreateWorkspaceCommandRequest,
) -> Result<CreateWorkspaceCommandResponse, IpcError> {
    const OPERATION: &str = "create_workspace";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let now = current_time_millis(OPERATION)?;
    let mut created = None;
    for _ in 0..4 {
        let workspace_id = random_workspace_uuid(OPERATION)?;
        match manager
            .library
            .create_project(&workspace_id, request.name.clone(), now)
        {
            Ok(service) => {
                created = Some(service);
                break;
            }
            Err(ProjectContainerError::AlreadyExists) => continue,
            Err(error) => return Err(project_error(error, OPERATION)),
        }
    }
    let service =
        created.ok_or_else(|| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))?;
    let workspace = service
        .summary()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    let header = service
        .header()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    commit_active_workspace(manager, &workspace.workspace_id, service, OPERATION)?;
    Ok(CreateWorkspaceCommandResponse {
        request_id: request.request_id,
        workspace,
        header,
    })
}

#[tauri::command]
pub async fn open_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: OpenWorkspaceRequest,
) -> Result<OpenWorkspaceResponse, IpcError> {
    const OPERATION: &str = "open_workspace";
    let label = window.label().to_string();
    // Same precondition set as open_workspace_from_label, checked before the
    // plugin project is closed so a rejected request leaves plugins running.
    require_main_window_label(&label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    WorkspaceUuid::parse(&request.workspace_id).map_err(|error| project_error(error, OPERATION))?;
    // Close the plugin project before the active workspace is replaced.
    crate::plugins::close_plugin_project(&app);
    let result = dispatch_workspace_core(app.clone(), label, OPERATION, |manager, label| {
        open_workspace_from_label(manager, label, request)
    })
    .await;
    activate_plugin_runtime_after_attempt(&app, result)
}

fn open_workspace_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: OpenWorkspaceRequest,
) -> Result<OpenWorkspaceResponse, IpcError> {
    const OPERATION: &str = "open_workspace";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let workspace_id = WorkspaceUuid::parse(&request.workspace_id)
        .map_err(|error| project_error(error, OPERATION))?;
    let service = manager
        .library
        .open_project(&workspace_id)
        .map_err(|error| project_error(error, OPERATION))?;
    let workspace = service
        .summary()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    let header = service
        .header()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    commit_active_workspace(manager, &workspace.workspace_id, service, OPERATION)?;
    Ok(OpenWorkspaceResponse {
        request_id: request.request_id,
        workspace,
        header,
    })
}

#[tauri::command]
pub async fn apply_workspace_batch(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: ApplyWorkspaceBatchRequest,
) -> Result<ApplyWorkspaceBatchResponse, IpcError> {
    const OPERATION: &str = "apply_workspace_batch";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        apply_workspace_batch_from_label(manager, label, request)
    })
    .await
}

fn apply_workspace_batch_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: ApplyWorkspaceBatchRequest,
) -> Result<ApplyWorkspaceBatchResponse, IpcError> {
    const OPERATION: &str = "apply_workspace_batch";
    require_main_window_label(label, OPERATION)?;
    let mut active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    active
        .as_mut()
        .expect("active workspace checked")
        .apply_batch(request)
        .map_err(|error| error.to_ipc_error(OPERATION))
}

#[tauri::command]
pub async fn flush_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: FlushWorkspaceRequest,
) -> Result<FlushWorkspaceResponse, IpcError> {
    const OPERATION: &str = "flush_workspace";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        flush_workspace_from_label(manager, label, request)
    })
    .await
}

fn flush_workspace_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: FlushWorkspaceRequest,
) -> Result<FlushWorkspaceResponse, IpcError> {
    const OPERATION: &str = "flush_workspace";
    require_main_window_label(label, OPERATION)?;
    let mut active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    let (committed_revision, save_health) = active
        .as_mut()
        .expect("active workspace checked")
        .flush(request.target_revision)
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    Ok(FlushWorkspaceResponse {
        committed_revision,
        save_health,
    })
}

#[tauri::command]
pub async fn import_project(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: ImportProjectRequest,
) -> Result<ImportProjectResponse, IpcError> {
    const OPERATION: &str = "import_project";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let operation_id = request.operation_id.clone();
    let cancellation = manager.begin_operation(&operation_id, OPERATION)?;
    let result = async {
        let encryption = validate_encryption(request.encryption, OPERATION)?;
        let source = manager
            .consume_grant(
                &request.source_grant_id,
                ProjectGrantKind::Source,
                OPERATION,
            )
            .await?;
        let source = NativeProjectSource::from_native_path(source);
        let cancellation_check = |checkpoint| cancellation.is_cancelled(checkpoint);
        let imported = match encryption.as_ref() {
            None => manager
                .library
                .import_plaintext(&source, &cancellation_check),
            Some(passphrase) => {
                manager
                    .library
                    .import_encrypted(&source, passphrase, &cancellation_check)
            }
        }
        .map_err(|error| project_error(error, OPERATION))?;
        let service = manager
            .library
            .open_project(&imported.workspace_id)
            .map_err(|error| project_error(error, OPERATION))?;
        let workspace = service
            .summary()
            .map_err(|error| error.to_ipc_error(OPERATION))?;
        Ok(ImportProjectResponse {
            request_id: request.request_id,
            operation_id: operation_id.clone(),
            workspace,
        })
    }
    .await;
    manager.finish_operation(&operation_id);
    result
}

#[tauri::command]
pub async fn export_project(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: ExportProjectRequest,
) -> Result<ExportProjectResponse, IpcError> {
    const OPERATION: &str = "export_project";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let operation_id = request.operation_id.clone();
    let cancellation = manager.begin_operation(&operation_id, OPERATION)?;
    let result = async {
        let workspace_id = WorkspaceUuid::parse(&request.workspace_id)
            .map_err(|error| project_error(error, OPERATION))?;
        if !manager.library.contains(&workspace_id) {
            return Err(IpcError::invalid_input(OPERATION, "workspaceId"));
        }
        let encryption = validate_encryption(request.encryption, OPERATION)?;
        let target = manager
            .consume_grant(
                &request.target_grant_id,
                ProjectGrantKind::Target,
                OPERATION,
            )
            .await?;
        let display_name = project_display_name(&target, OPERATION)?;
        let target = NativeProjectDestination::from_native_path(target);
        let cancellation_check = |checkpoint| cancellation.is_cancelled(checkpoint);
        match encryption.as_ref() {
            None => manager
                .library
                .export_plaintext(&workspace_id, &target, &cancellation_check),
            Some(passphrase) => manager.library.export_encrypted(
                &workspace_id,
                &target,
                passphrase,
                &cancellation_check,
            ),
        }
        .map_err(|error| project_error(error, OPERATION))?;
        Ok(ExportProjectResponse {
            request_id: request.request_id,
            operation_id: operation_id.clone(),
            display_name,
        })
    }
    .await;
    manager.finish_operation(&operation_id);
    result
}

#[tauri::command]
pub async fn cancel_workspace_operation(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: CancelWorkspaceOperationRequest,
) -> Result<CancelWorkspaceOperationResponse, IpcError> {
    const OPERATION: &str = "cancel_workspace_operation";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        cancel_workspace_operation_from_label(manager, label, request)
    })
    .await
}

fn cancel_workspace_operation_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: CancelWorkspaceOperationRequest,
) -> Result<CancelWorkspaceOperationResponse, IpcError> {
    const OPERATION: &str = "cancel_workspace_operation";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let cancellation_requested = manager.cancel_operation(&request.operation_id, OPERATION)?;
    Ok(CancelWorkspaceOperationResponse {
        request_id: request.request_id,
        operation_id: request.operation_id,
        cancellation_requested,
    })
}

fn active_workspace<'a>(
    manager: &'a WorkspaceManager,
    workspace_id: &str,
    operation: &'static str,
) -> Result<MutexGuard<'a, Option<WorkspaceService>>, IpcError> {
    let active = lock_active(manager, operation)?;
    let header = active
        .as_ref()
        .ok_or_else(|| IpcError::invalid_input(operation, "workspaceId"))?
        .header()
        .map_err(|error| error.to_ipc_error(operation))?;
    if header.workspace_id != workspace_id {
        return Err(IpcError::invalid_input(operation, "workspaceId"));
    }
    Ok(active)
}

fn lock_active<'a>(
    manager: &'a WorkspaceManager,
    operation: &'static str,
) -> Result<MutexGuard<'a, Option<WorkspaceService>>, IpcError> {
    manager
        .active
        .lock()
        .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))
}

fn commit_active_workspace(
    manager: &WorkspaceManager,
    workspace_id: &str,
    service: WorkspaceService,
    operation: &'static str,
) -> Result<(), IpcError> {
    let workspace_id =
        WorkspaceUuid::parse(workspace_id).map_err(|error| project_error(error, operation))?;
    let mut active = lock_active(manager, operation)?;
    if !manager.library.contains(&workspace_id) {
        return Err(IpcError::invalid_input(operation, "workspaceId"));
    }
    persist_active_workspace(&manager.active_marker, &workspace_id)
        .map_err(|error| io_error_kind(error.kind(), operation))?;
    *active = Some(service);
    Ok(())
}

fn read_active_workspace(
    library: &ProjectLibrary,
    marker: &Path,
) -> Result<Option<WorkspaceService>, ProjectContainerError> {
    let mut file = match File::open(marker) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            tracing::warn!(kind = ?error.kind(), "ignoring unreadable last-active workspace marker");
            let _ = fs::remove_file(marker);
            return Ok(None);
        }
    };
    let marker_len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            tracing::warn!(kind = ?error.kind(), "ignoring invalid last-active workspace marker metadata");
            let _ = fs::remove_file(marker);
            return Ok(None);
        }
    };
    if marker_len > MAX_ACTIVE_WORKSPACE_FILE_BYTES {
        let _ = fs::remove_file(marker);
        return Ok(None);
    }
    let mut encoded = String::new();
    if let Err(error) = file.read_to_string(&mut encoded) {
        tracing::warn!(kind = ?error.kind(), "ignoring malformed last-active workspace marker");
        let _ = fs::remove_file(marker);
        return Ok(None);
    }
    let Ok(workspace_id) = WorkspaceUuid::parse(encoded.trim()) else {
        let _ = fs::remove_file(marker);
        return Ok(None);
    };
    if !library.contains(&workspace_id) {
        let _ = fs::remove_file(marker);
        return Ok(None);
    }
    match library.open_project(&workspace_id) {
        Ok(service) => Ok(Some(service)),
        Err(_) => {
            // A stale/corrupt last-active pointer must not prevent the catalog
            // from opening so the user can choose another recoverable project.
            let _ = fs::remove_file(marker);
            Ok(None)
        }
    }
}

fn stage_closed_plugin_contribution_cleanup<F>(
    services: &mut [WorkspaceService],
    plugin_id: &str,
    disposition: bbcom_workspace::PluginContributionDisposition,
    action: &mut Option<F>,
) -> Result<bool, bbcom_workspace::WorkspaceError>
where
    F: FnOnce() -> bool,
{
    let Some((service, remaining)) = services.split_first_mut() else {
        return action
            .take()
            .map(|action| action())
            .ok_or(bbcom_workspace::WorkspaceError::Busy);
    };
    let mut nested_error = None;
    let (committed, _) =
        service.with_staged_plugin_contribution_cleanup(plugin_id, disposition, || {
            match stage_closed_plugin_contribution_cleanup(
                remaining,
                plugin_id,
                disposition,
                action,
            ) {
                Ok(committed) => committed,
                Err(error) => {
                    nested_error = Some(error);
                    false
                }
            }
        })?;
    match nested_error {
        Some(error) => Err(error),
        None => Ok(committed),
    }
}

fn read_plugin_contribution_intent(
    path: &Path,
) -> std::io::Result<Option<PluginContributionUninstallIntent>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_PLUGIN_CONTRIBUTION_INTENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid plugin contribution uninstall intent",
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    File::open(path)?
        .take(MAX_PLUGIN_CONTRIBUTION_INTENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PLUGIN_CONTRIBUTION_INTENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "oversized plugin contribution uninstall intent",
        ));
    }
    let intent: PluginContributionUninstallIntent = serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let valid_plugin_id = intent.plugin_id.len() >= 3
        && intent.plugin_id.len() <= 128
        && intent.plugin_id.contains('.')
        && intent.plugin_id.split('.').all(|part| {
            !part.is_empty()
                && part.bytes().enumerate().all(|(index, byte)| match byte {
                    b'a'..=b'z' | b'0'..=b'9' => true,
                    b'-' => index > 0 && index + 1 < part.len(),
                    _ => false,
                })
        });
    if intent.format != PLUGIN_CONTRIBUTION_INTENT_FORMAT || !valid_plugin_id {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsupported plugin contribution uninstall intent",
        ));
    }
    Ok(Some(intent))
}

fn persist_plugin_contribution_intent(
    path: &Path,
    intent: &PluginContributionUninstallIntent,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(intent)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if bytes.len() as u64 > MAX_PLUGIN_CONTRIBUTION_INTENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "oversized plugin contribution uninstall intent",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::other("plugin contribution intent has no parent directory")
    })?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staged = parent.join(format!(
        ".plugin-contribution-uninstall-{}-{nonce}.part",
        std::process::id()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace_file(&staged, path)?;
        sync_native_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

fn remove_plugin_contribution_intent(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    match path.parent() {
        Some(parent) => sync_native_directory(parent),
        None => Ok(()),
    }
}

fn persist_active_workspace(marker: &Path, workspace_id: &WorkspaceUuid) -> std::io::Result<()> {
    let parent = marker
        .parent()
        .ok_or_else(|| std::io::Error::other("active workspace marker has no parent"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staged = parent.join(format!(
        ".active-workspace-{}-{nonce}.part",
        std::process::id()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staged)?;
        file.write_all(workspace_id.as_str().as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        atomic_replace_file(&staged, marker)?;
        sync_native_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

#[cfg(windows)]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
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
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn sync_native_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn validate_encryption(
    encryption: ProjectEncryptionOptions,
    operation: &'static str,
) -> Result<Option<AgeScryptPassphraseStreams>, IpcError> {
    match (encryption.mode, encryption.passphrase) {
        (ProjectEncryptionMode::Plaintext, None) => Ok(None),
        (ProjectEncryptionMode::AgePassphrase, Some(passphrase)) => {
            let length = passphrase.chars().count();
            if !(12..=MAX_PASSPHRASE_CHARS).contains(&length) {
                return Err(IpcError::invalid_input(operation, "passphrase"));
            }
            AgeScryptPassphraseStreams::new(passphrase)
                .map(Some)
                .map_err(|error| project_error(error, operation))
        }
        _ => Err(IpcError::invalid_input(operation, "encryption")),
    }
}

fn validate_project_path(
    path: &Path,
    must_exist: bool,
    operation: &'static str,
) -> Result<(), IpcError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("bbcom"))
        || (must_exist && !path.is_file())
        || (!must_exist && (path.is_dir() || path.parent().is_none_or(|parent| !parent.is_dir())))
    {
        return Err(IpcError::invalid_input(
            operation,
            if must_exist { "source" } else { "destination" },
        ));
    }
    Ok(())
}

fn validate_project_file_name(value: &str, operation: &'static str) -> Result<(), IpcError> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || !value.to_ascii_lowercase().ends_with(".bbcom")
    {
        return Err(IpcError::invalid_input(operation, "suggestedName"));
    }
    Ok(())
}

fn project_display_name(path: &Path, operation: &'static str) -> Result<String, IpcError> {
    let value = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| IpcError::invalid_input(operation, "displayName"))?;
    validate_project_file_name(value, operation)?;
    Ok(value.to_owned())
}

fn validate_opaque_id(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(IpcError::invalid_input(operation, field));
    }
    Ok(())
}

fn random_workspace_uuid(operation: &'static str) -> Result<WorkspaceUuid, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation, true))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let value = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    );
    WorkspaceUuid::parse(&value).map_err(|error| project_error(error, operation))
}

fn random_opaque_id(prefix: &str, operation: &'static str) -> Result<String, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation, true))?;
    let mut value = String::with_capacity(prefix.len() + 33);
    value.push_str(prefix);
    value.push('-');
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn current_time_millis(operation: &'static str) -> Result<u64, IpcError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io_failure(operation, false))?;
    u64::try_from(duration.as_millis()).map_err(|_| io_failure(operation, false))
}

fn project_error(error: ProjectContainerError, operation: &'static str) -> IpcError {
    match error {
        ProjectContainerError::InvalidInput { field } => IpcError::invalid_input(operation, field),
        ProjectContainerError::LimitExceeded {
            field,
            limit,
            actual,
        } => IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field(field)
        .with_size(
            usize::try_from(limit).unwrap_or(usize::MAX),
            usize::try_from(actual).unwrap_or(usize::MAX),
        ),
        ProjectContainerError::Cancelled { .. } => cancelled(operation),
        ProjectContainerError::AlreadyExists => IpcError::invalid_input(operation, "workspaceId"),
        ProjectContainerError::Integrity | ProjectContainerError::AgeStream => corrupt(operation),
        ProjectContainerError::Workspace(error) => error.to_ipc_error(operation),
        ProjectContainerError::AgeIo(error) | ProjectContainerError::Io(error) => {
            io_error_kind(error.kind(), operation)
        }
    }
}

fn io_error_kind(kind: std::io::ErrorKind, operation: &'static str) -> IpcError {
    match kind {
        std::io::ErrorKind::PermissionDenied => IpcError::new(
            AppErrorCode::IoPermissionDenied,
            "error.io_permission_denied",
            false,
            operation,
        ),
        std::io::ErrorKind::StorageFull => IpcError::new(
            AppErrorCode::IoDiskFull,
            "error.io_disk_full",
            true,
            operation,
        ),
        _ => io_failure(operation, true),
    }
}

fn cancelled(operation: &'static str) -> IpcError {
    IpcError::new(AppErrorCode::Cancelled, "error.cancelled", false, operation)
}

fn corrupt(operation: &'static str) -> IpcError {
    IpcError::new(
        AppErrorCode::WorkspaceCorrupt,
        "error.workspace_corrupt",
        false,
        operation,
    )
}

fn io_failure(operation: &'static str, retryable: bool) -> IpcError {
    IpcError::new(
        AppErrorCode::WorkspaceCorrupt,
        "error.workspace_io_failed",
        retryable,
        operation,
    )
}

/// Shared by this module's tests and the submodule test suites.
#[cfg(test)]
fn temporary_root(label: &str) -> PathBuf {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).expect("test entropy");
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    std::env::temp_dir().join(format!("bbcom-workspace-manager-{label}-{suffix}"))
}

#[cfg(test)]
mod tests {
    use std::io;

    use bbcom_workspace::WorkspaceError;
    use bbcom_workspace::container::ContainerCheckpoint;

    use super::*;

    fn delete_request(request_id: &str, workspace_id: &str) -> DeleteWorkspaceRequest {
        DeleteWorkspaceRequest {
            request_id: request_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
        }
    }

    fn add_owned_contribution(service: &mut WorkspaceService, workspace_id: &str) {
        let mutation = serde_json::from_value(serde_json::json!({
            "kind": "upsert-session",
            "sequence": 1,
            "sessionId": "session-a",
            "payload": {
                "name": "Session A",
                "sortOrder": 0,
                "kind": "live",
                "portConfig": {},
                "document": {}
            }
        }))
        .expect("session mutation");
        service
            .apply_batch(ApplyWorkspaceBatchRequest {
                workspace_id: workspace_id.to_owned(),
                client_batch_id: "create-session".to_owned(),
                base_revision: 0,
                mutations: vec![mutation],
            })
            .expect("create session");
        service
            .upsert_plugin_quick_command(
                "session-a",
                &WorkspaceQuickCommand {
                    id: "plugin:dev.bbcom.fixture:status".to_owned(),
                    name: "Status".to_owned(),
                    data: "status".to_owned(),
                    is_hex: false,
                    owner_plugin_id: Some("dev.bbcom.fixture".to_owned()),
                },
            )
            .expect("owned contribution");
    }

    #[test]
    fn uninstall_cleanup_covers_active_and_closed_managed_workspaces() {
        let root = temporary_root("plugin-contribution-cleanup");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let active_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000021").expect("active id");
        let closed_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000022").expect("closed id");
        let mut active = manager
            .library
            .create_project(&active_id, "active", 1)
            .expect("create active");
        add_owned_contribution(&mut active, active_id.as_str());
        commit_active_workspace(&manager, active_id.as_str(), active, "test")
            .expect("commit active");
        let mut closed = manager
            .library
            .create_project(&closed_id, "closed", 2)
            .expect("create closed");
        add_owned_contribution(&mut closed, closed_id.as_str());
        drop(closed);

        let report = manager
            .cleanup_plugin_contributions(
                "dev.bbcom.fixture",
                bbcom_workspace::PluginContributionDisposition::Delete,
            )
            .expect("cleanup all projects");
        assert_eq!(report.quick_commands, 2);
        assert_eq!(report.macros, 0);
        assert!(
            lock_active(&manager, "test")
                .expect("active lock")
                .as_ref()
                .expect("active workspace")
                .hydrate_session_collections("session-a")
                .expect("active collections")
                .quick_commands
                .is_empty()
        );
        assert!(
            manager
                .library
                .open_project(&closed_id)
                .expect("open closed")
                .hydrate_session_collections("session-a")
                .expect("closed collections")
                .quick_commands
                .is_empty()
        );
        drop(manager);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn failed_artifact_action_rolls_back_active_and_closed_contributions() {
        let root = temporary_root("plugin-contribution-rollback");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let active_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000031").expect("active id");
        let closed_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000032").expect("closed id");
        let mut active = manager
            .library
            .create_project(&active_id, "active", 1)
            .expect("create active");
        add_owned_contribution(&mut active, active_id.as_str());
        let active_before = active
            .hydrate_session_collections("session-a")
            .expect("active before");
        commit_active_workspace(&manager, active_id.as_str(), active, "test")
            .expect("commit active");
        let mut closed = manager
            .library
            .create_project(&closed_id, "closed", 2)
            .expect("create closed");
        add_owned_contribution(&mut closed, closed_id.as_str());
        let closed_before = closed
            .hydrate_session_collections("session-a")
            .expect("closed before");
        drop(closed);

        let action_called = std::cell::Cell::new(false);
        let committed = manager
            .with_plugin_contribution_uninstall(
                "dev.bbcom.fixture",
                bbcom_workspace::PluginContributionDisposition::ConvertToUser,
                || {
                    action_called.set(true);
                    false
                },
            )
            .expect("staged uninstall");
        assert!(action_called.get());
        assert!(!committed);
        assert!(!manager.plugin_contribution_intent.exists());
        assert_eq!(
            lock_active(&manager, "test")
                .expect("active lock")
                .as_ref()
                .expect("active workspace")
                .hydrate_session_collections("session-a")
                .expect("active after"),
            active_before
        );
        assert_eq!(
            manager
                .library
                .open_project(&closed_id)
                .expect("open closed")
                .hydrate_session_collections("session-a")
                .expect("closed after"),
            closed_before
        );
        drop(manager);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn successful_artifact_action_commits_cleanup_across_all_workspaces() {
        let root = temporary_root("plugin-contribution-commit");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let active_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000036").expect("active id");
        let closed_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000037").expect("closed id");
        let mut active = manager
            .library
            .create_project(&active_id, "active", 1)
            .expect("create active");
        add_owned_contribution(&mut active, active_id.as_str());
        commit_active_workspace(&manager, active_id.as_str(), active, "test")
            .expect("commit active");
        let mut closed = manager
            .library
            .create_project(&closed_id, "closed", 2)
            .expect("create closed");
        add_owned_contribution(&mut closed, closed_id.as_str());
        drop(closed);

        assert!(
            manager
                .with_plugin_contribution_uninstall(
                    "dev.bbcom.fixture",
                    bbcom_workspace::PluginContributionDisposition::ConvertToUser,
                    || true,
                )
                .expect("staged uninstall")
        );
        for collections in [
            lock_active(&manager, "test")
                .expect("active lock")
                .as_ref()
                .expect("active workspace")
                .hydrate_session_collections("session-a")
                .expect("active collections"),
            manager
                .library
                .open_project(&closed_id)
                .expect("open closed")
                .hydrate_session_collections("session-a")
                .expect("closed collections"),
        ] {
            assert_eq!(collections.quick_commands.len(), 1);
            assert_eq!(collections.quick_commands[0].id, "status");
            assert_eq!(collections.quick_commands[0].owner_plugin_id, None);
        }
        assert!(!manager.plugin_contribution_intent.exists());
        drop(manager);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn durable_contribution_intent_recovers_before_guest_activation() {
        let root = temporary_root("plugin-contribution-recovery");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000033").expect("workspace id");
        let mut service = manager
            .library
            .create_project(&workspace_id, "workspace", 1)
            .expect("create workspace");
        add_owned_contribution(&mut service, workspace_id.as_str());
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active");
        persist_plugin_contribution_intent(
            &manager.plugin_contribution_intent,
            &PluginContributionUninstallIntent {
                format: PLUGIN_CONTRIBUTION_INTENT_FORMAT.to_owned(),
                plugin_id: "dev.bbcom.fixture".to_owned(),
                disposition: DurablePluginContributionDisposition::Delete,
            },
        )
        .expect("persist crash intent");
        drop(manager);

        let recovered = WorkspaceManager::open(&root).expect("reopen manager");
        recovered
            .recover_plugin_contribution_uninstall(&BTreeSet::new())
            .expect("recover absent artifact");
        assert!(!recovered.plugin_contribution_intent.exists());
        assert!(
            lock_active(&recovered, "test")
                .expect("active lock")
                .as_ref()
                .expect("active workspace")
                .hydrate_session_collections("session-a")
                .expect("collections")
                .quick_commands
                .is_empty()
        );
        drop(recovered);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn recovery_preserves_rows_when_artifact_is_still_installed() {
        let root = temporary_root("plugin-contribution-installed-recovery");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000034").expect("workspace id");
        let mut service = manager
            .library
            .create_project(&workspace_id, "workspace", 1)
            .expect("create workspace");
        add_owned_contribution(&mut service, workspace_id.as_str());
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active");
        persist_plugin_contribution_intent(
            &manager.plugin_contribution_intent,
            &PluginContributionUninstallIntent {
                format: PLUGIN_CONTRIBUTION_INTENT_FORMAT.to_owned(),
                plugin_id: "dev.bbcom.fixture".to_owned(),
                disposition: DurablePluginContributionDisposition::ConvertToUser,
            },
        )
        .expect("persist crash intent");
        let installed = BTreeSet::from(["dev.bbcom.fixture".to_owned()]);
        manager
            .recover_plugin_contribution_uninstall(&installed)
            .expect("recover installed artifact");
        let commands = &lock_active(&manager, "test")
            .expect("active lock")
            .as_ref()
            .expect("active workspace")
            .hydrate_session_collections("session-a")
            .expect("collections")
            .quick_commands;
        assert_eq!(commands.len(), 1);
        assert_eq!(
            commands[0].owner_plugin_id.as_deref(),
            Some("dev.bbcom.fixture")
        );
        assert!(!manager.plugin_contribution_intent.exists());
        drop(manager);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn pre_action_staging_failure_clears_intent_for_same_process_retry() {
        let root = temporary_root("plugin-contribution-staging-retry");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000035").expect("workspace id");
        let service = manager
            .library
            .create_project(&workspace_id, "workspace", 1)
            .expect("create workspace");
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active");

        let invalid_action_called = std::cell::Cell::new(false);
        assert!(
            manager
                .with_plugin_contribution_uninstall(
                    "",
                    bbcom_workspace::PluginContributionDisposition::Delete,
                    || {
                        invalid_action_called.set(true);
                        false
                    },
                )
                .is_err()
        );
        assert!(!invalid_action_called.get());
        assert!(!manager.plugin_contribution_intent.exists());

        let retry_action_called = std::cell::Cell::new(false);
        assert!(
            !manager
                .with_plugin_contribution_uninstall(
                    "dev.bbcom.fixture",
                    bbcom_workspace::PluginContributionDisposition::Delete,
                    || {
                        retry_action_called.set(true);
                        false
                    },
                )
                .expect("retry staged uninstall")
        );
        assert!(retry_action_called.get());
        assert!(!manager.plugin_contribution_intent.exists());
        drop(manager);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn last_active_workspace_survives_manager_restart() {
        let root = temporary_root("last-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000011").expect("workspace id");
        let service = manager
            .library
            .create_project(&workspace_id, "last active", 1)
            .expect("create project");
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active");
        drop(manager);

        let reopened = WorkspaceManager::open(&root).expect("reopen manager");
        let active = lock_active(&reopened, "test").expect("active lock");
        let header = active
            .as_ref()
            .expect("restored active project")
            .header()
            .expect("active header");
        assert_eq!(header.workspace_id, workspace_id.as_str());
        drop(active);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn stale_active_marker_does_not_block_catalog_startup() {
        let root = temporary_root("stale-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        persist_active_workspace(
            &manager.active_marker,
            &WorkspaceUuid::parse("00000000-0000-4000-8000-000000000012").expect("workspace id"),
        )
        .expect("persist stale marker");
        drop(manager);

        let reopened = WorkspaceManager::open(&root).expect("reopen manager");
        assert!(
            lock_active(&reopened, "test")
                .expect("active lock")
                .is_none()
        );
        assert!(!reopened.active_marker.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn non_utf8_active_marker_does_not_block_catalog_startup() {
        let root = temporary_root("non-utf8-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        fs::write(&manager.active_marker, [0xff, 0xfe, 0xfd]).expect("write malformed marker");
        drop(manager);

        let reopened = WorkspaceManager::open(&root).expect("reopen manager");
        assert!(
            lock_active(&reopened, "test")
                .expect("active lock")
                .is_none()
        );
        assert!(!reopened.active_marker.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn reset_workspace_creation_is_idempotent_and_verification_is_strict() {
        let root = temporary_root("reset-workspace");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id = "00000000-0000-4000-8000-000000000021";

        manager
            .ensure_empty_reset_workspace(workspace_id, "reset", 0, 10, "test")
            .expect("create reset workspace");
        manager
            .ensure_empty_reset_workspace(workspace_id, "reset", 0, 20, "test")
            .expect("resume reset workspace creation");
        manager
            .verify_empty_reset_workspace(workspace_id, "reset", 0, "test")
            .expect("verify reset workspace");

        for (name, revision) in [("wrong", 0), ("reset", 1)] {
            let error = manager
                .verify_empty_reset_workspace(workspace_id, name, revision, "test")
                .unwrap_err();
            assert_eq!(error.code, AppErrorCode::WorkspaceCorrupt);
            assert_eq!(error.field, Some("workspaceId"));
        }
        assert_eq!(
            manager
                .verify_empty_reset_workspace("invalid", "reset", 0, "test")
                .unwrap_err()
                .code,
            AppErrorCode::InvalidInput
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn active_workspace_requires_an_exact_active_identity() {
        let root = temporary_root("active-identity");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let absent = active_workspace(&manager, "missing", "test").unwrap_err();
        assert_eq!(absent.field, Some("workspaceId"));

        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000022").expect("workspace id");
        let service = manager
            .library
            .create_project(&workspace_id, "active", 1)
            .expect("create active workspace");
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active workspace");
        assert!(active_workspace(&manager, workspace_id.as_str(), "test").is_ok());
        assert_eq!(
            active_workspace(&manager, "00000000-0000-4000-8000-000000000023", "test")
                .unwrap_err()
                .field,
            Some("workspaceId")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_removes_a_closed_workspace_and_echoes_the_request_identity() {
        let root = temporary_root("delete-closed-workspace");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000031").expect("workspace id");
        drop(
            manager
                .library
                .create_project(&workspace_id, "closed", 1)
                .expect("create closed"),
        );

        let response = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-closed", workspace_id.as_str()),
        )
        .expect("delete closed workspace");
        assert_eq!(response.request_id, "delete-closed");
        assert_eq!(response.workspace_id, workspace_id.as_str());
        assert!(!manager.library.contains(&workspace_id));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_closes_and_removes_the_active_workspace_writer() {
        let root = temporary_root("delete-active-workspace");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000032").expect("workspace id");
        let active = manager
            .library
            .create_project(&workspace_id, "active", 1)
            .expect("create active");
        commit_active_workspace(&manager, workspace_id.as_str(), active, "test")
            .expect("commit active");

        let response = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-active", workspace_id.as_str()),
        )
        .expect("delete active workspace");
        assert_eq!(response.workspace_id, workspace_id.as_str());
        assert!(!manager.library.contains(&workspace_id));
        assert!(lock_active(&manager, "test").unwrap().is_none());
        assert!(!manager.active_marker.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_requires_the_main_window_capability() {
        let root = temporary_root("delete-window-capability");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let error = delete_workspace_from_label(
            &manager,
            "ai-terminal",
            delete_request("delete-denied", "00000000-0000-4000-8000-000000000033"),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::SecurityDenied);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_rejects_an_invalid_request_id_before_parsing_the_workspace() {
        let root = temporary_root("delete-request-id");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("invalid request", "not-a-workspace"),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("requestId"));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_rejects_an_invalid_workspace_id() {
        let root = temporary_root("delete-workspace-id");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-invalid", "not-a-workspace"),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("workspaceId"));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_rejects_a_missing_managed_workspace() {
        let root = temporary_root("delete-missing-workspace");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-missing", "00000000-0000-4000-8000-000000000034"),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("workspaceId"));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_preserves_an_unrelated_active_workspace() {
        let root = temporary_root("delete-preserve-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let active_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000035").expect("active id");
        let closed_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000036").expect("closed id");
        let active = manager
            .library
            .create_project(&active_id, "active", 1)
            .expect("create active");
        commit_active_workspace(&manager, active_id.as_str(), active, "test")
            .expect("commit active");
        drop(
            manager
                .library
                .create_project(&closed_id, "closed", 1)
                .expect("create closed"),
        );

        delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-closed", closed_id.as_str()),
        )
        .expect("delete closed workspace");
        assert!(manager.library.contains(&active_id));
        assert!(!manager.library.contains(&closed_id));
        assert_eq!(
            lock_active(&manager, "test")
                .expect("active lock")
                .as_ref()
                .expect("active workspace")
                .summary()
                .expect("active summary")
                .workspace_id,
            active_id.as_str()
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn repeated_deletion_fails_closed_after_the_first_commit() {
        let root = temporary_root("delete-repeated");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000037").expect("workspace id");
        drop(
            manager
                .library
                .create_project(&workspace_id, "closed", 1)
                .expect("create closed"),
        );

        delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-first", workspace_id.as_str()),
        )
        .expect("first delete");
        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-second", workspace_id.as_str()),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("workspaceId"));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_rejects_an_oversized_request_id() {
        let root = temporary_root("delete-oversized-request");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request(&"a".repeat(129), "00000000-0000-4000-8000-000000000038"),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("requestId"));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_rejects_a_noncanonical_workspace_uuid() {
        let root = temporary_root("delete-noncanonical-workspace");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-noncanonical", "00000000000040008000000000000039"),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("workspaceId"));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn deletion_fails_busy_without_committing_when_the_active_lock_is_poisoned() {
        let root = temporary_root("delete-poisoned-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000040").expect("workspace id");
        drop(
            manager
                .library
                .create_project(&workspace_id, "closed", 1)
                .expect("create closed"),
        );
        std::thread::scope(|scope| {
            assert!(
                scope
                    .spawn(|| {
                        let _active = manager.active.lock().expect("active lock");
                        panic!("poison active lock");
                    })
                    .join()
                    .is_err()
            );
        });

        let error = delete_workspace_from_label(
            &manager,
            "main",
            delete_request("delete-poisoned", workspace_id.as_str()),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::Busy);
        assert!(manager.library.contains(&workspace_id));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn oversized_and_malformed_active_markers_fail_closed() {
        for (label, bytes) in [
            (
                "oversized",
                vec![b'a'; MAX_ACTIVE_WORKSPACE_FILE_BYTES as usize + 1],
            ),
            ("malformed", b"not-a-workspace-id\n".to_vec()),
        ] {
            let root = temporary_root(label);
            let manager = WorkspaceManager::open(&root).expect("open manager");
            fs::write(&manager.active_marker, bytes).expect("write invalid marker");
            drop(manager);

            let reopened = WorkspaceManager::open(&root).expect("ignore invalid marker");
            assert!(lock_active(&reopened, "test").unwrap().is_none());
            assert!(!reopened.active_marker.exists());
            fs::remove_dir_all(root).expect("remove test root");
        }
    }

    #[test]
    fn workspace_input_validators_cover_encryption_paths_and_file_targets() {
        let root = temporary_root("validators");
        fs::create_dir_all(&root).expect("create root");
        let source = root.join("source.BBCOM");
        fs::write(&source, b"project").expect("write source");
        assert!(validate_project_path(&source, true, "test").is_ok());
        assert!(validate_project_path(&root.join("target.BBCOM"), false, "test").is_ok());
        let directory_target = root.join("directory.bbcom");
        fs::create_dir(&directory_target).expect("create directory target");
        assert!(validate_project_path(&directory_target, false, "test").is_err());
        assert!(validate_project_path(&root.join("wrong.txt"), false, "test").is_err());
        assert!(validate_project_file_name("Project.BBCOM", "test").is_ok());
        for invalid in [
            "",
            "nested/project.bbcom",
            "nested\\project.bbcom",
            "project.txt",
        ] {
            assert!(validate_project_file_name(invalid, "test").is_err());
        }
        assert_eq!(
            project_display_name(&source, "test").expect("display name"),
            "source.BBCOM"
        );

        assert!(
            validate_encryption(
                ProjectEncryptionOptions {
                    mode: ProjectEncryptionMode::Plaintext,
                    passphrase: None,
                },
                "test"
            )
            .expect("plaintext")
            .is_none()
        );
        assert!(
            validate_encryption(
                ProjectEncryptionOptions {
                    mode: ProjectEncryptionMode::AgePassphrase,
                    passphrase: Some("twelve-chars".to_owned()),
                },
                "test"
            )
            .expect("encrypted")
            .is_some()
        );
        for encryption in [
            ProjectEncryptionOptions {
                mode: ProjectEncryptionMode::Plaintext,
                passphrase: Some("unexpected-secret".to_owned()),
            },
            ProjectEncryptionOptions {
                mode: ProjectEncryptionMode::AgePassphrase,
                passphrase: None,
            },
            ProjectEncryptionOptions {
                mode: ProjectEncryptionMode::AgePassphrase,
                passphrase: Some("too-short".to_owned()),
            },
        ] {
            assert!(validate_encryption(encryption, "test").is_err());
        }

        for valid in ["request", "request.id_1:value-2"] {
            assert!(validate_opaque_id(valid, "requestId", "test").is_ok());
        }
        for invalid in ["", "bad id", "bad/path"] {
            assert!(validate_opaque_id(invalid, "requestId", "test").is_err());
        }
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_error_mapping_preserves_stable_codes_and_bounds() {
        let invalid = project_error(
            ProjectContainerError::InvalidInput { field: "source" },
            "test",
        );
        assert_eq!(
            (invalid.code, invalid.field),
            (AppErrorCode::InvalidInput, Some("source"))
        );

        let limited = project_error(
            ProjectContainerError::LimitExceeded {
                field: "frames",
                limit: 4,
                actual: 5,
            },
            "test",
        );
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!((limited.limit, limited.actual), (Some(4), Some(5)));
        assert_eq!(
            project_error(
                ProjectContainerError::Cancelled {
                    checkpoint: ContainerCheckpoint::ImportCopy,
                },
                "test"
            )
            .code,
            AppErrorCode::Cancelled
        );
        assert_eq!(
            project_error(ProjectContainerError::AlreadyExists, "test").field,
            Some("workspaceId")
        );
        for error in [
            ProjectContainerError::Integrity,
            ProjectContainerError::AgeStream,
        ] {
            assert_eq!(
                project_error(error, "test").code,
                AppErrorCode::WorkspaceCorrupt
            );
        }
        assert_eq!(
            project_error(
                ProjectContainerError::Workspace(WorkspaceError::ReadOnly),
                "test"
            )
            .code,
            AppErrorCode::WorkspaceReadOnly
        );
        assert_eq!(
            project_error(
                ProjectContainerError::Io(io::Error::from(io::ErrorKind::PermissionDenied)),
                "test"
            )
            .code,
            AppErrorCode::IoPermissionDenied
        );
        assert_eq!(
            project_error(
                ProjectContainerError::AgeIo(io::Error::from(io::ErrorKind::StorageFull)),
                "test"
            )
            .code,
            AppErrorCode::IoDiskFull
        );
        assert!(
            project_error(
                ProjectContainerError::Io(io::Error::from(io::ErrorKind::Other)),
                "test"
            )
            .retryable
        );
    }
}
