//! Native-only plugin lifecycle integration.
//!
//! This module intentionally exposes no Tauri command. Renderer code cannot
//! obtain plugin paths, spawn a host, or call the lifecycle manager directly.

mod authorization_v2;
mod bootstrap;
mod capability_gateway_v2;
mod command_adapter;
mod command_service;
mod detached_window_v2;
mod file_grants_v2;
mod g45_probe;
mod host_launcher;
mod installation;
mod market_readiness_probe;
mod presentation_v2;
mod repository;
mod runtime_actor;
mod runtime_wiring;
mod sandbox;
mod service;
mod source_registry;
mod state;
mod ui_actions_v2;

pub use authorization_v2::{
    NativePluginAuthorizationGateV2, NativePluginAuthorizationStore,
    PluginAuthorizationCoordinatorV2, PluginAuthorizationDecision, PluginAuthorizationError,
    PluginAuthorizationResolutionV2,
};
pub use capability_gateway_v2::{
    NativePluginCapabilityGatewayV2, PLUGIN_SERIAL_CAPABILITY_EVENT_V2,
    PLUGIN_SNAPSHOT_CHANGED_EVENT_V2, PluginCapabilityEventSinkV2, PluginCapabilitySinkErrorV2,
    PluginDetachedProjectionPortV2, PluginFileDialogPortV2, PluginHostContextStoreV2,
    PluginHostInitializationContextV2, PluginPrivateStatePersistenceV2,
    PluginRuntimeProjectionSnapshotV2, PluginRuntimeProjectionV2, PluginWorkspaceCapabilityPortV2,
    SerialCapabilityCorrelationRegistryV2, SerialCapabilityReplyErrorV2,
};
pub use detached_window_v2::{
    PLUGIN_DETACHED_SURFACE_UPDATE_EVENT_V2, PluginDetachedSerialRevocationPortV2,
    PluginDetachedWindowServiceV2,
};
pub use file_grants_v2::{
    MAX_PLUGIN_FILE_CHUNK_BYTES, PluginFileError, PluginFileGrantService, PluginFileGrantView,
};
pub use host_launcher::{
    ArtifactPathResolver, HostCrashEvent, HostExitMonitor, HostLauncherBuildError,
    HostMonitorError, PluginHostContextProviderV2, PluginHostServicesV2,
    PluginInitializationContextV2, PluginPersistedState, PluginProjectStateProviderV2,
    PluginProjectStateSnapshotV2, PluginStatePersistenceKey, PluginStatePersistencePort,
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
pub use state::{NativePluginStatePersistencePort, SharedNativePluginStatePersistencePort};
pub use ui_actions_v2::{
    NativePluginUiActionServiceV2, PluginUiActionServiceV2, PluginUiActionStateV2,
    PluginUiActionV2, ProjectingPluginCommandServiceV2, UnavailablePluginUiActionServiceV2,
};

pub use bootstrap::{
    CurrentPluginWorkspace, PluginBootstrapError, PluginRuntimeLifecycle, ProductionPluginRuntime,
    ProductionPluginRuntimeBuilder,
};

pub use command_adapter::{
    CatalogPluginRecord, CatalogViewFailure, CatalogViewPort, NativePluginCommandAdapter,
    PluginCommandCorePort, PluginDisplayRecord,
};

#[cfg(test)]
mod tests;
pub use command_service::{
    PluginCommandError, PluginCommandErrorCode, PluginCommandService, PluginCommandSnapshot,
    PluginLifecyclePort, PluginOperationFailure, PluginOperationKind, PluginOperationSnapshot,
    PluginOperationStatus,
};
pub use g45_probe::{PluginG45ProbeError, run_plugin_g45_probe_from_environment};
pub(crate) use market_readiness_probe::PluginMarketReadinessProbe;
pub use presentation_v2::{
    validate_detached_surface_interaction_v2, validate_detached_surface_view_v2,
    validate_plugin_center_extensions_v2,
};
pub use runtime_actor::PluginRuntimeActorHandle;
pub(crate) use runtime_wiring::PluginRuntimeDataRoot;
pub use runtime_wiring::{
    PluginLifecycleHandle, activate_plugin_workspace, close_plugin_project, compose,
    ensure_plugin_runtime, install_managed_defaults, spawn_dev_directory_watchers,
    spawn_host_exit_poll,
};
