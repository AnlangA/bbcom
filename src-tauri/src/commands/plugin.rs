//! Main-window-only plugin-center boundary.
//!
//! This module owns validation and correlation, but deliberately does not own
//! a concrete plugin service. Application setup injects one implementation of
//! [`PluginCommandService`] into [`PluginCommandState`].

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    AddPluginSourceRequest, AppErrorCode, CancelPluginOperationRequest, CancelPluginTaskRequestV2,
    EmitPluginSurfaceEventRequestV2, InstallLocalPluginRequest, InstallPluginRequest,
    InstalledPluginView, IpcError, MAX_INSTALLED_PLUGINS, MAX_PLUGIN_CATALOG_ITEMS,
    MAX_PLUGIN_DESCRIPTION_BYTES, MAX_PLUGIN_DISPLAY_NAME_BYTES, MAX_PLUGIN_ID_BYTES,
    MAX_PLUGIN_VERSION_BYTES, PluginCatalogItem, PluginCenterData, PluginCommandResponse,
    PluginDetachedSurfaceEventRequestV2, PluginDetachedSurfaceSnapshotRequestV2,
    PluginDetachedSurfaceViewV2, PluginDetachedTaskCancelRequestV2,
    PluginHostContextUpdateRequestV2, PluginLocalSourceGrantResponse, PluginLocalSourceKind,
    PluginSerialCapabilityReplyRequestV2, PluginSnapshotRequest, PluginSourceKind,
    PluginSourceView, RefreshPluginSourceRequest, RemovePluginSourceRequest,
    RequestPluginLocalSourceGrantRequest, RunPluginCommandRequestV2, RuntimeInstanceKey,
    SetPluginEnabledRequest, SetPluginSurfacePlacementRequestV2, SetPluginWatchEnabledRequest,
    UninstallPluginRequest, UpdatePluginSourceRequest,
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PLUGIN_CAPABILITIES: usize = 64;
const MAX_PLUGIN_SOURCES: usize = 64;
const LOCAL_GRANT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_LOCAL_GRANTS: usize = 16;

struct PluginLocalGrant {
    path: PathBuf,
    kind: PluginLocalSourceKind,
    issued_at: Instant,
}

#[derive(Default)]
pub struct PluginLocalGrantState {
    grants: Mutex<HashMap<String, PluginLocalGrant>>,
}

impl PluginLocalGrantState {
    fn issue(&self, path: PathBuf, kind: PluginLocalSourceKind) -> Result<String, IpcError> {
        let mut grants = self.grants.lock().map_err(|_| {
            IpcError::new(AppErrorCode::Busy, "error.busy", true, "plugin_local_grant")
        })?;
        grants.retain(|_, grant| grant.issued_at.elapsed() <= LOCAL_GRANT_TTL);
        if grants.len() >= MAX_LOCAL_GRANTS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                "plugin_local_grant",
            ));
        }
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| {
            IpcError::new(
                AppErrorCode::IoPermissionDenied,
                "error.io_permission_denied",
                true,
                "plugin_local_grant",
            )
        })?;
        let grant_id = format!(
            "plugin-grant-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        grants.insert(
            grant_id.clone(),
            PluginLocalGrant {
                path,
                kind,
                issued_at: Instant::now(),
            },
        );
        Ok(grant_id)
    }

    fn consume(&self, grant_id: &str) -> Result<PluginLocalGrant, IpcError> {
        let mut grants = self.grants.lock().map_err(|_| {
            IpcError::new(
                AppErrorCode::Busy,
                "error.busy",
                true,
                "plugin_install_local",
            )
        })?;
        grants.retain(|_, grant| grant.issued_at.elapsed() <= LOCAL_GRANT_TTL);
        grants
            .remove(grant_id)
            .ok_or_else(|| IpcError::invalid_input("plugin_install_local", "grantId"))
    }
}

/// Fully typed command passed to the injected application service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginCommand {
    Snapshot(PluginSnapshotRequest),
    Install(InstallPluginRequest),
    InstallLocal {
        request: InstallLocalPluginRequest,
        package_root: PathBuf,
    },
    Uninstall(UninstallPluginRequest),
    SetEnabled(SetPluginEnabledRequest),
    CancelOperation(CancelPluginOperationRequest),
}

