use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use bbcom_plugin_broker::{
    GatewayContext, GatewayDispatch, GatewayFailure, GatewaySession, PluginCapabilityGateway,
    RuntimeBootstrapState, TaskTerminal,
};
use bbcom_plugin_contracts::generated_v2::{
    self as wire, Envelope, Handshake, HostContext, HostHello, InitializeRequest, PluginIdentity,
    Request, ShutdownRequest, envelope, handshake, request, response,
};
use bbcom_plugin_contracts::v2::{
    LONG_TASK_TIMEOUT_MS, MAX_PENDING_HOST_REQUESTS, MAX_PROTOCOL_MINOR, MIN_PROTOCOL_MINOR,
    PROTOCOL_MAJOR, WIT_PACKAGE, default_resource_limits,
};
use bbcom_plugin_contracts::{
    HANDSHAKE_TIMEOUT_MS, MAX_PLUGIN_PERSISTED_STATE_BYTES,
    MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES,
};
use bbcom_plugin_host::PluginPackage;
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};
use bbcom_plugin_manager::{
    ArtifactSlot, CrashKind, HostFailure, HostHandle, HostLaunchMode, HostLaunchRequest,
    HostLauncher, HostReport,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
// Initialization performs the guest's complete surface/command declaration
// and may issue several host capability calls before returning its model.
// Reusing the short interactive-request timeout killed healthy plugins during
// cold Wasm startup on development and lower-power machines.
const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(15);
const PROCESS_EXIT_POLL: Duration = Duration::from_millis(10);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginStatePersistenceKey {
    pub plugin_id: String,
    pub workspace_id: String,
    pub artifact_slot: ArtifactSlot,
    pub launch_mode: HostLaunchMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginPersistedState {
    pub plugin_storage: Vec<u8>,
    pub project_state: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginInitializationContextV2 {
    pub locale: String,
    pub theme: wire::ColorScheme,
    pub sessions: Vec<wire::SessionSummary>,
}

pub trait PluginHostContextProviderV2: Send + Sync + 'static {
    fn context_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<PluginInitializationContextV2, HostFailure>;
}

/// Authoritative, path-free portable state read used immediately before each
/// host launch. The lifecycle manager intentionally keeps only a projection;
/// production implementations must read the currently active workspace so a
/// same-process crash restart cannot replay an older project-state snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginProjectStateSnapshotV2 {
    pub value: Vec<u8>,
    pub api_generation: u32,
    pub schema_version: Option<u32>,
}

pub trait PluginProjectStateProviderV2: Send + Sync + 'static {
    fn current_project_state(
        &self,
        workspace_id: &str,
        plugin_id: &str,
    ) -> Result<Option<PluginProjectStateSnapshotV2>, HostFailure>;
}

/// Application services injected into one sidecar launcher.
pub struct PluginHostServicesV2 {
    gateway: Arc<dyn PluginCapabilityGateway>,
    host_context: Arc<dyn PluginHostContextProviderV2>,
    project_state: Arc<dyn PluginProjectStateProviderV2>,
}

impl PluginHostServicesV2 {
    #[must_use]
    pub fn new(
        gateway: Arc<dyn PluginCapabilityGateway>,
        host_context: Arc<dyn PluginHostContextProviderV2>,
        project_state: Arc<dyn PluginProjectStateProviderV2>,
    ) -> Self {
        Self {
            gateway,
            host_context,
            project_state,
        }
    }
}

impl PluginPersistedState {
    fn validate(&self) -> Result<(), HostFailure> {
        if self
            .plugin_storage
            .len()
            .saturating_add(self.project_state.as_ref().map_or(0, Vec::len))
            > MAX_PLUGIN_PERSISTED_STATE_BYTES
        {
            Err(HostFailure::Initialization)
        } else {
            Ok(())
        }
    }
}

/// Native-only persistence authority for opaque plugin bytes.
///
/// Implementations atomically replace one private persistence record and
/// reject an update when it would exceed 16 MiB for one plugin or 64 MiB across
/// one workspace. Portable project state is committed separately by the
/// capability gateway and uses an explicit compensating sequence; this port
/// does not claim cross-store atomicity. Keys are repository/workspace
/// identities; neither input nor output may be a filesystem path. Update
/// preflight deliberately loads the active record and has no durable prepared
/// private-state slot; candidate writes remain inside that runtime.
pub trait PluginStatePersistencePort: Send + 'static {
    fn load_plugin_storage(
        &mut self,
        key: &PluginStatePersistenceKey,
    ) -> Result<Option<Vec<u8>>, HostFailure>;

    fn workspace_total_bytes(&mut self, workspace_id: &str) -> Result<usize, HostFailure>;

    fn persist_state(
        &mut self,
        key: &PluginStatePersistenceKey,
        state: &PluginPersistedState,
    ) -> Result<(), HostFailure>;
}

fn private_state_load_key(
    request: &HostLaunchRequest,
) -> Result<PluginStatePersistenceKey, HostFailure> {
    // Update preflight must inspect the exact currently-active private bytes,
    // but it may never create or mutate a durable prepared slot. All guest
    // writes remain inside the preflight runtime and the active artifact
    // repeats migration after package activation.
    let (artifact_slot, launch_mode) = match (&request.artifact_slot, request.mode) {
        (ArtifactSlot::Active, HostLaunchMode::Active)
        | (ArtifactSlot::Prepared(_), HostLaunchMode::UpdatePreflight) => {
            (ArtifactSlot::Active, HostLaunchMode::Active)
        }
        _ => return Err(HostFailure::Initialization),
    };
    Ok(PluginStatePersistenceKey {
        plugin_id: request.artifact.plugin_id.clone(),
        workspace_id: request.workspace_id.clone(),
        artifact_slot,
        launch_mode,
    })
}

/// Plain (unsandboxed) sidecar child process.
pub struct PluginChild {
    child: Child,
}

