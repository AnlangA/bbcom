//! Native composition of the production plugin runtime (T3 wiring).
//!
//! This module is the single place where `ProductionPluginRuntimeBuilder`
//! receives its concrete application-owned dependencies. It is fail-closed in
//! the ADR-0004 sense: when any dependency cannot be constructed, composition
//! fails and application setup keeps `UnavailablePluginCommandService`, so no
//! partial plugin behavior is exposed.
//!
//! User-configured unsigned HTTPS sources are resolved by the native source
//! registry. The registry enforces the network boundary and package/component
//! SHA-256 integrity; it does not assert publisher identity.
//!
//! Durable roots, all below the native application-data directory:
//!
//! - installer package root: `plugins-v2` (installer-managed `plugins/` and
//!   `.staging/` subdirectories)
//! - installer rollback snapshots: `plugin-state-v2/installer-snapshots`
//! - opaque plugin storage: `plugin-state-v2`
//! - bounded broker audit log: `logs/plugin-audit.jsonl`
//! - Windows AppContainer host copy: `plugin-host-v2` (content addressed)
//!
//! On-disk plugin roots for every builder dependency are resolved by native
//! setup only; no command, event, DTO or renderer string can select them.

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bbcom_contracts::{
    InstallLocalPluginRequest, PluginCommandResponse, PluginContributionDisposition,
    PluginErrorCodeV2, PluginSnapshotRequest, RuntimeInstanceKey, WorkspaceMacro,
    WorkspaceMacroStep, WorkspaceQuickCommand,
};
use bbcom_plugin_manager::ManualPackageRequest;
use bbcom_plugin_repository::{DownloadedPackage, PluginInstaller};
use semver::Version;
use sha2::{Digest, Sha256};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::workspace::WorkspaceManager;
use crate::utils::window::MAIN_WINDOW_LABEL;

use super::bootstrap::{
    CurrentPluginWorkspace, PluginBootstrapError, PluginRuntimeLifecycle, ProductionPluginRuntime,
    ProductionPluginRuntimeBuilder,
};
use super::command_adapter::{
    CatalogPluginRecord, CatalogViewFailure, CatalogViewPort, PluginDisplayRecord,
};
use super::host_launcher::{
    PluginProjectStateProviderV2, PluginProjectStateSnapshotV2, PrivateArtifactRoot,
};
use super::installation::VerifiedPackageProvider;
use super::runtime_actor::PluginWorkspaceBindingPort;
use super::state::SharedNativePluginStatePersistencePort;

const SIDECAR_BASENAME: &str = "bbcom-plugin-host";
static NEXT_SIDECAR_STAGE_ID: AtomicU64 = AtomicU64::new(1);
/// Application-owned bridge used by protocol-v2 capability projection and
/// workspace lifecycle wiring. Production is backed by [`AppHandle`]; tests
/// substitute a recording environment.
trait HostUpstreamEnvironment: Send + Sync + 'static {
    /// Emits a JSON payload to the main webview window.
    fn emit_to_main(&self, event: &'static str, payload: &serde_json::Value) -> Result<(), ()>;

    /// Returns the identity of the currently active workspace, if one is open.
    fn active_workspace(&self)
    -> Option<crate::commands::workspace::NativePluginWorkspaceSnapshot>;
    fn set_plugin_expected_enabled(
        &self,
        plugin_id: &str,
        expected_enabled: bool,
    ) -> Result<(), ()>;
    fn uninstall_with_plugin_contribution_cleanup(
        &self,
        plugin_id: &str,
        disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> bool,
    ) -> Result<bool, ()>;
    fn recover_plugin_contribution_uninstall(
        &self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), ()>;
}

struct TauriHostUpstreamEnvironment<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> TauriHostUpstreamEnvironment<R> {
    fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> HostUpstreamEnvironment for TauriHostUpstreamEnvironment<R> {
    fn emit_to_main(&self, event: &'static str, payload: &serde_json::Value) -> Result<(), ()> {
        self.app
            .emit_to(MAIN_WINDOW_LABEL, event, payload.clone())
            .map_err(|_| ())
    }

    fn active_workspace(
        &self,
    ) -> Option<crate::commands::workspace::NativePluginWorkspaceSnapshot> {
        self.app
            .try_state::<WorkspaceManager>()
            .and_then(|manager| manager.plugin_workspace_snapshot())
    }

    fn set_plugin_expected_enabled(
        &self,
        plugin_id: &str,
        expected_enabled: bool,
    ) -> Result<(), ()> {
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(())?
            .set_plugin_expected_enabled(plugin_id, expected_enabled)
    }

    fn uninstall_with_plugin_contribution_cleanup(
        &self,
        plugin_id: &str,
        disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> bool,
    ) -> Result<bool, ()> {
        let disposition = match disposition {
            PluginContributionDisposition::Delete => {
                bbcom_workspace::PluginContributionDisposition::Delete
            }
            PluginContributionDisposition::ConvertToUser => {
                bbcom_workspace::PluginContributionDisposition::ConvertToUser
            }
        };
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(())?
            .with_plugin_contribution_uninstall(plugin_id, disposition, uninstall)
    }

    fn recover_plugin_contribution_uninstall(
        &self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), ()> {
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(())?
            .recover_plugin_contribution_uninstall(installed_plugin_ids)
    }
}

/// Reads portable state from the active workspace at the last responsible
/// moment before every sidecar launch. This deliberately does not call back
/// into `PluginService`, so initialization can run while the lifecycle manager
/// owns its mutex without re-entrancy or deadlock.
struct EnvironmentProjectStateProvider<E>(Arc<E>);

impl<E: HostUpstreamEnvironment> PluginProjectStateProviderV2
    for EnvironmentProjectStateProvider<E>
{
    fn current_project_state(
        &self,
        workspace_id: &str,
        plugin_id: &str,
    ) -> Result<Option<PluginProjectStateSnapshotV2>, bbcom_plugin_manager::HostFailure> {
        let workspace = self.0.active_workspace().ok_or_else(|| {
            tracing::warn!(
                plugin_id,
                workspace_id,
                "plugin project state unavailable because no workspace is active"
            );
            bbcom_plugin_manager::HostFailure::Initialization
        })?;
        if workspace.workspace_id != workspace_id {
            tracing::warn!(
                plugin_id,
                requested_workspace_id = workspace_id,
                active_workspace_id = %workspace.workspace_id,
                "plugin project state requested for a stale workspace"
            );
            return Err(bbcom_plugin_manager::HostFailure::Initialization);
        }
        let mut matching = workspace
            .states
            .into_iter()
            .filter(|state| state.plugin_id == plugin_id);
        let state = matching.next();
        if matching.next().is_some() {
            tracing::warn!(
                plugin_id,
                workspace_id,
                "workspace returned duplicate plugin project-state records"
            );
            return Err(bbcom_plugin_manager::HostFailure::Initialization);
        }
        Ok(state.map(|state| PluginProjectStateSnapshotV2 {
            value: state.bytes,
            api_generation: state.api_generation,
            schema_version: state.schema_version,
        }))
    }
}

struct WebviewCapabilityEventSinkV2<E>(Arc<E>);

impl<E: HostUpstreamEnvironment> super::PluginCapabilityEventSinkV2
    for WebviewCapabilityEventSinkV2<E>
{
    fn emit_serial(
        &self,
        event: &bbcom_contracts::PluginSerialCapabilityInboundV2,
    ) -> Result<(), super::PluginCapabilitySinkErrorV2> {
        let payload =
            serde_json::to_value(event).map_err(|_| super::PluginCapabilitySinkErrorV2)?;
        self.0
            .emit_to_main(super::PLUGIN_SERIAL_CAPABILITY_EVENT_V2, &payload)
            .map_err(|_| super::PluginCapabilitySinkErrorV2)
    }

    fn projection_changed(&self) -> Result<(), super::PluginCapabilitySinkErrorV2> {
        self.0
            .emit_to_main(
                super::PLUGIN_SNAPSHOT_CHANGED_EVENT_V2,
                &serde_json::json!({}),
            )
            .map_err(|_| super::PluginCapabilitySinkErrorV2)
    }
}

struct TauriPluginFileDialogPortV2<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> super::PluginFileDialogPortV2 for TauriPluginFileDialogPortV2<R> {
    fn open_read(
        &self,
        accepted_extensions: &[String],
    ) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
        let window = self
            .app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or(PluginErrorCodeV2::Unavailable)?;
        let mut dialog = window.dialog().file();
        let extensions = accepted_extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        if !extensions.is_empty() {
            dialog = dialog.add_filter("Plugin files", &extensions);
        }
        dialog
            .blocking_pick_file()
            .map(|path| {
                path.into_path()
                    .map_err(|_| PluginErrorCodeV2::InvalidInput)
            })
            .transpose()
    }

