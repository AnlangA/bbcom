//! Fail-closed production composition root for the native plugin subsystem.
//!
//! This module deliberately does not discover paths, repositories, workspaces,
//! serial sessions or renderer catalog data. Native Tauri setup must resolve
//! every authority and provide it explicitly. [`ProductionPluginRuntimeBuilder`]
//! returns the reviewed IPC adapter only after the lifecycle manager has opened
//! the current workspace and the sidecar constructor has executed the platform
//! sandbox self-test.

use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bbcom_contracts::PluginContributionDisposition;
use bbcom_plugin_broker::PluginCapabilityGateway;
use bbcom_plugin_host::PluginAuthorizationGate;
use bbcom_plugin_manager::{
    ManualPackageRequest, OpaqueProjectPluginState, PluginArtifact, PluginManager, PluginSnapshot,
    SystemClock, WorkspacePluginBinding,
};
use bbcom_plugin_repository::{DownloadedPackage, PluginInstaller};

use crate::commands::plugin::PluginCommandService as IpcPluginCommandService;

use super::command_adapter::{CatalogViewPort, NativePluginCommandAdapter};
use super::command_service::{
    PluginCommandError, PluginCommandService, PluginCommandSnapshot, PluginContributionCleanupPort,
    PluginLifecyclePort, PluginOperationFailure, PluginOperationSnapshot,
};
use super::host_launcher::{
    HostLauncherBuildError, PluginHostContextProviderV2, PluginHostServicesV2,
    PluginProjectStateProviderV2, PrivateArtifactRoot, SidecarHostLauncher,
};
use super::installation::{
    NativeRepositoryStagingBackend, RepositoryArtifactPathResolver, RepositoryInstallationPort,
    VerifiedPackageProvider,
};
use super::runtime_actor::{PluginRuntimeActorHandle, PluginWorkspaceBindingPort};
use super::sandbox::PlatformSandboxDriver;
use super::service::{PluginService, PluginServiceError};
use super::state::SharedNativePluginStatePersistencePort;

struct WorkspaceContributionCleanup(Arc<dyn PluginWorkspaceBindingPort>);

impl PluginContributionCleanupPort for WorkspaceContributionCleanup {
    fn uninstall_with_contribution_cleanup(
        &self,
        plugin_id: &str,
        disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> Result<PluginSnapshot, PluginOperationFailure>,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        let mut uninstall_outcome = None;
        let staged =
            self.0
                .uninstall_with_contribution_cleanup(plugin_id, disposition, &mut || {
                    let outcome = uninstall();
                    let succeeded = outcome.is_ok();
                    uninstall_outcome = Some(outcome);
                    succeeded
                });
        match (staged, uninstall_outcome) {
            (Ok(true), Some(Ok(snapshot))) => Ok(snapshot),
            (Ok(false), Some(Err(failure))) => Err(failure),
            (Err(()), None) => Err(PluginOperationFailure {
                code: "PLUGIN_CONTRIBUTION_CLEANUP_FAILED",
                message_key: "plugin.error.contributionCleanupFailed",
            }),
            (Err(()), Some(Err(_))) => Err(PluginOperationFailure {
                code: "PLUGIN_CONTRIBUTION_ROLLBACK_FAILED",
                message_key: "plugin.error.contributionCleanupFailed",
            }),
            // Package removal is the irreversible commit point. If a later
            // workspace commit reports an I/O failure, the durable intent is
            // retained and startup finishes cleanup before any guest launch;
            // never report Failed and invite outer authorization/state undo.
            (Err(()), Some(Ok(snapshot))) => {
                tracing::warn!(
                    plugin_id,
                    "plugin contribution cleanup deferred to recovery"
                );
                Ok(snapshot)
            }
            _ => Err(PluginOperationFailure {
                code: "PLUGIN_CONTRIBUTION_CLEANUP_FAILED",
                message_key: "plugin.error.contributionCleanupFailed",
            }),
        }
    }
}

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
    /// Push a protocol-v2 event/cancel/stream payload into a running sidecar.
    fn deliver_envelope(
        &self,
        _plugin_id: &str,
        _payload: bbcom_plugin_contracts::generated_v2::envelope::Payload,
    ) -> Result<(), PluginServiceError> {
        Err(PluginServiceError::StatePoisoned)
    }
    /// Sends a path-free serial-port membership event only to authorized,
    /// currently running runtimes. Target selection is native-owned.
    fn notify_port_catalog_changed(&self) -> Result<usize, PluginServiceError> {
        Err(PluginServiceError::StatePoisoned)
    }
    fn notify_host_context_changed(
        &self,
        _locale: Option<String>,
        _theme: Option<bbcom_plugin_contracts::generated_v2::ColorScheme>,
    ) -> Result<usize, PluginServiceError> {
        Err(PluginServiceError::StatePoisoned)
    }
}

/// Fully composed plugin runtime. The command service is suitable for
/// `PluginCommandState`; lifecycle must be retained by the native runtime.
pub struct ProductionPluginRuntime {
    command_service: Arc<dyn IpcPluginCommandService>,
    lifecycle: Arc<dyn PluginRuntimeLifecycle>,
    private_state: SharedNativePluginStatePersistencePort,
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