impl PluginChild {
    fn spawn(
        sidecar_executable: &Path,
        package_root: &Path,
        arguments: &[OsString],
    ) -> std::io::Result<Self> {
        let child = Command::new(sidecar_executable)
            .current_dir(package_root)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Sidecar diagnostics are part of the application log. Discarding
            // stderr made guest traps and protocol startup failures look like
            // an undifferentiated `HostFailure::Initialization`.
            .stderr(Stdio::inherit())
            .spawn()?;
        Ok(Self { child })
    }

    pub(crate) fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.child
            .stdin
            .take()
            .map(|stdin| Box::new(stdin) as Box<dyn Write + Send>)
    }

    pub(crate) fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .stdout
            .take()
            .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
    }

    pub(crate) fn try_wait(&mut self) -> std::io::Result<bool> {
        self.child.try_wait().map(|status| status.is_some())
    }

    pub(crate) fn terminate_and_wait(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedPluginArtifact {
    package_root: PathBuf,
}

impl ResolvedPluginArtifact {
    #[must_use]
    pub fn new(package_root: PathBuf) -> Self {
        Self { package_root }
    }

    #[must_use]
    pub fn package_root(&self) -> &Path {
        &self.package_root
    }
}

/// Resolves only repository-owned active or staging tokens to native paths.
pub trait ArtifactPathResolver: Send + Sync + 'static {
    fn resolve(
        &self,
        plugin_id: &str,
        version: &str,
        slot: &ArtifactSlot,
    ) -> Result<ResolvedPluginArtifact, HostFailure>;
}

#[derive(Clone, Debug)]
pub struct PrivateArtifactRoot;

impl PrivateArtifactRoot {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, HostLauncherBuildError> {
        if !root.as_ref().is_dir() {
            return Err(HostLauncherBuildError::PrivateRoot);
        }
        Ok(Self)
    }

    fn resolve_package(&self, package_root: &Path) -> Result<PathBuf, HostFailure> {
        fs::canonicalize(package_root).map_err(|_| HostFailure::Launch)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostLauncherBuildError {
    SidecarExecutable,
    PrivateRoot,
}

impl fmt::Display for HostLauncherBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SidecarExecutable => formatter.write_str("plugin sidecar is not a regular file"),
            Self::PrivateRoot => formatter.write_str("plugin private root is unsafe"),
        }
    }
}

impl std::error::Error for HostLauncherBuildError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostMonitorError;

impl fmt::Display for HostMonitorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("plugin host monitor state is unavailable")
    }
}

impl std::error::Error for HostMonitorError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostCrashEvent {
    pub plugin_id: String,
    pub instance_id: u64,
    pub report: HostReport,
    pub crashes_observed: u64,
}

struct HostProcess {
    plugin_id: String,
    version: String,
    child: PluginChild,
    stdin: SharedHostStdin,
    responses: HostResponseRouter,
    gateway: Arc<GatewaySession<dyn PluginCapabilityGateway>>,
    tasks: Arc<Mutex<BTreeMap<String, u64>>>,
}

type SharedHostStdin = Arc<Mutex<Box<dyn Write + Send>>>;

type HostResponseSender = mpsc::SyncSender<Result<Envelope, HostFailure>>;

#[derive(Clone, Default)]
struct HostResponseRouter {
    pending: Arc<Mutex<BTreeMap<u64, HostResponseSender>>>,
    failed: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
struct CapabilityWorkerRegistry(Arc<AtomicUsize>);

impl CapabilityWorkerRegistry {
    fn try_acquire(&self) -> Option<CapabilityWorkerPermit> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_PENDING_HOST_REQUESTS as usize).then_some(active + 1)
            })
            .ok()
            .map(|_| CapabilityWorkerPermit(Arc::clone(&self.0)))
    }
}

struct CapabilityWorkerPermit(Arc<AtomicUsize>);

impl Drop for CapabilityWorkerPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl HostResponseRouter {
    fn register(
        &self,
        message_id: u64,
    ) -> Result<Receiver<Result<Envelope, HostFailure>>, HostFailure> {
        if message_id == 0 || self.failed.load(Ordering::Acquire) {
            return Err(HostFailure::Transport);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut pending = self.pending.lock().map_err(|_| HostFailure::Transport)?;
        if pending.len() >= 32 || pending.insert(message_id, sender).is_some() {
            return Err(HostFailure::Transport);
        }
        Ok(receiver)
    }

    fn complete(&self, envelope: Envelope) -> bool {
        let Some(reply_to) = envelope.reply_to else {
            return false;
        };
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&reply_to));
        if let Some(sender) = sender {
            let _ = sender.send(Ok(envelope));
            true
        } else {
            false
        }
    }

    fn discard(&self, message_id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&message_id);
        }
    }

    fn fail_all(&self) {
        self.failed.store(true, Ordering::Release);
        let pending = self
            .pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for sender in pending.into_values() {
            let _ = sender.send(Err(HostFailure::Transport));
        }
    }
}

#[derive(Default)]
struct HostProcesses {
    running: BTreeMap<u64, HostProcess>,
    crash_counts: BTreeMap<String, u64>,
}

#[derive(Clone)]
pub struct HostExitMonitor {
    processes: Arc<Mutex<HostProcesses>>,
}

impl HostExitMonitor {
    /// Polls native children once. The application runtime owns scheduling and
    /// feeds returned reports into `PluginManager::report_host_exit`.
    pub fn poll(&self) -> Result<Vec<HostCrashEvent>, HostMonitorError> {
        let mut processes = self.processes.lock().map_err(|_| HostMonitorError)?;
        let exited: Vec<_> = processes
            .running
            .iter_mut()
            .filter_map(|(instance_id, process)| match process.child.try_wait() {
                Ok(true) => Some((*instance_id, false)),
                Err(_) => Some((*instance_id, true)),
                Ok(false) => None,
            })
            .collect();
        let mut events = Vec::with_capacity(exited.len());
        for (instance_id, requires_termination) in exited {
            let Some(mut process) = processes.running.remove(&instance_id) else {
                continue;
            };
            process.gateway.revoke();
            if requires_termination {
                terminate_child(&mut process.child);
            }
            let count = processes
                .crash_counts
                .entry(process.plugin_id.clone())
                .or_default();
            *count = count.saturating_add(1);
            events.push(HostCrashEvent {
                plugin_id: process.plugin_id,
                instance_id,
                report: HostReport::Crashed(CrashKind::ProcessCrash),
                crashes_observed: *count,
            });
        }
        Ok(events)
    }

