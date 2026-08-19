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

use std::collections::HashMap;
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
    WorkspaceCatalogRequest, WorkspaceCatalogResponse,
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

#[derive(Debug)]
pub struct WorkspaceManager {
    library: ProjectLibrary,
    active: Mutex<Option<WorkspaceService>>,
    active_marker: PathBuf,
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
        let active = read_active_workspace(&library, &active_marker)?;
        Ok(Self {
            library,
            active: Mutex::new(active),
            active_marker,
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
                    if let Some(bytes) = item.project_state {
                        match bbcom_plugin_manager::OpaqueProjectPluginState::new(
                            item.plugin_id,
                            bytes,
                        ) {
                            Ok(state) => states.push(state),
                            Err(_) => skipped += 1,
                        }
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