    fn create_save(&self, suggested_name: &str) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
        let window = self
            .app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or(PluginErrorCodeV2::Unavailable)?;
        window
            .dialog()
            .file()
            .set_file_name(suggested_name)
            .blocking_save_file()
            .map(|path| {
                path.into_path()
                    .map_err(|_| PluginErrorCodeV2::InvalidInput)
            })
            .transpose()
    }
}

struct NativePluginPrivateStatePortV2(SharedNativePluginStatePersistencePort);

impl super::PluginPrivateStatePersistenceV2 for NativePluginPrivateStatePortV2 {
    fn persist_plugin_storage(
        &self,
        context: &bbcom_plugin_broker::GatewayContext,
        storage_scope: &str,
        encoded: &[u8],
    ) -> Result<(), PluginErrorCodeV2> {
        self.0
            .persist_scoped_storage(
                &context.workspace_id,
                &context.plugin_id,
                storage_scope,
                encoded,
            )
            .map_err(|_| PluginErrorCodeV2::IoError)
    }
}

struct TauriPluginWorkspaceCapabilityPortV2<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> super::PluginWorkspaceCapabilityPortV2
    for TauriPluginWorkspaceCapabilityPortV2<R>
{
    fn set_project_state(
        &self,
        context: &bbcom_plugin_broker::GatewayContext,
        schema_version: u32,
        value: &[u8],
    ) -> Result<(), PluginErrorCodeV2> {
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(PluginErrorCodeV2::Unavailable)?
            .set_plugin_project_state(
                &context.workspace_id,
                &context.plugin_id,
                value,
                2,
                Some(schema_version),
            )
            .map_err(|error| {
                tracing::warn!(
                    ?error,
                    plugin_id = %context.plugin_id,
                    workspace_id = %context.workspace_id,
                    schema_version,
                    state_bytes = value.len(),
                    "workspace rejected plugin project-state persistence"
                );
                map_workspace_capability_error(error)
            })
    }

    fn upsert_quick_command(
        &self,
        context: &bbcom_plugin_broker::GatewayContext,
        command: &bbcom_plugin_contracts::generated_v2::QuickCommand,
    ) -> Result<String, PluginErrorCodeV2> {
        let contribution_id = contribution_id(&context.plugin_id, &command.local_id)?;
        let session_id = command.session_id.clone();
        let mut payload = command.payload.clone();
        if command.append_newline {
            payload.push(b'\n');
        }
        let command = WorkspaceQuickCommand {
            id: contribution_id.clone(),
            name: command.title.clone(),
            data: encode_hex(&payload),
            is_hex: true,
            owner_plugin_id: Some(context.plugin_id.clone()),
        };
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(PluginErrorCodeV2::Unavailable)?
            .upsert_plugin_quick_command(&context.workspace_id, &session_id, &command)
            .map_err(map_workspace_capability_error)?;
        Ok(contribution_id)
    }

    fn delete_quick_command(
        &self,
        context: &bbcom_plugin_broker::GatewayContext,
        session_id: &str,
        local_id: &str,
    ) -> Result<(), PluginErrorCodeV2> {
        let contribution_id = contribution_id(&context.plugin_id, local_id)?;
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(PluginErrorCodeV2::Unavailable)?
            .delete_plugin_quick_command(
                &context.workspace_id,
                session_id,
                &contribution_id,
                &context.plugin_id,
            )
            .map_err(map_workspace_capability_error)
    }

    fn upsert_macro(
        &self,
        context: &bbcom_plugin_broker::GatewayContext,
        value: &bbcom_plugin_contracts::generated_v2::MacroContribution,
    ) -> Result<String, PluginErrorCodeV2> {
        let contribution_id = contribution_id(&context.plugin_id, &value.local_id)?;
        let session_id = value.session_id.clone();
        let value = WorkspaceMacro {
            id: contribution_id.clone(),
            name: value.title.clone(),
            steps: value
                .steps
                .iter()
                .map(|step| WorkspaceMacroStep {
                    data: encode_hex(&step.payload),
                    is_hex: true,
                    delay_ms: step.delay_ms,
                })
                .collect(),
            owner_plugin_id: Some(context.plugin_id.clone()),
        };
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(PluginErrorCodeV2::Unavailable)?
            .upsert_plugin_macro(&context.workspace_id, &session_id, &value)
            .map_err(map_workspace_capability_error)?;
        Ok(contribution_id)
    }

    fn delete_macro(
        &self,
        context: &bbcom_plugin_broker::GatewayContext,
        session_id: &str,
        local_id: &str,
    ) -> Result<(), PluginErrorCodeV2> {
        let contribution_id = contribution_id(&context.plugin_id, local_id)?;
        self.app
            .try_state::<WorkspaceManager>()
            .ok_or(PluginErrorCodeV2::Unavailable)?
            .delete_plugin_macro(
                &context.workspace_id,
                session_id,
                &contribution_id,
                &context.plugin_id,
            )
            .map_err(map_workspace_capability_error)
    }
}