    #[must_use]
    pub fn crash_count(&self, plugin_id: &str) -> u64 {
        self.processes
            .lock()
            .ok()
            .and_then(|processes| processes.crash_counts.get(plugin_id).copied())
            .unwrap_or(0)
    }
}

pub struct SidecarHostLauncher<R, P> {
    sidecar_executable: PathBuf,
    private_root: PrivateArtifactRoot,
    resolver: R,
    persistence: P,
    processes: Arc<Mutex<HostProcesses>>,
    next_instance_id: AtomicU64,
    gateway: Arc<dyn PluginCapabilityGateway>,
    host_context: Arc<dyn PluginHostContextProviderV2>,
    project_state: Arc<dyn PluginProjectStateProviderV2>,
}

struct RejectCapabilityGateway;
impl PluginCapabilityGateway for RejectCapabilityGateway {
    fn invoke(
        &self,
        _context: &GatewayContext,
        _message_id: u64,
        _operation: request::Operation,
    ) -> std::result::Result<response::Result, GatewayFailure> {
        Err(GatewayFailure::permission_denied())
    }
    fn cancel(
        &self,
        _context: &GatewayContext,
        _target_message_id: u64,
    ) -> std::result::Result<(), GatewayFailure> {
        Ok(())
    }
    fn revoke_runtime(&self, _context: &GatewayContext) {}
}

struct RejectHostContext;

impl PluginHostContextProviderV2 for RejectHostContext {
    fn context_for_workspace(&self, _: &str) -> Result<PluginInitializationContextV2, HostFailure> {
        Err(HostFailure::Initialization)
    }
}

struct RejectProjectState;

impl PluginProjectStateProviderV2 for RejectProjectState {
    fn current_project_state(
        &self,
        _: &str,
        _: &str,
    ) -> Result<Option<PluginProjectStateSnapshotV2>, HostFailure> {
        Err(HostFailure::Initialization)
    }
}

impl<R, P> Drop for SidecarHostLauncher<R, P> {
    fn drop(&mut self) {
        let Ok(mut processes) = self.processes.lock() else {
            return;
        };
        let running = std::mem::take(&mut processes.running);
        for (_, mut process) in running {
            process.gateway.revoke();
            terminate_child(&mut process.child);
        }
    }
}

