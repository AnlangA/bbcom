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
//! - Windows AppContainer host copy: `plugin-host-v1` (content addressed)
//!
//! On-disk plugin roots for every builder dependency are resolved by native
//! setup only; no command, event, DTO or renderer string can select them.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bbcom_contracts::{
    InstallLocalPluginRequest, PluginCommandResponse, PluginSerialAction,
    PluginSerialActionResultRequest, PluginSnapshotRequest, RuntimeInstanceKey, SerialSendOutcome,
};
use bbcom_plugin_broker::{
    AuditEvent, AuditOperation, AuditSink, BrokerAction, DeclarativePanelBroker,
    SerialProposalBroker,
};
use bbcom_plugin_manager::ManualPackageRequest;
use bbcom_plugin_repository::{DownloadedPackage, PluginInstaller};
use semver::Version;
use sha2::{Digest, Sha256};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::workspace::WorkspaceManager;
use crate::utils::window::MAIN_WINDOW_LABEL;

use super::bootstrap::{
    CurrentPluginWorkspace, PluginBootstrapError, PluginHostUpstreamPort, PluginRuntimeLifecycle,
    PluginSerialSchedulerPort, ProductionPluginRuntime, ProductionPluginRuntimeBuilder,
};
use super::command_adapter::{
    CatalogPluginRecord, CatalogViewFailure, CatalogViewPort, PluginDisplayRecord,
};
use super::command_service::PluginUpstreamFailure;
use super::host_launcher::PrivateArtifactRoot;
use super::installation::{VerifiedPackageProvider, artifact_source};
use super::runtime_actor::PluginWorkspaceBindingPort;
use super::sandbox::PlatformSandboxDriver;
use super::state::NativePluginStatePersistencePort;

const SIDECAR_BASENAME: &str = "bbcom-plugin-host";
static NEXT_SIDECAR_STAGE_ID: AtomicU64 = AtomicU64::new(1);
/// Serial actions wait at most this long for a main-window acknowledgement
/// before the operation is reported as unavailable (fail-closed).
/// The webview acknowledgement round trip includes the user-visible send
/// path; 2s timed out legitimate slow sends and made plugins retry (risking
/// duplicate device writes), so the bound is 10s with late completions
/// logged instead of silently discarded.
const SERIAL_ACTION_RESULT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on concurrently unacknowledged serial actions. Reaching it fails the
/// action instead of growing an unbounded pending map.
const MAX_PENDING_SERIAL_ACTIONS: usize = 16;
/// The audit log is truncated and reopened once it exceeds this size.
const MAX_AUDIT_LOG_BYTES: u64 = 4 * 1024 * 1024;

const PANEL_EVENT_NAME: &str = "plugin-panel-event";
const SERIAL_ACTION_EVENT_NAME: &str = "plugin-serial-action";
/// G43: a plugin session/capture query awaiting the main window's answer.
const SESSION_QUERY_EVENT_NAME: &str = "plugin-session-query";
/// Nudge for the plugin center to re-snapshot (e.g. a proposal arrived).
const SNAPSHOT_CHANGED_EVENT_NAME: &str = "plugin-snapshot-changed";
/// Session queries wait at most this long for the webview answer.
const SESSION_QUERY_RESULT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PENDING_SESSION_QUERIES: usize = 32;

/// Current lifecycle the push workers forward into; refreshed by
/// ensure_plugin_runtime on every (re)composition.
static ACTIVE_LIFECYCLE: Mutex<Option<Arc<dyn super::bootstrap::PluginRuntimeLifecycle>>> =
    Mutex::new(None);
/// Push workers are process-lifetime and must survive recomposition.
static PUSH_WORKERS: OnceLock<()> = OnceLock::new();

/// Non-blocking sink handed to every host reader thread.
struct NativeHostPushSink {
    proposals: mpsc::Sender<bbcom_plugin_contracts::generated::SerialProposalEvent>,
    queries: mpsc::Sender<bbcom_plugin_contracts::generated::SessionQueryRequest>,
}

impl bbcom_plugin_manager::HostPushSink for NativeHostPushSink {
    fn serial_proposal(&self, event: bbcom_plugin_contracts::generated::SerialProposalEvent) {
        // Bounded, non-blocking: the host reader thread must never stall on a
        // full queue; drops are covered by the sidecar's own TTL bound.
        let _ = self.proposals.send(event);
    }