impl PluginCommand {
    fn correlation(&self) -> (&str, u64, &str) {
        match self {
            Self::Snapshot(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::Install(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::InstallLocal { request, .. } => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::Uninstall(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::SetEnabled(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::CancelOperation(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
        }
    }
}

#[tauri::command]
pub async fn plugin_request_local_source_grant(
    app: AppHandle,
    window: WebviewWindow,
    request: RequestPluginLocalSourceGrantRequest,
) -> Result<PluginLocalSourceGrantResponse, IpcError> {
    const OPERATION: &str = "plugin_request_local_source_grant";
    require_main_window_label(window.label(), OPERATION)?;
    validate_identity(&request.request_id, "requestId", OPERATION)?;
    let selected =
        tauri::async_runtime::spawn_blocking(move || window.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| {
                IpcError::new(
                    AppErrorCode::IoPermissionDenied,
                    "error.io_permission_denied",
                    true,
                    OPERATION,
                )
            })?
            .ok_or_else(|| {
                IpcError::new(AppErrorCode::Cancelled, "error.cancelled", true, OPERATION)
            })?;
    let path = selected
        .into_path()
        .map_err(|_| IpcError::invalid_input(OPERATION, "source"))?;
    validate_local_package_root(&path, OPERATION)?;
    let path =
        std::fs::canonicalize(path).map_err(|_| IpcError::invalid_input(OPERATION, "source"))?;
    validate_local_package_root(&path, OPERATION)?;
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| IpcError::invalid_input(OPERATION, "source"))?
        .to_owned();
    let grant_id = app
        .state::<PluginLocalGrantState>()
        .issue(path, request.source_kind)?;
    Ok(PluginLocalSourceGrantResponse {
        request_id: request.request_id,
        grant_id,
        display_name,
        source_kind: request.source_kind,
    })
}

/// Injection port. The boundary has no dependency on `PluginService` or a
/// repository/host implementation.
pub trait PluginCommandService: Send + Sync + 'static {
    fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError>;
}

/// Fail-closed service installed until the native repository,
/// host and broker graph has passed the platform release gate. Keeping an
/// explicit state object avoids Tauri leaking an unstructured missing-state
/// error while still exposing no partial plugin behavior.
pub struct UnavailablePluginCommandService;

impl PluginCommandService for UnavailablePluginCommandService {
    fn execute(&self, _command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
        Err(IpcError::new(
            AppErrorCode::SecurityDenied,
            "error.plugin_permission_denied",
            false,
            "plugin_command",
        ))
    }
}

/// Managed command-service holder. Native setup installs the fail-closed
/// [`UnavailablePluginCommandService`] first and may replace it exactly once
/// after the production plugin runtime composed.
#[derive(Clone)]
pub struct PluginCommandState {
    service: Arc<Mutex<Arc<dyn PluginCommandService>>>,
}

impl PluginCommandState {
    pub fn new(service: Arc<dyn PluginCommandService>) -> Self {
        Self {
            service: Arc::new(Mutex::new(service)),
        }
    }

    /// Snapshot of the injected service, safe to move onto a blocking thread.
    pub fn current_service(&self) -> Arc<dyn PluginCommandService> {
        Arc::clone(
            &*self
                .service
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    /// Replaces the injected service after successful native composition.
    pub fn replace_service(&self, service: Arc<dyn PluginCommandService>) {
        *self
            .service
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = service;
    }
}

#[tauri::command]
pub async fn plugin_center_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    request: PluginSnapshotRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_async(
        app.clone(),
        window,
        "plugin_center_snapshot",
        PluginCommand::Snapshot(request),
    )
    .await
}

#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    window: WebviewWindow,
    request: InstallPluginRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_async(
        app.clone(),
        window,
        "plugin_install",
        PluginCommand::Install(request),
    )
    .await
}

#[tauri::command]
pub async fn plugin_install_local(
    app: AppHandle,
    window: WebviewWindow,
    request: InstallLocalPluginRequest,
) -> Result<PluginCommandResponse, IpcError> {
    validate_identity(&request.grant_id, "grantId", "plugin_install_local")?;
    let grant = app
        .state::<PluginLocalGrantState>()
        .consume(&request.grant_id)?;
    if grant.kind != PluginLocalSourceKind::LocalPackage
        && grant.kind != PluginLocalSourceKind::DevDirectory
    {
        return Err(IpcError::security_denied("plugin_install_local"));
    }
    let dev_source = if grant.kind == PluginLocalSourceKind::DevDirectory {
        let manifest = std::fs::read_to_string(grant.path.join("plugin.toml"))
            .ok()
            .and_then(|text| bbcom_plugin_contracts::PluginManifest::parse(&text).ok())
            .ok_or_else(|| IpcError::invalid_input("plugin_install_local", "source"))?;
        Some((manifest.id, manifest.name, grant.path.clone()))
    } else {
        None
    };
    let mut response = dispatch_async(
        app.clone(),
        window,
        "plugin_install_local",
        PluginCommand::InstallLocal {
            request,
            package_root: grant.path,
        },
    )
    .await?;
    if let Some((plugin_id, display_name, path)) = dev_source {
        app.state::<Arc<crate::plugins::NativePluginSourceRegistry>>()
            .add_or_update_dev_directory(&plugin_id, display_name, path)
            .map_err(|_| IpcError::invalid_input("plugin_install_local", "source"))?;
        attach_sources(&app, &mut response, "plugin_install_local")?;
    }
    Ok(response)
}

#[tauri::command]
pub async fn plugin_uninstall(
    app: AppHandle,
    window: WebviewWindow,
    request: UninstallPluginRequest,
) -> Result<PluginCommandResponse, IpcError> {
    let plugin_id = request.plugin_id.clone();
    let mut response = dispatch_async(
        app.clone(),
        window,
        "plugin_uninstall",
        PluginCommand::Uninstall(request),
    )
    .await?;
    if matches!(response, PluginCommandResponse::Completed { .. }) {
        let _ = app
            .state::<Arc<crate::plugins::NativePluginSourceRegistry>>()
            .remove_dev_directory(&plugin_id);
    }
    attach_sources(&app, &mut response, "plugin_uninstall")?;
    Ok(response)
}

#[tauri::command]
pub async fn plugin_set_enabled(
    app: AppHandle,
    window: WebviewWindow,
    request: SetPluginEnabledRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_async(
        app,
        window,
        "plugin_set_enabled",
        PluginCommand::SetEnabled(request),
    )
    .await
}

#[tauri::command]
pub async fn plugin_source_add(
    app: AppHandle,
    window: WebviewWindow,
    request: AddPluginSourceRequest,
) -> Result<PluginCommandResponse, IpcError> {
    let source_id = request.source_id.clone();
    let url = request.url.clone();
    let enabled = request.enabled;
    mutate_source(
        app,
        window,
        "plugin_source_add",
        request.request_id,
        request.revision,
        request.operation_id,
        move |registry| registry.add_https(source_id, url, enabled),
    )
    .await
}

#[tauri::command]
pub async fn plugin_source_update(
    app: AppHandle,
    window: WebviewWindow,
    request: UpdatePluginSourceRequest,
) -> Result<PluginCommandResponse, IpcError> {
    let source_id = request.source_id.clone();
    let url = request.url.clone();
    let enabled = request.enabled;
    mutate_source(
        app,
        window,
        "plugin_source_update",
        request.request_id,
        request.revision,
        request.operation_id,
        move |registry| registry.update_https(&source_id, url, enabled),
    )
    .await
}

#[tauri::command]
pub async fn plugin_source_remove(
    app: AppHandle,
    window: WebviewWindow,
    request: RemovePluginSourceRequest,
) -> Result<PluginCommandResponse, IpcError> {
    let source_id = request.source_id.clone();
    mutate_source(
        app,
        window,
        "plugin_source_remove",
        request.request_id,
        request.revision,
        request.operation_id,
        move |registry| registry.remove(&source_id),
    )
    .await
}

#[tauri::command]
pub async fn plugin_source_refresh(
    app: AppHandle,
    window: WebviewWindow,
    request: RefreshPluginSourceRequest,
) -> Result<PluginCommandResponse, IpcError> {
    let source_id = request.source_id.clone();
    mutate_source(
        app,
        window,
        "plugin_source_refresh",
        request.request_id,
        request.revision,
        request.operation_id,
        move |registry| registry.refresh(&source_id),
    )
    .await
}

#[tauri::command]
pub async fn plugin_set_watch_enabled(
    app: AppHandle,
    window: WebviewWindow,
    request: SetPluginWatchEnabledRequest,
) -> Result<PluginCommandResponse, IpcError> {
    let source_id = request.source_id.clone();
    let enabled = request.enabled;
    mutate_source(
        app,
        window,
        "plugin_set_watch_enabled",
        request.request_id,
        request.revision,
        request.operation_id,
        move |registry| registry.set_watch_enabled(&source_id, enabled),
    )
    .await
}

#[tauri::command]
pub async fn plugin_emit_surface_event_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: EmitPluginSurfaceEventRequestV2,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_v2_ui_action(
        app,
        window,
        "plugin_emit_surface_event_v2",
        crate::plugins::PluginUiActionV2::EmitSurfaceEvent(request),
    )
    .await
}

#[tauri::command]
pub async fn plugin_cancel_task_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: CancelPluginTaskRequestV2,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_v2_ui_action(
        app,
        window,
        "plugin_cancel_task_v2",
        crate::plugins::PluginUiActionV2::CancelTask(request),
    )
    .await
}

#[tauri::command]
pub async fn plugin_run_command_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: RunPluginCommandRequestV2,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_v2_ui_action(
        app,
        window,
        "plugin_run_command_v2",
        crate::plugins::PluginUiActionV2::RunCommand(request),
    )
    .await
}