impl<R, P> SidecarHostLauncher<R, P>
where
    R: ArtifactPathResolver,
    P: PluginStatePersistencePort,
{
    pub fn new(
        sidecar_executable: impl AsRef<Path>,
        private_root: PrivateArtifactRoot,
        resolver: R,
        persistence: P,
    ) -> Result<(Self, HostExitMonitor), HostLauncherBuildError> {
        Self::new_with_v2_services(
            sidecar_executable,
            private_root,
            resolver,
            persistence,
            PluginHostServicesV2::new(
                Arc::new(RejectCapabilityGateway),
                Arc::new(RejectHostContext),
                Arc::new(RejectProjectState),
            ),
        )
    }

    /// Production v2 constructor with application services injected.
    pub fn new_with_v2_services(
        sidecar_executable: impl AsRef<Path>,
        private_root: PrivateArtifactRoot,
        resolver: R,
        persistence: P,
        services: PluginHostServicesV2,
    ) -> Result<(Self, HostExitMonitor), HostLauncherBuildError> {
        let sidecar_executable = sidecar_executable.as_ref();
        if !sidecar_executable.is_file() {
            return Err(HostLauncherBuildError::SidecarExecutable);
        }
        let processes = Arc::new(Mutex::new(HostProcesses::default()));
        let monitor = HostExitMonitor {
            processes: Arc::clone(&processes),
        };
        Ok((
            Self {
                sidecar_executable: sidecar_executable.to_path_buf(),
                private_root,
                resolver,
                persistence,
                processes,
                next_instance_id: AtomicU64::new(1),
                gateway: services.gateway,
                host_context: services.host_context,
                project_state: services.project_state,
            },
            monitor,
        ))
    }

    fn lock_processes(&self) -> Result<MutexGuard<'_, HostProcesses>, HostFailure> {
        self.processes.lock().map_err(|_| HostFailure::Launch)
    }

    fn process_request(
        process: &mut HostProcess,
        operation: request::Operation,
        timeout: Duration,
    ) -> Result<Envelope, HostFailure> {
        let operation_name = operation_name(&operation);
        let request_id = process
            .gateway
            .next_outbound_message_id()
            .map_err(|error| {
                tracing::warn!(
                    ?error,
                    plugin_id = %process.plugin_id,
                    operation = %operation_name,
                    "plugin host request id allocation failed"
                );
                HostFailure::Transport
            })?;
        let response = process
            .responses
            .register(request_id)
            .inspect_err(|error| {
                tracing::warn!(
                    ?error,
                    plugin_id = %process.plugin_id,
                    instance_id = %process.gateway.context().instance_id,
                    request_id,
                    operation = %operation_name,
                    "plugin host response registration failed"
                );
            })?;
        let envelope = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: request_id,
            reply_to: None,
            payload: Some(envelope::Payload::Request(Request {
                operation: Some(operation),
            })),
        };
        if let Err(error) = write_host_envelope(&process.stdin, &envelope) {
            tracing::warn!(
                ?error,
                plugin_id = %process.plugin_id,
                instance_id = %process.gateway.context().instance_id,
                request_id,
                operation = %operation_name,
                "plugin host request write failed"
            );
            process.responses.discard(request_id);
            return Err(error);
        }
        let response = receive_response(&response, timeout).inspect_err(|error| {
            tracing::warn!(
                ?error,
                plugin_id = %process.plugin_id,
                instance_id = %process.gateway.context().instance_id,
                request_id,
                operation = %operation_name,
                timeout_ms = timeout.as_millis(),
                "plugin host response wait failed"
            );
        })?;
        if response.reply_to != Some(request_id) {
            tracing::warn!(
                plugin_id = %process.plugin_id,
                instance_id = %process.gateway.context().instance_id,
                request_id,
                reply_to = ?response.reply_to,
                operation = %operation_name,
                "plugin host response correlation was invalid"
            );
            return Err(HostFailure::Transport);
        }
        Ok(response)
    }

    fn start_command(
        process: &mut HostProcess,
        request: wire::RunCommandRequest,
    ) -> Result<(), HostFailure> {
        let invocation = request.invocation.as_ref().ok_or(HostFailure::Transport)?;
        if invocation.invocation_id.is_empty() || invocation.invocation_id.len() > 128 {
            return Err(HostFailure::Transport);
        }
        let task_id = invocation.invocation_id.clone();
        let request_id = process
            .gateway
            .next_outbound_message_id()
            .map_err(|_| HostFailure::Transport)?;
        let response = process.responses.register(request_id)?;
        {
            let mut tasks = process.tasks.lock().map_err(|_| HostFailure::Transport)?;
            if !tasks.is_empty() || tasks.insert(task_id.clone(), request_id).is_some() {
                process.responses.discard(request_id);
                return Err(HostFailure::Transport);
            }
        }
        let envelope = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: request_id,
            reply_to: None,
            payload: Some(envelope::Payload::Request(Request {
                operation: Some(request::Operation::RunCommand(request)),
            })),
        };
        if let Err(error) = write_host_envelope(&process.stdin, &envelope) {
            process.responses.discard(request_id);
            process
                .tasks
                .lock()
                .map_err(|_| HostFailure::Transport)?
                .remove(&task_id);
            return Err(error);
        }
        let tasks = Arc::clone(&process.tasks);
        let gateway = Arc::clone(&process.gateway);
        let responses = process.responses.clone();
        let stdin = Arc::clone(&process.stdin);
        let completion_task_id = task_id.clone();
        let completion_gateway = Arc::clone(&gateway);
        let spawned = thread::Builder::new()
            .name(format!("plugin-task-{task_id}"))
            .spawn(move || {
                let (terminal, timed_out) =
                    match response.recv_timeout(Duration::from_millis(LONG_TASK_TIMEOUT_MS)) {
                        Ok(Ok(envelope)) => match envelope.payload {
                            Some(envelope::Payload::Response(wire::Response {
                                result: Some(response::Result::RunCommand(_)),
                            })) => (TaskTerminal::Completed, false),
                            Some(envelope::Payload::Error(error))
                                if error.code == wire::ErrorCode::Cancelled as i32 =>
                            {
                                (TaskTerminal::Cancelled, false)
                            }
                            Some(envelope::Payload::Error(error))
                                if error.code == wire::ErrorCode::UnknownOutcome as i32 =>
                            {
                                (TaskTerminal::UnknownOutcome, false)
                            }
                            Some(envelope::Payload::Error(error)) => (
                                TaskTerminal::Failed(
                                    wire::ErrorCode::try_from(error.code)
                                        .unwrap_or(wire::ErrorCode::ProtocolError),
                                ),
                                false,
                            ),
                            _ => (TaskTerminal::Failed(wire::ErrorCode::ProtocolError), false),
                        },
                        Ok(Err(_)) => (TaskTerminal::Failed(wire::ErrorCode::IoError), false),
                        Err(RecvTimeoutError::Timeout) => (TaskTerminal::UnknownOutcome, true),
                        Err(RecvTimeoutError::Disconnected) => {
                            (TaskTerminal::Failed(wire::ErrorCode::IoError), false)
                        }
                    };
                responses.discard(request_id);
                if timed_out
                    && let Ok(cancel) = gateway.cancel_envelope(request_id, "task-timeout")
                    && responses.register(cancel.message_id).is_ok()
                    && write_host_envelope(&stdin, &cancel).is_err()
                {
                    responses.discard(cancel.message_id);
                }
                if let Ok(mut tasks) = tasks.lock()
                    && tasks.get(&completion_task_id) == Some(&request_id)
                {
                    tasks.remove(&completion_task_id);
                }
                completion_gateway.complete_task(&completion_task_id, terminal);
            });
        if spawned.is_err() {
            process.responses.discard(request_id);
            if let Ok(mut tasks) = process.tasks.lock() {
                tasks.remove(&task_id);
            }
            if let Ok(cancel) = process
                .gateway
                .cancel_envelope(request_id, "task-worker-failed")
            {
                let _acknowledgement = process.responses.register(cancel.message_id);
                if write_host_envelope(&process.stdin, &cancel).is_err() {
                    process.responses.discard(cancel.message_id);
                }
            }
            process
                .gateway
                .complete_task(&task_id, TaskTerminal::UnknownOutcome);
            return Err(HostFailure::Launch);
        }
        Ok(())
    }

    fn cancel_active_task(process: &mut HostProcess, task_id: &str) -> Result<bool, HostFailure> {
        let target_message_id = process
            .tasks
            .lock()
            .map_err(|_| HostFailure::Transport)?
            .get(task_id)
            .copied();
        let Some(target_message_id) = target_message_id else {
            return Ok(false);
        };
        let envelope = process
            .gateway
            .cancel_envelope(target_message_id, "user-task-cancelled")
            .map_err(|_| HostFailure::Transport)?;
        let _acknowledgement = process.responses.register(envelope.message_id)?;
        if let Err(error) = write_host_envelope(&process.stdin, &envelope) {
            process.responses.discard(envelope.message_id);
            return Err(error);
        }
        Ok(true)
    }
}