    fn session_query(&self, request: bbcom_plugin_contracts::generated::SessionQueryRequest) {
        let _ = self.queries.send(request);
    }
}

/// Webview answer registry for in-flight session queries.
#[derive(Clone, Default)]
pub struct SessionQueryResultRegistry {
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<bbcom_contracts::PluginSessionQueryResult>>>>,
}

impl SessionQueryResultRegistry {
    fn register(
        &self,
        query_id: &str,
    ) -> Option<mpsc::Receiver<bbcom_contracts::PluginSessionQueryResult>> {
        let mut pending = self.lock_pending();
        if pending.len() >= MAX_PENDING_SESSION_QUERIES {
            return None;
        }
        let (sender, receiver) = mpsc::channel();
        pending.insert(query_id.to_owned(), sender);
        Some(receiver)
    }

    /// Fulfills an exact query correlation. Returns false for unknown or
    /// already-answered queries.
    pub fn complete(&self, result: bbcom_contracts::PluginSessionQueryResult) -> bool {
        let mut pending = self.lock_pending();
        pending
            .remove(&result.query_id)
            .is_some_and(|sender| sender.send(result).is_ok())
    }

    fn discard(&self, query_id: &str) {
        self.lock_pending().remove(query_id);
    }

    fn lock_pending(
        &self,
    ) -> std::sync::MutexGuard<
        '_,
        HashMap<String, mpsc::Sender<bbcom_contracts::PluginSessionQueryResult>>,
    > {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn active_lifecycle() -> Option<Arc<dyn super::bootstrap::PluginRuntimeLifecycle>> {
    ACTIVE_LIFECYCLE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

fn spawn_push_workers<E: HostUpstreamEnvironment>(
    environment: &Arc<E>,
    registry: &Arc<SessionQueryResultRegistry>,
    proposals: mpsc::Receiver<bbcom_plugin_contracts::generated::SerialProposalEvent>,
    queries: mpsc::Receiver<bbcom_plugin_contracts::generated::SessionQueryRequest>,
) {
    if PUSH_WORKERS.set(()).is_err() {
        return; // Workers from an earlier composition keep draining.
    }
    let proposal_environment = Arc::clone(environment);
    let query_environment = Arc::clone(environment);
    std::thread::Builder::new()
        .name("bbcom-plugin-proposals".to_owned())
        .spawn(move || {
            while let Ok(event) = proposals.recv() {
                if let Some(lifecycle) = active_lifecycle() {
                    lifecycle.register_serial_proposal(event);
                }
                // Make the pending prompt visible without a user-triggered
                // refresh; failures are harmless (next refresh catches up).
                let _ = proposal_environment
                    .emit_to_main(SNAPSHOT_CHANGED_EVENT_NAME, &serde_json::json!({}));
            }
        })
        .expect("proposal worker thread");
    let registry = Arc::clone(registry);
    std::thread::Builder::new()
        .name("bbcom-plugin-queries".to_owned())
        .spawn(move || {
            while let Ok(request) = queries.recv() {
                answer_session_query(&*query_environment, &registry, request);
            }
        })
        .expect("session query worker thread");
}

fn answer_session_query<E: HostUpstreamEnvironment>(
    environment: &E,
    registry: &SessionQueryResultRegistry,
    request: bbcom_plugin_contracts::generated::SessionQueryRequest,
) {
    use bbcom_contracts::{PluginSessionQuery, PluginSessionQueryKind};
    use bbcom_plugin_contracts::generated::session_query_request::Query;

    let query_id = request.query_id.clone();
    let plugin_id = request.plugin_id.clone();
    let kind = match request.query {
        Some(Query::List(_)) => PluginSessionQueryKind::List,
        Some(Query::Capture(capture)) => PluginSessionQueryKind::Capture {
            session_id: capture.session_id,
            from_sequence: u32::try_from(capture.from_sequence).unwrap_or(u32::MAX),
            max_frames: capture.max_frames,
            max_bytes: capture.max_bytes,
        },
        None => {
            deliver_query_error(environment, &plugin_id, &query_id, "invalid-input");
            return;
        }
    };
    let Some(waiter) = registry.register(&query_id) else {
        deliver_query_error(environment, &plugin_id, &query_id, "limit-exceeded");
        return;
    };
    let event = serde_json::to_value(PluginSessionQuery {
        query_id: query_id.clone(),
        plugin_id: plugin_id.clone(),
        kind,
    });
    let Ok(event) = event else {
        registry.discard(&query_id);
        deliver_query_error(environment, &plugin_id, &query_id, "invalid-input");
        return;
    };
    if environment
        .emit_to_main(SESSION_QUERY_EVENT_NAME, &event)
        .is_err()
    {
        registry.discard(&query_id);
        deliver_query_error(environment, &plugin_id, &query_id, "invalid-input");
        return;
    }
    let result = waiter.recv_timeout(SESSION_QUERY_RESULT_TIMEOUT);
    let payload = match result {
        Ok(result) if result.ok => build_query_response(&query_id, &result),
        Ok(_) => {
            // The webview answered with a domain error.
            deliver_query_error_code(environment, &plugin_id, &query_id, "permission-denied");
            return;
        }
        Err(_) => {
            registry.discard(&query_id);
            bbcom_plugin_contracts::generated::SessionQueryResponse {
                query_id,
                ok: false,
                error_code: "unavailable".to_owned(),
                sessions: Vec::new(),
                frames: Vec::new(),
                next_sequence: 0,
                has_more: false,
            }
        }
    };
    deliver_query_response(environment, &plugin_id, payload);
}

fn build_query_response(
    query_id: &str,
    result: &bbcom_contracts::PluginSessionQueryResult,
) -> bbcom_plugin_contracts::generated::SessionQueryResponse {
    bbcom_plugin_contracts::generated::SessionQueryResponse {
        query_id: query_id.to_owned(),
        ok: true,
        error_code: String::new(),
        sessions: result
            .sessions
            .iter()
            .map(
                |session| bbcom_plugin_contracts::generated::SessionMetadataEntry {
                    session_id: session.session_id.clone(),
                    name: session.name.clone(),
                    kind: session.kind.clone(),
                    connected: session.connected,
                    rx_bytes: session.rx_bytes,
                    tx_bytes: session.tx_bytes,
                },
            )
            .collect(),
        frames: result
            .frames
            .iter()
            .map(
                |frame| bbcom_plugin_contracts::generated::CaptureFrameEntry {
                    sequence: u64::from(frame.sequence),
                    timestamp_ms: frame.timestamp_ms,
                    tx: frame.tx,
                    payload: frame.bytes.clone(),
                },
            )
            .collect(),
        next_sequence: u64::from(result.next_sequence),
        has_more: result.has_more,
    }
}

fn deliver_query_error<E: HostUpstreamEnvironment>(
    environment: &E,
    plugin_id: &str,
    query_id: &str,
    error_code: &str,
) {
    deliver_query_error_code(environment, plugin_id, query_id, error_code);
}

fn deliver_query_error_code<E: HostUpstreamEnvironment>(
    environment: &E,
    _plugin_id: &str,
    query_id: &str,
    error_code: &str,
) {
    // The error response still needs a running host to reach; if none is
    // active the sidecar's own timeout resolves the call.
    let Some(lifecycle) = active_lifecycle() else {
        return;
    };
    let _ = environment;
    let payload = bbcom_plugin_contracts::generated::SessionQueryResponse {
        query_id: query_id.to_owned(),
        ok: false,
        error_code: error_code.to_owned(),
        sessions: Vec::new(),
        frames: Vec::new(),
        next_sequence: 0,
        has_more: false,
    };
    let _ = lifecycle.deliver_envelope(
        _plugin_id,
        bbcom_plugin_contracts::generated::envelope::Payload::SessionQueryResponse(payload),
    );
}

fn deliver_query_response<E: HostUpstreamEnvironment>(
    _environment: &E,
    plugin_id: &str,
    payload: bbcom_plugin_contracts::generated::SessionQueryResponse,
) {
    let Some(lifecycle) = active_lifecycle() else {
        return;
    };
    let _ = lifecycle.deliver_envelope(
        plugin_id,
        bbcom_plugin_contracts::generated::envelope::Payload::SessionQueryResponse(payload),
    );
}

/// Application-owned bridge the plugin upstream ports use to reach the main
/// webview and the active workspace. Production is backed by [`AppHandle`];
/// tests substitute a recording environment.
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
}

struct EnvironmentWorkspaceBindingPort<E>(Arc<E>);

impl<E: HostUpstreamEnvironment> PluginWorkspaceBindingPort for EnvironmentWorkspaceBindingPort<E> {
    fn set_expected_enabled(&self, plugin_id: &str, expected_enabled: bool) -> Result<(), ()> {
        self.0
            .set_plugin_expected_enabled(plugin_id, expected_enabled)
    }
}

/// Durable roots and the resolved sidecar path used by one composition.
struct PluginRuntimeRoots {
    installer_packages: PathBuf,
    installer_data: PathBuf,
    state_private: PathBuf,
    audit_log: PathBuf,
    sidecar_executable: PathBuf,
}

/// Composes the production plugin runtime from native application state.
///
/// Returns the runtime for `PluginCommandState`/lifecycle installation. On any
/// failure the caller must keep the fail-closed unavailable command service and
/// record only [`PluginBootstrapError::code`].
pub fn compose<R: tauri::Runtime>(
    app: &AppHandle<R>,
    registry: SerialActionResultRegistry,
) -> Result<ProductionPluginRuntime, PluginBootstrapError> {
    let roots = app_data_roots(app)?;
    let environment = Arc::new(TauriHostUpstreamEnvironment::new(app.clone()));
    let sources = app
        .state::<Arc<super::NativePluginSourceRegistry>>()
        .inner()
        .clone();
    let query_registry = Arc::new(
        app.try_state::<SessionQueryResultRegistry>()
            .map(|state| state.inner().clone())
            .unwrap_or_default(),
    );
    compose_from_parts(roots, environment, registry, query_registry, sources)
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
    let registry = match app.try_state::<SerialActionResultRegistry>() {
        Some(registry) => registry.inner().clone(),
        None => return,
    };
    let lifecycle_handle = match app.try_state::<PluginLifecycleHandle>() {
        Some(handle) => handle,
        None => return,
    };
    if lifecycle_handle.current().is_some() {
        return;
    }
    let outcome = compose(app, registry);
    let status = match &outcome {
        Ok(runtime) => {
            let generation = HOST_EXIT_POLL_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            app.state::<crate::commands::plugin::PluginCommandState>()
                .replace_service(runtime.command_service());
            let lifecycle = runtime.lifecycle();
            lifecycle_handle.install(Arc::clone(&lifecycle));
            // Push workers forward host-side proposals/queries into the
            // current lifecycle; a recomposition swaps the slot atomically.
            *ACTIVE_LIFECYCLE
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&lifecycle));
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
    let app_data = match app.try_state::<PluginRuntimeDataRoot>() {
        Some(root) => root.0.clone(),
        None => app
            .path()
            .app_data_dir()
            .map_err(|_| PluginBootstrapError::MissingInstaller)?,
    };
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
        stage_runtime_sidecar(&bundled_sidecar, &app_data.join("plugin-host-v1")).map_err(
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
        audit_log: app_data.join("logs").join("plugin-audit.jsonl"),
        state_private: app_data.clone(),
        sidecar_executable,
    })
}

/// Process-lifetime audit sink shared by every runtime composition. The
/// stateful proposal/panel brokers borrow it as `&'static`; re-composing the
/// runtime (workspace switches, retries after a failed composition) must not
/// leak a fresh append handle each time, so it is created exactly once.
static SHARED_AUDIT_SINK: OnceLock<Arc<FileAuditSink>> = OnceLock::new();

fn shared_audit_sink(path: &Path) -> &'static FileAuditSink {
    let sink = SHARED_AUDIT_SINK.get_or_init(|| Arc::new(FileAuditSink::open(path.to_path_buf())));
    // The OnceLock contents outlive every composition (process lifetime), so
    // borrowing through it is a sound 'static promotion.
    Arc::as_ref(sink)
}

