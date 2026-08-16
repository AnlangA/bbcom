//! Fail-closed production composition root for the native plugin subsystem.
//!
//! This module deliberately does not discover paths, repositories, workspaces,
//! serial sessions or renderer catalog data. Native Tauri setup must resolve
//! every authority and provide it explicitly. [`ProductionPluginRuntimeBuilder`]
//! returns the reviewed IPC adapter only after the lifecycle manager has opened
//! the current workspace and the sidecar constructor has executed the platform
//! sandbox self-test.

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bbcom_contracts::RuntimeInstanceKey;
use bbcom_plugin_broker::{
    BrokerAction, PanelEvent, PanelEventAction, ProposalContext, ProposalDecision,
    SerialProposalView,
};
use bbcom_plugin_manager::{
    ManualPackageRequest, OpaqueProjectPluginState, PluginArtifact, PluginManager, PluginSnapshot,
    SystemClock, WorkspacePluginBinding,
};
use bbcom_plugin_repository::{DownloadedPackage, PluginInstaller};

use crate::commands::plugin::PluginCommandService as IpcPluginCommandService;

use super::command_adapter::{CatalogViewPort, NativePluginCommandAdapter};
use super::command_service::{
    PanelBrokerPort, PluginCommandError, PluginCommandService, PluginCommandSnapshot,
    PluginCommandUpstreamPort, PluginLifecyclePort, PluginOperationSnapshot, PluginUpstreamFailure,
    ProposalBrokerPort,
};
use super::host_launcher::{HostLauncherBuildError, PrivateArtifactRoot, SidecarHostLauncher};
use super::installation::{
    NativeRepositoryStagingBackend, RepositoryArtifactPathResolver, RepositoryInstallationPort,
    VerifiedPackageProvider,
};
use super::runtime_actor::{PluginRuntimeActorHandle, PluginWorkspaceBindingPort};
use super::sandbox::PlatformSandboxDriver;
use super::service::{PluginService, PluginServiceError};
use super::state::NativePluginStatePersistencePort;

/// Exact native workspace state used during plugin bootstrap.
///
/// Installed artifacts must come from repository-owned durable metadata. The
/// builder never derives an artifact or publisher identity from renderer data.
#[derive(Clone, Debug)]
pub struct CurrentPluginWorkspace {
    workspace_id: Option<String>,
    bindings: Vec<WorkspacePluginBinding>,
    project_states: Vec<OpaqueProjectPluginState>,
    installed_artifacts: Vec<PluginArtifact>,
}

impl CurrentPluginWorkspace {
    #[must_use]
    pub fn new(
        workspace_id: String,
        project_states: Vec<OpaqueProjectPluginState>,
        installed_artifacts: Vec<PluginArtifact>,
    ) -> Self {
        Self {
            workspace_id: Some(workspace_id),
            bindings: Vec::new(),
            project_states,
            installed_artifacts,
        }
    }

    #[must_use]
    pub fn with_bindings(mut self, bindings: Vec<WorkspacePluginBinding>) -> Self {
        self.bindings = bindings;
        self
    }

    #[must_use]
    pub fn detached(installed_artifacts: Vec<PluginArtifact>) -> Self {
        Self {
            workspace_id: None,
            bindings: Vec::new(),
            project_states: Vec::new(),
            installed_artifacts,
        }
    }
}

/// Application-owned data required by plugin hosts, excluding serial writes.
///
/// Keeping serial execution out of this port makes it impossible to construct
/// the production runtime without a separately reviewed serial scheduler.
pub trait PluginHostUpstreamPort: Send + 'static {
    fn current_proposal_context(
        &mut self,
        proposal: &SerialProposalView,
    ) -> Result<ProposalContext, PluginUpstreamFailure>;

    fn deliver_panel_event(
        &mut self,
        action: PanelEventAction,
    ) -> Result<(), PluginUpstreamFailure>;
}

/// The only production boundary allowed to execute an approved serial action.
pub trait PluginSerialSchedulerPort: Send + 'static {
    fn execute(
        &mut self,
        runtime: RuntimeInstanceKey,
        action: BrokerAction,
    ) -> Result<(), PluginUpstreamFailure>;
}