fn dispatch_sidecar_gateway_envelope(
    gateway: &Arc<GatewaySession<dyn PluginCapabilityGateway>>,
    stdin: &SharedHostStdin,
    responses: &HostResponseRouter,
    workers: &CapabilityWorkerRegistry,
    envelope: Envelope,
) -> Result<(), HostFailure> {
    let debug_operation = match &envelope.payload {
        Some(envelope::Payload::Request(Request {
            operation: Some(operation),
        })) => operation_name(operation),
        other => format!("{other:?}").chars().take(160).collect::<String>(),
    };
    match gateway
        .begin(envelope)
        .inspect_err(|error| {
            tracing::warn!(
                ?error,
                plugin_id = %gateway.context().plugin_id,
                instance_id = %gateway.context().instance_id,
                operation = %debug_operation,
                "plugin capability request was rejected before execution"
            );
        })
        .map_err(|_| HostFailure::Transport)?
    {
        GatewayDispatch::Immediate(Some(reply)) => write_host_envelope(stdin, &reply),
        GatewayDispatch::Immediate(None) => Ok(()),
        GatewayDispatch::Request(request) => {
            let Some(permit) = workers.try_acquire() else {
                if let Some(reply) = gateway
                    .abort(
                        request,
                        GatewayFailure::new(
                            wire::ErrorCode::LimitExceeded,
                            "plugin.error.limitExceeded",
                        ),
                    )
                    .map_err(|_| HostFailure::Transport)?
                {
                    write_host_envelope(stdin, &reply)?;
                }
                return Ok(());
            };
            let worker_gateway = Arc::clone(gateway);
            let worker_stdin = Arc::clone(stdin);
            let worker_router = responses.clone();
            let worker_operation = debug_operation.clone();
            let worker_plugin_id = gateway.context().plugin_id.clone();
            let fallback = request.clone();
            let spawn_failed = thread::Builder::new()
                .name("plugin-capability-v2".to_owned())
                .spawn(move || {
                    let _permit = permit;
                    let started = Instant::now();
                    tracing::debug!(
                        plugin_id = %worker_plugin_id,
                        operation = %worker_operation,
                        "plugin capability request started"
                    );
                    match worker_gateway.finish(request) {
                        Ok(Some(reply)) => {
                            tracing::debug!(
                                plugin_id = %worker_plugin_id,
                                operation = %worker_operation,
                                elapsed_ms = started.elapsed().as_millis(),
                                "plugin capability request completed"
                            );
                            if write_host_envelope(&worker_stdin, &reply).is_err() {
                                worker_router.fail_all();
                            }
                        }
                        Ok(None) => {
                            tracing::debug!(
                                plugin_id = %worker_plugin_id,
                                operation = %worker_operation,
                                elapsed_ms = started.elapsed().as_millis(),
                                "plugin capability request completed without a reply"
                            );
                        }
                        Err(error) => {
                            tracing::warn!(
                                ?error,
                                plugin_id = %worker_plugin_id,
                                operation = %worker_operation,
                                elapsed_ms = started.elapsed().as_millis(),
                                "plugin capability request failed"
                            );
                            worker_router.fail_all();
                        }
                    }
                })
                .is_err();
            if spawn_failed
                && let Some(reply) = gateway
                    .abort(
                        fallback,
                        GatewayFailure::new(
                            wire::ErrorCode::Unavailable,
                            "plugin.error.unavailable",
                        ),
                    )
                    .map_err(|_| HostFailure::Transport)?
            {
                write_host_envelope(stdin, &reply)?;
            }
            Ok(())
        }
    }
}

fn operation_name(operation: &request::Operation) -> String {
    format!("{operation:?}")
        .split(['(', '{'])
        .next()
        .unwrap_or("Unknown")
        .chars()
        .take(64)
        .collect()
}