#[tauri::command]
pub async fn plugin_set_surface_placement_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: SetPluginSurfacePlacementRequestV2,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_v2_ui_action(
        app,
        window,
        "plugin_set_surface_placement_v2",
        crate::plugins::PluginUiActionV2::SetSurfacePlacement(request),
    )
    .await
}

/// Token-bound read model for a least-privilege detached plugin window. The
/// exact window label is part of the grant and the command exposes no plugin
/// catalog, serial, filesystem, or main-window capability.
#[tauri::command]
pub async fn plugin_detached_surface_snapshot_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: PluginDetachedSurfaceSnapshotRequestV2,
) -> Result<PluginDetachedSurfaceViewV2, IpcError> {
    const OPERATION: &str = "plugin_detached_surface_snapshot_v2";
    app.state::<Arc<crate::plugins::PluginDetachedWindowServiceV2>>()
        .snapshot(window.label(), &request.token)
        .ok_or_else(|| IpcError::security_denied(OPERATION))
}

#[tauri::command]
pub async fn plugin_detached_emit_surface_event_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: PluginDetachedSurfaceEventRequestV2,
) -> Result<(), IpcError> {
    let action = app
        .state::<Arc<crate::plugins::PluginDetachedWindowServiceV2>>()
        .surface_action(window.label(), &request)?;
    dispatch_detached_v2_ui_action(
        app,
        "plugin_detached_emit_surface_event_v2",
        crate::plugins::PluginUiActionV2::EmitSurfaceEvent(action),
    )
    .await
}

#[tauri::command]
pub async fn plugin_detached_cancel_task_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: PluginDetachedTaskCancelRequestV2,
) -> Result<(), IpcError> {
    let action = app
        .state::<Arc<crate::plugins::PluginDetachedWindowServiceV2>>()
        .task_cancel_action(window.label(), &request)?;
    dispatch_detached_v2_ui_action(
        app,
        "plugin_detached_cancel_task_v2",
        crate::plugins::PluginUiActionV2::CancelTask(action),
    )
    .await
}

