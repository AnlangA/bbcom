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

use bbcom_plugin_broker::{
    AuditEvent, AuditSink, AuthorizationBroker, AuthorizationReview, AuthorizationState,
    BrokerAction, BrokerError, DeclarativePanel, HostedPanel, PanelEvent, PanelEventAction,
    ProposalContext, ProposalDecision, ProposalResolution, SerialProposalRequest,
    SerialProposalView,
};
use bbcom_plugin_contracts::{AuthorizationKey, Permission, permission_plan};
use bbcom_plugin_manager::{
    ManualPackageRequest, OpaqueProjectPluginState, PluginArtifact, PluginManager, PluginSnapshot,
    SystemClock,
};
use bbcom_plugin_repository::{DownloadedPackage, PluginInstaller};

use crate::commands::plugin::PluginCommandService as IpcPluginCommandService;

use super::command_adapter::{
    CatalogPluginRecord, CatalogViewFailure, CatalogViewPort, NativePluginCommandAdapter,
    PluginDisplayRecord,
};
use super::command_service::{
    AuthorizationBrokerPort, AuthorizationSubject, PanelBrokerPort, PluginCommandError,
    PluginCommandService, PluginCommandSnapshot, PluginCommandUpstreamPort,
    PluginOperationSnapshot, PluginUpstreamFailure, ProposalBrokerPort,
    ReviewedAuthorizationReceipt,
};
use super::host_launcher::{HostLauncherBuildError, PrivateArtifactRoot, SidecarHostLauncher};
use super::installation::{
    NativeRepositoryStagingBackend, RepositoryArtifactPathResolver, RepositoryInstallationPort,
    VerifiedPackageProvider,
};
use super::sandbox::PlatformSandboxDriver;
use super::security::NativePluginSecurityStore;
use super::service::{PluginService, PluginServiceError};
use super::state::NativePluginStatePersistencePort;

/// Exact native workspace state used during plugin bootstrap.
///
/// Installed artifacts must come from repository-owned durable metadata. The
/// builder never derives an artifact or publisher identity from renderer data.
#[derive(Clone, Debug)]
pub struct CurrentPluginWorkspace {
    workspace_id: String,
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
            workspace_id,
            project_states,
            installed_artifacts,
        }
    }
}

/// Application-owned data required by plugin hosts, excluding serial writes.
///
/// Keeping serial execution out of this port makes it impossible to construct
/// the production runtime without a separately reviewed serial scheduler.
pub trait PluginHostUpstreamPort: Send + 'static {
    fn authorization_subject(
        &mut self,
        plugin_id: &str,
    ) -> Result<AuthorizationSubject, PluginUpstreamFailure>;

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
    fn execute(&mut self, action: BrokerAction) -> Result<(), PluginUpstreamFailure>;
}

