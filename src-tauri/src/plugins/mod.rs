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
mod runtime_actor;
mod runtime_wiring;
mod sandbox;
mod service;
mod source_registry;
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
pub use service::{PluginService, PluginServiceError};
pub use source_registry::{
    NativePluginSourceRegistry, SourceRegistryError, spawn_automatic_source_checks,
};
pub use state::NativePluginStatePersistencePort;

pub use bootstrap::{
    CurrentPluginWorkspace, PluginBootstrapError, PluginHostUpstreamPort, PluginRuntimeLifecycle,
    PluginSerialSchedulerPort, ProductionPluginRuntime, ProductionPluginRuntimeBuilder,
};

pub use command_adapter::{
    CatalogPluginRecord, CatalogViewFailure, CatalogViewPort, NativePluginCommandAdapter,
    PluginCommandCorePort, PluginDisplayRecord,
};

#[cfg(test)]
mod tests;
pub use command_service::{
    PanelBrokerPort, PluginCommandError, PluginCommandErrorCode, PluginCommandService,
    PluginCommandSnapshot, PluginCommandUpstreamPort, PluginLifecyclePort, PluginOperationFailure,
    PluginOperationKind, PluginOperationSnapshot, PluginOperationStatus, PluginUpstreamFailure,
    ProposalBrokerPort,
};
pub use g45_probe::{PluginG45ProbeError, run_plugin_g45_probe_from_environment};
pub use runtime_actor::PluginRuntimeActorHandle;
pub use runtime_wiring::{
    PluginLifecycleHandle, SerialActionResultRegistry, SessionQueryResultRegistry,
    activate_plugin_workspace, close_plugin_project, compose, ensure_plugin_runtime,
    install_managed_defaults, spawn_dev_directory_watchers, spawn_host_exit_poll,
};
