use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use bbcom_plugin_contracts::generated::{
    CompleteShutdownRequest, Envelope, GetStateChunkRequest, HostHello, InitializeRequest,
    InvokeRequest, OpaqueStateKind, PutStateChunkRequest, ShutdownRequest, StateSnapshotDescriptor,
    envelope,
};
use bbcom_plugin_contracts::{
    HANDSHAKE_TIMEOUT_MS, HOST_PROCESS_MEMORY_LIMIT_BYTES, MAX_PLUGIN_PERSISTED_STATE_BYTES,
    MAX_PLUGIN_STATE_CHUNK_BYTES, MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES,
    PLUGIN_STATE_SCHEMA_VERSION, PROTOCOL_MAJOR, PROTOCOL_MINOR, Permission, WIT_PACKAGE,
    empty_plugin_storage_payload, encode_frame,
};
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};
use bbcom_plugin_manager::{
    ArtifactSlot, CrashKind, HostFailure, HostHandle, HostLaunchMode, HostLaunchRequest,
    HostLauncher, HostPanel, HostPanelField, HostPanelFieldKind, HostReport,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_EXIT_POLL: Duration = Duration::from_millis(10);

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
/// Implementations must atomically replace both payloads and reject an update
/// when it would exceed 16 MiB for one plugin or 64 MiB across one workspace.
/// Keys are repository/workspace identities; neither input nor output may be a
/// filesystem path. Prepared slots must resolve to staged data, never active
/// data.
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

    #[cfg(target_os = "windows")]
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
    stdin: Box<dyn Write + Send>,
    responses: Receiver<Result<Option<Envelope>, HostFailure>>,
    next_request_id: u64,
    state_key: PluginStatePersistenceKey,
    initial_state: PluginPersistedState,
    published_panel: Option<HostPanel>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostPanelJson {
    title: String,
    fields: Vec<HostPanelFieldJson>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostPanelFieldJson {
    id: String,
    label: String,
    kind: String,
    value: String,
    options: Vec<String>,
    disabled: bool,
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
    /// Sidecar-initiated pushes (proposals, session queries) stream here.
    /// Shared with every host reader thread so a sink attached after
    /// construction is honored by already-running readers.
    push_sink: Arc<Mutex<Option<Arc<dyn bbcom_plugin_manager::HostPushSink>>>>,
    /// Outbound push request ids live in a dedicated high range so they can
    /// never collide with request/response ids.
    push_request_id: AtomicU64,
}

/// First id of the outbound push range.
const PUSH_REQUEST_ID_BASE: u64 = 1 << 63;

impl<R, S, P> Drop for SidecarHostLauncher<R, S, P> {
    fn drop(&mut self) {
        let Ok(mut processes) = self.processes.lock() else {
            return;
        };
        let running = std::mem::take(&mut processes.running);
        for (_, mut process) in running {
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
        let push_sink = Arc::new(Mutex::new(
            None::<Arc<dyn bbcom_plugin_manager::HostPushSink>>,
        ));
        Ok((
            Self {
                sidecar_executable: sidecar_executable.to_path_buf(),
                private_root,
                resolver,
                sandbox,
                persistence,
                processes,
                next_instance_id: AtomicU64::new(1),
                push_sink,
                push_request_id: AtomicU64::new(PUSH_REQUEST_ID_BASE),
            },
            monitor,
        ))
    }

    fn lock_processes(&self) -> Result<MutexGuard<'_, HostProcesses>, HostFailure> {
        self.processes.lock().map_err(|_| HostFailure::Launch)
    }

    fn process_request(
        process: &mut HostProcess,
        payload: envelope::Payload,
        timeout: Duration,
    ) -> Result<Envelope, HostFailure> {
        let request_id = process.next_request_id;
        process.next_request_id = process
            .next_request_id
            .checked_add(1)
            .ok_or(HostFailure::Transport)?;
        let envelope = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(payload),
        };
        FrameWriter::new(&mut process.stdin)
            .write_envelope(&envelope)
            .map_err(|_| HostFailure::Transport)?;
        let response = receive_response(&process.responses, timeout)?;
        if response.request_id != request_id {
            return Err(HostFailure::Transport);
        }
        Ok(response)
    }

    fn upload_state(
        process: &mut HostProcess,
        kind: OpaqueStateKind,
        bytes: &[u8],
    ) -> Result<(), HostFailure> {
        let mut offset = 0usize;
        loop {
            let end = offset
                .saturating_add(MAX_PLUGIN_STATE_CHUNK_BYTES)
                .min(bytes.len());
            let final_chunk = end == bytes.len();
            let response = Self::process_request(
                process,
                envelope::Payload::PutStateChunkRequest(PutStateChunkRequest {
                    state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                    kind: kind as i32,
                    total_bytes: bytes.len() as u64,
                    offset: offset as u64,
                    payload: bytes[offset..end].to_vec(),
                    final_chunk,
                }),
                REQUEST_TIMEOUT,
            )?;
            let accepted = match response.payload {
                Some(envelope::Payload::PutStateChunkResponse(response))
                    if response.kind == kind as i32 =>
                {
                    response.accepted_bytes as usize
                }
                _ => return Err(HostFailure::Initialization),
            };
            if accepted != end {
                return Err(HostFailure::Initialization);
            }
            offset = end;
            if final_chunk {
                return Ok(());
            }
        }
    }

    fn download_state(
        process: &mut HostProcess,
        descriptor: &StateSnapshotDescriptor,
    ) -> Result<PluginPersistedState, HostFailure> {
        if descriptor.state_schema_version != PLUGIN_STATE_SCHEMA_VERSION
            || descriptor.revision == 0
            || descriptor.plugin_storage_bytes as usize > MAX_PLUGIN_PERSISTED_STATE_BYTES
            || descriptor.project_state_bytes as usize > MAX_PLUGIN_PERSISTED_STATE_BYTES
            || (!descriptor.has_project_state && descriptor.project_state_bytes != 0)
        {
            return Err(HostFailure::Initialization);
        }
        let plugin_storage = Self::download_state_kind(
            process,
            descriptor,
            OpaqueStateKind::PluginStorage,
            descriptor.plugin_storage_bytes as usize,
        )?;
        let project_state = if descriptor.has_project_state {
            Some(Self::download_state_kind(
                process,
                descriptor,
                OpaqueStateKind::ProjectState,
                descriptor.project_state_bytes as usize,
            )?)
        } else {
            None
        };
        let state = PluginPersistedState {
            plugin_storage,
            project_state,
        };
        state.validate()?;
        Ok(state)
    }

    fn download_state_kind(
        process: &mut HostProcess,
        descriptor: &StateSnapshotDescriptor,
        kind: OpaqueStateKind,
        total_bytes: usize,
    ) -> Result<Vec<u8>, HostFailure> {
        let mut bytes = Vec::with_capacity(total_bytes.min(MAX_PLUGIN_STATE_CHUNK_BYTES));
        loop {
            let response = Self::process_request(
                process,
                envelope::Payload::GetStateChunkRequest(GetStateChunkRequest {
                    state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                    revision: descriptor.revision,
                    kind: kind as i32,
                    offset: bytes.len() as u64,
                    max_bytes: MAX_PLUGIN_STATE_CHUNK_BYTES as u32,
                }),
                REQUEST_TIMEOUT,
            )?;
            let chunk = match response.payload {
                Some(envelope::Payload::GetStateChunkResponse(response))
                    if response.state_schema_version == PLUGIN_STATE_SCHEMA_VERSION
                        && response.revision == descriptor.revision
                        && response.kind == kind as i32
                        && response.offset as usize == bytes.len()
                        && response.total_bytes as usize == total_bytes =>
                {
                    response.payload
                }
                _ => return Err(HostFailure::Initialization),
            };
            if chunk.len() > MAX_PLUGIN_STATE_CHUNK_BYTES
                || bytes.len().saturating_add(chunk.len()) > total_bytes
                || (chunk.is_empty() && bytes.len() < total_bytes)
            {
                return Err(HostFailure::Initialization);
            }
            bytes.extend_from_slice(&chunk);
            if bytes.len() == total_bytes {
                return Ok(bytes);
            }
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
        let state_key = PluginStatePersistenceKey {
            plugin_id: request.artifact.plugin_id.clone(),
            workspace_id: request.workspace_id.clone(),
            artifact_slot: request.artifact_slot.clone(),
            launch_mode: request.mode,
        };
        let plugin_storage = self
            .persistence
            .load_plugin_storage(&state_key)
            .inspect_err(|error| {
                tracing::warn!(?error, plugin_id = %request.artifact.plugin_id, "plugin storage load failed before host launch");
            })?
            .unwrap_or_else(empty_plugin_storage_payload);
        let initial_state = PluginPersistedState {
            plugin_storage,
            project_state: request.project_state.clone(),
        };
        initial_state.validate()?;
        if self
            .persistence
            .workspace_total_bytes(&request.workspace_id)?
            > MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES
        {
            return Err(HostFailure::Initialization);
        }
        if request
            .granted_permissions
            .iter()
            .any(|permission| permission.as_str().starts_with("network."))
        {
            return Err(HostFailure::SandboxUnavailable);
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
        let mut arguments = vec![
            OsString::from("--package-root"),
            package_root.as_os_str().to_owned(),
            OsString::from("--platform"),
            OsString::from(self.sandbox.platform_argument()),
            OsString::from("--memory-limit-bytes"),
            OsString::from(HOST_PROCESS_MEMORY_LIMIT_BYTES.to_string()),
            OsString::from("--sandbox-no-children"),
            OsString::from("--sandbox-no-network"),
            OsString::from("--sandbox-private-fs"),
        ];
        for permission in &request.granted_permissions {
            arguments.push(OsString::from("--grant"));
            arguments.push(OsString::from(permission.as_str()));
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
        let (sender, responses) = mpsc::sync_channel(32);
        let sink_cell = Arc::clone(&self.push_sink);
        if thread::Builder::new()
            .name(format!("plugin-host-{}", request.artifact.plugin_id))
            .spawn(move || {
                let mut reader = FrameReader::new(stdout);
                loop {
                    let response = reader.read_envelope().map_err(|_| HostFailure::Transport);
                    // Sidecar pushes bypass request/response matching: the
                    // guest call is parked inside the sidecar waiting for the
                    // pipeline, not for this reader's correlation. Sinks must
                    // only enqueue (never block) — this is the plugin's sole
                    // response pump.
                    if let Ok(Some(envelope)) = &response
                        && let Some(sink) = sink_cell.lock().ok().and_then(|guard| guard.clone())
                    {
                        match envelope.payload.as_ref() {
                            Some(envelope::Payload::SerialProposalEvent(event)) => {
                                sink.serial_proposal(event.clone());
                                continue;
                            }
                            Some(envelope::Payload::SessionQueryRequest(query)) => {
                                sink.session_query(query.clone());
                                continue;
                            }
                            _ => {}
                        }
                    }
                    let terminal = !matches!(response, Ok(Some(_)));
                    if sender.send(response).is_err() || terminal {
                        return;
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
            next_request_id: 1,
            state_key,
            initial_state,
            published_panel: None,
        };
        let granted_capabilities = request
            .granted_permissions
            .iter()
            .copied()
            .map(Permission::as_str)
            .map(str::to_owned)
            .collect();
        let handshake = Self::process_request(
            &mut process,
            envelope::Payload::HostHello(HostHello {
                wit_package: WIT_PACKAGE.to_owned(),
                plugin_id: request.artifact.plugin_id.clone(),
                plugin_version: request.artifact.version.clone(),
                granted_capabilities,
            }),
            Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
        );
        let handshake_valid = handshake.is_ok_and(|response| {
            matches!(
                response.payload,
                Some(envelope::Payload::PluginHello(hello))
                    if hello.plugin_id == request.artifact.plugin_id
                        && hello.plugin_version == request.artifact.version
                        && hello.wit_package == WIT_PACKAGE
            )
        });
        if !handshake_valid {
            tracing::warn!(plugin_id = %request.artifact.plugin_id, "plugin host handshake failed");
            terminate_child(&mut process.child);
            return Err(HostFailure::Handshake);
        }
        let instance_id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);
        if instance_id == 0 {
            terminate_child(&mut process.child);
            return Err(HostFailure::Launch);
        }
        let handle = HostHandle::new(
            instance_id,
            request.artifact.plugin_id.clone(),
            request.artifact.version.clone(),
        );
        let mut processes = match self.lock_processes() {
            Ok(processes) => processes,
            Err(error) => {
                terminate_child(&mut process.child);
                return Err(error);
            }
        };
        if processes
            .running
            .values()
            .any(|running| running.plugin_id == request.artifact.plugin_id)
        {
            terminate_child(&mut process.child);
            return Err(HostFailure::Launch);
        }
        if processes.running.contains_key(&instance_id) {
            terminate_child(&mut process.child);
            return Err(HostFailure::Launch);
        }
        processes.running.insert(instance_id, process);
        Ok(handle)
    }

    fn initialize(&mut self, handle: &HostHandle) -> Result<(), HostFailure> {
        let mut process = take_process(&self.processes, handle)?;
        let result = (|| {
            let plugin_storage = process.initial_state.plugin_storage.clone();
            let project_state = process.initial_state.project_state.clone();
            Self::upload_state(
                &mut process,
                OpaqueStateKind::PluginStorage,
                &plugin_storage,
            )?;
            if let Some(project_state) = project_state.as_ref() {
                Self::upload_state(&mut process, OpaqueStateKind::ProjectState, project_state)?;
            }
            let response = Self::process_request(
                &mut process,
                envelope::Payload::InitializeRequest(InitializeRequest {
                    state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                    has_plugin_storage: true,
                    has_project_state: project_state.is_some(),
                }),
                REQUEST_TIMEOUT,
            )?;
            let descriptor = match response.payload {
                Some(envelope::Payload::InitializeResponse(response)) => {
                    process.published_panel = parse_panel_json(&response.panel_json)?;
                    response.state.ok_or(HostFailure::Initialization)?
                }
                _ => return Err(HostFailure::Initialization),
            };
            let state = Self::download_state(&mut process, &descriptor)?;
            self.persistence.persist_state(&process.state_key, &state)?;
            process.initial_state = state;
            Ok(())
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
                envelope::Payload::ShutdownRequest(ShutdownRequest {
                    state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                }),
                REQUEST_TIMEOUT,
            )?;
            let descriptor = match response.payload {
                Some(envelope::Payload::ShutdownResponse(response)) => {
                    response.state.ok_or(HostFailure::Shutdown)?
                }
                _ => return Err(HostFailure::Shutdown),
            };
            let state = Self::download_state(&mut process, &descriptor)
                .map_err(|_| HostFailure::Shutdown)?;
            self.persistence
                .persist_state(&process.state_key, &state)
                .map_err(|_| HostFailure::Shutdown)?;
            let completed = Self::process_request(
                &mut process,
                envelope::Payload::CompleteShutdownRequest(CompleteShutdownRequest {
                    state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                    revision: descriptor.revision,
                }),
                REQUEST_TIMEOUT,
            )?;
            if !matches!(
                completed.payload,
                Some(envelope::Payload::CompleteShutdownResponse(_))
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
            Ok(()) => Ok(()),
            // Failure reinserts so the caller's terminate fallback (and the
            // exit monitor) can still find and kill the child.
            Err(error) => {
                reinsert_process(&self.processes, handle.instance_id, process);
                Err(error)
            }
        }
    }

    fn take_published_panel(
        &mut self,
        handle: &HostHandle,
    ) -> Result<Option<HostPanel>, HostFailure> {
        let mut processes = self.processes.lock().map_err(|_| HostFailure::Launch)?;
        Ok(exact_process(&mut processes, handle)?
            .published_panel
            .take())
    }

    fn invoke_panel_event(
        &mut self,
        handle: &HostHandle,
        field_id: &str,
        value: &str,
    ) -> Result<Option<HostPanel>, HostFailure> {
        let mut processes = self.processes.lock().map_err(|_| HostFailure::Launch)?;
        let process = exact_process(&mut processes, handle)?;
        let body = serde_json::to_vec(&serde_json::json!({
            "fieldId": field_id,
            "value": value,
        }))
        .map_err(|_| HostFailure::Transport)?;
        let response = Self::process_request(
            process,
            envelope::Payload::InvokeRequest(InvokeRequest {
                method: "panel-event".to_owned(),
                body,
                long_running: false,
            }),
            REQUEST_TIMEOUT,
        )?;
        let panel = match response.payload {
            Some(envelope::Payload::InvokeResponse(response)) => parse_panel_json(&response.body)?,
            _ => return Err(HostFailure::Transport),
        };
        process.published_panel = panel.clone();
        Ok(panel)
    }

    fn terminate(&mut self, handle: &HostHandle) {
        let Ok(mut processes) = self.processes.lock() else {
            return;
        };
        if let Some(mut process) = processes.running.remove(&handle.instance_id) {
            terminate_child(&mut process.child);
        }
    }

    fn deliver_envelope(
        &mut self,
        handle: &HostHandle,
        payload: envelope::Payload,
    ) -> Result<(), HostFailure> {
        let request_id = self.push_request_id.fetch_add(1, Ordering::Relaxed);
        let frame = encode_frame(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(payload),
        })
        .map_err(|_| HostFailure::Transport)?;
        let mut processes = self.lock_processes()?;
        let process = exact_process(&mut processes, handle)?;
        process
            .stdin
            .write_all(&frame)
            .and_then(|()| process.stdin.flush())
            .map_err(|_| HostFailure::Transport)
    }

    fn attach_push_sink(&mut self, sink: std::sync::Arc<dyn bbcom_plugin_manager::HostPushSink>) {
        if let Ok(mut current) = self.push_sink.lock() {
            *current = Some(sink);
        }
    }
}

fn receive_response(
    responses: &Receiver<Result<Option<Envelope>, HostFailure>>,
    timeout: Duration,
) -> Result<Envelope, HostFailure> {
    match responses.recv_timeout(timeout) {
        Ok(Ok(Some(envelope))) => Ok(envelope),
        Ok(Ok(None)) | Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => {
            Err(HostFailure::Transport)
        }
        Err(RecvTimeoutError::Timeout) => Err(HostFailure::Transport),
    }
}

fn parse_panel_json(bytes: &[u8]) -> Result<Option<HostPanel>, HostFailure> {
    if bytes.is_empty() || bytes == b"null" {
        return Ok(None);
    }
    let panel: HostPanelJson =
        serde_json::from_slice(bytes).map_err(|_| HostFailure::Initialization)?;
    let fields = panel
        .fields
        .into_iter()
        .map(|field| {
            let kind = match field.kind.as_str() {
                "text" => HostPanelFieldKind::Text,
                "number" => HostPanelFieldKind::Number,
                "toggle" => HostPanelFieldKind::Toggle,
                "select" => HostPanelFieldKind::Select,
                "button" => HostPanelFieldKind::Button,
                _ => return Err(HostFailure::Initialization),
            };
            Ok(HostPanelField {
                id: field.id,
                label: field.label,
                kind,
                value: field.value,
                options: field.options,
                disabled: field.disabled,
            })
        })
        .collect::<Result<Vec<_>, HostFailure>>()?;
    Ok(Some(HostPanel {
        title: panel.title,
        fields,
    }))
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

fn exact_process<'a>(
    processes: &'a mut HostProcesses,
    handle: &HostHandle,
) -> Result<&'a mut HostProcess, HostFailure> {
    processes
        .running
        .get_mut(&handle.instance_id)
        .filter(|process| {
            process.plugin_id == handle.plugin_id && process.version == handle.version
        })
        .ok_or(HostFailure::Transport)
}

fn terminate_child(child: &mut SandboxedChild) {
    child.terminate_and_wait();
}

#[cfg(test)]
mod tests {
    use super::*;

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
            protocol_minor: PROTOCOL_MINOR,
            request_id: 7,
            payload: None,
        };
        let (sender, receiver) = mpsc::channel();
        sender.send(Ok(Some(envelope.clone()))).unwrap();
        assert_eq!(
            receive_response(&receiver, Duration::from_millis(1))
                .unwrap()
                .request_id,
            7
        );
        sender.send(Ok(None)).unwrap();
        assert_eq!(
            receive_response(&receiver, Duration::from_millis(1)),
            Err(HostFailure::Transport)
        );
        sender.send(Err(HostFailure::Handshake)).unwrap();
        assert_eq!(
            receive_response(&receiver, Duration::from_millis(1)),
            Err(HostFailure::Transport)
        );
        drop(sender);
        assert_eq!(
            receive_response(&receiver, Duration::from_millis(1)),
            Err(HostFailure::Transport)
        );

        let (_sender, empty) = mpsc::channel();
        assert_eq!(
            receive_response(&empty, Duration::from_millis(1)),
            Err(HostFailure::Transport)
        );
    }
}