/// Environment-independent composition used by native setup and the unit tests.
fn compose_from_parts<E: HostUpstreamEnvironment>(
    roots: PluginRuntimeRoots,
    environment: Arc<E>,
    registry: SerialActionResultRegistry,
    query_registry: Arc<SessionQueryResultRegistry>,
    sources: Arc<super::NativePluginSourceRegistry>,
) -> Result<ProductionPluginRuntime, PluginBootstrapError> {
    let workspace_bindings = EnvironmentWorkspaceBindingPort(Arc::clone(&environment));
    // Missing sidecar is resolved before `build()` so platforms without the
    // bundled sidecar fail with the stable missing-sidecar code and never
    // execute the (slower) platform sandbox self-test first.
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
            let permissions = std::fs::read_to_string(active.package_directory.join("plugin.toml"))
                .ok()
                .and_then(|text| {
                    bbcom_plugin_contracts::PluginManifest::parse(&text)
                        .ok()
                        .and_then(|manifest| manifest.permissions().ok())
                })
                .unwrap_or_default()
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            match bbcom_plugin_manager::PluginArtifact::new(
                &active.plugin_id,
                &active.version,
                &active.package_sha256,
                &active.component_sha256,
                artifact_source(&active.repository_origin),
                permissions,
            ) {
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
    let workspace = match environment.active_workspace() {
        Some(context) => {
            CurrentPluginWorkspace::new(context.workspace_id, context.states, installed_artifacts)
                .with_bindings(context.bindings)
        }
        None => CurrentPluginWorkspace::detached(installed_artifacts),
    };

    let state = NativePluginStatePersistencePort::open(&roots.state_private)
        .map_err(|_| PluginBootstrapError::MissingStatePersistence)?;

    fs::create_dir_all(&roots.installer_packages)
        .map_err(|_| PluginBootstrapError::MissingPrivateArtifactRoot)?;
    // Resolver and sandbox validator share the exact canonical package root.
    let private_artifact_root = PrivateArtifactRoot::open(&roots.installer_packages)
        .map_err(|_| PluginBootstrapError::MissingPrivateArtifactRoot)?;

    let audit_for_brokers = shared_audit_sink(&roots.audit_log);

    let host_upstream = WebviewHostUpstream {
        environment: Arc::clone(&environment),
    };
    let serial_scheduler = WebviewSerialScheduler {
        environment: Arc::clone(&environment),
        registry,
        next_correlation: AtomicU64::new(1),
    };

    // Push pipeline: reader threads enqueue into these channels; the
    // process-lifetime workers forward proposals to the actor and answer
    // session queries through the webview round trip.
    let (proposal_tx, proposal_rx) = mpsc::channel();
    let (query_tx, query_rx) = mpsc::channel();
    spawn_push_workers(&environment, &query_registry, proposal_rx, query_rx);
    let push_sink: Arc<dyn bbcom_plugin_manager::HostPushSink> = Arc::new(NativeHostPushSink {
        proposals: proposal_tx,
        queries: query_tx,
    });

    ProductionPluginRuntimeBuilder::new()
        .installer(Arc::clone(&installer))
        .trusted_repository(ConfiguredRepositoryProvider(Arc::clone(&sources)))
        .catalog(ConfiguredCatalogView {
            installer: Arc::clone(&installer),
            sources,
        })
        .workspace(workspace)
        .state_persistence(state)
        .serial_scheduler(serial_scheduler)
        .host_upstream(host_upstream)
        .push_sink(push_sink)
        .proposal_broker(SerialProposalBroker::new(audit_for_brokers))
        .panel_broker(DeclarativePanelBroker::new(audit_for_brokers))
        .sandbox(PlatformSandboxDriver::system())
        .sidecar_executable(roots.sidecar_executable)
        .private_artifact_root(private_artifact_root)
        .workspace_bindings(workspace_bindings)
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

    fn session_label(&mut self, session_id: &str) -> Result<String, CatalogViewFailure> {
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(CatalogViewFailure::MissingSessionDisplay);
        }
        // Session display metadata remains renderer-owned. The opaque session
        // identity is safe to show and keeps the confirmation usable without
        // leaking a port path or native handle.
        Ok(session_id.to_owned())
    }
}