/// Process-lifetime lifecycle hooks retained by native application runtime.
pub trait PluginRuntimeLifecycle: Send + Sync + 'static {
    fn poll_host_exits(&self) -> Vec<Result<PluginSnapshot, PluginServiceError>>;
    fn open_workspace(
        &self,
        workspace_id: String,
        bindings: Vec<WorkspacePluginBinding>,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<(), PluginServiceError>;
    fn close_project(&self) -> Result<(), PluginServiceError>;
}

/// Fully composed plugin runtime. The command service is suitable for
/// `PluginCommandState`; lifecycle must be retained by the native runtime.
pub struct ProductionPluginRuntime {
    command_service: Arc<dyn IpcPluginCommandService>,
    lifecycle: Arc<dyn PluginRuntimeLifecycle>,
}

impl ProductionPluginRuntime {
    #[must_use]
    pub fn command_service(&self) -> Arc<dyn IpcPluginCommandService> {
        Arc::clone(&self.command_service)
    }

    #[must_use]
    pub fn lifecycle(&self) -> Arc<dyn PluginRuntimeLifecycle> {
        Arc::clone(&self.lifecycle)
    }
}

/// Stable fail-closed bootstrap failures. Missing dependencies are reported in
/// the declaration order used by [`ProductionPluginRuntimeBuilder::build`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginBootstrapError {
    MissingInstaller,
    MissingTrustedRepositoryProvider,
    MissingCatalog,
    MissingWorkspace,
    MissingStatePersistence,
    MissingSerialScheduler,
    MissingHostUpstream,
    MissingProposalBroker,
    MissingPanelBroker,
    MissingSandbox,
    MissingSidecarExecutable,
    MissingPrivateArtifactRoot,
    SidecarUnavailable,
    InstalledArtifactRejected,
    WorkspaceRejected,
    CommandServiceUnavailable,
}

impl PluginBootstrapError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::MissingInstaller => "PLUGIN_BOOTSTRAP_INSTALLER_MISSING",
            Self::MissingTrustedRepositoryProvider => "PLUGIN_BOOTSTRAP_TRUSTED_REPOSITORY_MISSING",
            Self::MissingCatalog => "PLUGIN_BOOTSTRAP_CATALOG_MISSING",
            Self::MissingWorkspace => "PLUGIN_BOOTSTRAP_WORKSPACE_MISSING",
            Self::MissingStatePersistence => "PLUGIN_BOOTSTRAP_STATE_STORE_MISSING",
            Self::MissingSerialScheduler => "PLUGIN_BOOTSTRAP_SERIAL_SCHEDULER_MISSING",
            Self::MissingHostUpstream => "PLUGIN_BOOTSTRAP_HOST_UPSTREAM_MISSING",
            Self::MissingProposalBroker => "PLUGIN_BOOTSTRAP_PROPOSAL_BROKER_MISSING",
            Self::MissingPanelBroker => "PLUGIN_BOOTSTRAP_PANEL_BROKER_MISSING",
            Self::MissingSandbox => "PLUGIN_BOOTSTRAP_SANDBOX_MISSING",
            Self::MissingSidecarExecutable => "PLUGIN_BOOTSTRAP_SIDECAR_MISSING",
            Self::MissingPrivateArtifactRoot => "PLUGIN_BOOTSTRAP_PRIVATE_ROOT_MISSING",
            Self::SidecarUnavailable => "PLUGIN_BOOTSTRAP_SIDECAR_UNAVAILABLE",
            Self::InstalledArtifactRejected => "PLUGIN_BOOTSTRAP_ARTIFACT_REJECTED",
            Self::WorkspaceRejected => "PLUGIN_BOOTSTRAP_WORKSPACE_REJECTED",
            Self::CommandServiceUnavailable => "PLUGIN_BOOTSTRAP_COMMAND_SERVICE_UNAVAILABLE",
        }
    }
}

impl fmt::Display for PluginBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for PluginBootstrapError {}

