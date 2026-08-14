//! Verified, manual-only plugin repository and installation primitives.

mod archive;
mod error;
mod install;
mod repository;

pub use error::{RepositoryError, Result};
pub use install::{
    ActiveInstallation, InstallOutcome, MAX_PLUGIN_DATA_BYTES, MAX_PLUGIN_DATA_FILES,
    MAX_ROLLBACK_CANDIDATES, PluginInstaller, PreparedInstallationKind, PreparedPluginInstallation,
    RollbackCandidate, RollbackOutcome,
};
pub use repository::{
    DownloadedPackage, HttpsResponse, HttpsTransport, MAX_REDIRECTS, MAX_REPOSITORY_INDEX_BYTES,
    ManualUpdateCandidate, RepositoryClient, RepositoryConfiguration, RepositoryEndpoint,
    TransportError,
};