/// Process-lifetime lifecycle hooks retained by native application runtime.
pub trait PluginRuntimeLifecycle: Send + Sync + 'static {
    fn poll_host_exits(&self) -> Vec<Result<PluginSnapshot, PluginServiceError>>;
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
    MissingSecurityStore,
    MissingStatePersistence,
    MissingSerialScheduler,
    MissingHostUpstream,
    MissingAuthorizationAudit,
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
            Self::MissingSecurityStore => "PLUGIN_BOOTSTRAP_SECURITY_STORE_MISSING",
            Self::MissingStatePersistence => "PLUGIN_BOOTSTRAP_STATE_STORE_MISSING",
            Self::MissingSerialScheduler => "PLUGIN_BOOTSTRAP_SERIAL_SCHEDULER_MISSING",
            Self::MissingHostUpstream => "PLUGIN_BOOTSTRAP_HOST_UPSTREAM_MISSING",
            Self::MissingAuthorizationAudit => "PLUGIN_BOOTSTRAP_AUTH_AUDIT_MISSING",
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
    catalog: Option<DynCatalog>,
    workspace: Option<CurrentPluginWorkspace>,
    security: Option<NativePluginSecurityStore>,
    state: Option<NativePluginStatePersistencePort>,
    serial: Option<DynSerialScheduler>,
    host_upstream: Option<DynHostUpstream>,
    audit: Option<Arc<dyn AuditSink>>,
    proposals: Option<DynProposalBroker>,
    panels: Option<DynPanelBroker>,
    sandbox: Option<PlatformSandboxDriver>,
    sidecar_executable: Option<PathBuf>,
    private_artifact_root: Option<PrivateArtifactRoot>,
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
        self.catalog = Some(DynCatalog(Box::new(catalog)));
        self
    }

    #[must_use]
    pub fn workspace(mut self, workspace: CurrentPluginWorkspace) -> Self {
        self.workspace = Some(workspace);
        self
    }

    #[must_use]
    pub fn security_store(mut self, security: NativePluginSecurityStore) -> Self {
        self.security = Some(security);
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
    pub fn authorization_audit<A>(mut self, audit: Arc<A>) -> Self
    where
        A: AuditSink + 'static,
    {
        self.audit = Some(audit);
        self
    }

    #[must_use]
    pub fn proposal_broker<P>(mut self, proposals: P) -> Self
    where
        P: ProposalBrokerPort + Send + 'static,
    {
        self.proposals = Some(DynProposalBroker(Box::new(proposals)));
        self
    }

    #[must_use]
    pub fn panel_broker<P>(mut self, panels: P) -> Self
    where
        P: PanelBrokerPort + Send + 'static,
    {
        self.panels = Some(DynPanelBroker(Box::new(panels)));
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
        let security = self
            .security
            .ok_or(PluginBootstrapError::MissingSecurityStore)?;
        let state = self
            .state
            .ok_or(PluginBootstrapError::MissingStatePersistence)?;
        let serial = self
            .serial
            .ok_or(PluginBootstrapError::MissingSerialScheduler)?;
        let host_upstream = self
            .host_upstream
            .ok_or(PluginBootstrapError::MissingHostUpstream)?;
        let audit = self
            .audit
            .ok_or(PluginBootstrapError::MissingAuthorizationAudit)?;
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
        let manager = PluginManager::new(
            installation,
            hosts,
            security.clone(),
            security.clone(),
            SystemClock,
        );
        let lifecycle = Arc::new(PluginService::new(manager, exits));

        for artifact in workspace.installed_artifacts {
            lifecycle
                .observe_installed(artifact)
                .map_err(|_| PluginBootstrapError::InstalledArtifactRejected)?;
        }
        lifecycle
            .open_project(workspace.workspace_id, workspace.project_states)
            .map_err(|_| PluginBootstrapError::WorkspaceRejected)?;

        let upstream = SplitPluginUpstream {
            host: host_upstream,
            serial,
        };
        let authorization = NativeAuthorizationBroker {
            store: security,
            audit: DynAuditSink(audit),
            lifecycle: Arc::clone(&lifecycle),
        };
        let core = PluginCommandService::new(
            Arc::clone(&lifecycle),
            upstream,
            authorization,
            proposals,
            panels,
        )
        .map_err(|_| PluginBootstrapError::CommandServiceUnavailable)?;
        let core = RefreshingCommandCore::new(core);
        let command_service: Arc<dyn IpcPluginCommandService> =
            Arc::new(NativePluginCommandAdapter::new(core, catalog, SystemClock));
        let lifecycle: Arc<dyn PluginRuntimeLifecycle> = lifecycle;
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
type ProductionLifecycle = PluginService<
    ProductionInstallation,
    ProductionHost,
    NativePluginSecurityStore,
    NativePluginSecurityStore,
    SystemClock,
>;
type ProductionCommandCore = PluginCommandService<
    Arc<ProductionLifecycle>,
    SplitPluginUpstream,
    NativeAuthorizationBroker,
    DynProposalBroker,
    DynPanelBroker,
>;

impl PluginRuntimeLifecycle for ProductionLifecycle {
    fn poll_host_exits(&self) -> Vec<Result<PluginSnapshot, PluginServiceError>> {
        PluginService::poll_host_exits(self)
    }

    fn close_project(&self) -> Result<(), PluginServiceError> {
        PluginService::close_project(self)
    }
}

/// Synchronizes manager changes caused by native host-exit polling before the
/// next renderer-visible snapshot. Mutating command paths already update their
/// cached snapshots as part of the same serialized command operation.
struct RefreshingCommandCore {
    inner: Mutex<ProductionCommandCore>,
}

impl RefreshingCommandCore {
    fn new(inner: ProductionCommandCore) -> Self {
        Self {
            inner: Mutex::new(inner),
        }
    }

    fn mutable(&mut self) -> &mut ProductionCommandCore {
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

    fn queue_authorization_decisions(
        &mut self,
        revision: u64,
        request_id: String,
        review_id: String,
        decisions: Vec<(Permission, AuthorizationState)>,
        per_request_acknowledged: std::collections::BTreeSet<Permission>,
        extra_confirmation_acknowledged: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable().queue_authorization_decisions(
            revision,
            request_id,
            review_id,
            decisions,
            per_request_acknowledged,
            extra_confirmation_acknowledged,
        )
    }

    fn queue_dismiss_authorization(
        &mut self,
        revision: u64,
        request_id: String,
        review_id: String,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.mutable()
            .queue_dismiss_authorization(revision, request_id, review_id)
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

struct DynCatalog(Box<dyn CatalogViewPort>);

impl CatalogViewPort for DynCatalog {
    fn catalog(&mut self) -> Result<Vec<CatalogPluginRecord>, CatalogViewFailure> {
        self.0.catalog()
    }

    fn plugin_display(
        &mut self,
        plugin_id: &str,
    ) -> Result<PluginDisplayRecord, CatalogViewFailure> {
        self.0.plugin_display(plugin_id)
    }

    fn session_label(&mut self, session_id: &str) -> Result<String, CatalogViewFailure> {
        self.0.session_label(session_id)
    }
}

struct DynHostUpstream(Box<dyn PluginHostUpstreamPort>);
struct DynSerialScheduler(Box<dyn PluginSerialSchedulerPort>);

struct SplitPluginUpstream {
    host: DynHostUpstream,
    serial: DynSerialScheduler,
}

impl PluginCommandUpstreamPort for SplitPluginUpstream {
    fn authorization_subject(
        &mut self,
        plugin_id: &str,
    ) -> Result<AuthorizationSubject, PluginUpstreamFailure> {
        self.host.0.authorization_subject(plugin_id)
    }

    fn current_proposal_context(
        &mut self,
        proposal: &SerialProposalView,
    ) -> Result<ProposalContext, PluginUpstreamFailure> {
        self.host.0.current_proposal_context(proposal)
    }

    fn execute_serial_action(&mut self, action: BrokerAction) -> Result<(), PluginUpstreamFailure> {
        self.serial.0.execute(action)
    }

    fn deliver_panel_event(
        &mut self,
        action: PanelEventAction,
    ) -> Result<(), PluginUpstreamFailure> {
        self.host.0.deliver_panel_event(action)
    }
}

struct DynAuditSink(Arc<dyn AuditSink>);

impl AuditSink for DynAuditSink {
    fn record(&self, event: AuditEvent) {
        self.0.record(event);
    }
}

struct NativeAuthorizationBroker {
    store: NativePluginSecurityStore,
    audit: DynAuditSink,
    lifecycle: Arc<ProductionLifecycle>,
}

impl AuthorizationBrokerPort for NativeAuthorizationBroker {
    fn review(
        &self,
        key: AuthorizationKey,
        requested: &[Permission],
        network_requested: bool,
    ) -> Result<AuthorizationReview, BrokerError> {
        AuthorizationBroker::new(&self.store, &self.audit).review(key, requested, network_requested)
    }

    fn record_decisions(
        &self,
        review: &AuthorizationReview,
        decisions: &[(Permission, AuthorizationState)],
        extra_confirmation_acknowledged: bool,
        expected_target: &bbcom_plugin_manager::AuthorizationTarget,
        reviewed_permissions: std::collections::BTreeSet<Permission>,
        revision: u64,
    ) -> Result<ReviewedAuthorizationReceipt, BrokerError> {
        // Resolve and validate the exact authorization target before changing
        // any durable decision state. In particular, an upgrade can replace
        // the pending artifact while its review dialog is open; a review for
        // that stale target must not mutate the new target's authorization.
        let target = self
            .lifecycle
            .authorization_target(&review.key().plugin_id)
            .map_err(|_| BrokerError::AuthorizationStoreUnavailable)?;
        if target != *expected_target {
            return Err(BrokerError::AuthorizationStoreUnavailable);
        }
        let artifact = &target.artifact;
        let expected_key = artifact
            .authorization_key(&review.key().workspace_id)
            .map_err(|_| BrokerError::AuthorizationStoreUnavailable)?;
        let expected_plan = permission_plan(
            &artifact
                .requested_permissions
                .iter()
                .copied()
                .collect::<Vec<_>>(),
        );
        let expected_per_request = expected_plan
            .requires_approval
            .iter()
            .copied()
            .filter(|permission| permission.is_per_request_only())
            .collect::<std::collections::BTreeSet<_>>();
        let expected_persistent = expected_plan
            .requires_approval
            .iter()
            .copied()
            .filter(|permission| !permission.is_per_request_only())
            .collect::<std::collections::BTreeSet<_>>();
        let allowed_receipt = artifact
            .requested_permissions
            .iter()
            .chain(review.implicit())
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if expected_key != *review.key()
            || artifact.version != expected_target.artifact.version
            || *review.implicit() != expected_plan.implicit
            || *review.requires_persistent_approval() != expected_persistent
            || *review.requires_per_request_approval() != expected_per_request
            || !reviewed_permissions.is_subset(&allowed_receipt)
        {
            return Err(BrokerError::AuthorizationStoreUnavailable);
        }

        let decision_generation = AuthorizationBroker::new(&self.store, &self.audit)
            .record_decisions(review, decisions, extra_confirmation_acknowledged)?;
        let receipt = ReviewedAuthorizationReceipt {
            artifact_version: artifact.version.clone(),
            reviewed_permissions,
            revision,
            decision_generation,
        };

        if !review.unavailable().is_empty()
            || !artifact
                .requested_permissions
                .is_subset(&receipt.reviewed_permissions)
        {
            // A denied capability never becomes a manager grant. Remove an
            // older exact-version receipt so a changed decision cannot reuse
            // a previously approved artifact.
            self.store
                .clear_reviewed_grant(review.key(), &artifact.version)
                .map_err(|_| BrokerError::AuthorizationStoreUnavailable)?;
            return Ok(receipt);
        }
        self.store
            .record_reviewed_grant(
                review.key(),
                &artifact.version,
                receipt.reviewed_permissions.clone(),
                receipt.revision,
                receipt.decision_generation,
            )
            .map_err(|_| BrokerError::AuthorizationStoreUnavailable)?;
        Ok(receipt)
    }
}

struct DynProposalBroker(Box<dyn ProposalBrokerPort + Send>);

impl ProposalBrokerPort for DynProposalBroker {
    fn create(
        &mut self,
        key: &AuthorizationKey,
        declared: &std::collections::BTreeSet<Permission>,
        request: SerialProposalRequest,
        now_ms: u64,
    ) -> Result<SerialProposalView, BrokerError> {
        self.0.create(key, declared, request, now_ms)
    }

    fn resolve(
        &mut self,
        proposal_id: &str,
        decision: ProposalDecision,
        current: &ProposalContext,
        now_ms: u64,
    ) -> ProposalResolution {
        self.0.resolve(proposal_id, decision, current, now_ms)
    }
}

struct DynPanelBroker(Box<dyn PanelBrokerPort + Send>);

impl PanelBrokerPort for DynPanelBroker {
    fn publish(
        &self,
        key: &AuthorizationKey,
        panel: DeclarativePanel,
    ) -> Result<HostedPanel, BrokerError> {
        self.0.publish(key, panel)
    }

    fn event(
        &self,
        hosted: &HostedPanel,
        event: PanelEvent,
    ) -> Result<PanelEventAction, BrokerError> {
        self.0.event(hosted, event)
    }
}