impl<R, P> HostLauncher for SidecarHostLauncher<R, P>
where
    R: ArtifactPathResolver,
    P: PluginStatePersistencePort,
{
    fn launch(&mut self, request: &HostLaunchRequest) -> Result<HostHandle, HostFailure> {
        let project_state = self
            .project_state
            .current_project_state(&request.workspace_id, &request.artifact.plugin_id)?;
        let (project_state, project_state_schema_version) = match project_state {
            Some(state) if state.api_generation == 2 => (Some(state.value), state.schema_version),
            Some(_) => return Err(HostFailure::Initialization),
            None => (None, None),
        };
        let state_key = private_state_load_key(request)?;
        let plugin_storage = self
            .persistence
            .load_plugin_storage(&state_key)
            .inspect_err(|error| {
                tracing::warn!(?error, plugin_id = %request.artifact.plugin_id, "plugin storage load failed before host launch");
            })?
            .unwrap_or_default();
        let initial_state = PluginPersistedState {
            plugin_storage,
            project_state,
        };
        initial_state.validate()?;
        let valid_project_state = match (
            initial_state.project_state.is_some(),
            project_state_schema_version,
        ) {
            (false, None) => true,
            (true, Some(schema_version)) => schema_version != 0,
            _ => false,
        };
        if !valid_project_state {
            return Err(HostFailure::Initialization);
        }
        if self
            .persistence
            .workspace_total_bytes(&request.workspace_id)?
            > MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES
        {
            return Err(HostFailure::Initialization);
        }
        let resolved = self
            .resolver
            .resolve(
                &request.artifact.plugin_id,
                &request.artifact.version,
                &request.artifact_slot,
            )
            .inspect_err(|error| {
                tracing::warn!(?error, plugin_id = %request.artifact.plugin_id, "plugin artifact resolution failed before host launch");
            })?;
        let package_root = self
            .private_root
            .resolve_package(resolved.package_root())
            .inspect_err(|error| {
                tracing::warn!(?error, plugin_id = %request.artifact.plugin_id, package_root = %resolved.package_root().display(), "plugin package path could not be resolved before host launch");
            })?;
        let manifest_text = fs::read_to_string(package_root.join("plugin.toml"))
            .map_err(|_| HostFailure::Launch)?;
        let artifact =
            PluginPackage::load(&package_root, &manifest_text).map_err(|_| HostFailure::Launch)?;
        let granted = artifact
            .manifest
            .v2_capabilities()
            .map_err(|_| HostFailure::Initialization)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        let instance_id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);
        if instance_id == 0 {
            return Err(HostFailure::Launch);
        }
        let runtime_instance_id = instance_id.to_string();
        let gateway_context = GatewayContext {
            workspace_id: request.workspace_id.clone(),
            plugin_id: request.artifact.plugin_id.clone(),
            instance_id: runtime_instance_id.clone(),
            generation: instance_id,
            granted_capabilities: granted.clone(),
        };
        let storage_scope = match (&request.artifact_slot, request.mode) {
            (ArtifactSlot::Active, HostLaunchMode::Active) => "active".to_owned(),
            (ArtifactSlot::Prepared(token), HostLaunchMode::UpdatePreflight) => {
                format!("prepared:{}", token.as_str())
            }
            _ => return Err(HostFailure::Initialization),
        };
        self.gateway
            .register_runtime(
                &gateway_context,
                RuntimeBootstrapState {
                    plugin_storage: initial_state.plugin_storage.clone(),
                    project_state: initial_state.project_state.clone(),
                    project_state_schema_version,
                    storage_scope,
                },
            )
            .map_err(|_| HostFailure::Initialization)?;
        let gateway: Arc<GatewaySession<dyn PluginCapabilityGateway>> = Arc::new(
            GatewaySession::new(gateway_context, Arc::clone(&self.gateway)),
        );
        let mut arguments = vec![
            OsString::from("--package-root"),
            package_root.as_os_str().to_owned(),
            OsString::from("--workspace-id"),
            OsString::from(&request.workspace_id),
            OsString::from("--instance-id"),
            OsString::from(&runtime_instance_id),
            OsString::from("--generation"),
            OsString::from(instance_id.to_string()),
        ];
        for capability in &granted {
            arguments.push(OsString::from("--grant"));
            arguments.push(OsString::from(bbcom_plugin_contracts::v2_capability_name(
                *capability,
            )));
        }
        let mut child =
            PluginChild::spawn(&self.sidecar_executable, &package_root, &arguments).map_err(
                |error| {
                    tracing::warn!(%error, plugin_id = %request.artifact.plugin_id, "plugin host spawn failed");
                    HostFailure::Launch
                },
            )?;
        let Some(stdin) = child.take_stdin() else {
            terminate_child(&mut child);
            return Err(HostFailure::Launch);
        };
        let Some(stdout) = child.take_stdout() else {
            terminate_child(&mut child);
            return Err(HostFailure::Launch);
        };
        let stdin: SharedHostStdin = Arc::new(Mutex::new(stdin));
        let push_stdin = Arc::clone(&stdin);
        let responses = HostResponseRouter::default();
        let response_router = responses.clone();
        let gateway_reader = Arc::clone(&gateway);
        let capability_workers = CapabilityWorkerRegistry::default();
        let reader_plugin_id = request.artifact.plugin_id.clone();
        if thread::Builder::new()
            .name(format!("plugin-host-{}", request.artifact.plugin_id))
            .spawn(move || {
                let mut reader = FrameReader::new(stdout);
                loop {
                    let response = reader.read_envelope().map_err(|error| {
                        tracing::warn!(
                            %error,
                            plugin_id = %reader_plugin_id,
                            "plugin host output stream failed"
                        );
                        HostFailure::Transport
                    });
                    if let Ok(Some(envelope)) = &response
                        && matches!(
                            envelope.payload,
                            Some(
                                envelope::Payload::Request(_)
                                    | envelope::Payload::Cancel(_)
                                    | envelope::Payload::Stream(_)
                            )
                        )
                    {
                        if dispatch_sidecar_gateway_envelope(
                            &gateway_reader,
                            &push_stdin,
                            &response_router,
                            &capability_workers,
                            envelope.clone(),
                        )
                        .inspect_err(|error| {
                            tracing::warn!(
                                ?error,
                                plugin_id = %reader_plugin_id,
                                "plugin host gateway dispatch failed"
                            );
                        })
                        .is_err()
                        {
                            response_router.fail_all();
                            return;
                        }
                        continue;
                    }
                    match response {
                        Ok(Some(envelope)) => {
                            if response_router.complete(envelope) {
                                continue;
                            }
                            tracing::warn!(
                                plugin_id = %reader_plugin_id,
                                "plugin host returned an uncorrelated or unexpected envelope"
                            );
                            response_router.fail_all();
                            return;
                        }
                        Ok(None) => {
                            tracing::warn!(
                                plugin_id = %reader_plugin_id,
                                "plugin host output stream closed"
                            );
                            response_router.fail_all();
                            return;
                        }
                        Err(_) => {
                            response_router.fail_all();
                            return;
                        }
                    }
                }
            })
            .is_err()
        {
            terminate_child(&mut child);
            return Err(HostFailure::Launch);
        }
        let mut process = HostProcess {
            plugin_id: request.artifact.plugin_id.clone(),
            version: request.artifact.version.clone(),
            child,
            stdin,
            responses,
            gateway,
            tasks: Arc::new(Mutex::new(BTreeMap::new())),
        };
        let handshake_id = process
            .gateway
            .next_outbound_message_id()
            .map_err(|_| HostFailure::Handshake)?;
        let hello = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: handshake_id,
            reply_to: None,
            payload: Some(envelope::Payload::Handshake(Handshake {
                hello: Some(handshake::Hello::Host(HostHello {
                    protocol_major: PROTOCOL_MAJOR,
                    min_minor: MIN_PROTOCOL_MINOR,
                    max_minor: MAX_PROTOCOL_MINOR,
                    wit_package: WIT_PACKAGE.to_owned(),
                    plugin: Some(PluginIdentity {
                        plugin_id: request.artifact.plugin_id.clone(),
                        plugin_version: request.artifact.version.clone(),
                        component_sha256: request.artifact.component_sha256.clone(),
                    }),
                    granted_capabilities: granted.iter().map(|value| *value as i32).collect(),
                    limits: Some(default_resource_limits()),
                    workspace_id: request.workspace_id.clone(),
                    instance_id: runtime_instance_id,
                    generation: instance_id,
                })),
            })),
        };
        let handshake = process
            .responses
            .register(handshake_id)
            .and_then(|response| {
                write_host_envelope(&process.stdin, &hello).and_then(|()| {
                    receive_response(&response, Duration::from_millis(HANDSHAKE_TIMEOUT_MS))
                })
            });
        let handshake_valid = handshake.is_ok_and(|response| {
            matches!(
                response.payload,
                Some(envelope::Payload::Handshake(Handshake { hello: Some(handshake::Hello::Plugin(hello)) }))
                    if response.reply_to == Some(handshake_id)
                        && hello.plugin.as_ref().is_some_and(|plugin| plugin.plugin_id == request.artifact.plugin_id)
                        && hello.wit_package == WIT_PACKAGE
            )
        });
        if !handshake_valid {
            tracing::warn!(plugin_id = %request.artifact.plugin_id, "plugin host handshake failed");
            process.gateway.revoke();
            terminate_child(&mut process.child);
            return Err(HostFailure::Handshake);
        }
        let handle = HostHandle::new(
            instance_id,
            request.artifact.plugin_id.clone(),
            request.artifact.version.clone(),
        );
        let mut processes = match self.lock_processes() {
            Ok(processes) => processes,
            Err(error) => {
                process.gateway.revoke();
                terminate_child(&mut process.child);
                return Err(error);
            }
        };
        if processes
            .running
            .values()
            .any(|running| running.plugin_id == request.artifact.plugin_id)
        {
            process.gateway.revoke();
            terminate_child(&mut process.child);
            return Err(HostFailure::Launch);
        }
        if processes.running.contains_key(&instance_id) {
            process.gateway.revoke();
            terminate_child(&mut process.child);
            return Err(HostFailure::Launch);
        }
        processes.running.insert(instance_id, process);
        Ok(handle)
    }

    fn initialize(&mut self, handle: &HostHandle) -> Result<(), HostFailure> {
        let mut process = take_process(&self.processes, handle)?;
        let result = (|| {
            let context = process.gateway.context().clone();
            let initialization = self
                .host_context
                .context_for_workspace(&context.workspace_id)
                .inspect_err(|error| {
                    tracing::warn!(
                        ?error,
                        plugin_id = %handle.plugin_id,
                        workspace_id = %context.workspace_id,
                        "plugin host context was unavailable"
                    );
                })?;
            validate_initialization_context(&initialization).inspect_err(|error| {
                tracing::warn!(
                    ?error,
                    plugin_id = %handle.plugin_id,
                    "plugin host context was invalid"
                );
            })?;
            let response = Self::process_request(
                &mut process,
                request::Operation::Initialize(InitializeRequest {
                    context: Some(HostContext {
                        workspace_id: context.workspace_id.clone(),
                        plugin_id: context.plugin_id.clone(),
                        instance_id: context.instance_id.clone(),
                        generation: context.generation,
                        locale: initialization.locale,
                        theme: initialization.theme as i32,
                        granted_capabilities: context
                            .granted_capabilities
                            .iter()
                            .map(|value| *value as i32)
                            .collect(),
                        limits: Some(default_resource_limits()),
                        sessions: initialization.sessions,
                    }),
                }),
                INITIALIZATION_TIMEOUT,
            )?;
            let initialized = match response.payload {
                Some(envelope::Payload::Response(wire::Response {
                    result: Some(response::Result::Initialize(initialized)),
                })) => initialized,
                Some(envelope::Payload::Error(error)) => {
                    tracing::warn!(
                        plugin_id = %handle.plugin_id,
                        instance_id = handle.instance_id,
                        error_code = error.code,
                        message_key = %error.message_key,
                        retryable = error.retryable,
                        detail = ?error.detail,
                        "plugin host rejected initialization"
                    );
                    return Err(HostFailure::Initialization);
                }
                payload => {
                    tracing::warn!(
                        plugin_id = %handle.plugin_id,
                        instance_id = handle.instance_id,
                        ?payload,
                        "plugin host returned an invalid initialization response"
                    );
                    return Err(HostFailure::Initialization);
                }
            };
            let model = initialized.model.ok_or_else(|| {
                tracing::warn!(
                    plugin_id = %handle.plugin_id,
                    "plugin host initialization response omitted its model"
                );
                HostFailure::Initialization
            })?;
            process
                .gateway
                .finalize_initial_model(&model)
                .map_err(|error| {
                    tracing::warn!(
                        ?error,
                        plugin_id = %handle.plugin_id,
                        "plugin host initial model finalization failed"
                    );
                    HostFailure::Initialization
                })
        })();
        if let Err(error) = &result {
            tracing::warn!(?error, plugin_id = %handle.plugin_id, "plugin host initialization failed");
        }
        // Failure restores the previous behavior exactly: the entry stays in
        // the table so the exit monitor and terminate fallbacks can find it.
        reinsert_process(&self.processes, handle.instance_id, process);
        result
    }

    fn shutdown(&mut self, handle: &HostHandle) -> Result<(), HostFailure> {
        let mut process = take_process(&self.processes, handle)?;
        let result = (|| {
            let response = Self::process_request(
                &mut process,
                request::Operation::Shutdown(ShutdownRequest {}),
                REQUEST_TIMEOUT,
            )?;
            if !matches!(
                response.payload,
                Some(envelope::Payload::Response(wire::Response {
                    result: Some(response::Result::Shutdown(_))
                }))
            ) {
                return Err(HostFailure::Shutdown);
            }
            let deadline = Instant::now() + REQUEST_TIMEOUT;
            loop {
                match process.child.try_wait() {
                    Ok(true) => break,
                    Ok(false) if Instant::now() < deadline => thread::sleep(PROCESS_EXIT_POLL),
                    Ok(false) | Err(_) => return Err(HostFailure::Shutdown),
                }
            }
            Ok(())
        })();
        match result {
            // Success keeps the old final state: removed from the table.
            Ok(()) => {
                process.gateway.revoke();
                Ok(())
            }
            // Failure reinserts so the caller's terminate fallback (and the
            // exit monitor) can still find and kill the child.
            Err(error) => {
                reinsert_process(&self.processes, handle.instance_id, process);
                Err(error)
            }
        }
    }

    fn terminate(&mut self, handle: &HostHandle) {
        let Ok(mut processes) = self.processes.lock() else {
            return;
        };
        if let Some(mut process) = processes.running.remove(&handle.instance_id) {
            process.gateway.revoke();
            terminate_child(&mut process.child);
        }
    }

    fn deliver_envelope(
        &mut self,
        handle: &HostHandle,
        payload: bbcom_plugin_contracts::generated_v2::envelope::Payload,
    ) -> Result<(), HostFailure> {
        let mut processes = self.lock_processes()?;
        let process = processes
            .running
            .get_mut(&handle.instance_id)
            .filter(|process| {
                process.plugin_id == handle.plugin_id && process.version == handle.version
            })
            .ok_or(HostFailure::Transport)?;
        let payload = match payload {
            envelope::Payload::Request(request) => {
                let operation = request.operation.ok_or(HostFailure::Transport)?;
                match operation {
                    request::Operation::RunCommand(request) => {
                        return Self::start_command(process, request);
                    }
                    request::Operation::HandleEvent(request) => {
                        if let Some(wire::plugin_event::Item::CancelTask(cancel)) =
                            request.event.as_ref().and_then(|event| event.item.as_ref())
                            && Self::cancel_active_task(process, &cancel.task_id)?
                        {
                            return Ok(());
                        }
                        let response = Self::process_request(
                            process,
                            request::Operation::HandleEvent(request),
                            REQUEST_TIMEOUT,
                        )?;
                        return matches!(
                            response.payload,
                            Some(envelope::Payload::Response(wire::Response {
                                result: Some(response::Result::HandleEvent(_))
                            }))
                        )
                        .then_some(())
                        .ok_or(HostFailure::Transport);
                    }
                    _ => return Err(HostFailure::Transport),
                }
            }
            payload => payload,
        };
        let envelope = match payload {
            envelope::Payload::Event(event) => process
                .gateway
                .event_envelope(event.item.ok_or(HostFailure::Transport)?)
                .map_err(|_| HostFailure::Transport)?,
            envelope::Payload::Cancel(cancel) => process
                .gateway
                .cancel_envelope(cancel.target_message_id, cancel.reason)
                .map_err(|_| HostFailure::Transport)?,
            envelope::Payload::Stream(stream) => process
                .gateway
                .stream_envelope(stream)
                .map_err(|_| HostFailure::Transport)?,
            // Host requests require a correlated result and therefore use the
            // typed command/task API rather than this fire-and-forget port.
            envelope::Payload::Handshake(_)
            | envelope::Payload::Request(_)
            | envelope::Payload::Response(_)
            | envelope::Payload::Error(_) => return Err(HostFailure::Transport),
        };
        write_host_envelope(&process.stdin, &envelope)
    }
}

