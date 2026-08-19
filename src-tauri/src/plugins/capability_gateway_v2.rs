//! Production application gateway for typed plugin protocol-v2 capabilities.
//!
//! Serial authority remains in the main WebView runtime, so the native side
//! emits a closed DTO and waits on an exact, bounded correlation. Presentation
//! state and opaque file resources stay native and are generation-bound.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use bbcom_contracts::{
    PluginCommandContributionV2, PluginErrorCodeV2, PluginFailureV2, PluginGatewayContextV2,
    PluginHostContextUpdateRequestV2, PluginHostLocaleV2, PluginHostThemeV2, PluginKeyValueEntry,
    PluginResourceBindingV2, PluginSelectOption, PluginSerialCapabilityInboundV2,
    PluginSerialCapabilityOperationV2, PluginSerialCapabilityOutboundV2,
    PluginSerialCapabilityResultV2, PluginSerialConfigV2, PluginSerialFrameDirectionV2,
    PluginSerialPortV2, PluginSerialSessionLifetimeV2, PluginSerialSessionV2,
    PluginSerialWriteOutcomeV2, PluginSurfacePlacement, PluginSurfaceSnapshot, PluginTableColumn,
    PluginTaskStatusV2, PluginTaskViewV2, PluginTextTone, PluginUiNode, PluginUiTab,
    RuntimeInstanceKey,
};
use bbcom_plugin_broker::{
    GatewayContext, GatewayFailure, PluginCapabilityGateway, RuntimeBootstrapState, StreamEvent,
    TaskTerminal,
};
use bbcom_plugin_contracts::generated_v2::{self as wire, ErrorCode, request, response};
use bbcom_plugin_contracts::v2::{
    MAX_PENDING_HOST_REQUESTS, MAX_STREAM_CHUNK_BYTES, SERIAL_READ_TIMEOUT_MS,
    validate_surface_patch, validate_surface_snapshot,
};
use bbcom_plugin_contracts::{MAX_PLUGIN_PERSISTED_STATE_BYTES, MAX_PLUGIN_STATE_CHUNK_BYTES};

use super::file_grants_v2::{PluginFileError, PluginFileGrantService, PluginFileGrantView};
use super::presentation_v2::{
    validate_command_projection_v2, validate_surface_projection_v2, validate_task_projection_v2,
};

pub const PLUGIN_SERIAL_CAPABILITY_EVENT_V2: &str = "plugin-serial-capability-v2";
pub const PLUGIN_SNAPSHOT_CHANGED_EVENT_V2: &str = "plugin-snapshot-changed";
const SERIAL_CAPABILITY_TIMEOUT: Duration = Duration::from_secs(10);
const SERIAL_READ_RENDERER_MARGIN: Duration = Duration::from_secs(2);
const MAX_PROJECTED_SURFACES: usize = 32;
const MAX_PROJECTED_TASKS: usize = 128;
const MAX_PROJECTED_COMMANDS: usize = 256;
const MAX_PENDING_SERIAL_CAPABILITIES: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_STORAGE_KEY_BYTES: usize = 128;
const STORAGE_MAGIC: &[u8; 8] = b"BBCPKV02";

fn serial_read_renderer_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms)) + SERIAL_READ_RENDERER_MARGIN
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginHostInitializationContextV2 {
    pub locale: String,
    pub theme: wire::ColorScheme,
    pub sessions: Vec<wire::SessionSummary>,
}

#[derive(Clone)]
struct PluginHostContextStateV2 {
    hydrated: bool,
    workspace_id: Option<String>,
    locale: PluginHostLocaleV2,
    theme: PluginHostThemeV2,
    sessions: Vec<wire::SessionSummary>,
}

impl Default for PluginHostContextStateV2 {
    fn default() -> Self {
        Self {
            hydrated: false,
            workspace_id: None,
            // These values are placeholders only. `initialization_context`
            // fails closed until the main window has supplied its hydrated
            // application state, so a guest never observes them as a claimed
            // production HostContext.
            locale: PluginHostLocaleV2::Zh,
            theme: PluginHostThemeV2::Dark,
            sessions: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginHostContextChangesV2 {
    pub locale: Option<String>,
    pub theme: Option<wire::ColorScheme>,
}

#[derive(Default)]
pub struct PluginHostContextStoreV2 {
    state: Mutex<PluginHostContextStateV2>,
}

impl PluginHostContextStoreV2 {
    pub fn update(
        &self,
        request: PluginHostContextUpdateRequestV2,
    ) -> Result<PluginHostContextChangesV2, GatewayFailure> {
        if request.sessions.len() > 1_024 {
            return Err(limit_failure());
        }
        if let Some(workspace_id) = request.workspace_id.as_deref() {
            validate_identity(workspace_id)?;
        }
        let mut seen = HashSet::new();
        let mut sessions = Vec::with_capacity(request.sessions.len());
        for session in request.sessions {
            validate_identity(&session.session_id)?;
            validate_short_text(&session.name, false)?;
            if !seen.insert(session.session_id.clone())
                || session.rx_bytes > MAX_SAFE_INTEGER
                || session.tx_bytes > MAX_SAFE_INTEGER
                || session.generation > MAX_SAFE_INTEGER
                || (session.connected && session.generation == 0)
            {
                return Err(invalid_failure());
            }
            sessions.push(wire::SessionSummary {
                session_id: session.session_id,
                name: session.name,
                connected: session.connected,
                rx_bytes: session.rx_bytes,
                tx_bytes: session.tx_bytes,
                generation: session.generation,
            });
        }
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let locale = (state.locale != request.locale).then(|| host_locale(request.locale));
        let theme = (state.theme != request.theme).then(|| host_theme(request.theme));
        state.hydrated = true;
        state.workspace_id = request.workspace_id;
        state.locale = request.locale;
        state.theme = request.theme;
        state.sessions = sessions;
        Ok(PluginHostContextChangesV2 { locale, theme })
    }

    pub fn initialization_context(
        &self,
        workspace_id: &str,
    ) -> Result<PluginHostInitializationContextV2, GatewayFailure> {
        validate_identity(workspace_id)?;
        let state = self.state.lock().map_err(|_| unavailable_failure())?;
        if !state.hydrated {
            return Err(unavailable_failure());
        }
        Ok(PluginHostInitializationContextV2 {
            locale: host_locale(state.locale),
            theme: host_theme(state.theme),
            sessions: if state.workspace_id.as_deref() == Some(workspace_id) {
                state.sessions.clone()
            } else {
                Vec::new()
            },
        })
    }
}

impl super::host_launcher::PluginHostContextProviderV2 for PluginHostContextStoreV2 {
    fn context_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<
        super::host_launcher::PluginInitializationContextV2,
        bbcom_plugin_manager::HostFailure,
    > {
        let value = self
            .initialization_context(workspace_id)
            .map_err(|_| bbcom_plugin_manager::HostFailure::Initialization)?;
        Ok(super::host_launcher::PluginInitializationContextV2 {
            locale: value.locale,
            theme: value.theme,
            sessions: value.sessions,
        })
    }
}

fn host_locale(locale: PluginHostLocaleV2) -> String {
    match locale {
        PluginHostLocaleV2::En => "en-US",
        PluginHostLocaleV2::Zh => "zh-CN",
    }
    .to_owned()
}

const fn host_theme(theme: PluginHostThemeV2) -> wire::ColorScheme {
    match theme {
        PluginHostThemeV2::Light => wire::ColorScheme::Light,
        PluginHostThemeV2::Dark => wire::ColorScheme::Dark,
    }
}

/// Trusted native dialog boundary. Implementations return a path only inside
/// native memory; the gateway immediately converts it into an opaque grant.
pub trait PluginFileDialogPortV2: Send + Sync + 'static {
    fn open_read(
        &self,
        accepted_extensions: &[String],
    ) -> Result<Option<PathBuf>, PluginErrorCodeV2>;
    fn create_save(&self, suggested_name: &str) -> Result<Option<PathBuf>, PluginErrorCodeV2>;
}

/// Durable private-state sink. `storage_scope` is generated by the launcher;
/// production persistence is invoked only for the exact `active` scope.
/// Prepared preflight state is deliberately runtime-only.
pub trait PluginPrivateStatePersistenceV2: Send + Sync + 'static {
    fn persist_plugin_storage(
        &self,
        context: &GatewayContext,
        storage_scope: &str,
        encoded: &[u8],
    ) -> Result<(), PluginErrorCodeV2>;
}

/// Native workspace mutation boundary for portable project state and owned
/// quick-command/macro contributions.
pub trait PluginWorkspaceCapabilityPortV2: Send + Sync + 'static {
    fn set_project_state(
        &self,
        context: &GatewayContext,
        schema_version: u32,
        value: &[u8],
    ) -> Result<(), PluginErrorCodeV2>;
    fn upsert_quick_command(
        &self,
        context: &GatewayContext,
        command: &wire::QuickCommand,
    ) -> Result<String, PluginErrorCodeV2>;
    fn delete_quick_command(
        &self,
        context: &GatewayContext,
        session_id: &str,
        local_id: &str,
    ) -> Result<(), PluginErrorCodeV2>;
    fn upsert_macro(
        &self,
        context: &GatewayContext,
        value: &wire::MacroContribution,
    ) -> Result<String, PluginErrorCodeV2>;
    fn delete_macro(
        &self,
        context: &GatewayContext,
        session_id: &str,
        local_id: &str,
    ) -> Result<(), PluginErrorCodeV2>;
}

pub trait PluginDetachedProjectionPortV2: Send + Sync + 'static {
    fn sync(
        &self,
        center_revision: u64,
        projection: &PluginRuntimeProjectionSnapshotV2,
    ) -> Result<(), PluginErrorCodeV2>;
    fn open(
        &self,
        center_revision: u64,
        runtime: &RuntimeInstanceKey,
        surface_id: &str,
        projection: &PluginRuntimeProjectionSnapshotV2,
    ) -> Result<(), PluginErrorCodeV2>;
    fn revoke_surface(&self, runtime: &RuntimeInstanceKey, surface_id: &str);
    fn revoke_runtime(&self, runtime: &RuntimeInstanceKey);
}

struct UnavailableFileDialog;
impl PluginFileDialogPortV2 for UnavailableFileDialog {
    fn open_read(&self, _: &[String]) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
    fn create_save(&self, _: &str) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
}

struct UnavailablePrivateState;
impl PluginPrivateStatePersistenceV2 for UnavailablePrivateState {
    fn persist_plugin_storage(
        &self,
        _: &GatewayContext,
        _: &str,
        _: &[u8],
    ) -> Result<(), PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
}

struct UnavailableWorkspaceCapabilities;
impl PluginWorkspaceCapabilityPortV2 for UnavailableWorkspaceCapabilities {
    fn set_project_state(
        &self,
        _: &GatewayContext,
        _: u32,
        _: &[u8],
    ) -> Result<(), PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
    fn upsert_quick_command(
        &self,
        _: &GatewayContext,
        _: &wire::QuickCommand,
    ) -> Result<String, PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
    fn delete_quick_command(
        &self,
        _: &GatewayContext,
        _: &str,
        _: &str,
    ) -> Result<(), PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
    fn upsert_macro(
        &self,
        _: &GatewayContext,
        _: &wire::MacroContribution,
    ) -> Result<String, PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
    fn delete_macro(&self, _: &GatewayContext, _: &str, _: &str) -> Result<(), PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
}

struct UnavailableDetachedProjection;
impl PluginDetachedProjectionPortV2 for UnavailableDetachedProjection {
    fn sync(&self, _: u64, _: &PluginRuntimeProjectionSnapshotV2) -> Result<(), PluginErrorCodeV2> {
        Ok(())
    }
    fn open(
        &self,
        _: u64,
        _: &RuntimeInstanceKey,
        _: &str,
        _: &PluginRuntimeProjectionSnapshotV2,
    ) -> Result<(), PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
    fn revoke_surface(&self, _: &RuntimeInstanceKey, _: &str) {}
    fn revoke_runtime(&self, _: &RuntimeInstanceKey) {}
}

/// Testable boundary for the only WebView-backed capability subset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PluginCapabilitySinkErrorV2;