/// Main-window plugin host upstream. Panel events are delivered to the main webview only.
struct WebviewHostUpstream<E: HostUpstreamEnvironment> {
    environment: Arc<E>,
}

impl<E: HostUpstreamEnvironment> PluginHostUpstreamPort for WebviewHostUpstream<E> {
    fn current_proposal_context(
        &mut self,
        proposal: &bbcom_plugin_broker::SerialProposalView,
    ) -> Result<bbcom_plugin_broker::ProposalContext, PluginUpstreamFailure> {
        // An active native workspace is required here. The renderer performs
        // the second, authoritative check by resolving the session runtime;
        // missing/disposed sessions return a failed serial result.
        self.environment
            .active_workspace()
            .ok_or(PluginUpstreamFailure::ProposalContextUnavailable)?;
        Ok(bbcom_plugin_broker::ProposalContext {
            operation_id: proposal.operation_id.clone(),
            session_id: proposal.session_id.clone(),
        })
    }

    fn deliver_panel_event(
        &mut self,
        action: bbcom_plugin_broker::PanelEventAction,
    ) -> Result<(), PluginUpstreamFailure> {
        let payload = serde_json::json!({
            "plugin_id": action.plugin_id,
            "field_id": action.event.field_id,
            "value": action.event.value,
        });
        self.environment
            .emit_to_main(PANEL_EVENT_NAME, &payload)
            .map_err(|_| PluginUpstreamFailure::PanelDeliveryUnavailable)
    }
}