#[tauri::command]
pub async fn plugin_cancel_operation(
    app: AppHandle,
    window: WebviewWindow,
    request: CancelPluginOperationRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch_async(
        app,
        window,
        "plugin_cancel_operation",
        PluginCommand::CancelOperation(request),
    )
    .await
}

/// Completes one exact protocol-v2 serial capability correlation. Only the
/// main window can answer; stale, duplicated, cross-runtime and malformed
/// replies never wake a sidecar waiter.
#[tauri::command]
pub async fn plugin_serial_capability_reply_v2(
    app: AppHandle,
    window: WebviewWindow,
    request: PluginSerialCapabilityReplyRequestV2,
) -> Result<(), IpcError> {
    const OPERATION: &str = "plugin_serial_capability_reply_v2";
    require_main_window_label(window.label(), OPERATION)?;
    let registry = app
        .try_state::<Arc<crate::plugins::SerialCapabilityCorrelationRegistryV2>>()
        .ok_or_else(|| IpcError::security_denied(OPERATION))?;
    registry
        .complete(request.event)
        .map_err(|error| match error {
            crate::plugins::SerialCapabilityReplyErrorV2::Unavailable => {
                IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION)
            }
            crate::plugins::SerialCapabilityReplyErrorV2::UnknownCorrelation
            | crate::plugins::SerialCapabilityReplyErrorV2::ContextMismatch
            | crate::plugins::SerialCapabilityReplyErrorV2::InvalidShape => {
                IpcError::invalid_input(OPERATION, "event")
            }
        })
}

/// Signals only that physical port membership changed. The renderer supplies
/// no runtime identity, opaque port identifier, or native system path; the
/// manager derives the authorized active targets from native state.
#[tauri::command]
pub async fn plugin_notify_port_catalog_changed_v2(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), IpcError> {
    const OPERATION: &str = "plugin_notify_port_catalog_changed_v2";
    require_main_window_label(window.label(), OPERATION)?;
    let handle = app
        .try_state::<crate::plugins::PluginLifecycleHandle>()
        .ok_or_else(|| IpcError::security_denied(OPERATION))?;
    let lifecycle = handle
        .current()
        .ok_or_else(|| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))?;
    tauri::async_runtime::spawn_blocking(move || lifecycle.notify_port_catalog_changed())
        .await
        .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))?
        .map(|_| ())
        .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))
}

/// Updates the native initialization projection from the real, hydrated main
/// application state. Runtime identities are never supplied by the renderer;
/// appearance changes are broadcast only through the manager's active set.
#[tauri::command]
pub async fn plugin_update_host_context_v2(
    app: AppHandle,
    window: WebviewWindow,
    mut request: PluginHostContextUpdateRequestV2,
) -> Result<(), IpcError> {
    const OPERATION: &str = "plugin_update_host_context_v2";
    require_main_window_label(window.label(), OPERATION)?;
    let active_workspace = app
        .try_state::<crate::commands::workspace::WorkspaceManager>()
        .and_then(|manager| manager.plugin_workspace_snapshot())
        .map(|snapshot| snapshot.workspace_id);
    if request.workspace_id.is_some() && request.workspace_id != active_workspace {
        return Err(IpcError::invalid_input(OPERATION, "workspaceId"));
    }
    request.workspace_id = active_workspace;
    let context = app
        .try_state::<Arc<crate::plugins::PluginHostContextStoreV2>>()
        .ok_or_else(|| IpcError::security_denied(OPERATION))?;
    let changes = context
        .update(request)
        .map_err(|_| IpcError::invalid_input(OPERATION, "context"))?;
    // Runtime composition is intentionally deferred until this first trusted,
    // hydrated main-window projection exists. Existing enabled plugins are
    // therefore initialized with real locale/theme/session summaries instead
    // of setup-time placeholders.
    crate::plugins::ensure_plugin_runtime(&app);
    if changes.locale.is_none() && changes.theme.is_none() {
        return Ok(());
    }
    let Some(lifecycle) = app
        .try_state::<crate::plugins::PluginLifecycleHandle>()
        .and_then(|handle| handle.current())
    else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        lifecycle.notify_host_context_changed(changes.locale, changes.theme)
    })
    .await
    .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))?
    .map(|_| ())
    .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))
}

/// Runs one plugin command on a blocking thread so the injected service's
/// internal timeouts and poll loops never occupy the async runtime.
async fn dispatch_async(
    app: AppHandle,
    window: WebviewWindow,
    operation: &'static str,
    command: PluginCommand,
) -> Result<PluginCommandResponse, IpcError> {
    let service = app.state::<PluginCommandState>().current_service();
    let label = window.label().to_owned();
    let mut response =
        tauri::async_runtime::spawn_blocking(move || dispatch(&label, service, operation, command))
            .await
            .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))??;
    attach_sources(&app, &mut response, operation)?;
    Ok(response)
}