fn contribution_id(plugin_id: &str, local_id: &str) -> Result<String, PluginErrorCodeV2> {
    if plugin_id.is_empty() || local_id.is_empty() || plugin_id.len() + local_id.len() + 8 > 128 {
        return Err(PluginErrorCodeV2::InvalidInput);
    }
    Ok(format!("plugin:{plugin_id}:{local_id}"))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn map_workspace_capability_error(error: bbcom_workspace::WorkspaceError) -> PluginErrorCodeV2 {
    match error {
        bbcom_workspace::WorkspaceError::InvalidInput { .. }
        | bbcom_workspace::WorkspaceError::AlreadyExists
        | bbcom_workspace::WorkspaceError::RevisionConflict { .. }
        | bbcom_workspace::WorkspaceError::BatchIdReuse => PluginErrorCodeV2::InvalidInput,
        bbcom_workspace::WorkspaceError::LimitExceeded { .. } => PluginErrorCodeV2::LimitExceeded,
        bbcom_workspace::WorkspaceError::NotFound => PluginErrorCodeV2::NotFound,
        bbcom_workspace::WorkspaceError::ReadOnly => PluginErrorCodeV2::PermissionDenied,
        bbcom_workspace::WorkspaceError::Busy => PluginErrorCodeV2::Busy,
        bbcom_workspace::WorkspaceError::Corrupt { .. }
        | bbcom_workspace::WorkspaceError::FutureSchema { .. }
        | bbcom_workspace::WorkspaceError::Serialization(_)
        | bbcom_workspace::WorkspaceError::Io(_)
        | bbcom_workspace::WorkspaceError::Database(_) => PluginErrorCodeV2::IoError,
    }
}

struct EnvironmentWorkspaceBindingPort<E>(Arc<E>);

impl<E: HostUpstreamEnvironment> PluginWorkspaceBindingPort for EnvironmentWorkspaceBindingPort<E> {
    fn set_expected_enabled(&self, plugin_id: &str, expected_enabled: bool) -> Result<(), ()> {
        self.0
            .set_plugin_expected_enabled(plugin_id, expected_enabled)
    }

    fn uninstall_with_contribution_cleanup(
        &self,
        plugin_id: &str,
        disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> bool,
    ) -> Result<bool, ()> {
        self.0
            .uninstall_with_plugin_contribution_cleanup(plugin_id, disposition, uninstall)
    }

    fn recover_contribution_uninstall(
        &self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), ()> {
        self.0
            .recover_plugin_contribution_uninstall(installed_plugin_ids)
    }
}

struct EnvironmentDetachedSerialRevokerV2<E>(Arc<E>);

impl<E: HostUpstreamEnvironment> super::PluginDetachedSerialRevocationPortV2
    for EnvironmentDetachedSerialRevokerV2<E>
{
    fn revoke_serial_runtime(&self, runtime: &RuntimeInstanceKey) {
        let event = bbcom_contracts::PluginSerialCapabilityInboundV2::RevokeRuntime {
            context: bbcom_contracts::PluginGatewayContextV2 {
                workspace_id: runtime.workspace_id.clone(),
                plugin_id: runtime.plugin_id.clone(),
                instance_id: runtime.instance_id.to_string(),
                generation: runtime.generation,
            },
        };
        if let Ok(payload) = serde_json::to_value(event) {
            let _ = self
                .0
                .emit_to_main(super::PLUGIN_SERIAL_CAPABILITY_EVENT_V2, &payload);
        }
    }
}

struct TauriDetachedProjectionPortV2<R: tauri::Runtime> {
    app: AppHandle<R>,
    service: Arc<super::PluginDetachedWindowServiceV2>,
}

impl<R: tauri::Runtime> TauriDetachedProjectionPortV2<R> {
    fn view(
        center_revision: u64,
        runtime: &RuntimeInstanceKey,
        surface_id: &str,
        projection: &super::PluginRuntimeProjectionSnapshotV2,
    ) -> Option<bbcom_contracts::PluginDetachedSurfaceViewV2> {
        let surface = projection
            .surfaces
            .iter()
            .find(|surface| surface.runtime == *runtime && surface.surface_id == surface_id)?
            .clone();
        let tasks = projection
            .tasks
            .iter()
            .filter(|task| task.runtime == *runtime)
            .cloned()
            .collect();
        Some(bbcom_contracts::PluginDetachedSurfaceViewV2 {
            center_revision,
            surface,
            tasks,
        })
    }

    fn close_label(&self, label: Option<String>) {
        if let Some(label) = label
            && let Some(window) = self.app.get_webview_window(&label)
        {
            let _ = window.close();
        }
    }
}

impl<R: tauri::Runtime> super::PluginDetachedProjectionPortV2 for TauriDetachedProjectionPortV2<R> {
    fn sync(
        &self,
        center_revision: u64,
        projection: &super::PluginRuntimeProjectionSnapshotV2,
    ) -> Result<(), PluginErrorCodeV2> {
        for surface in projection.surfaces.iter().filter(|surface| {
            surface.placement == bbcom_contracts::PluginSurfacePlacement::DetachedWindow
        }) {
            let view = Self::view(
                center_revision,
                &surface.runtime,
                &surface.surface_id,
                projection,
            )
            .ok_or(PluginErrorCodeV2::NotFound)?;
            self.service
                .update(&self.app, view)
                .map_err(|_| PluginErrorCodeV2::Unavailable)?;
        }
        Ok(())
    }

    fn open(
        &self,
        center_revision: u64,
        runtime: &RuntimeInstanceKey,
        surface_id: &str,
        projection: &super::PluginRuntimeProjectionSnapshotV2,
    ) -> Result<(), PluginErrorCodeV2> {
        let view = Self::view(center_revision, runtime, surface_id, projection)
            .ok_or(PluginErrorCodeV2::NotFound)?;
        self.service
            .open(&self.app, view)
            .map_err(|_| PluginErrorCodeV2::Unavailable)
    }

    fn revoke_surface(&self, runtime: &RuntimeInstanceKey, surface_id: &str) {
        let label = self.service.revoke_surface(runtime, surface_id);
        self.close_label(label);
    }

    fn revoke_runtime(&self, runtime: &RuntimeInstanceKey) {
        for label in self.service.revoke_runtime(runtime) {
            self.close_label(Some(label));
        }
    }
}

fn detached_projection_port<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Arc<dyn super::PluginDetachedProjectionPortV2> {
    Arc::new(TauriDetachedProjectionPortV2 {
        app: app.clone(),
        service: app
            .state::<Arc<super::PluginDetachedWindowServiceV2>>()
            .inner()
            .clone(),
    })
}

/// Durable roots and the resolved sidecar path used by one composition.
struct PluginRuntimeRoots {
    installer_packages: PathBuf,
    installer_data: PathBuf,
    state_private: PathBuf,
    sidecar_executable: PathBuf,
}

struct PluginRuntimeCompositionParts<E: HostUpstreamEnvironment> {
    roots: PluginRuntimeRoots,
    environment: Arc<E>,
    sources: Arc<super::NativePluginSourceRegistry>,
    serial_v2: Arc<super::SerialCapabilityCorrelationRegistryV2>,
    projection: Arc<super::PluginRuntimeProjectionV2>,
    host_context: Arc<super::PluginHostContextStoreV2>,
    files: Arc<super::PluginFileGrantService>,
    dialogs: Arc<dyn super::PluginFileDialogPortV2>,
    workspace_capabilities: Arc<dyn super::PluginWorkspaceCapabilityPortV2>,
    detached: Arc<dyn super::PluginDetachedProjectionPortV2>,
}

/// Composes the production plugin runtime from native application state.
///
/// Returns the runtime for `PluginCommandState`/lifecycle installation. On any
/// failure the caller must keep the fail-closed unavailable command service and
/// record only [`PluginBootstrapError::code`].
pub fn compose<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<ProductionPluginRuntime, PluginBootstrapError> {
    let roots = app_data_roots(app)?;
    let environment = Arc::new(TauriHostUpstreamEnvironment::new(app.clone()));
    let sources = app
        .state::<Arc<super::NativePluginSourceRegistry>>()
        .inner()
        .clone();
    let serial_v2 = app
        .state::<Arc<super::SerialCapabilityCorrelationRegistryV2>>()
        .inner()
        .clone();
    let projection = app
        .state::<Arc<super::PluginRuntimeProjectionV2>>()
        .inner()
        .clone();
    let host_context = app
        .state::<Arc<super::PluginHostContextStoreV2>>()
        .inner()
        .clone();
    let files = app
        .state::<Arc<super::PluginFileGrantService>>()
        .inner()
        .clone();
    let dialogs: Arc<dyn super::PluginFileDialogPortV2> =
        Arc::new(TauriPluginFileDialogPortV2 { app: app.clone() });
    let workspace_capabilities: Arc<dyn super::PluginWorkspaceCapabilityPortV2> =
        Arc::new(TauriPluginWorkspaceCapabilityPortV2 { app: app.clone() });
    let detached = detached_projection_port(app);
    app.state::<Arc<super::PluginDetachedWindowServiceV2>>()
        .install_serial_revoker(Arc::new(EnvironmentDetachedSerialRevokerV2(Arc::clone(
            &environment,
        ))));
    compose_from_parts(PluginRuntimeCompositionParts {
        roots,
        environment,
        sources,
        serial_v2,
        projection,
        host_context,
        files,
        dialogs,
        workspace_capabilities,
        detached,
    })
}

/// Serializes composition attempts and owns the host-exit poll generation.
static COMPOSE_LOCK: Mutex<()> = Mutex::new(());
static HOST_EXIT_POLL_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Composes (or recomposes) the production plugin runtime against the
/// currently active workspace and swaps it into managed state.
///
/// Setup calls this once after the fail-closed unavailable service is
/// installed, and every `create_workspace`/`open_workspace` attempt retries it
/// (via `activate_plugin_runtime_after_attempt`) while no runtime is
/// installed, so a transiently failed composition heals without a restart.
/// A failed recomposition keeps the stable unavailable service: the previous
/// runtime's project was already closed, so continuing to serve it would
/// expose partial plugin behavior. The outcome is always emitted as
/// `plugin-runtime-status` so the plugin center can surface the cause.
pub fn ensure_plugin_runtime<R: tauri::Runtime>(app: &AppHandle<R>) {
    let _serial = COMPOSE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let lifecycle_handle = match app.try_state::<PluginLifecycleHandle>() {
        Some(handle) => handle,
        None => return,
    };
    if lifecycle_handle.current().is_some() {
        return;
    }
    let outcome = compose(app);
    let status = match &outcome {
        Ok(runtime) => {
            let generation = HOST_EXIT_POLL_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            let projection = app
                .state::<Arc<super::PluginRuntimeProjectionV2>>()
                .inner()
                .clone();
            let detached = detached_projection_port(app);
            let lifecycle = runtime.lifecycle();
            let private_state = Arc::new(runtime.private_state());
            let projected_commands: Arc<dyn crate::commands::plugin::PluginCommandService> =
                Arc::new(super::ProjectingPluginCommandServiceV2::new(
                    runtime.command_service(),
                    Arc::clone(&projection),
                    Arc::clone(&detached),
                    private_state,
                ));
            app.state::<crate::commands::plugin::PluginCommandState>()
                .replace_service(Arc::clone(&projected_commands));
            app.state::<super::PluginUiActionStateV2>()
                .replace_service(Arc::new(super::NativePluginUiActionServiceV2::new(
                    projected_commands,
                    Arc::clone(&lifecycle),
                    projection,
                    detached,
                )));
            lifecycle_handle.install(Arc::clone(&lifecycle));
            spawn_host_exit_poll(lifecycle, generation);
            serde_json::json!({ "available": true, "code": null })
        }
        Err(error) => {
            // Composition-failure rule: record only the stable code.
            let code = error.code();
            eprintln!("plugin runtime unavailable: {code}");
            // A previously active runtime's project was already closed by the
            // workspace switch; it must not keep serving partial behavior.
            if lifecycle_handle.take().is_some() {
                app.state::<crate::commands::plugin::PluginCommandState>()
                    .replace_service(Arc::new(
                        crate::commands::plugin::UnavailablePluginCommandService,
                    ));
            }
            serde_json::json!({ "available": false, "code": code })
        }
    };
    let _ = app.emit("plugin-runtime-status", status);
}

/// Switches the active workspace inside the existing process-lifetime actor.
/// Installed records, operation/correlation retention and revision ownership
/// therefore survive workspace changes.
pub fn activate_plugin_workspace<R: tauri::Runtime>(app: &AppHandle<R>) {
    // Serialize with (re)composition: an activation interleaved with
    // ensure_plugin_runtime could otherwise bind the actor to a stale
    // workspace while the runtime is being swapped.
    let _serial = COMPOSE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(handle) = app.try_state::<PluginLifecycleHandle>() else {
        return;
    };
    let Some(lifecycle) = handle.current() else {
        return;
    };
    let Some(manager) = app.try_state::<WorkspaceManager>() else {
        return;
    };
    let Some(context) = manager.plugin_workspace_snapshot() else {
        return;
    };
    if let Err(error) =
        lifecycle.open_workspace(context.workspace_id, context.bindings, context.states)
    {
        tracing::warn!("plugin workspace activation failed: {error}");
    }
}

fn app_data_roots<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<PluginRuntimeRoots, PluginBootstrapError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| PluginBootstrapError::MissingInstaller)?;
    // An unresolvable or unwritable application-data root fails composition
    // with the first-dependency code; setup records only that code.
    fs::create_dir_all(&app_data).map_err(|_| PluginBootstrapError::MissingInstaller)?;
    let bundled_sidecar =
        resolve_sidecar_executable().ok_or(PluginBootstrapError::MissingSidecarExecutable)?;
    // A packaged Windows sidecar commonly lives under Program Files. Standard
    // users cannot add the per-AppContainer read/execute ACE there, so launch
    // used to fail even though discovery and the sandbox self-test succeeded.
    // Copy the byte-verified executable into user-owned app data before the
    // Windows ACL lease is acquired. Content-addressing makes upgrades and
    // crash recovery deterministic without ever overwriting a running host.
    let sidecar_executable = if cfg!(windows) {
        stage_runtime_sidecar(&bundled_sidecar, &app_data.join("plugin-host-v2")).map_err(
            |error| {
                tracing::warn!(%error, "Windows plugin host staging failed");
                PluginBootstrapError::MissingSidecarExecutable
            },
        )?
    } else {
        bundled_sidecar
    };
    Ok(PluginRuntimeRoots {
        installer_packages: app_data.join("plugins-v2"),
        // Installer staging lives OUTSIDE `plugin-state-v2`: `open_installer`
        // below runs `create_dir_all` under the process umask, and a
        // umask-created parent would then be rejected by the state store's
        // strict private-directory check (`PLUGIN_BOOTSTRAP_STATE_STORE_MISSING`
        // on every first run with umask != 077). Old snapshots under the
        // previous location are transient staging data and are not migrated.
        installer_data: app_data.join("plugin-installer-v2").join("snapshots"),
        state_private: app_data.clone(),
        sidecar_executable,
    })
}