/// Registry of serial actions awaiting a real main-window send result.
#[derive(Clone, Default)]
pub struct SerialActionResultRegistry {
    pending: Arc<Mutex<HashMap<String, PendingSerialAction>>>,
}

struct PendingSerialAction {
    runtime: RuntimeInstanceKey,
    sender: mpsc::Sender<PluginSerialActionResultRequest>,
}

impl SerialActionResultRegistry {
    fn register(
        &self,
        correlation_id: &str,
        runtime: RuntimeInstanceKey,
    ) -> Option<mpsc::Receiver<PluginSerialActionResultRequest>> {
        let mut pending = self.lock_pending();
        if pending.len() >= MAX_PENDING_SERIAL_ACTIONS {
            return None;
        }
        let (sender, receiver) = mpsc::channel();
        pending.insert(
            correlation_id.to_owned(),
            PendingSerialAction { runtime, sender },
        );
        Some(receiver)
    }

    /// Fulfills only an exact correlation/runtime pair. Stale generations and
    /// spoofed instance identities cannot release the scheduler wait. A late
    /// completion (the waiter already timed out) is reported so duplicate
    /// device writes from plugin retries stay diagnosable.
    pub fn complete(&self, result: PluginSerialActionResultRequest) -> bool {
        let mut pending = self.lock_pending();
        let Some(expected) = pending.get(&result.correlation_id) else {
            tracing::warn!(
                "late plugin serial action completion for {} (already timed out)",
                result.correlation_id
            );
            return false;
        };
        if expected.runtime != result.runtime {
            return false;
        }
        pending
            .remove(&result.correlation_id)
            .map(|pending| pending.sender.send(result).is_ok())
            .unwrap_or(false)
    }