pub trait PluginCapabilityEventSinkV2: Send + Sync + 'static {
    fn emit_serial(
        &self,
        event: &PluginSerialCapabilityInboundV2,
    ) -> Result<(), PluginCapabilitySinkErrorV2>;

    fn projection_changed(&self) -> Result<(), PluginCapabilitySinkErrorV2> {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PendingSerialKind {
    ListPorts,
    ListSessions,
    CreateSession,
    UpdateSession {
        session_id: String,
    },
    ConnectSession {
        session_id: String,
    },
    DisconnectSession,
    DeleteSession,
    AcquireSerialLease,
    ReleaseSerialLease,
    SerialRead {
        maximum_bytes: usize,
        timeout_ms: u32,
    },
    SerialWrite {
        requested_bytes: u64,
    },
    ClearSerialBuffers,
    PendingSerialBytes,
    SetOutputLines,
    ReadInputLines,
    CaptureRead {
        from_sequence: u64,
        maximum_frames: usize,
        maximum_bytes: usize,
    },
}

struct PendingSerialCapability {
    context: PluginGatewayContextV2,
    expected: PendingSerialKind,
    sender: mpsc::Sender<Result<PluginSerialCapabilityResultV2, PluginErrorCodeV2>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SerialCapabilityReplyErrorV2 {
    UnknownCorrelation,
    ContextMismatch,
    InvalidShape,
    Unavailable,
}

/// Process-lifetime reply registry used by the main-window Tauri command.
#[derive(Clone, Default)]
pub struct SerialCapabilityCorrelationRegistryV2 {
    pending: Arc<Mutex<HashMap<(String, u64), PendingSerialCapability>>>,
}

impl SerialCapabilityCorrelationRegistryV2 {
    fn register(
        &self,
        context: PluginGatewayContextV2,
        message_id: u64,
        expected: PendingSerialKind,
    ) -> Result<
        mpsc::Receiver<Result<PluginSerialCapabilityResultV2, PluginErrorCodeV2>>,
        GatewayFailure,
    > {
        if message_id == 0 {
            return Err(protocol_failure());
        }
        let key = correlation_key(&context, message_id);
        let mut pending = self.pending.lock().map_err(|_| unavailable_failure())?;
        let runtime_pending = pending
            .values()
            .filter(|value| value.context == context)
            .count();
        if pending.len() >= MAX_PENDING_SERIAL_CAPABILITIES
            || runtime_pending >= MAX_PENDING_HOST_REQUESTS as usize
        {
            return Err(limit_failure());
        }
        let (sender, receiver) = mpsc::channel();
        if pending.contains_key(&key) {
            return Err(protocol_failure());
        }
        pending.insert(
            key,
            PendingSerialCapability {
                context,
                expected,
                sender,
            },
        );
        Ok(receiver)
    }

    pub fn complete(
        &self,
        event: PluginSerialCapabilityOutboundV2,
    ) -> Result<(), SerialCapabilityReplyErrorV2> {
        match event {
            PluginSerialCapabilityOutboundV2::Response { response } => {
                let key = correlation_key(&response.context, response.reply_to);
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| SerialCapabilityReplyErrorV2::Unavailable)?;
                let entry = pending
                    .get(&key)
                    .ok_or(SerialCapabilityReplyErrorV2::UnknownCorrelation)?;
                if entry.context != response.context {
                    return Err(SerialCapabilityReplyErrorV2::ContextMismatch);
                }
                let answer = validate_serial_response(&entry.expected, response)?;
                let entry = pending
                    .remove(&key)
                    .ok_or(SerialCapabilityReplyErrorV2::UnknownCorrelation)?;
                entry
                    .sender
                    .send(answer)
                    .map_err(|_| SerialCapabilityReplyErrorV2::UnknownCorrelation)
            }
            PluginSerialCapabilityOutboundV2::CancelResult {
                context,
                target_message_id,
                ok,
                error_code,
            } => {
                let key = correlation_key(&context, target_message_id);
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| SerialCapabilityReplyErrorV2::Unavailable)?;
                let entry = pending
                    .get(&key)
                    .ok_or(SerialCapabilityReplyErrorV2::UnknownCorrelation)?;
                if entry.context != context
                    || (ok && error_code.is_some())
                    || (!ok && error_code.is_none())
                {
                    return Err(SerialCapabilityReplyErrorV2::InvalidShape);
                }
                if !ok {
                    // A rejected cancellation leaves the original request
                    // alive; its ordinary response may still arrive.
                    return Ok(());
                }
                let entry = pending
                    .remove(&key)
                    .ok_or(SerialCapabilityReplyErrorV2::UnknownCorrelation)?;
                entry
                    .sender
                    .send(Err(PluginErrorCodeV2::Cancelled))
                    .map_err(|_| SerialCapabilityReplyErrorV2::UnknownCorrelation)
            }
        }
    }

    fn discard(&self, context: &PluginGatewayContextV2, message_id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&correlation_key(context, message_id));
        }
    }

    pub fn revoke_runtime(&self, context: &PluginGatewayContextV2) -> usize {
        let Ok(mut pending) = self.pending.lock() else {
            return 0;
        };
        let keys = pending
            .iter()
            .filter(|(_, value)| value.context == *context)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in &keys {
            if let Some(value) = pending.remove(key) {
                let _ = value.sender.send(Err(PluginErrorCodeV2::Cancelled));
            }
        }
        keys.len()
    }

    pub fn revoke_all(&self) -> usize {
        let Ok(mut pending) = self.pending.lock() else {
            return 0;
        };
        let values = pending.drain().map(|(_, value)| value).collect::<Vec<_>>();
        for value in &values {
            let _ = value.sender.send(Err(PluginErrorCodeV2::Cancelled));
        }
        values.len()
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending.lock().map(|value| value.len()).unwrap_or(0)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginRuntimeProjectionSnapshotV2 {
    pub surfaces: Vec<PluginSurfaceSnapshot>,
    pub tasks: Vec<PluginTaskViewV2>,
    pub command_contributions: Vec<PluginCommandContributionV2>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RuntimeKey {
    workspace_id: String,
    plugin_id: String,
    instance_id: u64,
    generation: u64,
}

impl RuntimeKey {
    fn public(&self) -> RuntimeInstanceKey {
        RuntimeInstanceKey {
            workspace_id: self.workspace_id.clone(),
            plugin_id: self.plugin_id.clone(),
            instance_id: self.instance_id,
            generation: self.generation,
        }
    }
}

#[derive(Clone)]
struct ProjectedSurface {
    registration: wire::PluginSurface,
    detached_allowed: bool,
    editable: bool,
    document: Option<wire::SurfaceSnapshot>,
}

#[derive(Clone)]
struct ProjectedCommand {
    view: PluginCommandContributionV2,
    long_running: bool,
}

#[derive(Clone)]
struct ProjectedTask {
    view: PluginTaskViewV2,
    last_activity: Instant,
}

#[derive(Default)]
struct ProjectionState {
    surfaces: BTreeMap<(RuntimeKey, String), ProjectedSurface>,
    commands: BTreeMap<(RuntimeKey, String), ProjectedCommand>,
    tasks: BTreeMap<(RuntimeKey, String), ProjectedTask>,
}

/// Native, generation-bound presentation model consumed by plugin-center
/// snapshots. No guest markup or native resource is retained here.
#[derive(Default)]
pub struct PluginRuntimeProjectionV2 {
    state: Mutex<ProjectionState>,
    change_sink: Mutex<Option<Arc<dyn PluginCapabilityEventSinkV2>>>,
}

impl PluginRuntimeProjectionV2 {
    fn install_change_sink(&self, sink: Arc<dyn PluginCapabilityEventSinkV2>) {
        if let Ok(mut current) = self.change_sink.lock() {
            *current = Some(sink);
        }
    }

    pub fn notify_changed(&self) {
        if let Ok(current) = self.change_sink.lock()
            && let Some(sink) = current.as_ref()
        {
            let _ = sink.projection_changed();
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> PluginRuntimeProjectionSnapshotV2 {
        let Ok(state) = self.state.lock() else {
            return PluginRuntimeProjectionSnapshotV2::default();
        };
        let mut snapshot = PluginRuntimeProjectionSnapshotV2 {
            surfaces: state
                .surfaces
                .iter()
                .filter_map(|((runtime, _), surface)| {
                    surface
                        .document
                        .as_ref()
                        .and_then(|document| project_surface(runtime, surface, document).ok())
                })
                .collect(),
            tasks: state.tasks.values().map(|task| task.view.clone()).collect(),
            command_contributions: state
                .commands
                .values()
                .map(|command| command.view.clone())
                .collect(),
        };
        snapshot.surfaces.sort_by(|left, right| {
            runtime_sort_key(&left.runtime)
                .cmp(&runtime_sort_key(&right.runtime))
                .then_with(|| left.surface_id.cmp(&right.surface_id))
        });
        snapshot.tasks.sort_by(|left, right| {
            runtime_sort_key(&left.runtime)
                .cmp(&runtime_sort_key(&right.runtime))
                .then_with(|| left.task_id.cmp(&right.task_id))
        });
        snapshot.command_contributions.sort_by(|left, right| {
            runtime_sort_key(&left.runtime)
                .cmp(&runtime_sort_key(&right.runtime))
                .then_with(|| left.command_id.cmp(&right.command_id))
        });
        snapshot
    }

    fn register_surface(
        &self,
        context: &GatewayContext,
        registration: wire::PluginSurface,
    ) -> Result<(), GatewayFailure> {
        let runtime = runtime_key(context)?;
        validate_identity(&registration.surface_id)?;
        validate_short_text(&registration.title, false)?;
        let location = wire::SurfaceLocation::try_from(registration.location)
            .ok()
            .filter(|value| *value != wire::SurfaceLocation::Unspecified)
            .ok_or_else(invalid_failure)?;
        let detached_allowed = context
            .granted_capabilities
            .contains(&wire::Capability::UiDetachedWindow);
        if location == wire::SurfaceLocation::DetachedWindow && !detached_allowed {
            return Err(permission_failure());
        }
        let key = (runtime, registration.surface_id.clone());
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        if state.surfaces.len() >= MAX_PROJECTED_SURFACES && !state.surfaces.contains_key(&key) {
            return Err(limit_failure());
        }
        match state.surfaces.get_mut(&key) {
            Some(existing) => {
                existing.registration = registration;
                existing.detached_allowed = detached_allowed;
            }
            None => {
                state.surfaces.insert(
                    key,
                    ProjectedSurface {
                        registration,
                        detached_allowed,
                        editable: true,
                        document: None,
                    },
                );
            }
        }
        Ok(())
    }

    fn unregister_surface(
        &self,
        context: &GatewayContext,
        surface_id: &str,
    ) -> Result<(), GatewayFailure> {
        validate_identity(surface_id)?;
        let key = (runtime_key(context)?, surface_id.to_owned());
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        state.surfaces.remove(&key).ok_or_else(not_found_failure)?;
        Ok(())
    }

    fn publish_snapshot(
        &self,
        context: &GatewayContext,
        document: wire::SurfaceSnapshot,
    ) -> Result<(), GatewayFailure> {
        validate_surface_snapshot(&document).map_err(|_| invalid_failure())?;
        let key = (runtime_key(context)?, document.surface_id.clone());
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let surface = state.surfaces.get_mut(&key).ok_or_else(not_found_failure)?;
        if surface
            .document
            .as_ref()
            .is_some_and(|current| document.revision <= current.revision)
        {
            return Err(revision_failure());
        }
        let projected = project_surface(&key.0, surface, &document)?;
        validate_surface_projection_v2(&projected).map_err(|_| invalid_failure())?;
        surface.document = Some(document);
        Ok(())
    }

    fn publish_patch(
        &self,
        context: &GatewayContext,
        patch: wire::SurfacePatch,
    ) -> Result<(), GatewayFailure> {
        validate_surface_patch(&patch).map_err(|_| invalid_failure())?;
        let key = (runtime_key(context)?, patch.surface_id.clone());
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let surface = state.surfaces.get_mut(&key).ok_or_else(not_found_failure)?;
        let mut document = surface.document.clone().ok_or_else(not_found_failure)?;
        if document.revision != patch.base_revision {
            return Err(revision_failure());
        }
        for operation in patch.operations {
            use wire::ui_patch_operation::Operation;
            match operation.operation.ok_or_else(protocol_failure)? {
                Operation::Upsert(node) => {
                    if let Some(existing) =
                        document.nodes.iter_mut().find(|value| value.id == node.id)
                    {
                        *existing = node;
                    } else {
                        document.nodes.push(node);
                    }
                }
                Operation::Remove(node_id) => {
                    document.nodes.retain(|value| value.id != node_id);
                }
                Operation::SetRoot(node_id) => document.root_node_id = node_id,
            }
        }
        document.revision = patch.next_revision;
        validate_surface_snapshot(&document).map_err(|_| invalid_failure())?;
        let projected = project_surface(&key.0, surface, &document)?;
        validate_surface_projection_v2(&projected).map_err(|_| invalid_failure())?;
        surface.document = Some(document);
        Ok(())
    }

    fn register_command(
        &self,
        context: &GatewayContext,
        command: wire::CommandContribution,
    ) -> Result<(), GatewayFailure> {
        validate_identity(&command.command_id)?;
        validate_short_text(&command.title, false)?;
        validate_long_text(&command.description)?;
        if let Some(confirmation) = command.confirmation.as_deref() {
            validate_short_text(confirmation, false)?;
        }
        let runtime = runtime_key(context)?;
        let view = PluginCommandContributionV2 {
            runtime: runtime.public(),
            command_id: command.command_id.clone(),
            title: command.title,
            description: command.description,
            dangerous: command.confirmation.is_some(),
            confirmation: command.confirmation,
        };
        validate_command_projection_v2(&view).map_err(|_| invalid_failure())?;
        let key = (runtime, command.command_id);
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        if state.commands.len() >= MAX_PROJECTED_COMMANDS && !state.commands.contains_key(&key) {
            return Err(limit_failure());
        }
        state.commands.insert(
            key,
            ProjectedCommand {
                view,
                long_running: command.long_running,
            },
        );
        Ok(())
    }

    fn finalize_initial_model(
        &self,
        context: &GatewayContext,
        model: &wire::PluginModel,
    ) -> Result<(), GatewayFailure> {
        if model.surfaces.len() > MAX_PROJECTED_SURFACES
            || model.commands.len() > MAX_PROJECTED_COMMANDS
        {
            return Err(limit_failure());
        }
        let runtime = runtime_key(context)?;
        let mut declared_surfaces = BTreeMap::new();
        for surface in &model.surfaces {
            validate_identity(&surface.surface_id)?;
            if declared_surfaces
                .insert(surface.surface_id.as_str(), surface)
                .is_some()
            {
                return Err(protocol_failure());
            }
        }
        let mut declared_commands = BTreeMap::new();
        for command in &model.commands {
            validate_identity(&command.command_id)?;
            if declared_commands
                .insert(command.command_id.as_str(), command)
                .is_some()
            {
                return Err(protocol_failure());
            }
        }

        let state = self.state.lock().map_err(|_| unavailable_failure())?;
        let registered_surfaces: Vec<_> = state
            .surfaces
            .iter()
            .filter(|((owner, _), _)| owner == &runtime)
            .collect();
        if registered_surfaces.len() != declared_surfaces.len() {
            return Err(protocol_failure());
        }
        for ((_, surface_id), projected) in registered_surfaces {
            let Some(declared) = declared_surfaces.get(surface_id.as_str()) else {
                return Err(protocol_failure());
            };
            if projected.registration != **declared {
                return Err(protocol_failure());
            }
        }

        let registered_commands: Vec<_> = state
            .commands
            .iter()
            .filter(|((owner, _), _)| owner == &runtime)
            .collect();
        if registered_commands.len() != declared_commands.len() {
            return Err(protocol_failure());
        }
        for ((_, command_id), projected) in registered_commands {
            let Some(declared) = declared_commands.get(command_id.as_str()) else {
                return Err(protocol_failure());
            };
            if projected.view.title != declared.title
                || projected.view.description != declared.description
                || projected.view.confirmation != declared.confirmation
                || projected.long_running != declared.long_running
            {
                return Err(protocol_failure());
            }
        }
        Ok(())
    }

    fn unregister_command(
        &self,
        context: &GatewayContext,
        command_id: &str,
    ) -> Result<(), GatewayFailure> {
        validate_identity(command_id)?;
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        state
            .commands
            .remove(&(runtime_key(context)?, command_id.to_owned()))
            .ok_or_else(not_found_failure)?;
        Ok(())
    }

    fn report_progress(
        &self,
        context: &GatewayContext,
        progress: wire::TaskStateEvent,
    ) -> Result<(), GatewayFailure> {
        validate_identity(&progress.task_id)?;
        validate_long_text(&progress.message)?;
        let runtime = runtime_key(context)?;
        let key = (runtime.clone(), progress.task_id.clone());
        let state_value = wire::TaskState::try_from(progress.state)
            .ok()
            .filter(|value| *value != wire::TaskState::Unspecified)
            .ok_or_else(invalid_failure)?;
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let task = state.tasks.get_mut(&key).ok_or_else(not_found_failure)?;
        if !matches!(
            task.view.status,
            PluginTaskStatusV2::Running | PluginTaskStatusV2::Cancelling
        ) {
            return Err(failure(ErrorCode::Busy, "plugin.error.busy"));
        }
        let total = progress.total.unwrap_or(0);
        let completed = progress.completed.unwrap_or(0);
        let status = match (state_value, task.view.status) {
            (wire::TaskState::Running, PluginTaskStatusV2::Cancelling) => {
                PluginTaskStatusV2::Cancelling
            }
            (wire::TaskState::Running, _) => PluginTaskStatusV2::Running,
            (wire::TaskState::Succeeded, _) => PluginTaskStatusV2::Completed,
            (wire::TaskState::Failed, _) => PluginTaskStatusV2::Failed,
            (wire::TaskState::Cancelled, _) => PluginTaskStatusV2::Cancelled,
            (wire::TaskState::Unspecified, _) => return Err(invalid_failure()),
        };
        task.view.status = status;
        task.view.completed = completed;
        task.view.total = total;
        task.view.status_text = progress.message;
        task.view.cancellable = status == PluginTaskStatusV2::Running;
        task.view.failure = match status {
            PluginTaskStatusV2::Failed => Some(task_failure(
                PluginErrorCodeV2::ProtocolError,
                "plugin.error.commandFailed",
            )),
            PluginTaskStatusV2::Cancelled => Some(task_failure(
                PluginErrorCodeV2::Cancelled,
                "plugin.error.cancelled",
            )),
            _ => None,
        };
        validate_task_projection_v2(&task.view).map_err(|_| invalid_failure())?;
        task.last_activity = Instant::now();
        Ok(())
    }

    fn heartbeat(&self, context: &GatewayContext, task_id: &str) -> Result<(), GatewayFailure> {
        validate_identity(task_id)?;
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let task = state
            .tasks
            .get_mut(&(runtime_key(context)?, task_id.to_owned()))
            .ok_or_else(not_found_failure)?;
        if !matches!(
            task.view.status,
            PluginTaskStatusV2::Running | PluginTaskStatusV2::Cancelling
        ) {
            return Err(failure(ErrorCode::Busy, "plugin.error.busy"));
        }
        task.last_activity = Instant::now();
        Ok(())
    }

    pub fn set_surface_placement(
        &self,
        runtime: &RuntimeInstanceKey,
        surface_id: &str,
        placement: PluginSurfacePlacement,
    ) -> Result<(), GatewayFailure> {
        validate_identity(surface_id)?;
        let key = (runtime_key_from_public(runtime)?, surface_id.to_owned());
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let surface = state.surfaces.get_mut(&key).ok_or_else(not_found_failure)?;
        if placement == PluginSurfacePlacement::DetachedWindow && !surface.detached_allowed {
            return Err(permission_failure());
        }
        surface.registration.location = match placement {
            PluginSurfacePlacement::Workspace => wire::SurfaceLocation::Workspace as i32,
            PluginSurfacePlacement::DetachedWindow => wire::SurfaceLocation::DetachedWindow as i32,
        };
        Ok(())
    }

    pub fn contains_surface(
        &self,
        runtime: &RuntimeInstanceKey,
        surface_id: &str,
        revision: u64,
    ) -> bool {
        runtime_key_from_public(runtime)
            .ok()
            .is_some_and(|runtime| {
                self.state.lock().ok().is_some_and(|state| {
                    state
                        .surfaces
                        .get(&(runtime, surface_id.to_owned()))
                        .and_then(|surface| surface.document.as_ref())
                        .is_some_and(|document| document.revision == revision)
                })
            })
    }

    pub fn validate_surface_interaction(
        &self,
        event: &bbcom_contracts::PluginSurfaceEventV2,
    ) -> Result<super::presentation_v2::ValidatedSurfaceInteractionV2, GatewayFailure> {
        let runtime = runtime_key_from_public(&event.runtime)?;
        let state = self.state.lock().map_err(|_| unavailable_failure())?;
        let surface = state
            .surfaces
            .get(&(runtime.clone(), event.surface_id.clone()))
            .ok_or_else(not_found_failure)?;
        let document = surface.document.as_ref().ok_or_else(not_found_failure)?;
        let projected = project_surface(&runtime, surface, document)?;
        super::presentation_v2::validate_surface_interaction_v2(
            &projected,
            event.revision,
            &event.node_id,
            event.event,
            event.value.as_deref(),
        )
        .map_err(|_| invalid_failure())
    }

    pub fn contains_task(&self, runtime: &RuntimeInstanceKey, task_id: &str) -> bool {
        runtime_key_from_public(runtime)
            .ok()
            .is_some_and(|runtime| {
                self.state
                    .lock()
                    .ok()
                    .is_some_and(|state| state.tasks.contains_key(&(runtime, task_id.to_owned())))
            })
    }

    pub fn begin_command_task(
        &self,
        runtime: &RuntimeInstanceKey,
        task_id: &str,
        command_id: &str,
    ) -> Result<(), GatewayFailure> {
        validate_identity(task_id)?;
        validate_identity(command_id)?;
        let runtime_key = runtime_key_from_public(runtime)?;
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let command = state
            .commands
            .get(&(runtime_key.clone(), command_id.to_owned()))
            .ok_or_else(not_found_failure)?;
        let title = command.view.title.clone();
        let key = (runtime_key, task_id.to_owned());
        if state.tasks.get(&key).is_some_and(|task| {
            matches!(
                task.view.status,
                PluginTaskStatusV2::Running | PluginTaskStatusV2::Cancelling
            )
        }) {
            return Err(failure(ErrorCode::Busy, "plugin.error.busy"));
        }
        if state.tasks.len() >= MAX_PROJECTED_TASKS && !state.tasks.contains_key(&key) {
            let eviction = state
                .tasks
                .iter()
                .filter(|(_, task)| is_terminal_task_status(task.view.status))
                .min_by_key(|(_, task)| task.last_activity)
                .map(|(key, _)| key.clone())
                .ok_or_else(limit_failure)?;
            state.tasks.remove(&eviction);
        }
        state.tasks.insert(
            key,
            ProjectedTask {
                view: PluginTaskViewV2 {
                    runtime: runtime.clone(),
                    task_id: task_id.to_owned(),
                    command_id: command_id.to_owned(),
                    title,
                    status: PluginTaskStatusV2::Running,
                    completed: 0,
                    total: 0,
                    status_text: String::new(),
                    cancellable: true,
                    failure: None,
                },
                last_activity: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn mark_task_cancelling(
        &self,
        runtime: &RuntimeInstanceKey,
        task_id: &str,
    ) -> Result<(), GatewayFailure> {
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let task = state
            .tasks
            .get_mut(&(runtime_key_from_public(runtime)?, task_id.to_owned()))
            .ok_or_else(not_found_failure)?;
        if task.view.status != PluginTaskStatusV2::Running {
            return Err(failure(ErrorCode::Busy, "plugin.error.busy"));
        }
        task.view.status = PluginTaskStatusV2::Cancelling;
        task.view.cancellable = false;
        task.last_activity = Instant::now();
        Ok(())
    }

    fn finish_task(
        &self,
        context: &GatewayContext,
        task_id: &str,
        terminal: TaskTerminal,
    ) -> Result<(), GatewayFailure> {
        validate_identity(task_id)?;
        let mut state = self.state.lock().map_err(|_| unavailable_failure())?;
        let task = state
            .tasks
            .get_mut(&(runtime_key(context)?, task_id.to_owned()))
            .ok_or_else(not_found_failure)?;
        let (status, failure) = match terminal {
            TaskTerminal::Completed => (PluginTaskStatusV2::Completed, None),
            TaskTerminal::Cancelled => (
                PluginTaskStatusV2::Cancelled,
                Some(task_failure(
                    PluginErrorCodeV2::Cancelled,
                    "plugin.error.cancelled",
                )),
            ),
            TaskTerminal::Failed(code) => (
                PluginTaskStatusV2::Failed,
                Some(task_failure_from_wire(code)),
            ),
            TaskTerminal::UnknownOutcome => (
                PluginTaskStatusV2::UnknownOutcome,
                Some(task_failure(
                    PluginErrorCodeV2::UnknownOutcome,
                    "plugin.error.unknownOutcome",
                )),
            ),
        };
        task.view.status = status;
        task.view.cancellable = false;
        task.view.failure = failure;
        task.last_activity = Instant::now();
        Ok(())
    }

    pub fn fail_started_task(
        &self,
        runtime: &RuntimeInstanceKey,
        task_id: &str,
        code: ErrorCode,
    ) -> Result<(), GatewayFailure> {
        let context = GatewayContext {
            workspace_id: runtime.workspace_id.clone(),
            plugin_id: runtime.plugin_id.clone(),
            instance_id: runtime.instance_id.to_string(),
            generation: runtime.generation,
            granted_capabilities: BTreeSet::new(),
        };
        self.finish_task(&context, task_id, TaskTerminal::Failed(code))
    }

    pub fn contains_command(&self, runtime: &RuntimeInstanceKey, command_id: &str) -> bool {
        runtime_key_from_public(runtime)
            .ok()
            .is_some_and(|runtime| {
                self.state.lock().ok().is_some_and(|state| {
                    state
                        .commands
                        .contains_key(&(runtime, command_id.to_owned()))
                })
            })
    }

    fn revoke_runtime(&self, context: &GatewayContext) -> usize {
        let Ok(runtime) = runtime_key(context) else {
            return 0;
        };
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let before = state.surfaces.len() + state.commands.len() + state.tasks.len();
        state.surfaces.retain(|(owner, _), _| owner != &runtime);
        state.commands.retain(|(owner, _), _| owner != &runtime);
        state.tasks.retain(|(owner, _), _| owner != &runtime);
        before - (state.surfaces.len() + state.commands.len() + state.tasks.len())
    }

    #[must_use]
    pub fn command_long_running(
        &self,
        runtime: &RuntimeInstanceKey,
        command_id: &str,
    ) -> Option<bool> {
        let runtime = runtime_key_from_public(runtime).ok()?;
        self.state
            .lock()
            .ok()?
            .commands
            .get(&(runtime, command_id.to_owned()))
            .map(|value| value.long_running)
    }

    #[must_use]
    pub fn task_inactive_for(
        &self,
        runtime: &RuntimeInstanceKey,
        task_id: &str,
    ) -> Option<Duration> {
        let runtime = runtime_key_from_public(runtime).ok()?;
        self.state
            .lock()
            .ok()?
            .tasks
            .get(&(runtime, task_id.to_owned()))
            .map(|value| value.last_activity.elapsed())
    }
}

pub struct NativePluginCapabilityGatewayV2 {
    sink: Arc<dyn PluginCapabilityEventSinkV2>,
    serial: Arc<SerialCapabilityCorrelationRegistryV2>,
    projection: Arc<PluginRuntimeProjectionV2>,
    files: Arc<PluginFileGrantService>,
    dialogs: Arc<dyn PluginFileDialogPortV2>,
    private_state: Arc<dyn PluginPrivateStatePersistenceV2>,
    workspace: Arc<dyn PluginWorkspaceCapabilityPortV2>,
    detached: Arc<dyn PluginDetachedProjectionPortV2>,
    state: Mutex<BTreeMap<RuntimeKey, RuntimeCapabilityStateV2>>,
}

#[derive(Clone)]
struct RuntimeCapabilityStateV2 {
    initializing: bool,
    storage_scope: String,
    storage: BTreeMap<String, Vec<u8>>,
    persisted_storage: Vec<u8>,
    storage_dirty: bool,
    project_schema_version: Option<u32>,
    project_state: Option<Vec<u8>>,
    project_dirty: bool,
}

impl NativePluginCapabilityGatewayV2 {
    #[must_use]
    pub fn new(
        sink: Arc<dyn PluginCapabilityEventSinkV2>,
        serial: Arc<SerialCapabilityCorrelationRegistryV2>,
        projection: Arc<PluginRuntimeProjectionV2>,
        files: Arc<PluginFileGrantService>,
    ) -> Self {
        Self::new_with_ports(
            sink,
            serial,
            projection,
            files,
            Arc::new(UnavailableFileDialog),
            Arc::new(UnavailablePrivateState),
            Arc::new(UnavailableWorkspaceCapabilities),
            Arc::new(UnavailableDetachedProjection),
        )
    }

    #[must_use]
    /// Production composition supplies eight independent, capability-scoped
    /// ports. Keeping them explicit here makes authority review mechanical;
    /// callers cannot obtain a permissive aggregate/default service bag.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_ports(
        sink: Arc<dyn PluginCapabilityEventSinkV2>,
        serial: Arc<SerialCapabilityCorrelationRegistryV2>,
        projection: Arc<PluginRuntimeProjectionV2>,
        files: Arc<PluginFileGrantService>,
        dialogs: Arc<dyn PluginFileDialogPortV2>,
        private_state: Arc<dyn PluginPrivateStatePersistenceV2>,
        workspace: Arc<dyn PluginWorkspaceCapabilityPortV2>,
        detached: Arc<dyn PluginDetachedProjectionPortV2>,
    ) -> Self {
        projection.install_change_sink(Arc::clone(&sink));
        Self {
            sink,
            serial,
            projection,
            files,
            dialogs,
            private_state,
            workspace,
            detached,
            state: Mutex::new(BTreeMap::new()),
        }
    }

    fn serial_request(
        &self,
        context: &GatewayContext,
        message_id: u64,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure> {
        let renderer_context = renderer_context(context)?;
        let (operation, expected) = serial_operation(operation)?;
        let receiver =
            self.serial
                .register(renderer_context.clone(), message_id, expected.clone())?;
        let event = PluginSerialCapabilityInboundV2::Request {
            context: renderer_context.clone(),
            message_id,
            operation,
        };
        if self.sink.emit_serial(&event).is_err() {
            self.serial.discard(&renderer_context, message_id);
            return Err(unavailable_failure());
        }
        let wait_timeout = match expected {
            PendingSerialKind::SerialRead { timeout_ms, .. } => {
                serial_read_renderer_timeout(timeout_ms)
            }
            _ => SERIAL_CAPABILITY_TIMEOUT,
        };
        let answer = match receiver.recv_timeout(wait_timeout) {
            Ok(answer) => answer.map_err(gateway_failure_from_renderer)?,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.serial.discard(&renderer_context, message_id);
                return Err(
                    if matches!(expected, PendingSerialKind::SerialWrite { .. }) {
                        unknown_outcome_failure()
                    } else {
                        timeout_failure()
                    },
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(unavailable_failure()),
        };
        serial_result(answer)
    }

    fn invoke_projection(
        &self,
        context: &GatewayContext,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure> {
        let result = match operation {
            request::Operation::RegisterSurface(value) => {
                self.projection
                    .register_surface(context, value.surface.ok_or_else(invalid_failure)?)?;
                response::Result::RegisterSurface(wire::OperationAck {})
            }
            request::Operation::UnregisterSurface(value) => {
                let runtime = runtime_key(context)?.public();
                self.projection
                    .unregister_surface(context, &value.surface_id)?;
                self.detached.revoke_surface(&runtime, &value.surface_id);
                response::Result::UnregisterSurface(wire::OperationAck {})
            }
            request::Operation::PublishSurfaceSnapshot(value) => {
                self.projection
                    .publish_snapshot(context, value.snapshot.ok_or_else(invalid_failure)?)?;
                response::Result::PublishSurfaceSnapshot(wire::OperationAck {})
            }
            request::Operation::PublishSurfacePatch(value) => {
                self.projection
                    .publish_patch(context, value.patch.ok_or_else(invalid_failure)?)?;
                response::Result::PublishSurfacePatch(wire::OperationAck {})
            }
            request::Operation::RegisterCommand(value) => {
                self.projection
                    .register_command(context, value.command.ok_or_else(invalid_failure)?)?;
                response::Result::RegisterCommand(wire::OperationAck {})
            }
            request::Operation::UnregisterCommand(value) => {
                self.projection
                    .unregister_command(context, &value.command_id)?;
                response::Result::UnregisterCommand(wire::OperationAck {})
            }
            request::Operation::ReportProgress(value) => {
                self.projection
                    .report_progress(context, value.progress.ok_or_else(invalid_failure)?)?;
                response::Result::ReportProgress(wire::OperationAck {})
            }
            request::Operation::Heartbeat(value) => {
                self.projection.heartbeat(context, &value.task_id)?;
                response::Result::Heartbeat(wire::OperationAck {})
            }
            _ => return Err(protocol_failure()),
        };
        let _ = self.sink.projection_changed();
        Ok(result)
    }

    fn invoke_file(
        &self,
        context: &GatewayContext,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure> {
        let owner = runtime_key(context)?.public();
        match operation {
            request::Operation::OpenReadGrant(value) => {
                let accepted_extensions = validate_extensions(value.accepted_extensions)?;
                let Some(path) = self
                    .dialogs
                    .open_read(&accepted_extensions)
                    .map_err(gateway_failure_from_renderer)?
                else {
                    return Ok(response::Result::OpenReadGrant(
                        wire::OpenReadGrantResponse { grant: None },
                    ));
                };
                let grant = self
                    .files
                    .issue_read_selected(owner, path)
                    .map_err(file_failure)?;
                Ok(response::Result::OpenReadGrant(
                    wire::OpenReadGrantResponse {
                        grant: Some(file_grant_info(context, grant, true)?),
                    },
                ))
            }
            request::Operation::CreateSaveGrant(value) => {
                validate_suggested_name(&value.suggested_name)?;
                let Some(path) = self
                    .dialogs
                    .create_save(&value.suggested_name)
                    .map_err(gateway_failure_from_renderer)?
                else {
                    return Ok(response::Result::CreateSaveGrant(
                        wire::CreateSaveGrantResponse { grant: None },
                    ));
                };
                let grant = self
                    .files
                    .issue_save_selected(owner, path)
                    .map_err(file_failure)?;
                Ok(response::Result::CreateSaveGrant(
                    wire::CreateSaveGrantResponse {
                        grant: Some(file_grant_info(context, grant, false)?),
                    },
                ))
            }
            request::Operation::ReadGrantChunk(value) => {
                let binding = value.grant.ok_or_else(invalid_failure)?;
                require_wire_binding(context, &binding)?;
                let (payload, total_bytes) = self
                    .files
                    .read_at_with_size(
                        &owner,
                        &binding.resource_id,
                        value.offset,
                        value.max_bytes as usize,
                    )
                    .map_err(file_failure)?;
                Ok(response::Result::ReadGrantChunk(
                    wire::ReadGrantChunkResponse {
                        offset: value.offset,
                        total_bytes,
                        payload,
                    },
                ))
            }
            request::Operation::CloseReadGrant(value) => {
                let binding = value.grant.ok_or_else(invalid_failure)?;
                require_wire_binding(context, &binding)?;
                self.files
                    .close(&owner, &binding.resource_id)
                    .map_err(file_failure)?;
                Ok(response::Result::CloseReadGrant(wire::OperationAck {}))
            }
            request::Operation::WriteSaveGrant(value) => {
                let binding = value.grant.ok_or_else(invalid_failure)?;
                require_wire_binding(context, &binding)?;
                let accepted_bytes = self
                    .files
                    .append_chunk(&owner, &binding.resource_id, &value.payload)
                    .map_err(file_failure)?;
                Ok(response::Result::WriteSaveGrant(
                    wire::WriteSaveGrantResponse { accepted_bytes },
                ))
            }
            request::Operation::CommitSaveGrant(value) => {
                let binding = value.grant.ok_or_else(invalid_failure)?;
                require_wire_binding(context, &binding)?;
                self.files
                    .commit_save(&owner, &binding.resource_id)
                    .map_err(file_failure)?;
                Ok(response::Result::CommitSaveGrant(wire::OperationAck {}))
            }
            request::Operation::CancelSaveGrant(value) => {
                let binding = value.grant.ok_or_else(invalid_failure)?;
                require_wire_binding(context, &binding)?;
                self.files
                    .close(&owner, &binding.resource_id)
                    .map_err(file_failure)?;
                Ok(response::Result::CancelSaveGrant(wire::OperationAck {}))
            }
            _ => Err(protocol_failure()),
        }
    }

    fn invoke_state(
        &self,
        context: &GatewayContext,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure> {
        let runtime = runtime_key(context)?;
        let mut states = self.state.lock().map_err(|_| unavailable_failure())?;
        let state = states.get_mut(&runtime).ok_or_else(stale_failure)?;
        match operation {
            request::Operation::StorageGet(value) => {
                validate_storage_key(&value.key)?;
                Ok(response::Result::StorageGet(wire::StorageGetResponse {
                    value: state.storage.get(&value.key).cloned(),
                }))
            }
            request::Operation::StorageSet(value) => {
                validate_storage_key(&value.key)?;
                if value.value.len() > MAX_PLUGIN_STATE_CHUNK_BYTES {
                    return Err(limit_failure());
                }
                let mut candidate = state.storage.clone();
                candidate.insert(value.key, value.value);
                let encoded = encode_storage(&candidate)?;
                if !state.initializing && state.storage_scope == "active" {
                    self.private_state
                        .persist_plugin_storage(context, &state.storage_scope, &encoded)
                        .map_err(gateway_failure_from_renderer)?;
                    state.persisted_storage = encoded;
                }
                state.storage = candidate;
                state.storage_dirty = state.initializing;
                Ok(response::Result::StorageSet(wire::OperationAck {}))
            }
            request::Operation::StorageDelete(value) => {
                validate_storage_key(&value.key)?;
                let mut candidate = state.storage.clone();
                candidate.remove(&value.key);
                let encoded = encode_storage(&candidate)?;
                if !state.initializing && state.storage_scope == "active" {
                    self.private_state
                        .persist_plugin_storage(context, &state.storage_scope, &encoded)
                        .map_err(gateway_failure_from_renderer)?;
                    state.persisted_storage = encoded;
                }
                state.storage = candidate;
                state.storage_dirty = state.initializing;
                Ok(response::Result::StorageDelete(wire::OperationAck {}))
            }
            request::Operation::ProjectStateGet(_) => Ok(response::Result::ProjectStateGet(
                wire::ProjectStateGetResponse {
                    schema_version: state.project_schema_version,
                    value: state
                        .project_schema_version
                        .and(state.project_state.clone()),
                },
            )),
            request::Operation::ProjectStateSet(value) => {
                if value.schema_version == 0 {
                    return Err(invalid_failure());
                }
                if value.value.len() > MAX_PLUGIN_STATE_CHUNK_BYTES {
                    return Err(limit_failure());
                }
                // Prepared runtimes never own the active workspace state.
                // Active runtimes buffer initialization writes, then switch to
                // ordinary immediate commits after finalization.
                if !state.initializing && state.storage_scope == "active" {
                    self.workspace
                        .set_project_state(context, value.schema_version, &value.value)
                        .map_err(gateway_failure_from_renderer)?;
                }
                state.project_schema_version = Some(value.schema_version);
                state.project_state = Some(value.value);
                state.project_dirty = state.initializing;
                Ok(response::Result::ProjectStateSet(wire::OperationAck {}))
            }
            _ => Err(protocol_failure()),
        }
    }

    fn invoke_contribution(
        &self,
        context: &GatewayContext,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure> {
        match operation {
            request::Operation::UpsertQuickCommand(value) => {
                let command = value.command.ok_or_else(invalid_failure)?;
                validate_quick_command(&command)?;
                let contribution_id = self
                    .workspace
                    .upsert_quick_command(context, &command)
                    .map_err(gateway_failure_from_renderer)?;
                Ok(response::Result::UpsertQuickCommand(
                    wire::ContributionResponse { contribution_id },
                ))
            }
            request::Operation::DeleteQuickCommand(value) => {
                validate_identity(&value.local_id)?;
                validate_identity(&value.session_id)?;
                self.workspace
                    .delete_quick_command(context, &value.session_id, &value.local_id)
                    .map_err(gateway_failure_from_renderer)?;
                Ok(response::Result::DeleteQuickCommand(wire::OperationAck {}))
            }
            request::Operation::UpsertMacro(value) => {
                let value = value.r#macro.ok_or_else(invalid_failure)?;
                validate_macro(&value)?;
                let contribution_id = self
                    .workspace
                    .upsert_macro(context, &value)
                    .map_err(gateway_failure_from_renderer)?;
                Ok(response::Result::UpsertMacro(wire::ContributionResponse {
                    contribution_id,
                }))
            }
            request::Operation::DeleteMacro(value) => {
                validate_identity(&value.local_id)?;
                validate_identity(&value.session_id)?;
                self.workspace
                    .delete_macro(context, &value.session_id, &value.local_id)
                    .map_err(gateway_failure_from_renderer)?;
                Ok(response::Result::DeleteMacro(wire::OperationAck {}))
            }
            _ => Err(protocol_failure()),
        }
    }
}

impl PluginCapabilityGateway for NativePluginCapabilityGatewayV2 {
    fn register_runtime(
        &self,
        context: &GatewayContext,
        bootstrap: RuntimeBootstrapState,
    ) -> Result<(), GatewayFailure> {
        let runtime = runtime_key(context)?;
        validate_storage_scope(&bootstrap.storage_scope)?;
        if bootstrap.plugin_storage.len() > MAX_PLUGIN_PERSISTED_STATE_BYTES
            || bootstrap
                .project_state
                .as_ref()
                .is_some_and(|value| value.len() > MAX_PLUGIN_STATE_CHUNK_BYTES)
        {
            return Err(limit_failure());
        }
        if bootstrap.project_state_schema_version == Some(0)
            || (bootstrap.project_state.is_none()
                && bootstrap.project_state_schema_version.is_some())
        {
            return Err(invalid_failure());
        }
        let storage = decode_storage(&bootstrap.plugin_storage)?;
        let mut states = self.state.lock().map_err(|_| unavailable_failure())?;
        if states.contains_key(&runtime) {
            return Err(failure(ErrorCode::Busy, "plugin.error.busy"));
        }
        states.insert(
            runtime,
            RuntimeCapabilityStateV2 {
                initializing: true,
                storage_scope: bootstrap.storage_scope,
                storage,
                persisted_storage: bootstrap.plugin_storage,
                storage_dirty: false,
                project_schema_version: bootstrap.project_state_schema_version,
                project_state: bootstrap.project_state,
                project_dirty: false,
            },
        );
        Ok(())
    }

    fn stage_migrated_project_state(
        &self,
        context: &GatewayContext,
        schema_version: u32,
        value: Vec<u8>,
    ) -> Result<(), GatewayFailure> {
        if schema_version == 0 {
            return Err(invalid_failure());
        }
        if value.len() > MAX_PLUGIN_STATE_CHUNK_BYTES {
            return Err(limit_failure());
        }
        let runtime = runtime_key(context)?;
        let mut states = self.state.lock().map_err(|_| unavailable_failure())?;
        let state = states.get_mut(&runtime).ok_or_else(stale_failure)?;
        if !state.initializing {
            return Err(protocol_failure());
        }
        state.project_schema_version = Some(schema_version);
        state.project_state = Some(value);
        state.project_dirty = true;
        Ok(())
    }

    fn finalize_initial_model(
        &self,
        context: &GatewayContext,
        model: &wire::PluginModel,
    ) -> Result<(), GatewayFailure> {
        // Validate the complete declaration before any durable state is
        // touched. A model mismatch therefore leaves both active private
        // storage and portable workspace state unchanged.
        self.projection.finalize_initial_model(context, model)?;

        let runtime = runtime_key(context)?;
        let mut states = self.state.lock().map_err(|_| unavailable_failure())?;
        let state = states.get_mut(&runtime).ok_or_else(stale_failure)?;
        if !state.initializing {
            return Err(protocol_failure());
        }

        let encoded_storage = state
            .storage_dirty
            .then(|| encode_storage(&state.storage))
            .transpose()?;
        let active_scope = state.storage_scope == "active";

        // Private storage is committed first because it has an exact previous
        // byte image that can be restored if the following workspace mutation
        // fails. This is an ordered, compensating transaction across two
        // stores; it deliberately does not claim filesystem/SQLite atomicity.
        if active_scope && let Some(encoded) = encoded_storage.as_deref() {
            self.private_state
                .persist_plugin_storage(context, &state.storage_scope, encoded)
                .map_err(gateway_failure_from_renderer)?;
        }

        if active_scope
            && state.project_dirty
            && let Some(project) = state.project_state.as_deref()
            && let Some(schema_version) = state.project_schema_version
            && let Err(error) = self
                .workspace
                .set_project_state(context, schema_version, project)
        {
            if encoded_storage.is_some()
                && self
                    .private_state
                    .persist_plugin_storage(context, &state.storage_scope, &state.persisted_storage)
                    .is_err()
            {
                return Err(failure(
                    ErrorCode::IoError,
                    "plugin.error.stateRollbackFailed",
                ));
            }
            return Err(gateway_failure_from_renderer(error));
        }

        if active_scope && let Some(encoded) = encoded_storage {
            state.persisted_storage = encoded;
        }
        state.storage_dirty = false;
        // Prepared preflight is entirely ephemeral: it reads active private
        // bytes, validates migration/initialization in memory, and persists
        // neither private nor project state. The activated artifact repeats
        // migration against the same active bytes in an active runtime.
        state.project_dirty = false;
        state.initializing = false;
        Ok(())
    }

    fn invoke(
        &self,
        context: &GatewayContext,
        message_id: u64,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure> {
        match operation {
            operation @ (request::Operation::ListPorts(_)
            | request::Operation::ListSessions(_)
            | request::Operation::CreateSession(_)
            | request::Operation::UpdateSession(_)
            | request::Operation::ConnectSession(_)
            | request::Operation::DisconnectSession(_)
            | request::Operation::DeleteSession(_)
            | request::Operation::AcquireSerialLease(_)
            | request::Operation::ReleaseSerialLease(_)
            | request::Operation::SerialRead(_)
            | request::Operation::SerialWrite(_)
            | request::Operation::ClearSerialBuffers(_)
            | request::Operation::PendingSerialBytes(_)
            | request::Operation::SetOutputLines(_)
            | request::Operation::ReadInputLines(_)
            | request::Operation::CaptureRead(_)) => {
                self.serial_request(context, message_id, operation)
            }
            operation @ (request::Operation::RegisterSurface(_)
            | request::Operation::UnregisterSurface(_)
            | request::Operation::PublishSurfaceSnapshot(_)
            | request::Operation::PublishSurfacePatch(_)
            | request::Operation::RegisterCommand(_)
            | request::Operation::UnregisterCommand(_)
            | request::Operation::ReportProgress(_)
            | request::Operation::Heartbeat(_)) => self.invoke_projection(context, operation),
            operation @ (request::Operation::OpenReadGrant(_)
            | request::Operation::ReadGrantChunk(_)
            | request::Operation::CloseReadGrant(_)
            | request::Operation::CreateSaveGrant(_)
            | request::Operation::WriteSaveGrant(_)
            | request::Operation::CommitSaveGrant(_)
            | request::Operation::CancelSaveGrant(_)) => self.invoke_file(context, operation),
            operation @ (request::Operation::StorageGet(_)
            | request::Operation::StorageSet(_)
            | request::Operation::StorageDelete(_)
            | request::Operation::ProjectStateGet(_)
            | request::Operation::ProjectStateSet(_)) => self.invoke_state(context, operation),
            operation @ (request::Operation::UpsertQuickCommand(_)
            | request::Operation::DeleteQuickCommand(_)
            | request::Operation::UpsertMacro(_)
            | request::Operation::DeleteMacro(_)) => self.invoke_contribution(context, operation),
            _ => Err(unavailable_failure()),
        }
    }

    fn cancel(
        &self,
        context: &GatewayContext,
        target_message_id: u64,
    ) -> Result<(), GatewayFailure> {
        if target_message_id == 0 {
            return Err(invalid_failure());
        }
        self.sink
            .emit_serial(&PluginSerialCapabilityInboundV2::Cancel {
                context: renderer_context(context)?,
                target_message_id,
            })
            .map_err(|_| unavailable_failure())
    }

    fn discard_cancelled_result(
        &self,
        context: &GatewayContext,
        operation: &request::Operation,
        result: &response::Result,
    ) {
        if let (
            request::Operation::AcquireSerialLease(_),
            response::Result::AcquireSerialLease(value),
        ) = (operation, result)
        {
            let Some(binding) = value.lease.as_ref() else {
                return;
            };
            if value.session_generation == 0
                || value.session_generation > MAX_SAFE_INTEGER
                || binding.resource_id.len() > 128
                || require_wire_binding(context, binding).is_err()
            {
                return;
            }
            let (Ok(renderer_context), Ok(lease)) =
                (renderer_context(context), renderer_binding(binding.clone()))
            else {
                return;
            };
            let _ = self
                .sink
                .emit_serial(&PluginSerialCapabilityInboundV2::RevokeLease {
                    context: renderer_context,
                    lease,
                    session_generation: value.session_generation,
                });
            return;
        }

        let binding = match (operation, result) {
            (request::Operation::OpenReadGrant(_), response::Result::OpenReadGrant(value)) => {
                value.grant.as_ref().and_then(|grant| grant.grant.as_ref())
            }
            (request::Operation::CreateSaveGrant(_), response::Result::CreateSaveGrant(value)) => {
                value.grant.as_ref().and_then(|grant| grant.grant.as_ref())
            }
            _ => None,
        };
        let (Ok(owner), Some(binding)) = (runtime_key(context).map(|key| key.public()), binding)
        else {
            return;
        };
        if require_wire_binding(context, binding).is_ok() {
            let _ = self.files.close(&owner, &binding.resource_id);
        }
    }

    fn revoke_runtime(&self, context: &GatewayContext) {
        let Ok(renderer_context) = renderer_context(context) else {
            return;
        };
        self.serial.revoke_runtime(&renderer_context);
        if let Ok(runtime) = runtime_key(context) {
            self.files.revoke_runtime(&runtime.public());
            self.detached.revoke_runtime(&runtime.public());
        }
        self.projection.revoke_runtime(context);
        if let Ok(runtime) = runtime_key(context)
            && let Ok(mut states) = self.state.lock()
        {
            states.remove(&runtime);
        }
        let _ = self
            .sink
            .emit_serial(&PluginSerialCapabilityInboundV2::RevokeRuntime {
                context: renderer_context,
            });
        let _ = self.sink.projection_changed();
    }

    fn complete_task(&self, context: &GatewayContext, task_id: &str, terminal: TaskTerminal) {
        if self
            .projection
            .finish_task(context, task_id, terminal)
            .is_ok()
        {
            let _ = self.sink.projection_changed();
        }
    }

    fn stream(&self, _context: &GatewayContext, _event: StreamEvent) -> Result<(), GatewayFailure> {
        Err(unavailable_failure())
    }
}

fn file_grant_info(
    context: &GatewayContext,
    grant: PluginFileGrantView,
    include_size: bool,
) -> Result<wire::FileGrantInfo, GatewayFailure> {
    validate_identity(&grant.handle_id)?;
    validate_short_text(&grant.display_name, false)?;
    Ok(wire::FileGrantInfo {
        grant: Some(wire::ResourceBinding {
            workspace_id: context.workspace_id.clone(),
            plugin_id: context.plugin_id.clone(),
            instance_id: context.instance_id.clone(),
            generation: context.generation,
            resource_id: grant.handle_id,
        }),
        display_name: grant.display_name,
        size: include_size.then_some(grant.size),
    })
}

fn validate_extensions(values: Vec<String>) -> Result<Vec<String>, GatewayFailure> {
    if values.len() > 32 {
        return Err(limit_failure());
    }
    let mut normalized = BTreeSet::new();
    for value in values {
        let value = value
            .strip_prefix('.')
            .unwrap_or(&value)
            .to_ascii_lowercase();
        if value.is_empty()
            || value.len() > 16
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(invalid_failure());
        }
        normalized.insert(value);
    }
    Ok(normalized.into_iter().collect())
}

fn validate_suggested_name(value: &str) -> Result<(), GatewayFailure> {
    if value.is_empty()
        || value.len() > 255
        || matches!(value, "." | "..")
        || value.contains(['/', '\\', '\0'])
    {
        Err(invalid_failure())
    } else {
        Ok(())
    }
}

fn validate_storage_key(value: &str) -> Result<(), GatewayFailure> {
    if value.is_empty()
        || value.len() > MAX_STORAGE_KEY_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        Err(invalid_failure())
    } else {
        Ok(())
    }
}

fn validate_storage_scope(value: &str) -> Result<(), GatewayFailure> {
    if value == "active" {
        return Ok(());
    }
    value
        .strip_prefix("prepared:")
        .filter(|token| validate_identity(token).is_ok())
        .map(|_| ())
        .ok_or_else(invalid_failure)
}

fn encode_storage(values: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, GatewayFailure> {
    let count = u32::try_from(values.len()).map_err(|_| limit_failure())?;
    let mut output = Vec::with_capacity(12);
    output.extend_from_slice(STORAGE_MAGIC);
    output.extend_from_slice(&count.to_le_bytes());
    for (key, value) in values {
        validate_storage_key(key)?;
        let key_len = u32::try_from(key.len()).map_err(|_| limit_failure())?;
        let value_len = u32::try_from(value.len()).map_err(|_| limit_failure())?;
        output.extend_from_slice(&key_len.to_le_bytes());
        output.extend_from_slice(&value_len.to_le_bytes());
        output.extend_from_slice(key.as_bytes());
        output.extend_from_slice(value);
        if output.len() > MAX_PLUGIN_PERSISTED_STATE_BYTES {
            return Err(limit_failure());
        }
    }
    Ok(output)
}

fn decode_storage(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, GatewayFailure> {
    if bytes.is_empty() {
        return Ok(BTreeMap::new());
    }
    if !bytes.starts_with(STORAGE_MAGIC) {
        return Err(protocol_failure());
    }
    let mut cursor = STORAGE_MAGIC.len();
    let count = take_u32(bytes, &mut cursor)? as usize;
    if count > 65_536 {
        return Err(limit_failure());
    }
    let mut values = BTreeMap::new();
    for _ in 0..count {
        let key_len = take_u32(bytes, &mut cursor)? as usize;
        let value_len = take_u32(bytes, &mut cursor)? as usize;
        let end = cursor
            .checked_add(key_len)
            .and_then(|value| value.checked_add(value_len))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(protocol_failure)?;
        let key_end = cursor + key_len;
        let key = std::str::from_utf8(&bytes[cursor..key_end])
            .map_err(|_| protocol_failure())?
            .to_owned();
        validate_storage_key(&key)?;
        if values.insert(key, bytes[key_end..end].to_vec()).is_some() {
            return Err(protocol_failure());
        }
        cursor = end;
    }
    if cursor != bytes.len() {
        return Err(protocol_failure());
    }
    Ok(values)
}

fn take_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, GatewayFailure> {
    let end = cursor.checked_add(4).ok_or_else(protocol_failure)?;
    let chunk: [u8; 4] = bytes
        .get(*cursor..end)
        .ok_or_else(protocol_failure)?
        .try_into()
        .map_err(|_| protocol_failure())?;
    *cursor = end;
    Ok(u32::from_le_bytes(chunk))
}

fn validate_quick_command(command: &wire::QuickCommand) -> Result<(), GatewayFailure> {
    validate_identity(&command.local_id)?;
    validate_identity(&command.session_id)?;
    validate_short_text(&command.title, false)?;
    if command.payload.is_empty() || command.payload.len() > MAX_STREAM_CHUNK_BYTES {
        return Err(limit_failure());
    }
    Ok(())
}

fn validate_macro(value: &wire::MacroContribution) -> Result<(), GatewayFailure> {
    validate_identity(&value.local_id)?;
    validate_identity(&value.session_id)?;
    validate_short_text(&value.title, false)?;
    if value.steps.is_empty() || value.steps.len() > 1_024 {
        return Err(limit_failure());
    }
    let bytes = value.steps.iter().try_fold(0usize, |total, step| {
        total
            .checked_add(step.payload.len())
            .ok_or_else(limit_failure)
    })?;
    if bytes == 0 || bytes > MAX_STREAM_CHUNK_BYTES {
        return Err(limit_failure());
    }
    Ok(())
}

fn correlation_key(context: &PluginGatewayContextV2, message_id: u64) -> (String, u64) {
    (
        format!(
            "{}\0{}\0{}\0{}",
            context.workspace_id, context.plugin_id, context.instance_id, context.generation
        ),
        message_id,
    )
}

fn validate_serial_response(
    expected: &PendingSerialKind,
    response: bbcom_contracts::PluginSerialCapabilityResponseV2,
) -> Result<Result<PluginSerialCapabilityResultV2, PluginErrorCodeV2>, SerialCapabilityReplyErrorV2>
{
    if response.reply_to == 0 {
        return Err(SerialCapabilityReplyErrorV2::InvalidShape);
    }
    let context = response.context;
    match (response.ok, response.result, response.error_code) {
        (true, Some(result), None) => {
            validate_serial_result(expected, &context, &result)?;
            Ok(Ok(result))
        }
        (false, None, Some(error)) => Ok(Err(error)),
        _ => Err(SerialCapabilityReplyErrorV2::InvalidShape),
    }
}

fn validate_serial_result(
    expected: &PendingSerialKind,
    context: &PluginGatewayContextV2,
    result: &PluginSerialCapabilityResultV2,
) -> Result<(), SerialCapabilityReplyErrorV2> {
    let valid = match (expected, result) {
        (PendingSerialKind::ListPorts, PluginSerialCapabilityResultV2::ListPorts { ports }) => {
            let mut ids = BTreeSet::new();
            ports.len() <= 256
                && ports
                    .iter()
                    .all(|port| ids.insert(port.port_id.as_str()) && validate_renderer_port(port))
        }
        (
            PendingSerialKind::ListSessions,
            PluginSerialCapabilityResultV2::ListSessions { sessions },
        ) => {
            let mut ids = BTreeSet::new();
            sessions.len() <= 256
                && sessions.iter().all(|session| {
                    ids.insert(session.session_id.as_str()) && validate_renderer_session(session)
                })
        }
        (
            PendingSerialKind::CreateSession,
            PluginSerialCapabilityResultV2::CreateSession { session },
        ) => validate_renderer_session(session),
        (
            PendingSerialKind::UpdateSession { session_id },
            PluginSerialCapabilityResultV2::UpdateSession { session },
        )
        | (
            PendingSerialKind::ConnectSession { session_id },
            PluginSerialCapabilityResultV2::ConnectSession { session },
        ) => session.session_id == *session_id && validate_renderer_session(session),
        (
            PendingSerialKind::DisconnectSession,
            PluginSerialCapabilityResultV2::DisconnectSession,
        )
        | (PendingSerialKind::DeleteSession, PluginSerialCapabilityResultV2::DeleteSession) => true,
        (
            PendingSerialKind::AcquireSerialLease,
            PluginSerialCapabilityResultV2::AcquireSerialLease {
                lease,
                session_generation,
            },
        ) => {
            lease.resource_id.len() <= 128
                && !lease.resource_id.is_empty()
                && lease.workspace_id == context.workspace_id
                && lease.plugin_id == context.plugin_id
                && lease.instance_id == context.instance_id
                && lease.generation == context.generation
                && *session_generation != 0
        }
        (
            PendingSerialKind::ReleaseSerialLease,
            PluginSerialCapabilityResultV2::ReleaseSerialLease,
        ) => true,
        (
            PendingSerialKind::SerialRead { maximum_bytes, .. },
            PluginSerialCapabilityResultV2::SerialRead { payload, .. },
        ) => payload.len() <= *maximum_bytes && payload.len() <= MAX_STREAM_CHUNK_BYTES,
        (
            PendingSerialKind::SerialWrite { requested_bytes },
            PluginSerialCapabilityResultV2::SerialWrite {
                requested,
                sent,
                outcome,
            },
        ) => {
            requested == requested_bytes
                && sent <= requested
                && match outcome {
                    PluginSerialWriteOutcomeV2::Completed => sent == requested,
                    PluginSerialWriteOutcomeV2::PartialWrite => sent < requested,
                    PluginSerialWriteOutcomeV2::UnknownOutcome => true,
                }
        }
        (
            PendingSerialKind::ClearSerialBuffers,
            PluginSerialCapabilityResultV2::ClearSerialBuffers,
        ) => true,
        (
            PendingSerialKind::PendingSerialBytes,
            PluginSerialCapabilityResultV2::PendingSerialBytes { .. },
        ) => true,
        (PendingSerialKind::SetOutputLines, PluginSerialCapabilityResultV2::SetOutputLines) => true,
        (
            PendingSerialKind::ReadInputLines,
            PluginSerialCapabilityResultV2::ReadInputLines { .. },
        ) => true,
        (
            PendingSerialKind::CaptureRead {
                from_sequence,
                maximum_frames,
                maximum_bytes,
            },
            PluginSerialCapabilityResultV2::CaptureRead {
                frames,
                next_sequence,
            },
        ) => validate_renderer_capture(
            frames,
            *next_sequence,
            *from_sequence,
            *maximum_frames,
            *maximum_bytes,
        ),
        _ => false,
    };
    valid
        .then_some(())
        .ok_or(SerialCapabilityReplyErrorV2::InvalidShape)
}

fn validate_renderer_port(port: &PluginSerialPortV2) -> bool {
    validate_identity(&port.port_id).is_ok()
        && validate_short_text(&port.display_name, false).is_ok()
        && port
            .serial_number
            .as_deref()
            .is_none_or(|value| validate_short_text(value, false).is_ok())
}

fn validate_renderer_capture(
    frames: &[bbcom_contracts::PluginSerialCaptureFrameV2],
    next_sequence: Option<u64>,
    from_sequence: u64,
    maximum_frames: usize,
    maximum_bytes: usize,
) -> bool {
    if frames.len() > maximum_frames {
        return false;
    }
    let mut total = 0usize;
    let mut previous = None;
    for frame in frames {
        if frame.sequence < from_sequence
            || frame.sequence > MAX_SAFE_INTEGER
            || frame.timestamp_ms > MAX_SAFE_INTEGER
            || previous.is_some_and(|value| frame.sequence <= value)
        {
            return false;
        }
        let Some(next_total) = total.checked_add(frame.payload.len()) else {
            return false;
        };
        if next_total > maximum_bytes {
            return false;
        }
        total = next_total;
        previous = Some(frame.sequence);
    }
    next_sequence.is_none_or(|next| {
        next <= MAX_SAFE_INTEGER && next >= from_sequence && previous.is_none_or(|last| next > last)
    })
}

fn validate_renderer_session(session: &PluginSerialSessionV2) -> bool {
    !session.session_id.is_empty()
        && session.session_id.len() <= 128
        && !session.name.is_empty()
        && session.name.len() <= 1024
        && (!session.connected || session.generation != 0)
        && session
            .port_id
            .as_deref()
            .is_none_or(|port_id| !port_id.is_empty() && port_id.len() <= 128)
        && session.config.baud_rate != 0
        && (5..=8).contains(&session.config.data_bits)
        && (1..=3).contains(&session.config.parity)
        && matches!(session.config.stop_bits, 1 | 3)
        && (1..=3).contains(&session.config.flow_control)
}

fn serial_operation(
    operation: request::Operation,
) -> Result<(PluginSerialCapabilityOperationV2, PendingSerialKind), GatewayFailure> {
    Ok(match operation {
        request::Operation::ListPorts(_) => (
            PluginSerialCapabilityOperationV2::ListPorts,
            PendingSerialKind::ListPorts,
        ),
        request::Operation::ListSessions(_) => (
            PluginSerialCapabilityOperationV2::ListSessions,
            PendingSerialKind::ListSessions,
        ),
        request::Operation::CreateSession(value) => {
            validate_identity(&value.local_id)?;
            validate_short_text(&value.name, false)?;
            if let Some(port_id) = value.port_id.as_deref() {
                validate_identity(port_id)?;
            }
            let config = renderer_serial_config(value.config.ok_or_else(invalid_failure)?)?;
            let lifetime = match wire::SessionLifetime::try_from(value.lifetime).ok() {
                Some(wire::SessionLifetime::Persistent) => {
                    PluginSerialSessionLifetimeV2::Persistent
                }
                Some(wire::SessionLifetime::Runtime) => PluginSerialSessionLifetimeV2::Runtime,
                _ => return Err(invalid_failure()),
            };
            (
                PluginSerialCapabilityOperationV2::CreateSession {
                    request: bbcom_contracts::PluginSerialCreateSessionV2 {
                        local_id: value.local_id,
                        name: value.name,
                        lifetime,
                        port_id: value.port_id,
                        config,
                    },
                },
                PendingSerialKind::CreateSession,
            )
        }
        request::Operation::UpdateSession(value) => {
            let session = renderer_serial_session(value.session.ok_or_else(invalid_failure)?)?;
            let session_id = session.session_id.clone();
            (
                PluginSerialCapabilityOperationV2::UpdateSession { session },
                PendingSerialKind::UpdateSession { session_id },
            )
        }
        request::Operation::ConnectSession(value) => {
            validate_identity(&value.session_id)?;
            let session_id = value.session_id;
            (
                PluginSerialCapabilityOperationV2::ConnectSession {
                    session_id: session_id.clone(),
                },
                PendingSerialKind::ConnectSession { session_id },
            )
        }
        request::Operation::DisconnectSession(value) => {
            validate_identity(&value.session_id)?;
            (
                PluginSerialCapabilityOperationV2::DisconnectSession {
                    session_id: value.session_id,
                },
                PendingSerialKind::DisconnectSession,
            )
        }
        request::Operation::DeleteSession(value) => {
            validate_identity(&value.session_id)?;
            (
                PluginSerialCapabilityOperationV2::DeleteSession {
                    session_id: value.session_id,
                },
                PendingSerialKind::DeleteSession,
            )
        }
        request::Operation::AcquireSerialLease(value) => {
            validate_identity(&value.session_id)?;
            let options = value.options.ok_or_else(invalid_failure)?;
            if !options.pause_automation || options.rx_buffer_bytes == 0 {
                return Err(invalid_failure());
            }
            (
                PluginSerialCapabilityOperationV2::AcquireSerialLease {
                    session_id: value.session_id,
                    options: bbcom_contracts::PluginSerialLeaseOptionsV2 {
                        pause_automation: options.pause_automation,
                        rx_buffer_bytes: options.rx_buffer_bytes,
                    },
                },
                PendingSerialKind::AcquireSerialLease,
            )
        }
        request::Operation::ReleaseSerialLease(value) => (
            PluginSerialCapabilityOperationV2::ReleaseSerialLease {
                lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
            },
            PendingSerialKind::ReleaseSerialLease,
        ),
        request::Operation::SerialRead(value) => {
            if value.max_bytes == 0
                || value.max_bytes as usize > MAX_STREAM_CHUNK_BYTES
                || value.timeout_ms == 0
                || value.timeout_ms > SERIAL_READ_TIMEOUT_MS
            {
                return Err(limit_failure());
            }
            (
                PluginSerialCapabilityOperationV2::SerialRead {
                    lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
                    max_bytes: value.max_bytes,
                    timeout_ms: value.timeout_ms,
                },
                PendingSerialKind::SerialRead {
                    maximum_bytes: value.max_bytes as usize,
                    timeout_ms: value.timeout_ms,
                },
            )
        }
        request::Operation::SerialWrite(value) => {
            if value.payload.is_empty() || value.payload.len() > MAX_STREAM_CHUNK_BYTES {
                return Err(limit_failure());
            }
            let requested_bytes = value.payload.len() as u64;
            (
                PluginSerialCapabilityOperationV2::SerialWrite {
                    lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
                    payload: value.payload,
                },
                PendingSerialKind::SerialWrite { requested_bytes },
            )
        }
        request::Operation::ClearSerialBuffers(value) => (
            PluginSerialCapabilityOperationV2::ClearSerialBuffers {
                lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
            },
            PendingSerialKind::ClearSerialBuffers,
        ),
        request::Operation::PendingSerialBytes(value) => (
            PluginSerialCapabilityOperationV2::PendingSerialBytes {
                lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
            },
            PendingSerialKind::PendingSerialBytes,
        ),
        request::Operation::SetOutputLines(value) => {
            let lines = value.lines.ok_or_else(invalid_failure)?;
            (
                PluginSerialCapabilityOperationV2::SetOutputLines {
                    lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
                    lines: bbcom_contracts::PluginSerialOutputLinesV2 {
                        dtr: lines.dtr,
                        rts: lines.rts,
                        break_active: lines.break_active,
                    },
                },
                PendingSerialKind::SetOutputLines,
            )
        }
        request::Operation::ReadInputLines(value) => (
            PluginSerialCapabilityOperationV2::ReadInputLines {
                lease: renderer_binding(value.lease.ok_or_else(invalid_failure)?)?,
            },
            PendingSerialKind::ReadInputLines,
        ),
        request::Operation::CaptureRead(value) => {
            validate_identity(&value.session_id)?;
            if value.from_sequence > MAX_SAFE_INTEGER
                || value.max_frames == 0
                || value.max_frames > 1_024
                || value.max_bytes == 0
                || value.max_bytes as usize > MAX_STREAM_CHUNK_BYTES
            {
                return Err(limit_failure());
            }
            (
                PluginSerialCapabilityOperationV2::CaptureRead {
                    session_id: value.session_id,
                    from_sequence: value.from_sequence,
                    max_frames: value.max_frames,
                    max_bytes: value.max_bytes,
                },
                PendingSerialKind::CaptureRead {
                    from_sequence: value.from_sequence,
                    maximum_frames: value.max_frames as usize,
                    maximum_bytes: value.max_bytes as usize,
                },
            )
        }
        _ => return Err(protocol_failure()),
    })
}

fn renderer_serial_config(
    value: wire::SerialConfig,
) -> Result<PluginSerialConfigV2, GatewayFailure> {
    let config = PluginSerialConfigV2 {
        baud_rate: value.baud_rate,
        data_bits: value.data_bits,
        parity: u32::try_from(value.parity).map_err(|_| invalid_failure())?,
        stop_bits: u32::try_from(value.stop_bits).map_err(|_| invalid_failure())?,
        flow_control: u32::try_from(value.flow_control).map_err(|_| invalid_failure())?,
    };
    if config.baud_rate == 0
        || !(5..=8).contains(&config.data_bits)
        || !matches!(wire::Parity::try_from(value.parity), Ok(value) if value != wire::Parity::Unspecified)
        || !matches!(wire::StopBits::try_from(value.stop_bits), Ok(value) if value != wire::StopBits::Unspecified)
        || !matches!(wire::FlowControl::try_from(value.flow_control), Ok(value) if value != wire::FlowControl::Unspecified)
    {
        return Err(invalid_failure());
    }
    Ok(config)
}

fn renderer_serial_session(
    value: wire::SerialSession,
) -> Result<PluginSerialSessionV2, GatewayFailure> {
    let session = PluginSerialSessionV2 {
        session_id: value.session_id,
        name: value.name,
        port_id: value.port_id,
        config: renderer_serial_config(value.config.ok_or_else(invalid_failure)?)?,
        connected: value.connected,
        generation: value.generation,
    };
    validate_renderer_session(&session)
        .then_some(session)
        .ok_or_else(invalid_failure)
}

fn serial_result(
    result: PluginSerialCapabilityResultV2,
) -> Result<response::Result, GatewayFailure> {
    Ok(match result {
        PluginSerialCapabilityResultV2::ListPorts { ports } => {
            response::Result::ListPorts(wire::ListPortsResponse {
                ports: ports
                    .into_iter()
                    .map(|port| wire::SerialPort {
                        port_id: port.port_id,
                        display_name: port.display_name,
                        usb_vendor_id: port.usb_vendor_id.map(u32::from),
                        usb_product_id: port.usb_product_id.map(u32::from),
                        serial_number: port.serial_number,
                    })
                    .collect(),
            })
        }
        PluginSerialCapabilityResultV2::ListSessions { sessions } => {
            response::Result::ListSessions(wire::ListSessionsResponse {
                sessions: sessions.into_iter().map(wire_serial_session).collect(),
            })
        }
        PluginSerialCapabilityResultV2::CreateSession { session } => {
            response::Result::CreateSession(wire::SessionResponse {
                session: Some(wire_serial_session(session)),
            })
        }
        PluginSerialCapabilityResultV2::UpdateSession { session } => {
            response::Result::UpdateSession(wire::SessionResponse {
                session: Some(wire_serial_session(session)),
            })
        }
        PluginSerialCapabilityResultV2::ConnectSession { session } => {
            response::Result::ConnectSession(wire::SessionResponse {
                session: Some(wire_serial_session(session)),
            })
        }
        PluginSerialCapabilityResultV2::DisconnectSession => {
            response::Result::DisconnectSession(wire::OperationAck {})
        }
        PluginSerialCapabilityResultV2::DeleteSession => {
            response::Result::DeleteSession(wire::OperationAck {})
        }
        PluginSerialCapabilityResultV2::AcquireSerialLease {
            lease,
            session_generation,
        } => response::Result::AcquireSerialLease(wire::AcquireSerialLeaseResponse {
            lease: Some(wire_binding(lease)?),
            session_generation,
        }),
        PluginSerialCapabilityResultV2::ReleaseSerialLease => {
            response::Result::ReleaseSerialLease(wire::OperationAck {})
        }
        PluginSerialCapabilityResultV2::SerialRead {
            payload,
            timed_out,
            disconnected,
        } => response::Result::SerialRead(wire::SerialReadResponse {
            payload,
            timed_out,
            disconnected,
        }),
        PluginSerialCapabilityResultV2::SerialWrite {
            requested,
            sent,
            outcome,
        } => response::Result::SerialWrite(wire::SerialWriteResponse {
            requested,
            sent,
            outcome: match outcome {
                PluginSerialWriteOutcomeV2::Completed => wire::WriteOutcome::Completed as i32,
                PluginSerialWriteOutcomeV2::PartialWrite => wire::WriteOutcome::PartialWrite as i32,
                PluginSerialWriteOutcomeV2::UnknownOutcome => {
                    wire::WriteOutcome::UnknownOutcome as i32
                }
            },
        }),
        PluginSerialCapabilityResultV2::ClearSerialBuffers => {
            response::Result::ClearSerialBuffers(wire::OperationAck {})
        }
        PluginSerialCapabilityResultV2::PendingSerialBytes { rx, tx } => {
            response::Result::PendingSerialBytes(wire::PendingSerialBytesResponse { rx, tx })
        }
        PluginSerialCapabilityResultV2::SetOutputLines => {
            response::Result::SetOutputLines(wire::OperationAck {})
        }
        PluginSerialCapabilityResultV2::ReadInputLines { lines } => {
            response::Result::ReadInputLines(wire::ReadInputLinesResponse {
                lines: Some(wire::InputLines {
                    cts: lines.cts,
                    dsr: lines.dsr,
                    ri: lines.ri,
                    cd: lines.cd,
                }),
            })
        }
        PluginSerialCapabilityResultV2::CaptureRead {
            frames,
            next_sequence,
        } => response::Result::CaptureRead(wire::CaptureReadResponse {
            frames: frames
                .into_iter()
                .map(|frame| wire::CaptureFrame {
                    sequence: frame.sequence,
                    timestamp_ms: frame.timestamp_ms,
                    direction: match frame.direction {
                        PluginSerialFrameDirectionV2::Rx => wire::FrameDirection::Rx as i32,
                        PluginSerialFrameDirectionV2::Tx => wire::FrameDirection::Tx as i32,
                    },
                    payload: frame.payload,
                })
                .collect(),
            next_sequence,
        }),
    })
}

fn wire_serial_session(session: PluginSerialSessionV2) -> wire::SerialSession {
    wire::SerialSession {
        session_id: session.session_id,
        name: session.name,
        port_id: session.port_id,
        config: Some(wire::SerialConfig {
            baud_rate: session.config.baud_rate,
            data_bits: session.config.data_bits,
            parity: session.config.parity as i32,
            stop_bits: session.config.stop_bits as i32,
            flow_control: session.config.flow_control as i32,
        }),
        connected: session.connected,
        generation: session.generation,
    }
}

fn renderer_context(context: &GatewayContext) -> Result<PluginGatewayContextV2, GatewayFailure> {
    runtime_key(context)?;
    Ok(PluginGatewayContextV2 {
        workspace_id: context.workspace_id.clone(),
        plugin_id: context.plugin_id.clone(),
        instance_id: context.instance_id.clone(),
        generation: context.generation,
    })
}

fn renderer_binding(
    binding: wire::ResourceBinding,
) -> Result<PluginResourceBindingV2, GatewayFailure> {
    if binding.resource_id.is_empty() {
        return Err(invalid_failure());
    }
    Ok(PluginResourceBindingV2 {
        workspace_id: binding.workspace_id,
        plugin_id: binding.plugin_id,
        instance_id: binding.instance_id,
        generation: binding.generation,
        resource_id: binding.resource_id,
    })
}

fn wire_binding(binding: PluginResourceBindingV2) -> Result<wire::ResourceBinding, GatewayFailure> {
    if binding.resource_id.is_empty() {
        return Err(protocol_failure());
    }
    Ok(wire::ResourceBinding {
        workspace_id: binding.workspace_id,
        plugin_id: binding.plugin_id,
        instance_id: binding.instance_id,
        generation: binding.generation,
        resource_id: binding.resource_id,
    })
}

fn require_wire_binding(
    context: &GatewayContext,
    binding: &wire::ResourceBinding,
) -> Result<(), GatewayFailure> {
    if context.binds(binding) {
        Ok(())
    } else {
        Err(stale_failure())
    }
}

fn runtime_key(context: &GatewayContext) -> Result<RuntimeKey, GatewayFailure> {
    let instance_id = context
        .instance_id
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0 && *value <= MAX_SAFE_INTEGER)
        .filter(|value| value.to_string() == context.instance_id)
        .ok_or_else(protocol_failure)?;
    if context.workspace_id.is_empty()
        || context.plugin_id.is_empty()
        || context.generation == 0
        || context.generation > MAX_SAFE_INTEGER
    {
        return Err(protocol_failure());
    }
    Ok(RuntimeKey {
        workspace_id: context.workspace_id.clone(),
        plugin_id: context.plugin_id.clone(),
        instance_id,
        generation: context.generation,
    })
}

fn runtime_key_from_public(runtime: &RuntimeInstanceKey) -> Result<RuntimeKey, GatewayFailure> {
    if runtime.workspace_id.is_empty()
        || runtime.plugin_id.is_empty()
        || runtime.instance_id == 0
        || runtime.instance_id > MAX_SAFE_INTEGER
        || runtime.generation == 0
        || runtime.generation > MAX_SAFE_INTEGER
    {
        return Err(invalid_failure());
    }
    Ok(RuntimeKey {
        workspace_id: runtime.workspace_id.clone(),
        plugin_id: runtime.plugin_id.clone(),
        instance_id: runtime.instance_id,
        generation: runtime.generation,
    })
}

fn project_surface(
    runtime: &RuntimeKey,
    surface: &ProjectedSurface,
    document: &wire::SurfaceSnapshot,
) -> Result<PluginSurfaceSnapshot, GatewayFailure> {
    let nodes = document
        .nodes
        .iter()
        .cloned()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut visited = HashSet::new();
    let root = project_node(&document.root_node_id, &nodes, &mut visited)?;
    if visited.len() != nodes.len() {
        return Err(invalid_failure());
    }
    let placement = match wire::SurfaceLocation::try_from(surface.registration.location).ok() {
        Some(wire::SurfaceLocation::Workspace) => PluginSurfacePlacement::Workspace,
        Some(wire::SurfaceLocation::DetachedWindow) => PluginSurfacePlacement::DetachedWindow,
        _ => return Err(invalid_failure()),
    };
    Ok(PluginSurfaceSnapshot {
        runtime: runtime.public(),
        surface_id: document.surface_id.clone(),
        revision: document.revision,
        title: surface.registration.title.clone(),
        placement,
        detached_allowed: surface.detached_allowed,
        editable: surface.editable,
        root,
    })
}

fn project_node(
    node_id: &str,
    nodes: &BTreeMap<String, wire::UiNode>,
    visited: &mut HashSet<String>,
) -> Result<PluginUiNode, GatewayFailure> {
    if !visited.insert(node_id.to_owned()) {
        return Err(invalid_failure());
    }
    let node = nodes.get(node_id).ok_or_else(invalid_failure)?;
    let mut child_ids = nodes
        .values()
        .filter(|candidate| candidate.parent_id.as_deref() == Some(node_id))
        .map(|candidate| (candidate.order, candidate.id.clone()))
        .collect::<Vec<_>>();
    child_ids.sort();
    let kind = node.kind.as_ref().ok_or_else(invalid_failure)?;
    use wire::ui_node::Kind;
    if let Kind::Tabs(tabs) = kind {
        if child_ids.is_empty()
            || !child_ids
                .iter()
                .any(|(_, child_id)| child_id == &tabs.selected_child_id)
        {
            return Err(invalid_failure());
        }
        let mut projected_tabs = Vec::with_capacity(child_ids.len());
        for (_, child_id) in child_ids {
            let child = nodes.get(&child_id).ok_or_else(invalid_failure)?;
            match child.kind.as_ref().ok_or_else(invalid_failure)? {
                Kind::Group(group) => {
                    if !visited.insert(child_id.clone()) {
                        return Err(invalid_failure());
                    }
                    let mut grandchildren = nodes
                        .values()
                        .filter(|candidate| candidate.parent_id.as_deref() == Some(&child_id))
                        .map(|candidate| (candidate.order, candidate.id.clone()))
                        .collect::<Vec<_>>();
                    grandchildren.sort();
                    let children = grandchildren
                        .into_iter()
                        .map(|(_, id)| project_node(&id, nodes, visited))
                        .collect::<Result<Vec<_>, _>>()?;
                    projected_tabs.push(PluginUiTab {
                        id: child_id,
                        label: group.title.clone(),
                        children,
                    });
                }
                _ => projected_tabs.push(PluginUiTab {
                    id: child_id.clone(),
                    label: child_id.clone(),
                    children: vec![project_node(&child_id, nodes, visited)?],
                }),
            }
        }
        return Ok(PluginUiNode::Tabs {
            id: node.id.clone(),
            selected_id: tabs.selected_child_id.clone(),
            tabs: projected_tabs,
        });
    }
    let children = child_ids
        .into_iter()
        .map(|(_, id)| project_node(&id, nodes, visited))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(match kind {
        Kind::Column(_) => PluginUiNode::Column {
            id: node.id.clone(),
            children,
        },
        Kind::Row(_) => PluginUiNode::Row {
            id: node.id.clone(),
            children,
        },
        Kind::Group(group) => PluginUiNode::Group {
            id: node.id.clone(),
            label: group.title.clone(),
            children,
        },
        Kind::Tabs(_) => unreachable!(),
        Kind::Text(text) => {
            require_no_children(&children)?;
            PluginUiNode::Text {
                id: node.id.clone(),
                text: text.text.clone(),
                tone: PluginTextTone::Default,
            }
        }
        Kind::Badge(badge) => {
            require_no_children(&children)?;
            PluginUiNode::Badge {
                id: node.id.clone(),
                text: badge.text.clone(),
                tone: text_tone(&badge.tone)?,
            }
        }
        Kind::KeyValue(value) => {
            require_no_children(&children)?;
            PluginUiNode::KeyValueList {
                id: node.id.clone(),
                entries: value
                    .entries
                    .iter()
                    .map(|entry| PluginKeyValueEntry {
                        key: entry.key.clone(),
                        value: entry.value.clone(),
                        tone: None,
                    })
                    .collect(),
            }
        }
        Kind::Progress(progress) => {
            require_no_children(&children)?;
            PluginUiNode::Progress {
                id: node.id.clone(),
                label: progress.label.clone(),
                completed: u64::from(progress.value),
                total: u64::from(progress.maximum),
            }
        }
        Kind::Log(log) => {
            require_no_children(&children)?;
            PluginUiNode::Log {
                id: node.id.clone(),
                text: log.text.clone(),
                max_lines: 10_000,
            }
        }
        Kind::Code(code) => {
            require_no_children(&children)?;
            PluginUiNode::Code {
                id: node.id.clone(),
                text: code.text.clone(),
                language: code.language.clone().unwrap_or_else(|| "text".to_owned()),
            }
        }
        Kind::Table(table) => {
            require_no_children(&children)?;
            let page_count = table
                .total_rows
                .checked_add(u64::from(table.page_size).saturating_sub(1))
                .and_then(|value| value.checked_div(u64::from(table.page_size)))
                .and_then(|value| u32::try_from(value.max(1)).ok())
                .ok_or_else(limit_failure)?;
            PluginUiNode::Table {
                id: node.id.clone(),
                columns: table
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(index, label)| PluginTableColumn {
                        id: format!("column-{index}"),
                        label: label.clone(),
                    })
                    .collect(),
                rows: table.rows.iter().map(|row| row.cells.clone()).collect(),
                page: table.page,
                page_count,
            }
        }
        Kind::Input(input) => {
            require_no_children(&children)?;
            PluginUiNode::TextInput {
                id: node.id.clone(),
                label: input.label.clone(),
                value: input.value.clone(),
                disabled: input.disabled,
            }
        }
        Kind::NumberInput(input) => {
            require_no_children(&children)?;
            if !input.value.is_finite()
                || input.minimum.is_some_and(|value| !value.is_finite())
                || input.maximum.is_some_and(|value| !value.is_finite())
                || input.step.is_some_and(|value| !value.is_finite())
            {
                return Err(invalid_failure());
            }
            PluginUiNode::NumberInput {
                id: node.id.clone(),
                label: input.label.clone(),
                value: input.value.to_string(),
                min: input.minimum.map(|value| value.to_string()),
                max: input.maximum.map(|value| value.to_string()),
                step: input.step.map(|value| value.to_string()),
                disabled: input.disabled,
            }
        }
        Kind::Select(select) => {
            require_no_children(&children)?;
            PluginUiNode::Select {
                id: node.id.clone(),
                label: select.label.clone(),
                value: select.value.clone(),
                options: select
                    .options
                    .iter()
                    .map(|option| PluginSelectOption {
                        value: option.value.clone(),
                        label: option.label.clone(),
                    })
                    .collect(),
                disabled: select.disabled,
            }
        }
        Kind::Toggle(toggle) => {
            require_no_children(&children)?;
            PluginUiNode::Toggle {
                id: node.id.clone(),
                label: toggle.label.clone(),
                value: toggle.checked,
                disabled: toggle.disabled,
            }
        }
        Kind::Button(button) => {
            require_no_children(&children)?;
            if button.confirmation.is_some() {
                return Err(invalid_failure());
            }
            PluginUiNode::Button {
                id: node.id.clone(),
                label: button.label.clone(),
                disabled: button.disabled,
                dangerous: false,
                confirmation: None,
            }
        }
        Kind::DangerousButton(button) => {
            require_no_children(&children)?;
            PluginUiNode::Button {
                id: node.id.clone(),
                label: button.label.clone(),
                disabled: button.disabled,
                dangerous: true,
                confirmation: button.confirmation.clone(),
            }
        }
    })
}

fn require_no_children(children: &[PluginUiNode]) -> Result<(), GatewayFailure> {
    if children.is_empty() {
        Ok(())
    } else {
        Err(invalid_failure())
    }
}

fn text_tone(value: &str) -> Result<PluginTextTone, GatewayFailure> {
    Ok(match value {
        "" | "default" => PluginTextTone::Default,
        "muted" => PluginTextTone::Muted,
        "info" => PluginTextTone::Info,
        "success" => PluginTextTone::Success,
        "warning" => PluginTextTone::Warning,
        "danger" => PluginTextTone::Danger,
        _ => return Err(invalid_failure()),
    })
}

fn validate_identity(value: &str) -> Result<(), GatewayFailure> {
    let mut bytes = value.bytes();
    if !value.is_empty()
        && value.len() <= 128
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(invalid_failure())
    }
}

fn validate_short_text(value: &str, allow_empty: bool) -> Result<(), GatewayFailure> {
    if (allow_empty || !value.is_empty())
        && value.len() <= 1024
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        Ok(())
    } else {
        Err(invalid_failure())
    }
}

fn validate_long_text(value: &str) -> Result<(), GatewayFailure> {
    if value.len() <= 256 * 1024
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        Ok(())
    } else {
        Err(invalid_failure())
    }
}

fn runtime_sort_key(runtime: &RuntimeInstanceKey) -> (&str, &str, u64, u64) {
    (
        &runtime.workspace_id,
        &runtime.plugin_id,
        runtime.instance_id,
        runtime.generation,
    )
}

fn gateway_failure_from_renderer(code: PluginErrorCodeV2) -> GatewayFailure {
    match code {
        PluginErrorCodeV2::InvalidInput => invalid_failure(),
        PluginErrorCodeV2::PermissionDenied => permission_failure(),
        PluginErrorCodeV2::Unavailable => unavailable_failure(),
        PluginErrorCodeV2::Busy => failure(ErrorCode::Busy, "plugin.error.busy"),
        PluginErrorCodeV2::NotFound => not_found_failure(),
        PluginErrorCodeV2::StaleHandle => stale_failure(),
        PluginErrorCodeV2::Disconnected => {
            failure(ErrorCode::Disconnected, "plugin.error.disconnected")
        }
        PluginErrorCodeV2::Timeout => timeout_failure(),
        PluginErrorCodeV2::Cancelled => failure(ErrorCode::Cancelled, "plugin.error.cancelled"),
        PluginErrorCodeV2::LimitExceeded => limit_failure(),
        PluginErrorCodeV2::PartialWrite => {
            failure(ErrorCode::PartialWrite, "plugin.error.partialWrite")
        }
        PluginErrorCodeV2::UnknownOutcome => unknown_outcome_failure(),
        PluginErrorCodeV2::ProtocolError => protocol_failure(),
        PluginErrorCodeV2::IoError => failure(ErrorCode::IoError, "plugin.error.io"),
    }
}

fn task_failure(code: PluginErrorCodeV2, message_key: &str) -> PluginFailureV2 {
    PluginFailureV2 {
        code,
        message_key: message_key.to_owned(),
        detail: None,
        retryable: false,
    }
}

fn task_failure_from_wire(code: ErrorCode) -> PluginFailureV2 {
    let (code, key) = match code {
        ErrorCode::InvalidInput => (PluginErrorCodeV2::InvalidInput, "plugin.error.invalidInput"),
        ErrorCode::PermissionDenied => (
            PluginErrorCodeV2::PermissionDenied,
            "plugin.error.permissionDenied",
        ),
        ErrorCode::Unavailable => (PluginErrorCodeV2::Unavailable, "plugin.error.unavailable"),
        ErrorCode::Busy => (PluginErrorCodeV2::Busy, "plugin.error.busy"),
        ErrorCode::NotFound => (PluginErrorCodeV2::NotFound, "plugin.error.notFound"),
        ErrorCode::StaleHandle => (PluginErrorCodeV2::StaleHandle, "plugin.error.staleHandle"),
        ErrorCode::Disconnected => (PluginErrorCodeV2::Disconnected, "plugin.error.disconnected"),
        ErrorCode::Timeout => (PluginErrorCodeV2::Timeout, "plugin.error.timeout"),
        ErrorCode::Cancelled => (PluginErrorCodeV2::Cancelled, "plugin.error.cancelled"),
        ErrorCode::LimitExceeded => (
            PluginErrorCodeV2::LimitExceeded,
            "plugin.error.limitExceeded",
        ),
        ErrorCode::PartialWrite => (PluginErrorCodeV2::PartialWrite, "plugin.error.partialWrite"),
        ErrorCode::UnknownOutcome => (
            PluginErrorCodeV2::UnknownOutcome,
            "plugin.error.unknownOutcome",
        ),
        ErrorCode::ProtocolError | ErrorCode::Unspecified => (
            PluginErrorCodeV2::ProtocolError,
            "plugin.error.commandFailed",
        ),
        ErrorCode::IoError => (PluginErrorCodeV2::IoError, "plugin.error.io"),
    };
    task_failure(code, key)
}

fn is_terminal_task_status(status: PluginTaskStatusV2) -> bool {
    matches!(
        status,
        PluginTaskStatusV2::Completed
            | PluginTaskStatusV2::Failed
            | PluginTaskStatusV2::Cancelled
            | PluginTaskStatusV2::UnknownOutcome
    )
}

fn file_failure(error: PluginFileError) -> GatewayFailure {
    gateway_failure_from_renderer(error.code)
}

fn failure(code: ErrorCode, key: &'static str) -> GatewayFailure {
    GatewayFailure::new(code, key)
}

fn invalid_failure() -> GatewayFailure {
    failure(ErrorCode::InvalidInput, "plugin.error.invalidInput")
}

fn permission_failure() -> GatewayFailure {
    GatewayFailure::permission_denied()
}

fn unavailable_failure() -> GatewayFailure {
    failure(ErrorCode::Unavailable, "plugin.error.unavailable")
}

fn not_found_failure() -> GatewayFailure {
    failure(ErrorCode::NotFound, "plugin.error.notFound")
}

fn stale_failure() -> GatewayFailure {
    failure(ErrorCode::StaleHandle, "plugin.error.staleHandle")
}

fn timeout_failure() -> GatewayFailure {
    failure(ErrorCode::Timeout, "plugin.error.timeout")
}

fn unknown_outcome_failure() -> GatewayFailure {
    failure(ErrorCode::UnknownOutcome, "plugin.error.unknownOutcome")
}

fn limit_failure() -> GatewayFailure {
    GatewayFailure::limit()
}

fn protocol_failure() -> GatewayFailure {
    GatewayFailure::protocol()
}

fn revision_failure() -> GatewayFailure {
    failure(
        ErrorCode::InvalidInput,
        "plugin.error.surfaceRevisionConflict",
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use bbcom_contracts::PluginSerialCapabilityResponseV2;

    use super::*;

    #[test]
    fn serial_read_wait_keeps_renderer_inside_guest_rpc_deadline() {
        assert_eq!(
            serial_read_renderer_timeout(SERIAL_READ_TIMEOUT_MS),
            Duration::from_secs(12)
        );
    }

    #[derive(Default)]
    struct RecordingPrivateState(Mutex<Vec<Vec<u8>>>);
    impl PluginPrivateStatePersistenceV2 for RecordingPrivateState {
        fn persist_plugin_storage(
            &self,
            _: &GatewayContext,
            _: &str,
            encoded: &[u8],
        ) -> Result<(), PluginErrorCodeV2> {
            self.0.lock().unwrap().push(encoded.to_vec());
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecordingWorkspace {
        project: Mutex<Option<Vec<u8>>>,
        project_schema: Mutex<Option<u32>>,
        contributions: Mutex<Vec<String>>,
        fail_project_write: AtomicBool,
    }
    impl PluginWorkspaceCapabilityPortV2 for RecordingWorkspace {
        fn set_project_state(
            &self,
            _: &GatewayContext,
            schema_version: u32,
            value: &[u8],
        ) -> Result<(), PluginErrorCodeV2> {
            if self.fail_project_write.load(Ordering::Acquire) {
                return Err(PluginErrorCodeV2::IoError);
            }
            *self.project.lock().unwrap() = Some(value.to_vec());
            *self.project_schema.lock().unwrap() = Some(schema_version);
            Ok(())
        }
        fn upsert_quick_command(
            &self,
            context: &GatewayContext,
            command: &wire::QuickCommand,
        ) -> Result<String, PluginErrorCodeV2> {
            let id = format!("plugin:{}:{}", context.plugin_id, command.local_id);
            self.contributions
                .lock()
                .unwrap()
                .push(format!("{}:{id}", command.session_id));
            Ok(id)
        }
        fn delete_quick_command(
            &self,
            _: &GatewayContext,
            session_id: &str,
            local_id: &str,
        ) -> Result<(), PluginErrorCodeV2> {
            self.contributions
                .lock()
                .unwrap()
                .push(format!("delete-quick:{session_id}:{local_id}"));
            Ok(())
        }
        fn upsert_macro(
            &self,
            context: &GatewayContext,
            value: &wire::MacroContribution,
        ) -> Result<String, PluginErrorCodeV2> {
            Ok(format!("plugin:{}:{}", context.plugin_id, value.local_id))
        }
        fn delete_macro(
            &self,
            _: &GatewayContext,
            _: &str,
            _: &str,
        ) -> Result<(), PluginErrorCodeV2> {
            Ok(())
        }
    }

    struct SelectedFiles {
        read: PathBuf,
        save: PathBuf,
    }
    impl PluginFileDialogPortV2 for SelectedFiles {
        fn open_read(&self, _: &[String]) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
            Ok(Some(self.read.clone()))
        }
        fn create_save(&self, _: &str) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
            Ok(Some(self.save.clone()))
        }
    }

    struct RecordingSink {
        serial: mpsc::Sender<PluginSerialCapabilityInboundV2>,
        projection_changes: AtomicUsize,
    }

    impl PluginCapabilityEventSinkV2 for RecordingSink {
        fn emit_serial(
            &self,
            event: &PluginSerialCapabilityInboundV2,
        ) -> Result<(), PluginCapabilitySinkErrorV2> {
            self.serial
                .send(event.clone())
                .map_err(|_| PluginCapabilitySinkErrorV2)
        }

        fn projection_changed(&self) -> Result<(), PluginCapabilitySinkErrorV2> {
            self.projection_changes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    fn context(capabilities: impl IntoIterator<Item = wire::Capability>) -> GatewayContext {
        GatewayContext {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.fixture".to_owned(),
            instance_id: "7".to_owned(),
            generation: 7,
            granted_capabilities: capabilities.into_iter().collect(),
        }
    }

    fn renderer_context_fixture() -> PluginGatewayContextV2 {
        PluginGatewayContextV2 {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.fixture".to_owned(),
            instance_id: "7".to_owned(),
            generation: 7,
        }
    }

    type GatewayFixture = (
        Arc<NativePluginCapabilityGatewayV2>,
        Arc<SerialCapabilityCorrelationRegistryV2>,
        Arc<PluginRuntimeProjectionV2>,
        mpsc::Receiver<PluginSerialCapabilityInboundV2>,
        Arc<RecordingSink>,
        Arc<PluginFileGrantService>,
    );

    fn gateway() -> GatewayFixture {
        let (sender, receiver) = mpsc::channel();
        let sink = Arc::new(RecordingSink {
            serial: sender,
            projection_changes: AtomicUsize::new(0),
        });
        let serial = Arc::new(SerialCapabilityCorrelationRegistryV2::default());
        let projection = Arc::new(PluginRuntimeProjectionV2::default());
        let files = Arc::new(PluginFileGrantService::default());
        let gateway = Arc::new(NativePluginCapabilityGatewayV2::new(
            sink.clone(),
            Arc::clone(&serial),
            Arc::clone(&projection),
            Arc::clone(&files),
        ));
        (gateway, serial, projection, receiver, sink, files)
    }

    fn empty_model() -> wire::PluginModel {
        wire::PluginModel {
            surfaces: Vec::new(),
            commands: Vec::new(),
        }
    }

    #[test]
    fn host_context_fails_closed_until_hydrated_and_binds_sessions_to_workspace() {
        let store = PluginHostContextStoreV2::default();
        assert_eq!(
            store
                .initialization_context("workspace-1")
                .unwrap_err()
                .code,
            ErrorCode::Unavailable
        );

        let changes = store
            .update(PluginHostContextUpdateRequestV2 {
                workspace_id: Some("workspace-1".to_owned()),
                locale: PluginHostLocaleV2::En,
                theme: PluginHostThemeV2::Light,
                sessions: vec![bbcom_contracts::PluginHostSessionSummaryV2 {
                    session_id: "session-1".to_owned(),
                    name: "Device".to_owned(),
                    connected: true,
                    rx_bytes: 7,
                    tx_bytes: 9,
                    generation: 3,
                }],
            })
            .unwrap();
        assert_eq!(changes.locale.as_deref(), Some("en-US"));
        assert_eq!(changes.theme, Some(wire::ColorScheme::Light));

        let context = store.initialization_context("workspace-1").unwrap();
        assert_eq!(context.locale, "en-US");
        assert_eq!(context.theme, wire::ColorScheme::Light);
        assert_eq!(context.sessions.len(), 1);
        assert_eq!(context.sessions[0].session_id, "session-1");
        assert!(
            store
                .initialization_context("workspace-2")
                .unwrap()
                .sessions
                .is_empty()
        );

        let error = store
            .update(PluginHostContextUpdateRequestV2 {
                workspace_id: Some("workspace-1".to_owned()),
                locale: PluginHostLocaleV2::En,
                theme: PluginHostThemeV2::Light,
                sessions: vec![bbcom_contracts::PluginHostSessionSummaryV2 {
                    session_id: "session-2".to_owned(),
                    name: "Disconnected".to_owned(),
                    connected: true,
                    rx_bytes: 0,
                    tx_bytes: 0,
                    generation: 0,
                }],
            })
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn serial_round_trip_is_exactly_correlated_and_typed() {
        let (gateway, registry, _, events, _, _) = gateway();
        let runtime = context([wire::Capability::SerialSessionsManage]);
        let worker = std::thread::spawn(move || {
            gateway.invoke(
                &runtime,
                11,
                request::Operation::ListSessions(wire::ListSessionsRequest {}),
            )
        });
        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(
            event,
            PluginSerialCapabilityInboundV2::Request {
                message_id: 11,
                operation: PluginSerialCapabilityOperationV2::ListSessions,
                ..
            }
        ));

        let malformed = PluginSerialCapabilityOutboundV2::Response {
            response: PluginSerialCapabilityResponseV2 {
                context: renderer_context_fixture(),
                reply_to: 11,
                ok: true,
                result: Some(PluginSerialCapabilityResultV2::ReleaseSerialLease),
                error_code: None,
            },
        };
        assert_eq!(
            registry.complete(malformed),
            Err(SerialCapabilityReplyErrorV2::InvalidShape)
        );
        assert_eq!(registry.pending_count(), 1);

        registry
            .complete(PluginSerialCapabilityOutboundV2::Response {
                response: PluginSerialCapabilityResponseV2 {
                    context: renderer_context_fixture(),
                    reply_to: 11,
                    ok: true,
                    result: Some(PluginSerialCapabilityResultV2::ListSessions {
                        sessions: Vec::new(),
                    }),
                    error_code: None,
                },
            })
            .unwrap();
        assert!(matches!(
            worker.join().unwrap().unwrap(),
            response::Result::ListSessions(wire::ListSessionsResponse { sessions })
                if sessions.is_empty()
        ));
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn cancelled_late_acquire_emits_only_an_exact_generation_bound_lease_revoke() {
        let (gateway, _, _, events, _, _) = gateway();
        let runtime = context([wire::Capability::SerialIo]);
        let operation = request::Operation::AcquireSerialLease(wire::AcquireSerialLeaseRequest {
            session_id: "session-1".to_owned(),
            options: Some(wire::SerialLeaseOptions {
                pause_automation: true,
                rx_buffer_bytes: 4_096,
            }),
        });
        let binding = wire::ResourceBinding {
            workspace_id: runtime.workspace_id.clone(),
            plugin_id: runtime.plugin_id.clone(),
            instance_id: runtime.instance_id.clone(),
            generation: runtime.generation,
            resource_id: "serial-v2.late.1".to_owned(),
        };

        let mut stale_binding = binding.clone();
        stale_binding.generation += 1;
        gateway.discard_cancelled_result(
            &runtime,
            &operation,
            &response::Result::AcquireSerialLease(wire::AcquireSerialLeaseResponse {
                lease: Some(stale_binding),
                session_generation: 9,
            }),
        );
        gateway.discard_cancelled_result(
            &runtime,
            &operation,
            &response::Result::AcquireSerialLease(wire::AcquireSerialLeaseResponse {
                lease: Some(binding.clone()),
                session_generation: 0,
            }),
        );
        assert!(matches!(events.try_recv(), Err(mpsc::TryRecvError::Empty)));

        let late_result = response::Result::AcquireSerialLease(wire::AcquireSerialLeaseResponse {
            lease: Some(binding.clone()),
            session_generation: 9,
        });
        gateway.discard_cancelled_result(&runtime, &operation, &late_result);
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap(),
            PluginSerialCapabilityInboundV2::RevokeLease {
                context: renderer_context_fixture(),
                lease: PluginResourceBindingV2 {
                    workspace_id: binding.workspace_id,
                    plugin_id: binding.plugin_id,
                    instance_id: binding.instance_id,
                    generation: binding.generation,
                    resource_id: binding.resource_id,
                },
                session_generation: 9,
            }
        );
    }

    #[test]
    fn cancellation_and_runtime_revoke_wake_waiters_without_cross_generation_reuse() {
        let registry = SerialCapabilityCorrelationRegistryV2::default();
        let context = renderer_context_fixture();
        let receiver = registry
            .register(context.clone(), 3, PendingSerialKind::AcquireSerialLease)
            .unwrap();
        registry
            .complete(PluginSerialCapabilityOutboundV2::CancelResult {
                context: context.clone(),
                target_message_id: 3,
                ok: true,
                error_code: None,
            })
            .unwrap();
        assert_eq!(receiver.recv().unwrap(), Err(PluginErrorCodeV2::Cancelled));

        let receiver = registry
            .register(context.clone(), 4, PendingSerialKind::ReleaseSerialLease)
            .unwrap();
        let mut stale = context.clone();
        stale.generation += 1;
        assert_eq!(registry.revoke_runtime(&stale), 0);
        assert_eq!(registry.revoke_runtime(&context), 1);
        assert_eq!(receiver.recv().unwrap(), Err(PluginErrorCodeV2::Cancelled));
    }

    #[test]
    fn surface_patch_commands_progress_and_revoke_share_one_generation_projection() {
        let (gateway, _, projection, _, sink, _) = gateway();
        let runtime = context([
            wire::Capability::UiWorkspace,
            wire::Capability::UiDetachedWindow,
        ]);
        gateway
            .register_runtime(
                &runtime,
                RuntimeBootstrapState {
                    plugin_storage: Vec::new(),
                    project_state: None,
                    project_state_schema_version: None,
                    storage_scope: "active".to_owned(),
                },
            )
            .unwrap();
        let initial_model = wire::PluginModel {
            surfaces: vec![wire::PluginSurface {
                surface_id: "overview".to_owned(),
                title: "Overview".to_owned(),
                location: wire::SurfaceLocation::Workspace as i32,
            }],
            commands: vec![wire::CommandContribution {
                command_id: "flash".to_owned(),
                title: "Flash".to_owned(),
                description: "Upload firmware".to_owned(),
                long_running: true,
                confirmation: None,
            }],
        };
        assert_eq!(
            gateway
                .finalize_initial_model(&runtime, &initial_model)
                .unwrap_err()
                .code,
            ErrorCode::ProtocolError
        );
        gateway
            .invoke(
                &runtime,
                1,
                request::Operation::RegisterSurface(wire::RegisterSurfaceRequest {
                    surface: Some(wire::PluginSurface {
                        surface_id: "overview".to_owned(),
                        title: "Overview".to_owned(),
                        location: wire::SurfaceLocation::Workspace as i32,
                    }),
                }),
            )
            .unwrap();
        assert_eq!(
            gateway
                .finalize_initial_model(&runtime, &initial_model)
                .unwrap_err()
                .code,
            ErrorCode::ProtocolError
        );
        gateway
            .invoke(
                &runtime,
                2,
                request::Operation::PublishSurfaceSnapshot(wire::PublishSurfaceSnapshotRequest {
                    snapshot: Some(surface_document(1, "ready")),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                3,
                request::Operation::PublishSurfacePatch(wire::PublishSurfacePatchRequest {
                    patch: Some(wire::SurfacePatch {
                        surface_id: "overview".to_owned(),
                        base_revision: 1,
                        next_revision: 2,
                        operations: vec![wire::UiPatchOperation {
                            operation: Some(wire::ui_patch_operation::Operation::Upsert(
                                text_node("status", "running"),
                            )),
                        }],
                    }),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                4,
                request::Operation::RegisterCommand(wire::RegisterCommandRequest {
                    command: Some(wire::CommandContribution {
                        command_id: "flash".to_owned(),
                        title: "Flash".to_owned(),
                        description: "Upload firmware".to_owned(),
                        long_running: true,
                        confirmation: None,
                    }),
                }),
            )
            .unwrap();
        gateway
            .finalize_initial_model(&runtime, &initial_model)
            .unwrap();
        let mut mismatched_model = initial_model.clone();
        mismatched_model.commands[0].title = "Different".to_owned();
        assert_eq!(
            gateway
                .finalize_initial_model(&runtime, &mismatched_model)
                .unwrap_err()
                .code,
            ErrorCode::ProtocolError
        );
        projection
            .begin_command_task(&runtime_key(&runtime).unwrap().public(), "flash", "flash")
            .unwrap();
        gateway
            .invoke(
                &runtime,
                5,
                request::Operation::ReportProgress(wire::ReportProgressRequest {
                    progress: Some(wire::TaskStateEvent {
                        task_id: "flash".to_owned(),
                        state: wire::TaskState::Running as i32,
                        completed: Some(1),
                        total: Some(4),
                        message: "uploading".to_owned(),
                    }),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                6,
                request::Operation::Heartbeat(wire::HeartbeatRequest {
                    task_id: "flash".to_owned(),
                }),
            )
            .unwrap();

        let snapshot = projection.snapshot();
        assert_eq!(snapshot.surfaces.len(), 1);
        assert_eq!(snapshot.surfaces[0].revision, 2);
        assert_eq!(snapshot.tasks.len(), 1);
        assert_eq!(snapshot.command_contributions.len(), 1);
        assert_eq!(
            projection.command_long_running(&runtime_key(&runtime).unwrap().public(), "flash"),
            Some(true)
        );
        assert!(sink.projection_changes.load(Ordering::Relaxed) >= 6);

        gateway.revoke_runtime(&runtime);
        let snapshot = projection.snapshot();
        assert!(snapshot.surfaces.is_empty());
        assert!(snapshot.tasks.is_empty());
        assert!(snapshot.command_contributions.is_empty());
    }

    #[test]
    fn async_command_tasks_reach_every_host_terminal_state() {
        let (gateway, _, projection, _, _, _) = gateway();
        let context = context([wire::Capability::UiWorkspace]);
        gateway
            .invoke(
                &context,
                1,
                request::Operation::RegisterCommand(wire::RegisterCommandRequest {
                    command: Some(wire::CommandContribution {
                        command_id: "long-command".to_owned(),
                        title: "Long command".to_owned(),
                        description: String::new(),
                        long_running: true,
                        confirmation: None,
                    }),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &context,
                2,
                request::Operation::RegisterCommand(wire::RegisterCommandRequest {
                    command: Some(wire::CommandContribution {
                        command_id: "quick-command".to_owned(),
                        title: "Quick command".to_owned(),
                        description: String::new(),
                        long_running: false,
                        confirmation: None,
                    }),
                }),
            )
            .unwrap();
        let runtime = runtime_key(&context).unwrap().public();
        projection
            .begin_command_task(&runtime, "quick-task", "quick-command")
            .unwrap();
        gateway
            .invoke(
                &context,
                3,
                request::Operation::Heartbeat(wire::HeartbeatRequest {
                    task_id: "quick-task".to_owned(),
                }),
            )
            .unwrap();
        gateway.complete_task(&context, "quick-task", TaskTerminal::Completed);
        assert_eq!(
            projection
                .snapshot()
                .tasks
                .iter()
                .find(|task| task.task_id == "quick-task")
                .map(|task| task.status),
            Some(PluginTaskStatusV2::Completed)
        );
        for (index, (terminal, status)) in [
            (TaskTerminal::Completed, PluginTaskStatusV2::Completed),
            (
                TaskTerminal::Failed(ErrorCode::IoError),
                PluginTaskStatusV2::Failed,
            ),
            (TaskTerminal::Cancelled, PluginTaskStatusV2::Cancelled),
            (
                TaskTerminal::UnknownOutcome,
                PluginTaskStatusV2::UnknownOutcome,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let task_id = format!("task-{index}");
            projection
                .begin_command_task(&runtime, &task_id, "long-command")
                .unwrap();
            if terminal == TaskTerminal::Cancelled {
                projection.mark_task_cancelling(&runtime, &task_id).unwrap();
            }
            gateway.complete_task(&context, &task_id, terminal);
            let task = projection
                .snapshot()
                .tasks
                .into_iter()
                .find(|task| task.task_id == task_id)
                .unwrap();
            assert_eq!(task.status, status);
            assert!(!task.cancellable);
        }
    }

    #[test]
    fn task_projection_rejects_forged_progress_and_evicts_only_terminal_history() {
        let (gateway, _, projection, _, _, _) = gateway();
        let context = context([wire::Capability::UiWorkspace]);
        gateway
            .invoke(
                &context,
                1,
                request::Operation::RegisterCommand(wire::RegisterCommandRequest {
                    command: Some(wire::CommandContribution {
                        command_id: "short".to_owned(),
                        title: "Short".to_owned(),
                        description: String::new(),
                        long_running: false,
                        confirmation: None,
                    }),
                }),
            )
            .unwrap();
        let forged = gateway
            .invoke(
                &context,
                2,
                request::Operation::ReportProgress(wire::ReportProgressRequest {
                    progress: Some(wire::TaskStateEvent {
                        task_id: "forged".to_owned(),
                        state: wire::TaskState::Running as i32,
                        completed: Some(0),
                        total: Some(1),
                        message: String::new(),
                    }),
                }),
            )
            .unwrap_err();
        assert_eq!(forged.code, ErrorCode::NotFound);

        let runtime = runtime_key(&context).unwrap().public();
        for index in 0..(MAX_PROJECTED_TASKS + 16) {
            let task_id = format!("task-{index}");
            projection
                .begin_command_task(&runtime, &task_id, "short")
                .unwrap();
            gateway.complete_task(&context, &task_id, TaskTerminal::Completed);
        }
        let snapshot = projection.snapshot();
        assert_eq!(snapshot.tasks.len(), MAX_PROJECTED_TASKS);
        assert!(
            snapshot
                .tasks
                .iter()
                .all(|task| is_terminal_task_status(task.status))
        );
        assert!(!snapshot.tasks.iter().any(|task| task.task_id == "task-0"));
        assert!(
            snapshot
                .tasks
                .iter()
                .any(|task| task.task_id == format!("task-{}", MAX_PROJECTED_TASKS + 15))
        );
    }

    #[test]
    fn opaque_file_chunks_never_expose_paths_and_revoke_with_runtime() {
        let (gateway, _, _, _, _, files) = gateway();
        let runtime = context([wire::Capability::FileOpenRead]);
        let owner = runtime_key(&runtime).unwrap().public();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("firmware.bin");
        fs::write(&path, b"abcdef").unwrap();
        let grant = files.issue_read_selected(owner, path).unwrap();
        let binding = wire::ResourceBinding {
            workspace_id: runtime.workspace_id.clone(),
            plugin_id: runtime.plugin_id.clone(),
            instance_id: runtime.instance_id.clone(),
            generation: runtime.generation,
            resource_id: grant.handle_id,
        };
        let result = gateway
            .invoke(
                &runtime,
                1,
                request::Operation::ReadGrantChunk(wire::ReadGrantChunkRequest {
                    grant: Some(binding.clone()),
                    offset: 1,
                    max_bytes: 3,
                }),
            )
            .unwrap();
        assert!(matches!(
            result,
            response::Result::ReadGrantChunk(wire::ReadGrantChunkResponse {
                total_bytes: 6,
                payload,
                ..
            }) if payload == b"bcd"
        ));
        gateway.revoke_runtime(&runtime);
        assert_eq!(
            gateway
                .invoke(
                    &runtime,
                    2,
                    request::Operation::ReadGrantChunk(wire::ReadGrantChunkRequest {
                        grant: Some(binding),
                        offset: 0,
                        max_bytes: 1,
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::StaleHandle
        );
    }

    #[test]
    fn staged_state_commits_only_after_active_initialize_succeeds() {
        let (sender, _receiver) = mpsc::channel();
        let private = Arc::new(RecordingPrivateState::default());
        let workspace = Arc::new(RecordingWorkspace::default());
        *workspace.project.lock().unwrap() = Some(b"73".to_vec());
        let gateway = NativePluginCapabilityGatewayV2::new_with_ports(
            Arc::new(RecordingSink {
                serial: sender,
                projection_changes: AtomicUsize::new(0),
            }),
            Arc::new(SerialCapabilityCorrelationRegistryV2::default()),
            Arc::new(PluginRuntimeProjectionV2::default()),
            Arc::new(PluginFileGrantService::default()),
            Arc::new(UnavailableFileDialog),
            private.clone(),
            workspace.clone(),
            Arc::new(UnavailableDetachedProjection),
        );
        let mut runtime = context([
            wire::Capability::PluginStorage,
            wire::Capability::ProjectStateReadWrite,
        ]);
        runtime.plugin_id = "dev.bbcom.counter-v2".to_owned();
        gateway
            .register_runtime(
                &runtime,
                RuntimeBootstrapState {
                    plugin_storage: encode_storage(&BTreeMap::from([(
                        "counter-state".to_owned(),
                        b"73".to_vec(),
                    )]))
                    .unwrap(),
                    project_state: Some(b"73".to_vec()),
                    project_state_schema_version: None,
                    storage_scope: "active".to_owned(),
                },
            )
            .unwrap();

        assert!(matches!(
            gateway
                .invoke(
                    &runtime,
                    1,
                    request::Operation::StorageGet(wire::StorageGetRequest {
                        key: "counter-state".to_owned(),
                    }),
                )
                .unwrap(),
            response::Result::StorageGet(wire::StorageGetResponse { value: Some(value) })
                if value == b"73"
        ));
        gateway
            .invoke(
                &runtime,
                2,
                request::Operation::StorageDelete(wire::StorageDeleteRequest {
                    key: "counter-state".to_owned(),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                3,
                request::Operation::StorageSet(wire::StorageSetRequest {
                    key: "counter-v2-state".to_owned(),
                    value: b"private-v2".to_vec(),
                }),
            )
            .unwrap();
        gateway
            .stage_migrated_project_state(&runtime, 73, b"BCV2-migrated-73".to_vec())
            .unwrap();
        assert!(matches!(
            gateway
                .invoke(
                    &runtime,
                    4,
                    request::Operation::ProjectStateGet(wire::ProjectStateGetRequest {}),
                )
                .unwrap(),
            response::Result::ProjectStateGet(wire::ProjectStateGetResponse {
                schema_version: Some(73),
                value: Some(value),
            }) if value == b"BCV2-migrated-73"
        ));
        assert!(private.0.lock().unwrap().is_empty());
        assert_eq!(*workspace.project.lock().unwrap(), Some(b"73".to_vec()));

        gateway
            .finalize_initial_model(&runtime, &empty_model())
            .unwrap();
        assert_eq!(private.0.lock().unwrap().len(), 1);
        assert_eq!(*workspace.project_schema.lock().unwrap(), Some(73));
        assert_eq!(
            *workspace.project.lock().unwrap(),
            Some(b"BCV2-migrated-73".to_vec())
        );
    }

    #[test]
    fn initialize_model_failure_keeps_active_state_untouched() {
        let (sender, _receiver) = mpsc::channel();
        let private = Arc::new(RecordingPrivateState::default());
        let workspace = Arc::new(RecordingWorkspace::default());
        *workspace.project.lock().unwrap() = Some(b"41".to_vec());
        let gateway = NativePluginCapabilityGatewayV2::new_with_ports(
            Arc::new(RecordingSink {
                serial: sender,
                projection_changes: AtomicUsize::new(0),
            }),
            Arc::new(SerialCapabilityCorrelationRegistryV2::default()),
            Arc::new(PluginRuntimeProjectionV2::default()),
            Arc::new(PluginFileGrantService::default()),
            Arc::new(UnavailableFileDialog),
            private.clone(),
            workspace.clone(),
            Arc::new(UnavailableDetachedProjection),
        );
        let mut runtime = context([wire::Capability::PluginStorage]);
        runtime.plugin_id = "dev.bbcom.counter-v2".to_owned();
        gateway
            .register_runtime(
                &runtime,
                RuntimeBootstrapState {
                    plugin_storage: encode_storage(&BTreeMap::from([(
                        "counter-state".to_owned(),
                        b"41".to_vec(),
                    )]))
                    .unwrap(),
                    project_state: Some(b"41".to_vec()),
                    project_state_schema_version: None,
                    storage_scope: "active".to_owned(),
                },
            )
            .unwrap();
        assert!(matches!(
            gateway
                .invoke(
                    &runtime,
                    1,
                    request::Operation::StorageGet(wire::StorageGetRequest {
                        key: "counter-state".to_owned(),
                    }),
                )
                .unwrap(),
            response::Result::StorageGet(wire::StorageGetResponse { value: Some(value) })
                if value == b"41"
        ));
        gateway
            .invoke(
                &runtime,
                2,
                request::Operation::StorageDelete(wire::StorageDeleteRequest {
                    key: "counter-state".to_owned(),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                3,
                request::Operation::StorageSet(wire::StorageSetRequest {
                    key: "counter-v2-state".to_owned(),
                    value: b"candidate".to_vec(),
                }),
            )
            .unwrap();
        gateway
            .stage_migrated_project_state(&runtime, 2, b"migrated".to_vec())
            .unwrap();

        let invalid_model = wire::PluginModel {
            surfaces: Vec::new(),
            commands: vec![wire::CommandContribution {
                command_id: "undeclared".to_owned(),
                title: "Undeclared".to_owned(),
                description: String::new(),
                long_running: false,
                confirmation: None,
            }],
        };
        assert_eq!(
            gateway
                .finalize_initial_model(&runtime, &invalid_model)
                .unwrap_err()
                .code,
            ErrorCode::ProtocolError
        );
        assert!(private.0.lock().unwrap().is_empty());
        assert_eq!(*workspace.project.lock().unwrap(), Some(b"41".to_vec()));
    }

    #[test]
    fn active_project_commit_failure_compensates_private_state() {
        let (sender, _receiver) = mpsc::channel();
        let initial_storage = encode_storage(&BTreeMap::from([(
            "counter-state".to_owned(),
            b"29".to_vec(),
        )]))
        .unwrap();
        let private = Arc::new(RecordingPrivateState::default());
        let workspace = Arc::new(RecordingWorkspace::default());
        *workspace.project.lock().unwrap() = Some(b"old-project".to_vec());
        workspace.fail_project_write.store(true, Ordering::Release);
        let gateway = NativePluginCapabilityGatewayV2::new_with_ports(
            Arc::new(RecordingSink {
                serial: sender,
                projection_changes: AtomicUsize::new(0),
            }),
            Arc::new(SerialCapabilityCorrelationRegistryV2::default()),
            Arc::new(PluginRuntimeProjectionV2::default()),
            Arc::new(PluginFileGrantService::default()),
            Arc::new(UnavailableFileDialog),
            private.clone(),
            workspace.clone(),
            Arc::new(UnavailableDetachedProjection),
        );
        let runtime = context([wire::Capability::PluginStorage]);
        gateway
            .register_runtime(
                &runtime,
                RuntimeBootstrapState {
                    plugin_storage: initial_storage.clone(),
                    project_state: Some(b"old-project".to_vec()),
                    project_state_schema_version: None,
                    storage_scope: "active".to_owned(),
                },
            )
            .unwrap();
        assert!(matches!(
            gateway
                .invoke(
                    &runtime,
                    1,
                    request::Operation::StorageGet(wire::StorageGetRequest {
                        key: "counter-state".to_owned(),
                    }),
                )
                .unwrap(),
            response::Result::StorageGet(wire::StorageGetResponse { value: Some(value) })
                if value == b"29"
        ));
        gateway
            .invoke(
                &runtime,
                2,
                request::Operation::StorageDelete(wire::StorageDeleteRequest {
                    key: "counter-state".to_owned(),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                3,
                request::Operation::StorageSet(wire::StorageSetRequest {
                    key: "counter-v2-state".to_owned(),
                    value: b"new-private".to_vec(),
                }),
            )
            .unwrap();
        gateway
            .stage_migrated_project_state(&runtime, 2, b"new-project".to_vec())
            .unwrap();

        assert_eq!(
            gateway
                .finalize_initial_model(&runtime, &empty_model())
                .unwrap_err()
                .code,
            ErrorCode::IoError
        );
        let writes = private.0.lock().unwrap();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes.last(), Some(&initial_storage));
        assert_eq!(
            *workspace.project.lock().unwrap(),
            Some(b"old-project".to_vec())
        );
    }

    #[test]
    fn prepared_initialize_and_post_init_writes_never_reach_persistence() {
        let (sender, _receiver) = mpsc::channel();
        let private = Arc::new(RecordingPrivateState::default());
        let workspace = Arc::new(RecordingWorkspace::default());
        *workspace.project.lock().unwrap() = Some(b"active-v1".to_vec());
        let gateway = NativePluginCapabilityGatewayV2::new_with_ports(
            Arc::new(RecordingSink {
                serial: sender,
                projection_changes: AtomicUsize::new(0),
            }),
            Arc::new(SerialCapabilityCorrelationRegistryV2::default()),
            Arc::new(PluginRuntimeProjectionV2::default()),
            Arc::new(PluginFileGrantService::default()),
            Arc::new(UnavailableFileDialog),
            private.clone(),
            workspace.clone(),
            Arc::new(UnavailableDetachedProjection),
        );
        let runtime = context([wire::Capability::PluginStorage]);
        gateway
            .register_runtime(
                &runtime,
                RuntimeBootstrapState {
                    plugin_storage: Vec::new(),
                    project_state: Some(b"active-v1".to_vec()),
                    project_state_schema_version: None,
                    storage_scope: "prepared:upgrade-1".to_owned(),
                },
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                1,
                request::Operation::StorageSet(wire::StorageSetRequest {
                    key: "counter-v2-state".to_owned(),
                    value: b"prepared-private".to_vec(),
                }),
            )
            .unwrap();
        gateway
            .stage_migrated_project_state(&runtime, 2, b"prepared-project".to_vec())
            .unwrap();

        gateway
            .finalize_initial_model(&runtime, &empty_model())
            .unwrap();
        gateway
            .invoke(
                &runtime,
                2,
                request::Operation::StorageSet(wire::StorageSetRequest {
                    key: "post-init".to_owned(),
                    value: b"still-ephemeral".to_vec(),
                }),
            )
            .unwrap();
        assert!(private.0.lock().unwrap().is_empty());
        assert_eq!(
            *workspace.project.lock().unwrap(),
            Some(b"active-v1".to_vec())
        );
    }

    #[test]
    fn startup_state_file_dialog_and_session_bound_contributions_are_executable() {
        let directory = tempfile::tempdir().unwrap();
        let read = directory.path().join("firmware.bin");
        let save = directory.path().join("download.bin");
        fs::write(&read, b"firmware").unwrap();
        let (sender, _receiver) = mpsc::channel();
        let sink = Arc::new(RecordingSink {
            serial: sender,
            projection_changes: AtomicUsize::new(0),
        });
        let private = Arc::new(RecordingPrivateState::default());
        let workspace = Arc::new(RecordingWorkspace::default());
        let gateway = NativePluginCapabilityGatewayV2::new_with_ports(
            sink,
            Arc::new(SerialCapabilityCorrelationRegistryV2::default()),
            Arc::new(PluginRuntimeProjectionV2::default()),
            Arc::new(PluginFileGrantService::default()),
            Arc::new(SelectedFiles {
                read,
                save: save.clone(),
            }),
            private.clone(),
            workspace.clone(),
            Arc::new(UnavailableDetachedProjection),
        );
        let runtime = context([
            wire::Capability::PluginStorage,
            wire::Capability::ProjectStateReadWrite,
            wire::Capability::FileOpenRead,
            wire::Capability::FileSaveWrite,
            wire::Capability::SessionCommandsReadWrite,
        ]);
        gateway
            .register_runtime(
                &runtime,
                RuntimeBootstrapState {
                    plugin_storage: Vec::new(),
                    project_state: Some(vec![1]),
                    project_state_schema_version: Some(73),
                    storage_scope: "active".to_owned(),
                },
            )
            .unwrap();
        gateway
            .finalize_initial_model(&runtime, &empty_model())
            .unwrap();
        assert!(matches!(
            gateway
                .invoke(
                    &runtime,
                    1,
                    request::Operation::StorageGet(wire::StorageGetRequest {
                        key: "counter".to_owned()
                    })
                )
                .unwrap(),
            response::Result::StorageGet(wire::StorageGetResponse { value: None })
        ));
        gateway
            .invoke(
                &runtime,
                2,
                request::Operation::StorageSet(wire::StorageSetRequest {
                    key: "counter".to_owned(),
                    value: vec![9],
                }),
            )
            .unwrap();
        assert_eq!(private.0.lock().unwrap().len(), 1);
        assert!(matches!(
            gateway
                .invoke(
                    &runtime,
                    30,
                    request::Operation::ProjectStateGet(wire::ProjectStateGetRequest {}),
                )
                .unwrap(),
            response::Result::ProjectStateGet(wire::ProjectStateGetResponse {
                schema_version: Some(73),
                value: Some(value),
            }) if value == vec![1]
        ));
        assert_eq!(
            gateway
                .invoke(
                    &runtime,
                    31,
                    request::Operation::ProjectStateSet(wire::ProjectStateSetRequest {
                        schema_version: 0,
                        value: vec![0],
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput,
        );
        gateway
            .invoke(
                &runtime,
                3,
                request::Operation::ProjectStateSet(wire::ProjectStateSetRequest {
                    schema_version: 91,
                    value: vec![2],
                }),
            )
            .unwrap();
        assert_eq!(*workspace.project.lock().unwrap(), Some(vec![2]));
        assert_eq!(*workspace.project_schema.lock().unwrap(), Some(91));

        let opened = gateway
            .invoke(
                &runtime,
                4,
                request::Operation::OpenReadGrant(wire::OpenReadGrantRequest {
                    accepted_extensions: vec!["bin".to_owned()],
                }),
            )
            .unwrap();
        let response::Result::OpenReadGrant(wire::OpenReadGrantResponse {
            grant: Some(opened),
        }) = opened
        else {
            panic!("open grant")
        };
        assert_eq!(opened.display_name, "firmware.bin");
        assert_eq!(opened.size, Some(8));

        let created = gateway
            .invoke(
                &runtime,
                5,
                request::Operation::CreateSaveGrant(wire::CreateSaveGrantRequest {
                    suggested_name: "download.bin".to_owned(),
                }),
            )
            .unwrap();
        let response::Result::CreateSaveGrant(wire::CreateSaveGrantResponse {
            grant: Some(created),
        }) = created
        else {
            panic!("save grant")
        };
        gateway
            .invoke(
                &runtime,
                6,
                request::Operation::WriteSaveGrant(wire::WriteSaveGrantRequest {
                    grant: created.grant.clone(),
                    payload: b"download".to_vec(),
                }),
            )
            .unwrap();
        gateway
            .invoke(
                &runtime,
                7,
                request::Operation::CommitSaveGrant(wire::CommitSaveGrantRequest {
                    grant: created.grant,
                }),
            )
            .unwrap();
        assert_eq!(fs::read(save).unwrap(), b"download");

        let contribution = gateway
            .invoke(
                &runtime,
                8,
                request::Operation::UpsertQuickCommand(wire::UpsertQuickCommandRequest {
                    command: Some(wire::QuickCommand {
                        local_id: "echo".to_owned(),
                        title: "Echo".to_owned(),
                        payload: vec![1],
                        append_newline: false,
                        session_id: "session-1".to_owned(),
                    }),
                }),
            )
            .unwrap();
        assert!(matches!(
            contribution,
            response::Result::UpsertQuickCommand(wire::ContributionResponse { contribution_id })
                if contribution_id == "plugin:dev.bbcom.fixture:echo"
        ));
        assert_eq!(
            workspace.contributions.lock().unwrap().as_slice(),
            ["session-1:plugin:dev.bbcom.fixture:echo"]
        );

        gateway.revoke_runtime(&runtime);
        let mut restarted = runtime.clone();
        restarted.instance_id = "8".to_owned();
        restarted.generation = 8;
        gateway
            .register_runtime(
                &restarted,
                RuntimeBootstrapState {
                    plugin_storage: Vec::new(),
                    project_state: Some(vec![2]),
                    project_state_schema_version: Some(91),
                    storage_scope: "active".to_owned(),
                },
            )
            .unwrap();
        gateway
            .finalize_initial_model(&restarted, &empty_model())
            .unwrap();
        assert_eq!(
            gateway
                .invoke(
                    &runtime,
                    32,
                    request::Operation::ProjectStateSet(wire::ProjectStateSetRequest {
                        schema_version: 73,
                        value: b"stale".to_vec(),
                    }),
                )
                .unwrap_err()
                .code,
            ErrorCode::StaleHandle,
        );
        assert_eq!(*workspace.project_schema.lock().unwrap(), Some(91));
        assert_eq!(*workspace.project.lock().unwrap(), Some(vec![2]));
        gateway
            .invoke(
                &restarted,
                33,
                request::Operation::ProjectStateSet(wire::ProjectStateSetRequest {
                    schema_version: 73,
                    value: b"latest".to_vec(),
                }),
            )
            .unwrap();
        assert_eq!(*workspace.project_schema.lock().unwrap(), Some(73));
        assert_eq!(*workspace.project.lock().unwrap(), Some(b"latest".to_vec()));
    }

    #[test]
    fn file_dialog_filters_are_extensions_and_reject_mime_types() {
        assert_eq!(
            validate_extensions(vec!["bin".to_owned(), ".HEX".to_owned()]).unwrap(),
            vec!["bin".to_owned(), "hex".to_owned()],
        );
        assert!(validate_extensions(vec!["application/octet-stream".to_owned()]).is_err());
    }

    fn surface_document(revision: u64, status: &str) -> wire::SurfaceSnapshot {
        wire::SurfaceSnapshot {
            surface_id: "overview".to_owned(),
            revision,
            root_node_id: "root".to_owned(),
            nodes: vec![
                wire::UiNode {
                    id: "root".to_owned(),
                    parent_id: None,
                    order: 0,
                    kind: Some(wire::ui_node::Kind::Column(wire::EmptyNode {})),
                },
                text_node("status", status),
            ],
        }
    }

    fn text_node(id: &str, text: &str) -> wire::UiNode {
        wire::UiNode {
            id: id.to_owned(),
            parent_id: Some("root".to_owned()),
            order: 0,
            kind: Some(wire::ui_node::Kind::Text(wire::TextNode {
                text: text.to_owned(),
            })),
        }
    }
}