/// Environment-independent composition used by native setup and the unit tests.
fn compose_from_parts<E: HostUpstreamEnvironment>(
    parts: PluginRuntimeCompositionParts<E>,
) -> Result<ProductionPluginRuntime, PluginBootstrapError> {
    let PluginRuntimeCompositionParts {
        roots,
        environment,
        sources,
        serial_v2,
        projection,
        host_context,
        files,
        dialogs,
        workspace_capabilities,
        detached,
    } = parts;
    let workspace_bindings = EnvironmentWorkspaceBindingPort(Arc::clone(&environment));
    // Missing sidecar is reported before composing the remaining runtime.
    let sidecar_metadata = fs::symlink_metadata(&roots.sidecar_executable)
        .map_err(|_| PluginBootstrapError::MissingSidecarExecutable)?;
    if !sidecar_metadata.is_file() || sidecar_metadata.file_type().is_symlink() {
        return Err(PluginBootstrapError::MissingSidecarExecutable);
    }

    let installer = open_installer(&roots.installer_packages, &roots.installer_data)
        .ok_or(PluginBootstrapError::MissingInstaller)?;

    // Restart discovery: every durable active installation is observed by
    // the manager, so locally installed plugins survive restarts. Opaque
    // per-project state stays empty until workspace plugin-state storage
    // exists.
    let installed_artifacts = installer
        .active_installations()
        .iter()
        .filter_map(|active| {
            match super::installation::map_active_installation(active) {
                Ok(artifact) => Some(artifact),
                // A corrupt durable install is skipped (correct), but it must
                // be visible — otherwise the plugin just "disappears" from
                // the center with no trail.
                Err(_) => {
                    tracing::warn!(
                        "skipping corrupt installed plugin {} at {}",
                        active.plugin_id,
                        active.package_directory.display()
                    );
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    let installed_plugin_ids = installed_artifacts
        .iter()
        .map(|artifact| artifact.plugin_id.clone())
        .collect::<BTreeSet<_>>();
    let workspace = match environment.active_workspace() {
        Some(context) => {
            CurrentPluginWorkspace::new(context.workspace_id, context.states, installed_artifacts)
                .with_bindings(context.bindings)
        }
        None => CurrentPluginWorkspace::detached(installed_artifacts),
    };

    let state = SharedNativePluginStatePersistencePort::open(&roots.state_private)
        .map_err(|_| PluginBootstrapError::MissingStatePersistence)?;
    state
        .retry_uninstalled_plugin_removals(&installed_plugin_ids)
        .map_err(|_| PluginBootstrapError::MissingStatePersistence)?;

    fs::create_dir_all(&roots.installer_packages)
        .map_err(|_| PluginBootstrapError::MissingPrivateArtifactRoot)?;
    // Resolver and sandbox validator share the exact canonical package root.
    let private_artifact_root = PrivateArtifactRoot::open(&roots.installer_packages)
        .map_err(|_| PluginBootstrapError::MissingPrivateArtifactRoot)?;

    let capability_sink: Arc<dyn super::PluginCapabilityEventSinkV2> =
        Arc::new(WebviewCapabilityEventSinkV2(Arc::clone(&environment)));
    let private_state: Arc<dyn super::PluginPrivateStatePersistenceV2> =
        Arc::new(NativePluginPrivateStatePortV2(state.clone()));
    let capability_gateway: Arc<dyn bbcom_plugin_broker::PluginCapabilityGateway> =
        Arc::new(super::NativePluginCapabilityGatewayV2::new_with_ports(
            capability_sink,
            serial_v2,
            projection,
            files,
            dialogs,
            private_state,
            workspace_capabilities,
            detached,
        ));
    let project_state_provider: Arc<dyn PluginProjectStateProviderV2> =
        Arc::new(EnvironmentProjectStateProvider(Arc::clone(&environment)));

    ProductionPluginRuntimeBuilder::new()
        .installer(Arc::clone(&installer))
        .trusted_repository(ConfiguredRepositoryProvider(Arc::clone(&sources)))
        .catalog(ConfiguredCatalogView {
            installer: Arc::clone(&installer),
            sources,
        })
        .workspace(workspace)
        .state_persistence(state)
        .sidecar_executable(roots.sidecar_executable)
        .private_artifact_root(private_artifact_root)
        .workspace_bindings(workspace_bindings)
        .capability_gateway(capability_gateway)
        .host_context_provider(host_context)
        .project_state_provider(project_state_provider)
        .build()
}

fn open_installer(packages: &Path, data: &Path) -> Option<Arc<PluginInstaller>> {
    fs::create_dir_all(packages).ok()?;
    fs::create_dir_all(data).ok()?;
    let installer = PluginInstaller::new(packages, data).ok()?;
    Some(Arc::new(installer))
}

/// Native-only package provider backed by the exact cached HTTPS source index.
struct ConfiguredRepositoryProvider(Arc<super::NativePluginSourceRegistry>);

impl VerifiedPackageProvider for ConfiguredRepositoryProvider {
    type Error = super::SourceRegistryError;

    fn download_verified(
        &mut self,
        request: &ManualPackageRequest,
    ) -> Result<DownloadedPackage, Self::Error> {
        self.0.download_verified(request)
    }
}

/// Catalog projection over the same cached source indexes used by installation.
struct ConfiguredCatalogView {
    installer: Arc<PluginInstaller>,
    sources: Arc<super::NativePluginSourceRegistry>,
}

impl CatalogViewPort for ConfiguredCatalogView {
    fn catalog(&mut self) -> Result<Vec<CatalogPluginRecord>, CatalogViewFailure> {
        let mut catalog = Vec::new();
        for (source_id, index) in self
            .sources
            .indexes()
            .map_err(|_| CatalogViewFailure::Unavailable)?
        {
            for plugin in index.plugins {
                let Some(package) = plugin
                    .packages
                    .into_iter()
                    .filter_map(|package| {
                        Version::parse(&package.version)
                            .ok()
                            .map(|version| (version, package))
                    })
                    .max_by(|left, right| left.0.cmp(&right.0))
                    .map(|(_, package)| package)
                else {
                    continue;
                };
                let install_request = ManualPackageRequest::new(
                    source_id.clone(),
                    plugin.id.clone(),
                    package.version.clone(),
                )
                .map_err(|_| CatalogViewFailure::InconsistentIdentity)?;
                catalog.push(CatalogPluginRecord {
                    catalog_id: format!("{source_id}:{}", plugin.id),
                    plugin_id: plugin.id.clone(),
                    display_name: plugin.name.unwrap_or_else(|| plugin.id.clone()),
                    description: plugin
                        .description
                        .unwrap_or_else(|| format!("Unsigned HTTPS source: {source_id}")),
                    version: package.version,
                    publisher_name: source_id.clone(),
                    install_request,
                });
            }
        }
        catalog.sort_by(|left, right| left.catalog_id.cmp(&right.catalog_id));
        Ok(catalog)
    }

    fn plugin_display(
        &mut self,
        plugin_id: &str,
    ) -> Result<PluginDisplayRecord, CatalogViewFailure> {
        let active = self
            .installer
            .active_installation(plugin_id)
            .map_err(|_| CatalogViewFailure::Unavailable)?
            .ok_or(CatalogViewFailure::MissingPluginDisplay)?;
        // An unreadable or malformed manifest still renders the plugin with
        // its identifier; the manifest was verified at install time, so this
        // is a display concern, never a trust decision.
        let display_name = std::fs::read_to_string(active.package_directory.join("plugin.toml"))
            .ok()
            .and_then(|text| bbcom_plugin_contracts::PluginManifest::parse(&text).ok())
            .map(|manifest| manifest.name)
            .unwrap_or_else(|| active.plugin_id.clone());
        Ok(PluginDisplayRecord {
            plugin_id: active.plugin_id,
            display_name,
            // The renderer's enabled flag follows the adapter's session
            // overrides and the manager's lifecycle status; a catalog entry
            // only supplies the neutral pre-approval default.
            enabled: false,
        })
    }
}

/// Process-lifetime holder for the active protocol-v2 plugin lifecycle.
pub struct PluginLifecycleHandle(Mutex<Option<Arc<dyn PluginRuntimeLifecycle>>>);

impl PluginLifecycleHandle {
    fn empty() -> Self {
        Self(Mutex::new(None))
    }

    fn install(&self, lifecycle: Arc<dyn PluginRuntimeLifecycle>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(lifecycle);
    }

    fn take(&self) -> Option<Arc<dyn PluginRuntimeLifecycle>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }

    pub(crate) fn current(&self) -> Option<Arc<dyn PluginRuntimeLifecycle>> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// Schedules `poll_host_exits` on the application runtime every 500 ms so
/// exited plugin hosts are reaped, reported and rolled back by the manager.
/// Scheduled from native setup only, never from a WebView.
pub fn spawn_host_exit_poll(lifecycle: Arc<dyn PluginRuntimeLifecycle>, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            // A newer composition retired this runtime; stop polling it.
            if HOST_EXIT_POLL_GENERATION.load(Ordering::Acquire) != generation {
                return;
            }
            let poll = Arc::clone(&lifecycle);
            match tauri::async_runtime::spawn_blocking(move || poll.poll_host_exits()).await {
                Ok(results) => {
                    for result in results {
                        match result {
                            Ok(snapshot) => tracing::info!(
                                plugin_id = %snapshot.artifact.plugin_id,
                                "plugin host exited"
                            ),
                            Err(error) => {
                                tracing::warn!("plugin host exit report failed: {error}")
                            }
                        }
                    }
                }
                Err(error) => tracing::warn!("plugin host exit poll join failed: {error}"),
            }
        }
    });
}

#[derive(Default)]
struct DevWatchState {
    observed: Option<[u8; 32]>,
    stable_reads: u8,
    baseline: Option<[u8; 32]>,
    attempted: Option<[u8; 32]>,
}

/// Native-only 250 ms sampler. A digest must be observed unchanged twice
/// before one reload is submitted, providing the required 500 ms debounce.
pub fn spawn_dev_directory_watchers<R: tauri::Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut states = HashMap::<String, DevWatchState>::new();
        let next_request = AtomicU64::new(1);
        loop {
            interval.tick().await;
            let Some(registry) = app.try_state::<Arc<super::NativePluginSourceRegistry>>() else {
                return;
            };
            let registry = registry.inner().clone();
            let watched = registry.watched_dev_directories().unwrap_or_default();
            let active_ids = watched
                .iter()
                .map(|source| source.source_id.clone())
                .collect::<std::collections::HashSet<_>>();
            states.retain(|source_id, _| active_ids.contains(source_id));
            for source in watched {
                let path = source.path.clone();
                let source_id = source.source_id.clone();
                let fingerprint = tauri::async_runtime::spawn_blocking(move || {
                    dev_directory_fingerprint(&path, &source_id)
                })
                .await
                .ok()
                .flatten();
                let Some(fingerprint) = fingerprint else {
                    let _ = registry.set_dev_health(&source.source_id, false);
                    continue;
                };
                let state = states.entry(source.source_id.clone()).or_default();
                if state.observed == Some(fingerprint) {
                    state.stable_reads = state.stable_reads.saturating_add(1);
                } else {
                    state.observed = Some(fingerprint);
                    state.stable_reads = 1;
                }
                if state.stable_reads < 2 {
                    continue;
                }
                if state.baseline.is_none() {
                    state.baseline = Some(fingerprint);
                    let _ = registry.set_dev_health(&source.source_id, true);
                    continue;
                }
                if state.baseline == Some(fingerprint) || state.attempted == Some(fingerprint) {
                    continue;
                }
                state.attempted = Some(fingerprint);
                let sequence = next_request.fetch_add(1, Ordering::Relaxed);
                let service = app
                    .state::<crate::commands::plugin::PluginCommandState>()
                    .current_service();
                let package_root = source.path.clone();
                let installed = tauri::async_runtime::spawn_blocking(move || {
                    let snapshot = service.execute(
                        crate::commands::plugin::PluginCommand::Snapshot(PluginSnapshotRequest {
                            request_id: format!("dev-watch-snapshot-{sequence}"),
                            revision: 0,
                            operation_id: format!("dev-watch-snapshot-operation-{sequence}"),
                        }),
                    )?;
                    service.execute(crate::commands::plugin::PluginCommand::InstallLocal {
                        request: InstallLocalPluginRequest {
                            request_id: format!("dev-watch-install-{sequence}"),
                            revision: snapshot.revision(),
                            operation_id: format!("dev-watch-install-operation-{sequence}"),
                            grant_id: format!("native-dev-watch-{sequence}"),
                        },
                        package_root,
                    })
                })
                .await
                .ok()
                .and_then(Result::ok)
                .is_some_and(|response| {
                    matches!(response, PluginCommandResponse::Completed { .. })
                });
                let _ = registry.set_dev_health(&source.source_id, installed);
                if installed {
                    state.baseline = Some(fingerprint);
                } else {
                    // A failed attempt must not leave `attempted` pinned to
                    // this fingerprint — that would block every retry until
                    // the content changed again. Reset the debounce so the
                    // install retries after two stable re-reads; revision
                    // conflicts against a concurrently mutated snapshot also
                    // clear themselves this way.
                    state.attempted = None;
                    state.observed = None;
                    state.stable_reads = 0;
                }
            }
        }
    });
}