/// Production-only builder. There are no permissive defaults.
#[derive(Default)]
pub struct ProductionPluginRuntimeBuilder {
    installer: Option<Arc<PluginInstaller>>,
    repository: Option<DynVerifiedPackageProvider>,
    catalog: Option<Box<dyn CatalogViewPort>>,
    workspace: Option<CurrentPluginWorkspace>,
    state: Option<NativePluginStatePersistencePort>,
    serial: Option<DynSerialScheduler>,
    host_upstream: Option<DynHostUpstream>,
    proposals: Option<Box<dyn ProposalBrokerPort + Send>>,
    panels: Option<Box<dyn PanelBrokerPort + Send>>,
    sandbox: Option<PlatformSandboxDriver>,
    sidecar_executable: Option<PathBuf>,
    private_artifact_root: Option<PrivateArtifactRoot>,
    workspace_bindings: Option<Arc<dyn PluginWorkspaceBindingPort>>,
}

impl ProductionPluginRuntimeBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn installer(mut self, installer: Arc<PluginInstaller>) -> Self {
        self.installer = Some(installer);
        self
    }

    #[must_use]
    pub fn trusted_repository<S>(mut self, repository: S) -> Self
    where
        S: VerifiedPackageProvider + Send + 'static,
    {
        self.repository = Some(DynVerifiedPackageProvider(Box::new(
            VerifiedPackageProviderAdapter(repository),
        )));
        self
    }

    #[must_use]
    pub fn catalog<V>(mut self, catalog: V) -> Self
    where
        V: CatalogViewPort,
    {
        self.catalog = Some(Box::new(catalog));
        self
    }

    #[must_use]
    pub fn workspace(mut self, workspace: CurrentPluginWorkspace) -> Self {
        self.workspace = Some(workspace);
        self
    }

    #[must_use]
    pub fn state_persistence(mut self, state: NativePluginStatePersistencePort) -> Self {
        self.state = Some(state);
        self
    }

    #[must_use]
    pub fn serial_scheduler<S>(mut self, serial: S) -> Self
    where
        S: PluginSerialSchedulerPort,
    {
        self.serial = Some(DynSerialScheduler(Box::new(serial)));
        self
    }

    #[must_use]
    pub fn host_upstream<U>(mut self, upstream: U) -> Self
    where
        U: PluginHostUpstreamPort,
    {
        self.host_upstream = Some(DynHostUpstream(Box::new(upstream)));
        self
    }

    #[must_use]
    pub fn proposal_broker<P>(mut self, proposals: P) -> Self
    where
        P: ProposalBrokerPort + Send + 'static,
    {
        self.proposals = Some(Box::new(proposals));
        self
    }

    #[must_use]
    pub fn panel_broker<P>(mut self, panels: P) -> Self
    where
        P: PanelBrokerPort + Send + 'static,
    {
        self.panels = Some(Box::new(panels));
        self
    }

    #[must_use]
    pub fn sandbox(mut self, sandbox: PlatformSandboxDriver) -> Self {
        self.sandbox = Some(sandbox);
        self
    }

    #[must_use]
    pub fn sidecar_executable(mut self, path: PathBuf) -> Self {
        self.sidecar_executable = Some(path);
        self
    }

    #[must_use]
    pub fn private_artifact_root(mut self, root: PrivateArtifactRoot) -> Self {
        self.private_artifact_root = Some(root);
        self
    }

    #[must_use]
    pub fn workspace_bindings<P>(mut self, port: P) -> Self
    where
        P: PluginWorkspaceBindingPort,
    {
        self.workspace_bindings = Some(Arc::new(port));
        self
    }

    pub fn build(self) -> Result<ProductionPluginRuntime, PluginBootstrapError> {
        // Keep this extraction order stable: it is the deterministic missing
        // dependency precedence used by native setup and diagnostics.
        let installer = self
            .installer
            .ok_or(PluginBootstrapError::MissingInstaller)?;
        let repository = self
            .repository
            .ok_or(PluginBootstrapError::MissingTrustedRepositoryProvider)?;
        let catalog = self.catalog.ok_or(PluginBootstrapError::MissingCatalog)?;
        let workspace = self
            .workspace
            .ok_or(PluginBootstrapError::MissingWorkspace)?;
        let state = self
            .state
            .ok_or(PluginBootstrapError::MissingStatePersistence)?;
        let serial = self
            .serial
            .ok_or(PluginBootstrapError::MissingSerialScheduler)?;
        let host_upstream = self
            .host_upstream
            .ok_or(PluginBootstrapError::MissingHostUpstream)?;
        let proposals = self
            .proposals
            .ok_or(PluginBootstrapError::MissingProposalBroker)?;
        let panels = self
            .panels
            .ok_or(PluginBootstrapError::MissingPanelBroker)?;
        let sandbox = self.sandbox.ok_or(PluginBootstrapError::MissingSandbox)?;
        let sidecar_executable = self
            .sidecar_executable
            .ok_or(PluginBootstrapError::MissingSidecarExecutable)?;
        let private_artifact_root = self
            .private_artifact_root
            .ok_or(PluginBootstrapError::MissingPrivateArtifactRoot)?;
        let workspace_bindings = self
            .workspace_bindings
            .ok_or(PluginBootstrapError::MissingWorkspace)?;

        let resolver = RepositoryArtifactPathResolver::new(Arc::clone(&installer));
        let (hosts, exits) = SidecarHostLauncher::new(
            sidecar_executable,
            private_artifact_root,
            resolver,
            sandbox,
            state,
        )
        .map_err(map_sidecar_error)?;

        let backend = NativeRepositoryStagingBackend::new(installer, repository);
        let installation = RepositoryInstallationPort::new(backend);
        let manager = PluginManager::new(installation, hosts, SystemClock);
        let lifecycle = Arc::new(PluginService::new(manager, exits));

        for artifact in workspace.installed_artifacts {
            lifecycle
                .observe_installed(artifact)
                .map_err(|_| PluginBootstrapError::InstalledArtifactRejected)?;
        }
        if let Some(workspace_id) = workspace.workspace_id {
            lifecycle
                .open_workspace(workspace_id, workspace.bindings, workspace.project_states)
                .map_err(|_| PluginBootstrapError::WorkspaceRejected)?;
        }

        let upstream = SplitPluginUpstream {
            host: host_upstream,
            serial,
        };
        let lifecycle_port: Arc<dyn PluginLifecyclePort + Send + Sync> = lifecycle.clone();
        let core = PluginCommandService::new(lifecycle_port, Box::new(upstream), proposals, panels)
            .map_err(|_| PluginBootstrapError::CommandServiceUnavailable)?;
        let core = RefreshingCommandCore::new(core);
        let adapter = NativePluginCommandAdapter::new(Box::new(core), catalog, SystemClock);
        let lifecycle: Arc<dyn PluginRuntimeLifecycle> = lifecycle;
        let actor = PluginRuntimeActorHandle::spawn(adapter, lifecycle, workspace_bindings)
            .map_err(|_| PluginBootstrapError::CommandServiceUnavailable)?;
        let command_service: Arc<dyn IpcPluginCommandService> = Arc::new(actor.clone());
        let lifecycle: Arc<dyn PluginRuntimeLifecycle> = Arc::new(actor);
        Ok(ProductionPluginRuntime {
            command_service,
            lifecycle,
        })
    }
}