fn write_host_envelope(stdin: &SharedHostStdin, envelope: &Envelope) -> Result<(), HostFailure> {
    let mut stdin = stdin.lock().map_err(|_| HostFailure::Transport)?;
    FrameWriter::new(&mut **stdin)
        .write_envelope(envelope)
        .map_err(|_| HostFailure::Transport)
}

fn validate_initialization_context(
    context: &PluginInitializationContextV2,
) -> Result<(), HostFailure> {
    if !matches!(context.locale.as_str(), "en-US" | "zh-CN")
        || context.theme == wire::ColorScheme::Unspecified
        || context.sessions.len() > 1_024
    {
        return Err(HostFailure::Initialization);
    }
    let mut session_ids = BTreeSet::new();
    for session in &context.sessions {
        let mut bytes = session.session_id.bytes();
        if session.session_id.is_empty()
            || session.session_id.len() > 128
            || !bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !bytes.all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
            || !session_ids.insert(session.session_id.as_str())
            || session.name.is_empty()
            || session.name.len() > 1_024
            || session.name.chars().any(char::is_control)
            || session.rx_bytes > MAX_SAFE_INTEGER
            || session.tx_bytes > MAX_SAFE_INTEGER
            || session.generation > MAX_SAFE_INTEGER
            || (session.connected && session.generation == 0)
        {
            return Err(HostFailure::Initialization);
        }
    }
    Ok(())
}