fn dev_directory_fingerprint(path: &Path, source_id: &str) -> Option<[u8; 32]> {
    let manifest_bytes = fs::read(path.join("plugin.toml")).ok()?;
    if manifest_bytes.len() > 1024 * 1024 {
        return None;
    }
    let manifest_text = std::str::from_utf8(&manifest_bytes).ok()?;
    let manifest = bbcom_plugin_contracts::PluginManifest::parse(manifest_text).ok()?;
    if source_id != format!("dev-{}", manifest.id) {
        return None;
    }
    let component_path = path.join(&manifest.component.path);
    let metadata = fs::symlink_metadata(&component_path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 * 1024
    {
        return None;
    }
    let mut component = File::open(component_path).ok()?;
    let mut component_digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = component.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        component_digest.update(&buffer[..read]);
    }
    let component_hex = format!("{:x}", component_digest.finalize());
    let mut fingerprint = Sha256::new();
    fingerprint.update(&manifest_bytes);
    fingerprint.update(component_hex.as_bytes());
    Some(fingerprint.finalize().into())
}

/// Closes the plugin project context, force-stopping every plugin host. Must
/// run before the active workspace is replaced and before the native shutdown
/// gate completes. Absent lifecycle state (runtime never composed) is a no-op.
pub fn close_plugin_project<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(handle) = app.try_state::<PluginLifecycleHandle>() else {
        return;
    };
    let Some(lifecycle) = handle.current() else {
        return;
    };
    if let Err(error) = lifecycle.close_project() {
        tracing::warn!("plugin project close failed: {error}");
    }
}

