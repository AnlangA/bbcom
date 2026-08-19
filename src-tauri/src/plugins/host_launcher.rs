use std::borrow::Cow;
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
    HANDSHAKE_TIMEOUT_MS, HOST_PROCESS_MEMORY_LIMIT_BYTES, MAX_PLUGIN_PERSISTED_STATE_BYTES,
    MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES,
};
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};
use bbcom_plugin_host::{
    AuthorizationRequest, PluginAuthorizationGate, PluginLaunchContext, TrustedPluginArtifact,
    authorization_request, authorization_ticket,
};
use bbcom_plugin_manager::{
    ArtifactSlot, CrashKind, HostFailure, HostHandle, HostLaunchMode, HostLaunchRequest,
    HostLauncher, HostReport,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
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

/// Explicit production authorities injected into one sidecar launcher.
/// Grouping these services keeps the constructor readable without introducing
/// any permissive default: callers must still supply every authority.
pub struct PluginHostServicesV2 {
    authorization: Arc<dyn PluginAuthorizationGate>,
    gateway: Arc<dyn PluginCapabilityGateway>,
    host_context: Arc<dyn PluginHostContextProviderV2>,
    project_state: Arc<dyn PluginProjectStateProviderV2>,
}

impl PluginHostServicesV2 {
    #[must_use]
    pub fn new(
        authorization: Arc<dyn PluginAuthorizationGate>,
        gateway: Arc<dyn PluginCapabilityGateway>,
        host_context: Arc<dyn PluginHostContextProviderV2>,
        project_state: Arc<dyn PluginProjectStateProviderV2>,
    ) -> Self {
        Self {
            authorization,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxSelfTest {
    pub blocks_network: bool,
    pub blocks_child_processes: bool,
    pub restricts_filesystem: bool,
    pub enforces_memory_limit: bool,
    pub observes_crashed_process: bool,
    pub terminates_hung_process: bool,
}

impl SandboxSelfTest {
    fn is_complete(self) -> bool {
        self.blocks_network
            && self.blocks_child_processes
            && self.restricts_filesystem
            && self.enforces_memory_limit
            && self.observes_crashed_process
            && self.terminates_hung_process
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxError {
    detail: Cow<'static, str>,
}

impl SandboxError {
    #[must_use]
    pub const fn new(detail: &'static str) -> Self {
        Self {
            detail: Cow::Borrowed(detail),
        }
    }

    #[cfg(target_os = "windows")]
    #[must_use]
    pub(crate) fn from_win32(context: &'static str, code: u32) -> Self {
        Self {
            // Keep diagnostics actionable without surfacing paths, account
            // names, environment variables, or other native error text.
            detail: Cow::Owned(format!("{context} (Win32 error {code})")),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[must_use]
    pub(crate) fn from_process_exit(context: &'static str, code: u32) -> Self {
        Self {
            // Numeric exit status identifies the failed probe without exposing
            // captured output, paths, account names, or environment values.
            detail: Cow::Owned(format!("{context} (process exit code {code})")),
        }
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for SandboxError {}

pub struct SandboxLaunch<'a> {
    pub sidecar_executable: &'a Path,
    pub package_root: &'a Path,
    pub memory_limit_bytes: usize,
    pub arguments: &'a [OsString],
}

/// Operating-system isolation authority.
///
/// `spawn` is the isolation boundary: a platform may override it when process
/// creation and constraint attachment must be one atomic operation. The
/// default adapter preserves Linux/macOS command-based drivers. Setting the
/// sidecar's attestation flags alone is never sufficient.
pub trait SandboxDriver: Send + Sync + 'static {
    fn self_test(&self, sidecar_executable: &Path) -> Result<SandboxSelfTest, SandboxError>;
    fn command(&self, launch: &SandboxLaunch<'_>) -> Result<Command, SandboxError>;
    fn spawn(&self, launch: &SandboxLaunch<'_>) -> Result<SandboxedChild, SandboxError> {
        let mut command = self.command(launch)?;
        configure_command(&mut command, launch);
        let child = command
            .spawn()
            .map_err(|_| SandboxError::new("sandboxed plugin host could not be spawned"))?;
        Ok(SandboxedChild::standard(child))
    }
    fn platform_argument(&self) -> &'static str;
}

fn configure_command(command: &mut Command, launch: &SandboxLaunch<'_>) {
    command
        .env_clear()
        .current_dir(launch.package_root)
        .args(launch.arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
}

pub trait SandboxedProcess: Send {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>>;
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    fn try_wait(&mut self) -> std::io::Result<bool>;
    fn terminate_and_wait(&mut self);
}

pub struct SandboxedChild {
    process: Box<dyn SandboxedProcess>,
}

impl SandboxedChild {
    fn standard(child: Child) -> Self {
        Self {
            process: Box::new(StandardSandboxedProcess { child }),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn platform(process: Box<dyn SandboxedProcess>) -> Self {
        Self { process }
    }

    pub(crate) fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.process.take_stdin()
    }

    pub(crate) fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.process.take_stdout()
    }

    pub(crate) fn try_wait(&mut self) -> std::io::Result<bool> {
        self.process.try_wait()
    }

    pub(crate) fn terminate_and_wait(&mut self) {
        self.process.terminate_and_wait();
    }
}

struct StandardSandboxedProcess {
    child: Child,
}

impl SandboxedProcess for StandardSandboxedProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.child
            .stdin
            .take()
            .map(|stdin| Box::new(stdin) as Box<dyn Write + Send>)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .stdout
            .take()
            .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
    }

    fn try_wait(&mut self) -> std::io::Result<bool> {
        self.child.try_wait().map(|status| status.is_some())
    }

    fn terminate_and_wait(&mut self) {
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
pub struct PrivateArtifactRoot {
    canonical: PathBuf,
}

impl PrivateArtifactRoot {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, HostLauncherBuildError> {
        let root = root.as_ref();
        let metadata =
            fs::symlink_metadata(root).map_err(|_| HostLauncherBuildError::PrivateRoot)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(HostLauncherBuildError::PrivateRoot);
        }
        let canonical = fs::canonicalize(root).map_err(|_| HostLauncherBuildError::PrivateRoot)?;
        Ok(Self { canonical })
    }

    fn validate_package(&self, package_root: &Path) -> Result<PathBuf, HostFailure> {
        let metadata = fs::symlink_metadata(package_root).map_err(|_| HostFailure::Launch)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(HostFailure::Launch);
        }
        let canonical = fs::canonicalize(package_root).map_err(|_| HostFailure::Launch)?;
        if canonical == self.canonical || !canonical.starts_with(&self.canonical) {
            return Err(HostFailure::Launch);
        }
        let manifest = canonical.join("plugin.toml");
        let manifest_metadata = fs::symlink_metadata(manifest).map_err(|_| HostFailure::Launch)?;
        if !manifest_metadata.is_file() || manifest_metadata.file_type().is_symlink() {
            return Err(HostFailure::Launch);
        }
        Ok(canonical)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostLauncherBuildError {
    SidecarExecutable,
    PrivateRoot,
    SandboxUnavailable(SandboxError),
}

impl fmt::Display for HostLauncherBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SidecarExecutable => formatter.write_str("plugin sidecar is not a regular file"),
            Self::PrivateRoot => formatter.write_str("plugin private root is unsafe"),
            Self::SandboxUnavailable(error) => {
                write!(formatter, "plugin sandbox unavailable: {error}")
            }
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
    child: SandboxedChild,
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

    #[cfg(test)]
    fn active(&self) -> usize {
        self.0.load(Ordering::Acquire)
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

pub struct SidecarHostLauncher<R, S, P> {
    sidecar_executable: PathBuf,
    private_root: PrivateArtifactRoot,
    resolver: R,
    sandbox: S,
    persistence: P,
    processes: Arc<Mutex<HostProcesses>>,
    next_instance_id: AtomicU64,
    authorization: Arc<dyn PluginAuthorizationGate>,
    gateway: Arc<dyn PluginCapabilityGateway>,
    host_context: Arc<dyn PluginHostContextProviderV2>,
    project_state: Arc<dyn PluginProjectStateProviderV2>,
}

struct RejectAuthorization;
impl PluginAuthorizationGate for RejectAuthorization {
    fn authorize(&self, _request: &AuthorizationRequest) -> bool {
        false
    }
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

impl<R, S, P> Drop for SidecarHostLauncher<R, S, P> {
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

impl<R, S, P> SidecarHostLauncher<R, S, P>
where
    R: ArtifactPathResolver,
    S: SandboxDriver,
    P: PluginStatePersistencePort,
{
    pub fn new(
        sidecar_executable: impl AsRef<Path>,
        private_root: PrivateArtifactRoot,
        resolver: R,
        sandbox: S,
        persistence: P,
    ) -> Result<(Self, HostExitMonitor), HostLauncherBuildError> {
        Self::new_with_v2_services(
            sidecar_executable,
            private_root,
            resolver,
            sandbox,
            persistence,
            PluginHostServicesV2::new(
                Arc::new(RejectAuthorization),
                Arc::new(RejectCapabilityGateway),
                Arc::new(RejectHostContext),
                Arc::new(RejectProjectState),
            ),
        )
    }

    /// Production v2 constructor. A launcher built with `new` is deliberately
    /// deny-only and cannot instantiate plugins until native injects both the
    /// durable grant gate and the application capability gateway.
    pub fn new_with_v2_services(
        sidecar_executable: impl AsRef<Path>,
        private_root: PrivateArtifactRoot,
        resolver: R,
        sandbox: S,
        persistence: P,
        services: PluginHostServicesV2,
    ) -> Result<(Self, HostExitMonitor), HostLauncherBuildError> {
        let sidecar_executable = sidecar_executable.as_ref();
        let metadata = fs::symlink_metadata(sidecar_executable)
            .map_err(|_| HostLauncherBuildError::SidecarExecutable)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(HostLauncherBuildError::SidecarExecutable);
        }
        let self_test = sandbox
            .self_test(sidecar_executable)
            .map_err(HostLauncherBuildError::SandboxUnavailable)?;
        if !self_test.is_complete() {
            return Err(HostLauncherBuildError::SandboxUnavailable(
                SandboxError::new("sandbox self-test did not prove every required control"),
            ));
        }
        if !matches!(sandbox.platform_argument(), "windows" | "macos" | "linux") {
            return Err(HostLauncherBuildError::SandboxUnavailable(
                SandboxError::new("sandbox selected an unsupported host platform"),
            ));
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
                sandbox,
                persistence,
                processes,
                next_instance_id: AtomicU64::new(1),
                authorization: services.authorization,
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
        let request_id = process
            .gateway
            .next_outbound_message_id()
            .map_err(|_| HostFailure::Transport)?;
        let response = process.responses.register(request_id)?;
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
            process.responses.discard(request_id);
            return Err(error);
        }
        let response = receive_response(&response, timeout)?;
        if response.reply_to != Some(request_id) {
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
    match gateway
        .begin(envelope)
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
            let fallback = request.clone();
            let spawn_failed = thread::Builder::new()
                .name("plugin-capability-v2".to_owned())
                .spawn(move || {
                    let _permit = permit;
                    match worker_gateway.finish(request) {
                        Ok(Some(reply)) => {
                            if write_host_envelope(&worker_stdin, &reply).is_err() {
                                worker_router.fail_all();
                            }
                        }
                        Ok(None) => {}
                        Err(_) => worker_router.fail_all(),
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

impl<R, S, P> HostLauncher for SidecarHostLauncher<R, S, P>
where
    R: ArtifactPathResolver,
    S: SandboxDriver,
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
            .validate_package(resolved.package_root())
            .inspect_err(|error| {
                tracing::warn!(?error, plugin_id = %request.artifact.plugin_id, package_root = %resolved.package_root().display(), "plugin package validation failed before host launch");
            })?;
        let manifest_text = fs::read_to_string(package_root.join("plugin.toml"))
            .map_err(|_| HostFailure::Launch)?;
        let artifact = TrustedPluginArtifact::load(&package_root, &manifest_text)
            .map_err(|_| HostFailure::Launch)?;
        if artifact.manifest.id != request.artifact.plugin_id
            || artifact.manifest.version != request.artifact.version
            || artifact.manifest.component.sha256 != request.artifact.component_sha256
        {
            return Err(HostFailure::Launch);
        }
        let granted = artifact
            .manifest
            .v2_capabilities()
            .map_err(|_| HostFailure::Initialization)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        if granted != request.requested_capabilities {
            return Err(HostFailure::Initialization);
        }
        let instance_id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);
        if instance_id == 0 {
            return Err(HostFailure::Launch);
        }
        let runtime_instance_id = instance_id.to_string();
        let launch_context = PluginLaunchContext {
            package_sha256: request.artifact.package_sha256.clone(),
            workspace_id: request.workspace_id.clone(),
            instance_id: runtime_instance_id.clone(),
            generation: instance_id,
        };
        let authorization =
            authorization_request(&artifact, &launch_context, granted.iter().copied());
        if !self.authorization.authorize(&authorization) {
            return Err(HostFailure::Initialization);
        }
        let launch_ticket = authorization_ticket(&authorization);
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
            OsString::from("--platform"),
            OsString::from(self.sandbox.platform_argument()),
            OsString::from("--memory-limit-bytes"),
            OsString::from(HOST_PROCESS_MEMORY_LIMIT_BYTES.to_string()),
            OsString::from("--blocks-child-processes"),
            OsString::from("--blocks-network"),
            OsString::from("--restricts-filesystem"),
            OsString::from("--package-sha256"),
            OsString::from(&request.artifact.package_sha256),
            OsString::from("--workspace-id"),
            OsString::from(&request.workspace_id),
            OsString::from("--instance-id"),
            OsString::from(&runtime_instance_id),
            OsString::from("--generation"),
            OsString::from(instance_id.to_string()),
            OsString::from("--authorization-ticket"),
            OsString::from(launch_ticket),
        ];
        for capability in &granted {
            arguments.push(OsString::from("--grant"));
            arguments.push(OsString::from(bbcom_plugin_contracts::v2_capability_name(
                *capability,
            )));
        }
        let launch = SandboxLaunch {
            sidecar_executable: &self.sidecar_executable,
            package_root: &package_root,
            memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
            arguments: &arguments,
        };
        let mut child = self
            .sandbox
            .spawn(&launch)
            .map_err(|error| {
                tracing::warn!(%error, plugin_id = %request.artifact.plugin_id, "plugin sandbox spawn failed");
                HostFailure::SandboxUnavailable
            })?;
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
        if thread::Builder::new()
            .name(format!("plugin-host-{}", request.artifact.plugin_id))
            .spawn(move || {
                let mut reader = FrameReader::new(stdout);
                loop {
                    let response = reader.read_envelope().map_err(|_| HostFailure::Transport);
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
                            response_router.fail_all();
                            return;
                        }
                        Ok(None) | Err(_) => {
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
                        && hello.plugin.as_ref().is_some_and(|plugin| plugin.plugin_id == request.artifact.plugin_id && plugin.plugin_version == request.artifact.version && plugin.component_sha256 == request.artifact.component_sha256)
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
                .context_for_workspace(&context.workspace_id)?;
            validate_initialization_context(&initialization)?;
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
                REQUEST_TIMEOUT,
            )?;
            let Some(envelope::Payload::Response(wire::Response {
                result: Some(response::Result::Initialize(initialized)),
            })) = response.payload
            else {
                return Err(HostFailure::Initialization);
            };
            let model = initialized.model.ok_or(HostFailure::Initialization)?;
            process
                .gateway
                .finalize_initial_model(&model)
                .map_err(|_| HostFailure::Initialization)
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

fn terminate_child(child: &mut SandboxedChild) {
    child.terminate_and_wait();
}

#[cfg(test)]
mod tests {
    use std::sync::Condvar;

    use super::*;

    #[derive(Default)]
    struct ReaderBlockingGateway {
        invoked: (Mutex<bool>, Condvar),
        release: (Mutex<bool>, Condvar),
        discarded: AtomicUsize,
        revoked: AtomicUsize,
    }

    impl PluginCapabilityGateway for ReaderBlockingGateway {
        fn invoke(
            &self,
            _: &GatewayContext,
            _: u64,
            operation: request::Operation,
        ) -> Result<response::Result, GatewayFailure> {
            if !matches!(operation, request::Operation::ListPorts(_)) {
                return Err(GatewayFailure::new(
                    wire::ErrorCode::ProtocolError,
                    "plugin.error.protocolInvalid",
                ));
            }
            *self.invoked.0.lock().unwrap() = true;
            self.invoked.1.notify_all();
            let mut release = self.release.0.lock().unwrap();
            while !*release {
                release = self.release.1.wait(release).unwrap();
            }
            Ok(response::Result::ListPorts(wire::ListPortsResponse {
                ports: Vec::new(),
            }))
        }

        fn cancel(&self, _: &GatewayContext, _: u64) -> Result<(), GatewayFailure> {
            *self.release.0.lock().unwrap() = true;
            self.release.1.notify_all();
            Ok(())
        }

        fn discard_cancelled_result(
            &self,
            _: &GatewayContext,
            _: &request::Operation,
            _: &response::Result,
        ) {
            self.discarded.fetch_add(1, Ordering::Relaxed);
        }

        fn revoke_runtime(&self, _: &GatewayContext) {
            self.revoked.fetch_add(1, Ordering::Relaxed);
        }
    }

    struct RecordingWrite(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWrite {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct MemoryPersistence;

    impl PluginStatePersistencePort for MemoryPersistence {
        fn load_plugin_storage(
            &mut self,
            _key: &PluginStatePersistenceKey,
        ) -> Result<Option<Vec<u8>>, HostFailure> {
            Ok(None)
        }

        fn workspace_total_bytes(&mut self, _workspace_id: &str) -> Result<usize, HostFailure> {
            Ok(0)
        }

        fn persist_state(
            &mut self,
            _key: &PluginStatePersistenceKey,
            state: &PluginPersistedState,
        ) -> Result<(), HostFailure> {
            state.validate()
        }
    }

    #[derive(Clone)]
    struct FixedResolver(PathBuf);

    impl ArtifactPathResolver for FixedResolver {
        fn resolve(
            &self,
            _plugin_id: &str,
            _version: &str,
            _slot: &ArtifactSlot,
        ) -> Result<ResolvedPluginArtifact, HostFailure> {
            Ok(ResolvedPluginArtifact::new(self.0.clone()))
        }
    }

    #[derive(Clone)]
    struct FixedSandbox {
        result: Result<SandboxSelfTest, SandboxError>,
        platform: &'static str,
    }

    impl SandboxDriver for FixedSandbox {
        fn self_test(&self, _sidecar_executable: &Path) -> Result<SandboxSelfTest, SandboxError> {
            self.result.clone()
        }

        fn command(&self, launch: &SandboxLaunch<'_>) -> Result<Command, SandboxError> {
            Ok(Command::new(launch.sidecar_executable))
        }

        fn platform_argument(&self) -> &'static str {
            self.platform
        }
    }

    fn complete_sandbox() -> SandboxSelfTest {
        SandboxSelfTest {
            blocks_network: true,
            blocks_child_processes: true,
            restricts_filesystem: true,
            enforces_memory_limit: true,
            observes_crashed_process: true,
            terminates_hung_process: true,
        }
    }

    #[test]
    fn v2_handshake_uses_the_exact_sorted_manifest_capability_set() {
        let granted = BTreeSet::from([
            wire::Capability::PluginStorage,
            wire::Capability::SerialIo,
            wire::Capability::UiWorkspace,
        ]);
        assert_eq!(
            granted
                .into_iter()
                .map(bbcom_plugin_contracts::v2_capability_name)
                .collect::<Vec<_>>(),
            vec!["ui.workspace", "serial.io", "plugin.storage"]
        );
    }

    #[test]
    fn update_preflight_reads_active_private_bytes_without_a_prepared_state_key() {
        struct ActivePrivateState;

        impl PluginStatePersistencePort for ActivePrivateState {
            fn load_plugin_storage(
                &mut self,
                key: &PluginStatePersistenceKey,
            ) -> Result<Option<Vec<u8>>, HostFailure> {
                assert_eq!(key.artifact_slot, ArtifactSlot::Active);
                assert_eq!(key.launch_mode, HostLaunchMode::Active);
                Ok(Some(b"active-private".to_vec()))
            }

            fn workspace_total_bytes(&mut self, _: &str) -> Result<usize, HostFailure> {
                Ok(b"active-private".len())
            }

            fn persist_state(
                &mut self,
                _: &PluginStatePersistenceKey,
                _: &PluginPersistedState,
            ) -> Result<(), HostFailure> {
                panic!("preflight loading must not persist private state")
            }
        }

        let artifact = bbcom_plugin_manager::PluginArtifact::new(
            "dev.bbcom.fixture",
            "2.0.0",
            "a".repeat(64),
            "b".repeat(64),
            bbcom_plugin_manager::PluginArtifactSource {
                source_id: "official".to_owned(),
                kind: bbcom_plugin_manager::PluginSourceKind::Https,
            },
            [],
        )
        .unwrap();
        let request = HostLaunchRequest {
            artifact,
            artifact_slot: ArtifactSlot::Prepared(
                bbcom_plugin_manager::PreparationToken::new("upgrade-1").unwrap(),
            ),
            workspace_id: "workspace-1".to_owned(),
            requested_capabilities: BTreeSet::new(),
            mode: HostLaunchMode::UpdatePreflight,
        };
        let key = private_state_load_key(&request).unwrap();
        let loaded = ActivePrivateState
            .load_plugin_storage(&key)
            .unwrap()
            .unwrap();
        assert_eq!(loaded, b"active-private");
    }

    #[test]
    fn reader_dispatches_cancel_while_capability_worker_blocks_and_writes_no_late_reply() {
        let concrete = Arc::new(ReaderBlockingGateway::default());
        let erased: Arc<dyn PluginCapabilityGateway> = concrete.clone();
        let session: Arc<GatewaySession<dyn PluginCapabilityGateway>> =
            Arc::new(GatewaySession::new(
                GatewayContext {
                    workspace_id: "workspace-1".to_owned(),
                    plugin_id: "dev.bbcom.reader".to_owned(),
                    instance_id: "1".to_owned(),
                    generation: 1,
                    granted_capabilities: BTreeSet::from([wire::Capability::SerialPortsRead]),
                },
                erased,
            ));
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let stdin: SharedHostStdin =
            Arc::new(Mutex::new(Box::new(RecordingWrite(Arc::clone(&bytes)))));
        let responses = HostResponseRouter::default();
        let workers = CapabilityWorkerRegistry::default();
        dispatch_sidecar_gateway_envelope(
            &session,
            &stdin,
            &responses,
            &workers,
            Envelope {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: MAX_PROTOCOL_MINOR,
                message_id: 1,
                reply_to: None,
                payload: Some(envelope::Payload::Request(Request {
                    operation: Some(request::Operation::ListPorts(wire::ListPortsRequest {})),
                })),
            },
        )
        .unwrap();
        let mut invoked = concrete.invoked.0.lock().unwrap();
        while !*invoked {
            invoked = concrete.invoked.1.wait(invoked).unwrap();
        }
        drop(invoked);
        assert_eq!(workers.active(), 1);
        dispatch_sidecar_gateway_envelope(
            &session,
            &stdin,
            &responses,
            &workers,
            Envelope {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: MAX_PROTOCOL_MINOR,
                message_id: 2,
                reply_to: None,
                payload: Some(envelope::Payload::Cancel(wire::Cancel {
                    target_message_id: 1,
                    reason: "test".to_owned(),
                })),
            },
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while workers.active() != 0 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(workers.active(), 0);
        assert_eq!(concrete.discarded.load(Ordering::Relaxed), 1);
        assert!(bytes.lock().unwrap().is_empty());

        session.revoke();
        assert_eq!(concrete.revoked.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn private_artifact_roots_accept_only_manifested_descendants() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("private");
        let package = root.join("dev.bbcom.coverage").join("1.0.0");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("plugin.toml"), b"id='dev.bbcom.coverage'").unwrap();

        let authority = PrivateArtifactRoot::open(&root).unwrap();
        assert_eq!(
            authority.validate_package(&package).unwrap(),
            package.canonicalize().unwrap()
        );
        assert_eq!(authority.validate_package(&root), Err(HostFailure::Launch));
        assert_eq!(
            authority.validate_package(temporary.path()),
            Err(HostFailure::Launch)
        );
        std::fs::remove_file(package.join("plugin.toml")).unwrap();
        assert_eq!(
            authority.validate_package(&package),
            Err(HostFailure::Launch)
        );
        assert!(matches!(
            PrivateArtifactRoot::open(temporary.path().join("missing")),
            Err(HostLauncherBuildError::PrivateRoot)
        ));

        let resolved = ResolvedPluginArtifact::new(package.clone());
        assert_eq!(resolved.package_root(), package);
    }

    #[test]
    fn launcher_build_is_fail_closed_until_every_sandbox_control_is_proven() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("private");
        let package = root.join("dev.bbcom.coverage").join("1.0.0");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("plugin.toml"), b"id='dev.bbcom.coverage'").unwrap();
        let sidecar = temporary.path().join("bbcom-plugin-host");
        std::fs::write(&sidecar, b"sidecar").unwrap();
        let private_root = PrivateArtifactRoot::open(&root).unwrap();
        let resolver = FixedResolver(package);

        let incomplete = SandboxSelfTest {
            blocks_network: true,
            blocks_child_processes: true,
            restricts_filesystem: true,
            enforces_memory_limit: false,
            observes_crashed_process: true,
            terminates_hung_process: true,
        };
        assert!(matches!(
            SidecarHostLauncher::new(
                &sidecar,
                private_root.clone(),
                resolver.clone(),
                FixedSandbox {
                    result: Ok(incomplete),
                    platform: "linux",
                },
                MemoryPersistence,
            ),
            Err(HostLauncherBuildError::SandboxUnavailable(_))
        ));
        assert!(matches!(
            SidecarHostLauncher::new(
                &sidecar,
                private_root.clone(),
                resolver.clone(),
                FixedSandbox {
                    result: Err(SandboxError::new("unavailable")),
                    platform: "linux",
                },
                MemoryPersistence,
            ),
            Err(HostLauncherBuildError::SandboxUnavailable(_))
        ));
        assert!(matches!(
            SidecarHostLauncher::new(
                &sidecar,
                private_root.clone(),
                resolver.clone(),
                FixedSandbox {
                    result: Ok(complete_sandbox()),
                    platform: "other",
                },
                MemoryPersistence,
            ),
            Err(HostLauncherBuildError::SandboxUnavailable(_))
        ));
        assert!(matches!(
            SidecarHostLauncher::new(
                temporary.path().join("missing"),
                private_root.clone(),
                resolver.clone(),
                FixedSandbox {
                    result: Ok(complete_sandbox()),
                    platform: "linux",
                },
                MemoryPersistence,
            ),
            Err(HostLauncherBuildError::SidecarExecutable)
        ));

        let (launcher, monitor) = SidecarHostLauncher::new(
            &sidecar,
            private_root,
            resolver,
            FixedSandbox {
                result: Ok(complete_sandbox()),
                platform: "linux",
            },
            MemoryPersistence,
        )
        .unwrap();
        assert!(launcher.lock_processes().unwrap().running.is_empty());
        assert!(monitor.poll().unwrap().is_empty());
        assert_eq!(monitor.crash_count("dev.bbcom.coverage"), 0);
        drop(launcher);

        for message in [
            SandboxError::new("sandbox").to_string(),
            HostLauncherBuildError::PrivateRoot.to_string(),
            HostLauncherBuildError::SidecarExecutable.to_string(),
            HostLauncherBuildError::SandboxUnavailable(SandboxError::new("sandbox")).to_string(),
            HostMonitorError.to_string(),
        ] {
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn response_transport_accepts_only_one_complete_envelope() {
        let envelope = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: 7,
            reply_to: Some(6),
            payload: None,
        };
        let router = HostResponseRouter::default();
        let receiver = router.register(6).unwrap();
        assert!(router.complete(envelope.clone()));
        assert_eq!(
            receive_response(&receiver, Duration::from_millis(1))
                .unwrap()
                .message_id,
            7
        );
        assert!(!router.complete(envelope));

        let (_sender, empty) = mpsc::channel::<Result<Envelope, HostFailure>>();
        assert_eq!(
            receive_response(&empty, Duration::from_millis(1)),
            Err(HostFailure::Transport)
        );
    }
}
