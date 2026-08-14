//! Application-level lifecycle orchestration for isolated bbcom plugins.

mod error;
mod manager;
mod model;
mod ports;
mod project_state;

pub use error::{ManagerError, ManagerErrorCode, Result};
pub use manager::PluginManager;
pub use model::{
    ApprovalReason, ArtifactSlot, AuthorizationTarget, CrashKind, DisableReason, HostHandle,
    HostLaunchMode, HostLaunchRequest, HostReport, ManualPackageRequest, OpaqueProjectPluginState,
    PluginArtifact, PluginSnapshot, PluginStatus, PluginStatusCode, PreparationKind,
    PreparationToken, PreparedInstallation,
};
pub use ports::{
    ArtifactRevocationStore, AuthorizationFailure, Clock, HostFailure, HostLauncher,
    InstallationFailure, InstallationPort, PluginAuthorizationGrant, PluginAuthorizationStore,
    RevocationFailure, SystemClock,
};
pub use project_state::{MAX_PLUGIN_PROJECT_STATE_BYTES, MAX_PROJECT_PLUGIN_STATE_BYTES};

/// Three unexpected host exits in the fixed window trigger rollback.
pub const CRASH_THRESHOLD: usize = 3;
/// A run that survives this interval begins a new crash sequence.
pub const CRASH_WINDOW_MS: u64 = 10 * 60 * 1_000;