/// Managed-state bootstrap for native setup: the fail-closed defaults that
/// `ensure_plugin_runtime` swaps in place. Setup must call this before the
/// first composition attempt.
pub fn install_managed_defaults<R: tauri::Runtime>(app: &AppHandle<R>) {
    app.manage(PluginLifecycleHandle::empty());
}

/// Resolves the bundled plugin-host sidecar executable.
///
/// Resolution order: next to the running executable (packaged builds bundle
/// the sidecar via `externalBin`, which strips the target-triple suffix), then
/// the dev fallbacks `binaries/bbcom-plugin-host-<triple>` relative to the
/// executable or the current directory (`src-tauri/binaries/...` when started
/// from the repository root, as produced by `scripts/prepare-plugin-sidecar.mjs`).
fn resolve_sidecar_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let triple = current_target_triple();
    let mut candidates = Vec::new();
    if cfg!(windows) {
        candidates.push(exe_dir.join(format!("{SIDECAR_BASENAME}.exe")));
        if !triple.is_empty() {
            candidates.push(exe_dir.join(format!("{SIDECAR_BASENAME}-{triple}.exe")));
        }
    } else {
        candidates.push(exe_dir.join(SIDECAR_BASENAME));
        if !triple.is_empty() {
            candidates.push(exe_dir.join(format!("{SIDECAR_BASENAME}-{triple}")));
        }
    }
    if !triple.is_empty() {
        let name = if cfg!(windows) {
            format!("{SIDECAR_BASENAME}-{triple}.exe")
        } else {
            format!("{SIDECAR_BASENAME}-{triple}")
        };
        candidates.push(exe_dir.join("binaries").join(&name));
        if let Ok(current) = std::env::current_dir() {
            candidates.push(current.join("binaries").join(&name));
            candidates.push(current.join("src-tauri").join("binaries").join(&name));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| is_regular_file(candidate))
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

/// Materialize an immutable, content-addressed sidecar in a writable private
/// root. This is platform-neutral for unit coverage but used only on Windows.
fn stage_runtime_sidecar(source: &Path, root: &Path) -> std::io::Result<PathBuf> {
    let source_metadata = fs::symlink_metadata(source)?;
    if !source_metadata.is_file() || source_metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "plugin sidecar source is not a regular file",
        ));
    }
    let digest = file_sha256(source)?;
    fs::create_dir_all(root)?;
    let root_metadata = fs::symlink_metadata(root)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "plugin sidecar runtime root is unsafe",
        ));
    }

    let extension = source.extension().and_then(|value| value.to_str());
    let file_name = match extension {
        Some(extension) => format!("{SIDECAR_BASENAME}-{digest}.{extension}"),
        None => format!("{SIDECAR_BASENAME}-{digest}"),
    };
    let destination = root.join(file_name);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(std::io::Error::other("staged plugin sidecar is unsafe"));
            }
            if file_sha256(&destination)? == digest {
                return Ok(destination);
            }
            fs::remove_file(&destination)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let sequence = NEXT_SIDECAR_STAGE_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = root.join(format!(
        ".{SIDECAR_BASENAME}-{}-{sequence}.tmp",
        std::process::id()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut input = File::open(source)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        if file_sha256(&temporary)? != digest {
            return Err(std::io::Error::other(
                "staged plugin sidecar digest mismatch",
            ));
        }
        fs::rename(&temporary, &destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(destination)
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// Compile-target triple used for dev sidecar fallbacks. Packaged resolution
/// does not depend on it; an unmapped platform simply has no dev fallback.
fn current_target_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => {
            if cfg!(target_env = "musl") {
                "x86_64-unknown-linux-musl"
            } else {
                "x86_64-unknown-linux-gnu"
            }
        }
        ("linux", "aarch64") => {
            if cfg!(target_env = "musl") {
                "aarch64-unknown-linux-musl"
            } else {
                "aarch64-unknown-linux-gnu"
            }
        }
        ("linux", "riscv64") => "riscv64gc-unknown-linux-gnu",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        _ => "",
    }
}

#[cfg(test)]
mod sidecar_staging_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    struct ProjectStateEnvironment {
        active: Mutex<Option<crate::commands::workspace::NativePluginWorkspaceSnapshot>>,
        lifecycle_mutations: AtomicUsize,
    }

    impl HostUpstreamEnvironment for ProjectStateEnvironment {
        fn emit_to_main(&self, _: &'static str, _: &serde_json::Value) -> Result<(), ()> {
            Ok(())
        }

        fn active_workspace(
            &self,
        ) -> Option<crate::commands::workspace::NativePluginWorkspaceSnapshot> {
            self.active.lock().ok()?.clone()
        }

        fn set_plugin_expected_enabled(&self, _: &str, _: bool) -> Result<(), ()> {
            self.lifecycle_mutations
                .fetch_add(1, AtomicOrdering::Relaxed);
            Err(())
        }

        fn uninstall_with_plugin_contribution_cleanup(
            &self,
            _: &str,
            _: PluginContributionDisposition,
            _: &mut dyn FnMut() -> bool,
        ) -> Result<bool, ()> {
            self.lifecycle_mutations
                .fetch_add(1, AtomicOrdering::Relaxed);
            Err(())
        }

        fn recover_plugin_contribution_uninstall(&self, _: &BTreeSet<String>) -> Result<(), ()> {
            Ok(())
        }
    }

    fn project_workspace(
        workspace_id: &str,
        schema_version: u32,
        bytes: &[u8],
    ) -> crate::commands::workspace::NativePluginWorkspaceSnapshot {
        crate::commands::workspace::NativePluginWorkspaceSnapshot {
            workspace_id: workspace_id.to_owned(),
            bindings: Vec::new(),
            states: vec![
                bbcom_plugin_manager::OpaqueProjectPluginState::new_with_versions(
                    "dev.bbcom.fixture",
                    bytes.to_vec(),
                    2,
                    Some(schema_version),
                )
                .unwrap(),
            ],
        }
    }

    #[test]
    fn project_state_provider_reloads_latest_state_without_lifecycle_reentry() {
        let environment = Arc::new(ProjectStateEnvironment {
            active: Mutex::new(Some(project_workspace("workspace-a", 2, b"old"))),
            lifecycle_mutations: AtomicUsize::new(0),
        });
        let provider = EnvironmentProjectStateProvider(Arc::clone(&environment));

        let first = provider
            .current_project_state("workspace-a", "dev.bbcom.fixture")
            .unwrap()
            .unwrap();
        assert_eq!(first.schema_version, Some(2));
        assert_eq!(first.value, b"old");

        // Simulate a guest's durable set followed by a same-process crash.
        // The next launch reads the workspace again rather than the manager's
        // original bootstrap projection.
        *environment.active.lock().unwrap() = Some(project_workspace("workspace-a", 73, b"latest"));
        let restarted = provider
            .current_project_state("workspace-a", "dev.bbcom.fixture")
            .unwrap()
            .unwrap();
        assert_eq!(restarted.schema_version, Some(73));
        assert_eq!(restarted.value, b"latest");
        assert_eq!(restarted.api_generation, 2);

        // Workspace identity is checked by the native provider, and reading
        // state never calls a lifecycle mutation while initialization owns
        // the PluginManager mutex.
        assert_eq!(
            provider.current_project_state("workspace-b", "dev.bbcom.fixture"),
            Err(bbcom_plugin_manager::HostFailure::Initialization)
        );
        assert_eq!(
            environment
                .lifecycle_mutations
                .load(AtomicOrdering::Relaxed),
            0
        );
    }

    #[test]
    fn runtime_sidecar_is_content_addressed_reused_and_repaired() {
        let fixture = tempfile::tempdir().expect("fixture");
        let source = fixture.path().join("bbcom-plugin-host.exe");
        let runtime = fixture.path().join("runtime");
        fs::write(&source, b"trusted-sidecar-v1").expect("source");

        let first = stage_runtime_sidecar(&source, &runtime).expect("first stage");
        let second = stage_runtime_sidecar(&source, &runtime).expect("reuse stage");
        assert_eq!(first, second);
        assert_eq!(
            fs::read(&first).expect("staged bytes"),
            b"trusted-sidecar-v1"
        );

        fs::write(&first, b"corrupt").expect("corrupt staged copy");
        let repaired = stage_runtime_sidecar(&source, &runtime).expect("repair stage");
        assert_eq!(repaired, first);
        assert_eq!(
            fs::read(repaired).expect("repaired bytes"),
            b"trusted-sidecar-v1"
        );

        fs::write(&source, b"trusted-sidecar-v2").expect("upgrade source");
        let upgraded = stage_runtime_sidecar(&source, &runtime).expect("upgrade stage");
        assert_ne!(upgraded, first);
        assert_eq!(
            fs::read(upgraded).expect("upgraded bytes"),
            b"trusted-sidecar-v2"
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_sidecar_rejects_symlink_sources_roots_and_destinations() {
        use std::os::unix::fs::symlink;

        let fixture = tempfile::tempdir().expect("fixture");
        let source = fixture.path().join("host.exe");
        let source_link = fixture.path().join("host-link.exe");
        fs::write(&source, b"host").expect("source");
        symlink(&source, &source_link).expect("source link");
        assert!(stage_runtime_sidecar(&source_link, &fixture.path().join("runtime")).is_err());

        let real_root = fixture.path().join("real-runtime");
        let linked_root = fixture.path().join("linked-runtime");
        fs::create_dir(&real_root).expect("real root");
        symlink(&real_root, &linked_root).expect("root link");
        assert!(stage_runtime_sidecar(&source, &linked_root).is_err());

        let runtime = fixture.path().join("runtime");
        fs::create_dir(&runtime).expect("runtime");
        let digest = file_sha256(&source).expect("source digest");
        let destination = runtime.join(format!("{SIDECAR_BASENAME}-{digest}.exe"));
        let dangling_target = runtime.join("missing.exe");
        symlink(dangling_target, destination).expect("destination link");
        assert!(stage_runtime_sidecar(&source, &runtime).is_err());
    }
}