    #[must_use]
    pub fn private_state(&self) -> SharedNativePluginStatePersistencePort {
        self.private_state.clone()
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
    MissingSandbox,
    MissingSidecarExecutable,
    MissingPrivateArtifactRoot,
    MissingAuthorizationGate,
    MissingCapabilityGateway,
    MissingHostContext,
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
            Self::MissingSandbox => "PLUGIN_BOOTSTRAP_SANDBOX_MISSING",
            Self::MissingSidecarExecutable => "PLUGIN_BOOTSTRAP_SIDECAR_MISSING",
            Self::MissingPrivateArtifactRoot => "PLUGIN_BOOTSTRAP_PRIVATE_ROOT_MISSING",
            Self::MissingAuthorizationGate => "PLUGIN_BOOTSTRAP_AUTHORIZATION_GATE_MISSING",
            Self::MissingCapabilityGateway => "PLUGIN_BOOTSTRAP_CAPABILITY_GATEWAY_MISSING",
            Self::MissingHostContext => "PLUGIN_BOOTSTRAP_HOST_CONTEXT_MISSING",
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
    state: Option<SharedNativePluginStatePersistencePort>,
    sandbox: Option<PlatformSandboxDriver>,
    sidecar_executable: Option<PathBuf>,
    private_artifact_root: Option<PrivateArtifactRoot>,
    workspace_bindings: Option<Arc<dyn PluginWorkspaceBindingPort>>,
    authorization_gate: Option<Arc<dyn PluginAuthorizationGate>>,
    capability_gateway: Option<Arc<dyn PluginCapabilityGateway>>,
    host_context: Option<Arc<dyn PluginHostContextProviderV2>>,
    project_state: Option<Arc<dyn PluginProjectStateProviderV2>>,
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
    pub fn state_persistence(mut self, state: SharedNativePluginStatePersistencePort) -> Self {
        self.state = Some(state);
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

    #[must_use]
    pub fn authorization_gate(mut self, gate: Arc<dyn PluginAuthorizationGate>) -> Self {
        self.authorization_gate = Some(gate);
        self
    }

    #[must_use]
    pub fn capability_gateway(mut self, gateway: Arc<dyn PluginCapabilityGateway>) -> Self {
        self.capability_gateway = Some(gateway);
        self
    }

    #[must_use]
    pub fn host_context_provider(mut self, provider: Arc<dyn PluginHostContextProviderV2>) -> Self {
        self.host_context = Some(provider);
        self
    }

    #[must_use]
    pub fn project_state_provider(
        mut self,
        provider: Arc<dyn PluginProjectStateProviderV2>,
    ) -> Self {
        self.project_state = Some(provider);
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
        let authorization_gate = self
            .authorization_gate
            .ok_or(PluginBootstrapError::MissingAuthorizationGate)?;
        let capability_gateway = self
            .capability_gateway
            .ok_or(PluginBootstrapError::MissingCapabilityGateway)?;
        let host_context = self
            .host_context
            .ok_or(PluginBootstrapError::MissingHostContext)?;
        let project_state = self
            .project_state
            .ok_or(PluginBootstrapError::MissingWorkspace)?;

        let resolver = RepositoryArtifactPathResolver::new(Arc::clone(&installer));
        let private_state = state.clone();
        let (hosts, exits) = SidecarHostLauncher::new_with_v2_services(
            sidecar_executable,
            private_artifact_root,
            resolver,
            sandbox,
            state,
            PluginHostServicesV2::new(
                authorization_gate,
                capability_gateway,
                host_context,
                project_state,
            ),
        )
        .map_err(map_sidecar_error)?;
        let backend = NativeRepositoryStagingBackend::new(installer, repository);
        let installation = RepositoryInstallationPort::new(backend);
        let manager = PluginManager::new(installation, hosts, SystemClock);
        let lifecycle = Arc::new(PluginService::new(manager, exits));

        let installed_plugin_ids = workspace
            .installed_artifacts
            .iter()
            .map(|artifact| artifact.plugin_id.clone())
            .collect::<BTreeSet<_>>();
        for artifact in workspace.installed_artifacts {
            lifecycle
                .observe_installed(artifact)
                .map_err(|_| PluginBootstrapError::InstalledArtifactRejected)?;
        }
        workspace_bindings
            .recover_contribution_uninstall(&installed_plugin_ids)
            .map_err(|()| PluginBootstrapError::WorkspaceRejected)?;
        if let Some(workspace_id) = workspace.workspace_id {
            lifecycle
                .open_workspace(workspace_id, workspace.bindings, workspace.project_states)
                .map_err(|_| PluginBootstrapError::WorkspaceRejected)?;
        }

        let lifecycle_port: Arc<dyn PluginLifecyclePort + Send + Sync> = lifecycle.clone();
        let contribution_cleanup: Arc<dyn PluginContributionCleanupPort> = Arc::new(
            WorkspaceContributionCleanup(Arc::clone(&workspace_bindings)),
        );
        let core = PluginCommandService::new_with_contribution_cleanup(
            lifecycle_port,
            contribution_cleanup,
        )
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
            private_state,
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
    SharedNativePluginStatePersistencePort,
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

    fn deliver_envelope(
        &self,
        plugin_id: &str,
        payload: bbcom_plugin_contracts::generated_v2::envelope::Payload,
    ) -> Result<(), PluginServiceError> {
        PluginService::deliver_envelope(self, plugin_id, payload)
    }

    fn notify_port_catalog_changed(&self) -> Result<usize, PluginServiceError> {
        PluginService::notify_port_catalog_changed(self)
    }

    fn notify_host_context_changed(
        &self,
        locale: Option<String>,
        theme: Option<bbcom_plugin_contracts::generated_v2::ColorScheme>,
    ) -> Result<usize, PluginServiceError> {
        PluginService::notify_host_context_changed(self, locale, theme)
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
        contribution_disposition: PluginContributionDisposition,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_uninstall(revision, request_id, plugin_id, contribution_disposition)
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