    fn discard(&self, correlation_id: &str) {
        self.lock_pending().remove(correlation_id);
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingSerialAction>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Serial scheduler that submits an approved `BrokerAction` to the main
/// webview and blocks (on a command-execution thread) until that window
/// acknowledges it or the acknowledgement times out. Until a frontend listener
/// exists every action times out, which is the intended fail-closed behavior;
/// nothing reaches `execute` before a plugin is installed and authorized.
struct WebviewSerialScheduler<E: HostUpstreamEnvironment> {
    environment: Arc<E>,
    registry: SerialActionResultRegistry,
    next_correlation: AtomicU64,
}

impl<E: HostUpstreamEnvironment> PluginSerialSchedulerPort for WebviewSerialScheduler<E> {
    fn execute(
        &mut self,
        runtime: RuntimeInstanceKey,
        action: BrokerAction,
    ) -> Result<(), PluginUpstreamFailure> {
        let BrokerAction::SerialSend {
            proposal_id,
            plugin_id,
            operation_id,
            session_id,
            payload,
        } = action;
        let correlation_id = format!(
            "plugin-serial-{}-{}",
            std::process::id(),
            self.next_correlation.fetch_add(1, Ordering::Relaxed)
        );
        if runtime.plugin_id != plugin_id {
            return Err(PluginUpstreamFailure::SerialExecutionUnavailable);
        }
        let requested_bytes = payload.len();
        let event = PluginSerialAction {
            correlation_id: correlation_id.clone(),
            proposal_id,
            operation_id,
            session_id,
            runtime: runtime.clone(),
            bytes: payload,
        };
        let result = self
            .registry
            .register(&correlation_id, runtime)
            .ok_or(PluginUpstreamFailure::SerialExecutionUnavailable)?;
        let event = serde_json::to_value(event)
            .map_err(|_| PluginUpstreamFailure::SerialExecutionUnavailable)?;
        if self
            .environment
            .emit_to_main(SERIAL_ACTION_EVENT_NAME, &event)
            .is_err()
        {
            self.registry.discard(&correlation_id);
            return Err(PluginUpstreamFailure::SerialExecutionUnavailable);
        }
        match result.recv_timeout(SERIAL_ACTION_RESULT_TIMEOUT) {
            Ok(result)
                if result.requested_bytes == requested_bytes
                    && result.sent_bytes == requested_bytes
                    && result.outcome == SerialSendOutcome::Complete =>
            {
                Ok(())
            }
            Ok(_) => Err(PluginUpstreamFailure::SerialExecutionUnavailable),
            Err(_) => {
                // Timeout or a dropped sender: the pending entry is removed so
                // the bounded map cannot leak.
                self.registry.discard(&correlation_id);
                Err(PluginUpstreamFailure::SerialExecutionUnavailable)
            }
        }
    }
}

/// Append-only JSON-lines audit sink below the application data root. Audit is
/// best-effort here: a write failure is reported on stderr and the event is
/// dropped rather than failing or delaying a broker decision.
#[derive(Clone)]
struct FileAuditSink {
    inner: Arc<FileAuditSinkInner>,
}

struct FileAuditSinkInner {
    path: PathBuf,
    file: Mutex<Option<File>>,
}

impl FileAuditSink {
    fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        Self {
            inner: Arc::new(FileAuditSinkInner {
                path,
                file: Mutex::new(None),
            }),
        }
    }

    fn append(&self, line: &str) -> std::io::Result<()> {
        let mut slot = self
            .inner
            .file
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let file = match slot.as_mut() {
            Some(file) => file,
            None => slot.insert(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.inner.path)?,
            ),
        };
        file.write_all(line.as_bytes())?;
        file.flush()?;
        if file.metadata()?.len() > MAX_AUDIT_LOG_BYTES {
            // Truncate in place and reopen for append; the current line is
            // re-written so no acknowledged event is silently lost.
            file.set_len(0)?;
            file.write_all(line.as_bytes())?;
            file.flush()?;
        }
        Ok(())
    }
}