fn map_sidecar_error(_error: HostLauncherBuildError) -> PluginBootstrapError {
    PluginBootstrapError::SidecarUnavailable
}

type ProductionInstallation =
    RepositoryInstallationPort<NativeRepositoryStagingBackend<DynVerifiedPackageProvider>>;
type ProductionHost = SidecarHostLauncher<
    RepositoryArtifactPathResolver,
    PlatformSandboxDriver,
    NativePluginStatePersistencePort,
>;
type ProductionLifecycle = PluginService<ProductionInstallation, ProductionHost, SystemClock>;

impl PluginRuntimeLifecycle for ProductionLifecycle {
    fn poll_host_exits(&self) -> Vec<Result<PluginSnapshot, PluginServiceError>> {
        PluginService::poll_host_exits(self)
    }

    fn close_project(&self) -> Result<(), PluginServiceError> {
        PluginService::close_project(self)
    }

    fn open_workspace(
        &self,
        workspace_id: String,
        bindings: Vec<WorkspacePluginBinding>,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<(), PluginServiceError> {
        PluginService::open_workspace(self, workspace_id, bindings, states).map(|_| ())
    }
}

/// Synchronizes manager changes caused by native host-exit polling before the
/// next renderer-visible snapshot. Mutating command paths already update their
/// cached snapshots as part of the same serialized command operation.
struct RefreshingCommandCore {
    inner: Mutex<PluginCommandService>,
}

impl RefreshingCommandCore {
    fn new(inner: PluginCommandService) -> Self {
        Self {
            inner: Mutex::new(inner),
        }
    }