async fn dispatch_v2_ui_action(
    app: AppHandle,
    window: WebviewWindow,
    operation: &'static str,
    action: crate::plugins::PluginUiActionV2,
) -> Result<PluginCommandResponse, IpcError> {
    let service = app
        .state::<crate::plugins::PluginUiActionStateV2>()
        .current_service();
    let label = window.label().to_owned();
    let mut response = tauri::async_runtime::spawn_blocking(move || {
        require_main_window_label(&label, operation)?;
        validate_v2_ui_action(&action, operation)?;
        let (request_id, revision, operation_id) = action.correlation();
        let request_id = request_id.to_owned();
        let operation_id = operation_id.to_owned();
        let response =
            service
                .execute(action)
                .map_err(|error| match error.request_id.as_deref() {
                    None => error.with_request_id(&request_id),
                    Some(error_request_id) if error_request_id == request_id => error,
                    Some(_) => invalid_response(operation, "error.requestId", &request_id),
                })?;
        validate_response(&response, &request_id, revision, &operation_id, operation)?;
        Ok::<_, IpcError>(response)
    })
    .await
    .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))??;
    attach_sources(&app, &mut response, operation)?;
    Ok(response)
}

async fn dispatch_detached_v2_ui_action(
    app: AppHandle,
    operation: &'static str,
    action: crate::plugins::PluginUiActionV2,
) -> Result<(), IpcError> {
    validate_v2_ui_action(&action, operation)?;
    let (request_id, revision, operation_id) = action.correlation();
    let request_id = request_id.to_owned();
    let operation_id = operation_id.to_owned();
    let service = app
        .state::<crate::plugins::PluginUiActionStateV2>()
        .current_service();
    let response = tauri::async_runtime::spawn_blocking(move || service.execute(action))
        .await
        .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))??;
    validate_response(&response, &request_id, revision, &operation_id, operation)?;
    match response {
        PluginCommandResponse::Completed { .. } => Ok(()),
        PluginCommandResponse::Cancelled { .. } => Err(IpcError::new(
            AppErrorCode::Cancelled,
            "error.cancelled",
            true,
            operation,
        )),
        PluginCommandResponse::Failed { .. } => Err(IpcError::new(
            AppErrorCode::Busy,
            "error.busy",
            true,
            operation,
        )),
    }
}

fn validate_v2_ui_action(
    action: &crate::plugins::PluginUiActionV2,
    operation: &'static str,
) -> Result<(), IpcError> {
    let (request_id, revision, operation_id) = action.correlation();
    validate_identity(request_id, "requestId", operation)?;
    validate_identity(operation_id, "operationId", operation)?;
    validate_revision(revision, "revision", operation)?;
    match action {
        crate::plugins::PluginUiActionV2::EmitSurfaceEvent(request) => {
            validate_runtime_instance_key(&request.event.runtime, operation)?;
            validate_identity(&request.event.surface_id, "surfaceId", operation)?;
            if request.event.revision == 0 {
                return Err(IpcError::invalid_input(operation, "surfaceRevision"));
            }
            validate_revision(request.event.revision, "surfaceRevision", operation)?;
            validate_identity(&request.event.node_id, "nodeId", operation)?;
            if let Some(value) = &request.event.value {
                validate_display_text(value, 4096, true, "event.value", operation)?;
            }
            Ok(())
        }
        crate::plugins::PluginUiActionV2::CancelTask(request) => {
            validate_runtime_instance_key(&request.runtime, operation)?;
            validate_identity(&request.task_id, "taskId", operation)
        }
        crate::plugins::PluginUiActionV2::RunCommand(request) => {
            validate_runtime_instance_key(&request.runtime, operation)?;
            validate_identity(&request.command_id, "commandId", operation)
        }
        crate::plugins::PluginUiActionV2::SetSurfacePlacement(request) => {
            validate_runtime_instance_key(&request.runtime, operation)?;
            validate_identity(&request.surface_id, "surfaceId", operation)
        }
    }
}

async fn mutate_source<F>(
    app: AppHandle,
    window: WebviewWindow,
    operation: &'static str,
    request_id: String,
    revision: u64,
    operation_id: String,
    mutation: F,
) -> Result<PluginCommandResponse, IpcError>
where
    F: FnOnce(
            &crate::plugins::NativePluginSourceRegistry,
        ) -> Result<(), crate::plugins::SourceRegistryError>
        + Send
        + 'static,
{
    require_main_window_label(window.label(), operation)?;
    validate_identity(&request_id, "requestId", operation)?;
    validate_identity(&operation_id, "operationId", operation)?;
    validate_revision(revision, "revision", operation)?;
    let external_request_id = request_id.clone();
    let external_operation_id = operation_id.clone();
    dispatch_async(
        app.clone(),
        window.clone(),
        operation,
        PluginCommand::Snapshot(PluginSnapshotRequest {
            request_id,
            revision,
            operation_id,
        }),
    )
    .await?;
    let app_for_mutation = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mutation(
            app_for_mutation
                .state::<Arc<crate::plugins::NativePluginSourceRegistry>>()
                .inner()
                .as_ref(),
        )
    })
    .await
    .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))?
    .map_err(|error| source_registry_error(error, operation))?;
    let mut response = dispatch_async(
        app.clone(),
        window,
        operation,
        PluginCommand::Snapshot(PluginSnapshotRequest {
            request_id: "source-postflight-request".to_owned(),
            revision,
            operation_id: "source-postflight-operation".to_owned(),
        }),
    )
    .await?;
    rewrite_response_correlation(&mut response, external_request_id, external_operation_id);
    Ok(response)
}