impl AuditSink for FileAuditSink {
    fn record(&self, event: AuditEvent) {
        if let Err(error) = self.append(&audit_line(&event)) {
            eprintln!("plugin audit append failed: {error}");
        }
    }
}

fn audit_line(event: &AuditEvent) -> String {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let plugin_id = serde_json::to_string(&event.plugin_id).unwrap_or_else(|_| "\"\"".into());
    let error_code = match &event.error_code {
        None => "null".to_owned(),
        Some(code) => serde_json::to_string(code.as_str()).unwrap_or_else(|_| "null".into()),
    };
    let operation = match event.operation {
        AuditOperation::PanelPublish => "panel_publish",
        AuditOperation::PanelEvent => "panel_event",
        AuditOperation::SerialProposalCreate => "serial_proposal_create",
        AuditOperation::SerialProposalResolve => "serial_proposal_resolve",
        AuditOperation::InvocationValidate => "invocation_validate",
    };
    format!(
        "{{\"ts_ms\":{timestamp_ms},\"plugin_id\":{plugin_id},\"operation\":\"{operation}\",\"error_code\":{error_code},\"byte_count\":{}}}\n",
        event.byte_count
    )
}

/// Managed wrapper giving the process-lifetime plugin lifecycle a `'static`
/// Tauri state type.
/// Managed, replaceable lifecycle holder. Native setup installs an empty
/// handle once; every successful (re)composition swaps the inner runtime.
/// Replacing the interior instead of re-managing avoids unsafe `unmanage`
/// dangling-reference risk.
pub struct PluginLifecycleHandle(Mutex<Option<Arc<dyn PluginRuntimeLifecycle>>>);

/// Private G46 override installed before composition. Normal application
/// setup never manages this type and therefore always uses the OS data root.
pub(crate) struct PluginRuntimeDataRoot(pub(crate) PathBuf);

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

    pub(super) fn current(&self) -> Option<Arc<dyn PluginRuntimeLifecycle>> {
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
    if component_hex != manifest.component.sha256 {
        return None;
    }
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
    app.manage(SerialActionResultRegistry::default());
    app.manage(SessionQueryResultRegistry::default());
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
