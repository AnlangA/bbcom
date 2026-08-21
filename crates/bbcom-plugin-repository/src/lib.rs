//! Plugin package installation primitives.

mod archive;
mod error;
mod install;
mod repository;

pub use bbcom_plugin_contracts::{MAX_REDIRECTS, RepositoryConfiguration, RepositoryEndpoint};
pub use error::{RepositoryError, Result};
pub use install::{
    ActiveInstallation, InstallOutcome, MAX_PLUGIN_DATA_BYTES, MAX_PLUGIN_DATA_FILES,
    MAX_ROLLBACK_CANDIDATES, PluginInstaller, PreparedInstallationKind, PreparedPluginInstallation,
    RollbackCandidate, RollbackOutcome,
};
pub use repository::{
    DownloadedPackage, HttpsResponse, HttpsTransport, LOCAL_INSTALL_ORIGIN,
    MAX_REPOSITORY_INDEX_BYTES, ManualUpdateCandidate, RepositoryClient, TransportError,
};