fn rewrite_response_correlation(
    response: &mut PluginCommandResponse,
    request: String,
    operation: String,
) {
    match response {
        PluginCommandResponse::Completed {
            request_id,
            operation_id,
            ..
        }
        | PluginCommandResponse::Cancelled {
            request_id,
            operation_id,
            ..
        }
        | PluginCommandResponse::Failed {
            request_id,
            operation_id,
            ..
        } => {
            *request_id = request;
            *operation_id = operation;
        }
    }
}

fn attach_sources(
    app: &AppHandle,
    response: &mut PluginCommandResponse,
    operation: &'static str,
) -> Result<(), IpcError> {
    let sources = app
        .state::<Arc<crate::plugins::NativePluginSourceRegistry>>()
        .views()
        .map_err(|error| source_registry_error(error, operation))?;
    if let Some(data) = match response {
        PluginCommandResponse::Completed { data, .. } => Some(data),
        PluginCommandResponse::Cancelled { data, .. }
        | PluginCommandResponse::Failed { data, .. } => data.as_mut(),
    } {
        data.sources = sources;
    }
    Ok(())
}

fn source_registry_error(
    error: crate::plugins::SourceRegistryError,
    operation: &'static str,
) -> IpcError {
    let field = match error {
        crate::plugins::SourceRegistryError::Invalid => "source",
        crate::plugins::SourceRegistryError::Conflict => "sourceId",
        crate::plugins::SourceRegistryError::Missing => "sourceId",
        crate::plugins::SourceRegistryError::Io => "sourceRegistry",
    };
    IpcError::invalid_input(operation, field)
}

fn dispatch(
    label: &str,
    service: Arc<dyn PluginCommandService>,
    operation: &'static str,
    command: PluginCommand,
) -> Result<PluginCommandResponse, IpcError> {
    require_main_window_label(label, operation)?;
    validate_command(&command, operation)?;
    let (request_id, revision, operation_id) = command.correlation();
    let request_id = request_id.to_owned();
    let operation_id = operation_id.to_owned();
    let response = service
        .execute(command)
        .map_err(|error| match error.request_id.as_deref() {
            None => error.with_request_id(&request_id),
            Some(error_request_id) if error_request_id == request_id.as_str() => error,
            Some(_) => invalid_response(operation, "error.requestId", &request_id),
        })?;
    validate_response(&response, &request_id, revision, &operation_id, operation)?;
    Ok(response)
}

fn validate_command(command: &PluginCommand, operation: &'static str) -> Result<(), IpcError> {
    let (request_id, revision, operation_id) = command.correlation();
    validate_identity(request_id, "requestId", operation)?;
    validate_identity(operation_id, "operationId", operation)?;
    validate_revision(revision, "revision", operation)?;
    match command {
        PluginCommand::Snapshot(_) | PluginCommand::CancelOperation(_) => Ok(()),
        PluginCommand::Install(request) => {
            validate_identity(&request.catalog_id, "catalogId", operation)
        }
        // A user-selected local package path; validated as an absolute,
        // existing directory by the native side before staging.
        PluginCommand::InstallLocal { package_root, .. } => {
            validate_local_package_root(package_root, operation)
        }
        PluginCommand::Uninstall(request) => {
            validate_identity(&request.plugin_id, "pluginId", operation)
        }
        PluginCommand::SetEnabled(request) => {
            validate_identity(&request.plugin_id, "pluginId", operation)
        }
    }
}

fn validate_response(
    response: &PluginCommandResponse,
    request_id: &str,
    request_revision: u64,
    operation_id: &str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if response.request_id() != request_id {
        return Err(invalid_response(
            operation,
            "response.requestId",
            request_id,
        ));
    }
    if response.operation_id() != operation_id {
        return Err(invalid_response(
            operation,
            "response.operationId",
            request_id,
        ));
    }
    validate_revision(response.revision(), "response.revision", operation)
        .map_err(|error| error.with_request_id(request_id))?;
    if response.revision() < request_revision {
        return Err(invalid_response(operation, "response.revision", request_id));
    }
    if let Some(data) = response.data() {
        if data.revision != response.revision() {
            return Err(invalid_response(
                operation,
                "response.data.revision",
                request_id,
            ));
        }
        validate_center_data(data, operation).map_err(|error| error.with_request_id(request_id))?;
    }
    Ok(())
}

fn validate_center_data(data: &PluginCenterData, operation: &'static str) -> Result<(), IpcError> {
    validate_revision(data.revision, "data.revision", operation)?;
    validate_limit(
        data.catalog.len(),
        MAX_PLUGIN_CATALOG_ITEMS,
        "data.catalog",
        operation,
    )?;
    validate_limit(
        data.installed.len(),
        MAX_INSTALLED_PLUGINS,
        "data.installed",
        operation,
    )?;
    let mut catalog_ids = HashSet::new();
    for item in &data.catalog {
        validate_catalog_item(item, operation)?;
        if !catalog_ids.insert(item.catalog_id.as_str()) {
            return Err(IpcError::invalid_input(operation, "data.catalog.catalogId"));
        }
    }
    let mut installed_ids = HashSet::new();
    for plugin in &data.installed {
        validate_installed_plugin(plugin, operation)?;
        if !installed_ids.insert(plugin.plugin_id.as_str()) {
            return Err(IpcError::invalid_input(
                operation,
                "data.installed.pluginId",
            ));
        }
    }
    validate_limit(
        data.sources.len(),
        MAX_PLUGIN_SOURCES,
        "data.sources",
        operation,
    )?;
    let mut source_ids = HashSet::new();
    for source in &data.sources {
        validate_source(source, operation)?;
        if !source_ids.insert(source.source_id.as_str()) {
            return Err(IpcError::invalid_input(operation, "data.sources.sourceId"));
        }
    }
    crate::plugins::validate_plugin_center_extensions_v2(data)
        .map_err(|field| IpcError::invalid_input(operation, field))?;
    Ok(())
}