    fn mutable(&mut self) -> &mut PluginCommandService {
        self.inner
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl super::command_adapter::PluginCommandCorePort for RefreshingCommandCore {
    fn snapshot(&self) -> PluginCommandSnapshot {
        let mut core = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = core.refresh_lifecycle();
        core.snapshot()
    }

    fn queue_install(
        &mut self,
        revision: u64,
        request_id: String,
        request: ManualPackageRequest,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable().queue_install(revision, request_id, request)
    }

    fn queue_set_enabled(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_set_enabled(revision, request_id, plugin_id, enabled)
    }

    fn queue_proposal_decision(
        &mut self,
        revision: u64,
        request_id: String,
        proposal_id: String,
        decision: ProposalDecision,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_proposal_decision(revision, request_id, proposal_id, decision)
    }

    fn queue_panel_event(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        event: PanelEvent,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_panel_event(revision, request_id, plugin_id, event)
    }

    fn execute_operation(
        &mut self,
        operation_id: &str,
        now_ms: u64,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable().execute(operation_id, now_ms)
    }

    fn cancel_operation(
        &mut self,
        revision: u64,
        operation_id: &str,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable().cancel(revision, operation_id)
    }

    fn queue_install_local(
        &mut self,
        revision: u64,
        request_id: String,
        package_root: std::path::PathBuf,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_install_local(revision, request_id, package_root)
    }

    fn queue_uninstall(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_uninstall(revision, request_id, plugin_id)
    }
}

trait ErasedVerifiedPackageProvider: Send {
    fn download_verified(
        &mut self,
        request: &ManualPackageRequest,
    ) -> Result<DownloadedPackage, ()>;
}

struct VerifiedPackageProviderAdapter<S>(S);

impl<S> ErasedVerifiedPackageProvider for VerifiedPackageProviderAdapter<S>
where
    S: VerifiedPackageProvider + Send,
{
    fn download_verified(
        &mut self,
        request: &ManualPackageRequest,
    ) -> Result<DownloadedPackage, ()> {
        self.0.download_verified(request).map_err(|_| ())
    }
}

struct DynVerifiedPackageProvider(Box<dyn ErasedVerifiedPackageProvider>);

impl VerifiedPackageProvider for DynVerifiedPackageProvider {
    type Error = ();

    fn download_verified(
        &mut self,
        request: &ManualPackageRequest,
    ) -> Result<DownloadedPackage, Self::Error> {
        self.0.download_verified(request)
    }
}

struct DynHostUpstream(Box<dyn PluginHostUpstreamPort>);
struct DynSerialScheduler(Box<dyn PluginSerialSchedulerPort>);

struct SplitPluginUpstream {
    host: DynHostUpstream,
    serial: DynSerialScheduler,
}

impl PluginCommandUpstreamPort for SplitPluginUpstream {
    fn current_proposal_context(
        &mut self,
        proposal: &SerialProposalView,
    ) -> Result<ProposalContext, PluginUpstreamFailure> {
        self.host.0.current_proposal_context(proposal)
    }

    fn execute_serial_action(
        &mut self,
        runtime: RuntimeInstanceKey,
        action: BrokerAction,
    ) -> Result<(), PluginUpstreamFailure> {
        self.serial.0.execute(runtime, action)
    }

    fn deliver_panel_event(
        &mut self,
        action: PanelEventAction,
    ) -> Result<(), PluginUpstreamFailure> {
        self.host.0.deliver_panel_event(action)
    }
}
