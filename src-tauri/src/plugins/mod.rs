//! Native-only plugin lifecycle integration.
//!
//! This module intentionally exposes no Tauri command. Renderer code cannot
//! obtain plugin paths, spawn a host, or call the lifecycle manager directly.

mod bootstrap;
mod command_adapter;
mod command_service;
mod g45_probe;
mod host_launcher;
mod installation;
mod repository;
mod sandbox;
mod security;
mod service;
mod state;

pub use host_launcher::{
    ArtifactPathResolver, HostCrashEvent, HostExitMonitor, HostLauncherBuildError,
    HostMonitorError, PluginPersistedState, PluginStatePersistenceKey, PluginStatePersistencePort,
    PrivateArtifactRoot, ResolvedPluginArtifact, SandboxDriver, SandboxError, SandboxLaunch,
    SandboxSelfTest, SidecarHostLauncher,
};
pub use installation::{
    NativeRepositoryError, NativeRepositoryStagingBackend, PreparedRepositoryArtifact,
    RepositoryArtifactPathResolver, RepositoryInstallationPort, RepositoryStagingBackend,
    VerifiedPackageProvider,
};
pub use repository::{NativeRepositoryFetchError, NativeRepositoryFetchPort};
pub use sandbox::PlatformSandboxDriver;
pub use security::{NativePluginSecurityError, NativePluginSecurityStore};
pub use service::{PluginService, PluginServiceError};
pub use state::NativePluginStatePersistencePort;

pub use bootstrap::{
    CurrentPluginWorkspace, PluginBootstrapError, PluginHostUpstreamPort, PluginRuntimeLifecycle,
    PluginSerialSchedulerPort, ProductionPluginRuntime, ProductionPluginRuntimeBuilder,
};

pub use command_adapter::{
    CatalogPluginRecord, CatalogViewFailure, CatalogViewPort, NativePluginCommandAdapter,
    PluginCommandCorePort, PluginDisplayRecord, PublisherVerification,
};

#[cfg(test)]
mod tests;
pub use command_service::{
    AuthorizationBrokerPort, AuthorizationReviewSnapshot, AuthorizationSubject, PanelBrokerPort,
    PluginCommandError, PluginCommandErrorCode, PluginCommandService, PluginCommandSnapshot,
    PluginCommandUpstreamPort, PluginLifecyclePort, PluginOperationFailure, PluginOperationKind,
    PluginOperationSnapshot, PluginOperationStatus, PluginUpstreamFailure, ProposalBrokerPort,
    ReviewedAuthorizationReceipt,
};
pub use g45_probe::{PluginG45ProbeError, run_plugin_g45_probe_from_environment};