fn validate_source(source: &PluginSourceView, operation: &'static str) -> Result<(), IpcError> {
    validate_identity(&source.source_id, "source.sourceId", operation)?;
    validate_display_text(
        &source.display_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "source.displayName",
        operation,
    )?;
    match source.kind {
        PluginSourceKind::Https => {
            let url = source
                .url
                .as_deref()
                .ok_or_else(|| IpcError::invalid_input(operation, "source.url"))?;
            bbcom_plugin_contracts::RepositoryEndpoint::new(source.source_id.clone(), url)
                .map_err(|_| IpcError::invalid_input(operation, "source.url"))?;
            if source.watch_enabled {
                return Err(IpcError::invalid_input(operation, "source.watchEnabled"));
            }
        }
        PluginSourceKind::LocalPackage | PluginSourceKind::DevDirectory => {
            if source.url.is_some() {
                return Err(IpcError::invalid_input(operation, "source.url"));
            }
        }
    }
    for (value, field) in [
        (source.last_attempt_ms, "source.lastAttemptMs"),
        (source.last_success_ms, "source.lastSuccessMs"),
    ] {
        if let Some(value) = value {
            validate_revision(value, field, operation)?;
        }
    }
    Ok(())
}

fn validate_catalog_item(
    item: &PluginCatalogItem,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(&item.catalog_id, "catalog.catalogId", operation)?;
    validate_identity(&item.plugin_id, "catalog.pluginId", operation)?;
    validate_display_text(
        &item.display_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "catalog.displayName",
        operation,
    )?;
    validate_display_text(
        &item.description,
        MAX_PLUGIN_DESCRIPTION_BYTES,
        true,
        "catalog.description",
        operation,
    )?;
    validate_version(&item.version, "catalog.version", operation)?;
    validate_display_text(
        &item.publisher_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "catalog.publisherName",
        operation,
    )?;
    if let Some(version) = &item.installed_version {
        validate_version(version, "catalog.installedVersion", operation)?;
    }
    Ok(())
}

fn validate_installed_plugin(
    plugin: &InstalledPluginView,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(&plugin.plugin_id, "installed.pluginId", operation)?;
    validate_display_text(
        &plugin.display_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "installed.displayName",
        operation,
    )?;
    validate_version(&plugin.version, "installed.version", operation)?;
    if let Some(version) = &plugin.pending_version {
        validate_version(version, "installed.pendingVersion", operation)?;
    }
    validate_unique(
        &plugin.requested_capabilities,
        MAX_PLUGIN_CAPABILITIES,
        "installed.requestedCapabilities",
        operation,
    )?;
    validate_unique(
        &plugin.effective_capabilities,
        MAX_PLUGIN_CAPABILITIES,
        "installed.effectiveCapabilities",
        operation,
    )?;
    if plugin
        .effective_capabilities
        .iter()
        .any(|capability| !plugin.requested_capabilities.contains(capability))
        || (plugin.runtime.is_none() && !plugin.effective_capabilities.is_empty())
    {
        return Err(IpcError::invalid_input(
            operation,
            "installed.effectiveCapabilities",
        ));
    }
    if let Some(runtime) = &plugin.runtime {
        validate_runtime_instance_key(runtime, operation)?;
        if runtime.plugin_id != plugin.plugin_id {
            return Err(IpcError::invalid_input(
                operation,
                "installed.runtime.pluginId",
            ));
        }
    }
    Ok(())
}

fn validate_runtime_instance_key(
    runtime: &RuntimeInstanceKey,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(&runtime.workspace_id, "runtime.workspaceId", operation)?;
    validate_identity(&runtime.plugin_id, "runtime.pluginId", operation)?;
    validate_revision(runtime.instance_id, "runtime.instanceId", operation)?;
    validate_revision(runtime.generation, "runtime.generation", operation)
}