fn receive_response(
    responses: &Receiver<Result<Envelope, HostFailure>>,
    timeout: Duration,
) -> Result<Envelope, HostFailure> {
    match responses.recv_timeout(timeout) {
        Ok(Ok(envelope)) => Ok(envelope),
        Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => Err(HostFailure::Transport),
        Err(RecvTimeoutError::Timeout) => Err(HostFailure::Transport),
    }
}

/// Remove a process from the shared table so long request sequences (chunked
/// state transfer, shutdown) can run without holding the single table mutex —
/// otherwise one slow host head-of-line blocks the 500ms crash poll and every
/// other plugin's commands. Identity is verified against the handle exactly
/// like `exact_process`; a mismatch reinserts and fails.
fn take_process(
    processes: &Arc<Mutex<HostProcesses>>,
    handle: &HostHandle,
) -> Result<HostProcess, HostFailure> {
    let mut processes = processes.lock().map_err(|_| HostFailure::Launch)?;
    match processes.running.remove(&handle.instance_id) {
        Some(process)
            if process.plugin_id == handle.plugin_id && process.version == handle.version =>
        {
            Ok(process)
        }
        Some(process) => {
            processes.running.insert(handle.instance_id, process);
            Err(HostFailure::Transport)
        }
        None => Err(HostFailure::Transport),
    }
}

fn reinsert_process(processes: &Arc<Mutex<HostProcesses>>, instance_id: u64, process: HostProcess) {
    if let Ok(mut processes) = processes.lock() {
        processes.running.entry(instance_id).or_insert(process);
    }
}

fn terminate_child(child: &mut PluginChild) {
    child.terminate_and_wait();
}