fn validate_unique<T: Eq + std::hash::Hash>(
    values: &[T],
    limit: usize,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_limit(values.len(), limit, field, operation)?;
    let mut seen = HashSet::new();
    if values.iter().all(|value| seen.insert(value)) {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

/// Local-install package roots must be absolute, existing directories with a
/// readable plugin.toml; no symlinked traversal is permitted.
fn validate_local_package_root(
    path: &std::path::Path,
    operation: &'static str,
) -> Result<(), IpcError> {
    if path.as_os_str().is_empty() || path.as_os_str().len() > 4096 {
        return Err(IpcError::new(
            AppErrorCode::InvalidInput,
            "error.invalid_input",
            true,
            operation,
        )
        .with_field("packageRoot"));
    }
    if !path.is_absolute() {
        return Err(IpcError::new(
            AppErrorCode::InvalidInput,
            "error.invalid_input",
            true,
            operation,
        )
        .with_field("packageRoot"));
    }
    match std::fs::symlink_metadata(path.join("plugin.toml")) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        _ => Err(IpcError::new(
            AppErrorCode::InvalidInput,
            "error.invalid_input",
            true,
            operation,
        )
        .with_field("packageRoot")),
    }
}

fn validate_identity(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    let mut bytes = value.bytes();
    let valid = !value.is_empty()
        && value.len() <= MAX_PLUGIN_ID_BYTES
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn validate_version(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if value.len() > MAX_PLUGIN_VERSION_BYTES || !safe_text(value, false) {
        return Err(IpcError::invalid_input(operation, field));
    }
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let core = &value[..core_end];
    let mut parts = core.split('.');
    let core_valid = (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
    }) && parts.next().is_none();
    let suffix_valid = if core_end == value.len() {
        true
    } else {
        let suffix = &value[core_end + 1..];
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    };
    if core_valid && suffix_valid {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn validate_display_text(
    value: &str,
    limit: usize,
    allow_empty: bool,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_limit(value.len(), limit, field, operation)?;
    if (allow_empty || !value.is_empty()) && safe_text(value, true) {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn safe_text(value: &str, reject_system_path: bool) -> bool {
    let lower = value.to_ascii_lowercase();
    let has_uri = [
        "://",
        "javascript:",
        "data:",
        "file:",
        "mailto:",
        "tel:",
        "ftp:",
        "ws:",
        "wss:",
        "urn:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower
            .split_ascii_whitespace()
            .any(|part| part.starts_with("www."));
    let system_path = reject_system_path
        && (value.starts_with('/')
            || value.starts_with("\\\\")
            || (value.len() >= 3
                && value.as_bytes()[0].is_ascii_alphabetic()
                && value.as_bytes()[1] == b':'
                && matches!(value.as_bytes()[2], b'/' | b'\\')));
    !has_uri
        && !system_path
        && !value.contains(['<', '>'])
        && !value.chars().any(|character| character.is_control())
}

fn validate_revision(
    revision: u64,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if revision <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field).with_size(
            MAX_SAFE_INTEGER as usize,
            usize::try_from(revision).unwrap_or(usize::MAX),
        ))
    }
}

fn validate_limit(
    actual: usize,
    limit: usize,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if actual <= limit {
        Ok(())
    } else {
        Err(IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field(field)
        .with_size(limit, actual))
    }
}

fn invalid_response(operation: &'static str, field: &'static str, request_id: &str) -> IpcError {
    IpcError::invalid_input(operation, field).with_request_id(request_id)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use bbcom_contracts::{PluginFailure, PluginFailureCode};

    use super::*;

    struct StubService {
        command: Mutex<Option<PluginCommand>>,
        response: PluginCommandResponse,
    }

    impl PluginCommandService for StubService {
        fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
            *self.command.lock().unwrap() = Some(command);
            Ok(self.response.clone())
        }
    }

    fn request() -> PluginSnapshotRequest {
        PluginSnapshotRequest {
            request_id: "request-1".to_owned(),
            revision: 3,
            operation_id: "operation-1".to_owned(),
        }
    }

    #[test]
    fn secondary_windows_are_denied_before_service_dispatch() {
        let state = PluginCommandState::new(Arc::new(StubService {
            command: Mutex::new(None),
            response: PluginCommandResponse::Failed {
                request_id: "request-1".to_owned(),
                operation_id: "operation-1".to_owned(),
                revision: 3,
                failure: PluginFailure {
                    code: PluginFailureCode::Unavailable,
                },
                data: None,
            },
        }));
        let error = dispatch(
            "ai-assistant",
            state.current_service(),
            "plugin_center_snapshot",
            PluginCommand::Snapshot(request()),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::SecurityDenied);
    }

    #[test]
    fn response_must_keep_request_operation_and_revision_correlation() {
        let state = PluginCommandState::new(Arc::new(StubService {
            command: Mutex::new(None),
            response: PluginCommandResponse::Failed {
                request_id: "wrong-request".to_owned(),
                operation_id: "operation-1".to_owned(),
                revision: 3,
                failure: PluginFailure {
                    code: PluginFailureCode::Unavailable,
                },
                data: None,
            },
        }));
        let error = dispatch(
            "main",
            state.current_service(),
            "plugin_center_snapshot",
            PluginCommand::Snapshot(request()),
        )
        .unwrap_err();
        assert_eq!(error.field, Some("response.requestId"));
    }

    #[test]
    fn v2_surface_events_require_a_live_runtime_revision_and_safe_value() {
        let runtime = RuntimeInstanceKey {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.mcumgr".to_owned(),
            instance_id: 1,
            generation: 2,
        };
        let mut request = EmitPluginSurfaceEventRequestV2 {
            request_id: "request-1".to_owned(),
            revision: 3,
            operation_id: "operation-1".to_owned(),
            event: bbcom_contracts::PluginSurfaceEventV2 {
                runtime,
                surface_id: "main".to_owned(),
                revision: 1,
                node_id: "refresh".to_owned(),
                event: bbcom_contracts::PluginSurfaceEventKind::Activate,
                value: None,
            },
        };
        assert!(
            validate_v2_ui_action(
                &crate::plugins::PluginUiActionV2::EmitSurfaceEvent(request.clone()),
                "surface-event"
            )
            .is_ok()
        );
        request.event.revision = 0;
        assert!(
            validate_v2_ui_action(
                &crate::plugins::PluginUiActionV2::EmitSurfaceEvent(request),
                "surface-event"
            )
            .is_err()
        );
    }
}
