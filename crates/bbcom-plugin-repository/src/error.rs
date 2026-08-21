use bbcom_plugin_contracts::ContractError;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, RepositoryError>;

#[derive(Debug, Error)]
pub enum RepositoryError {
    #[error(transparent)]
    Contract(#[from] ContractError),
    #[error("invalid repository configuration: {0}")]
    InvalidConfiguration(&'static str),
    #[error("invalid HTTPS URL")]
    InvalidHttpsUrl,
    #[error("repository index origin does not match its configured endpoint")]
    RepositoryOriginMismatch,
    #[error("repository transport failed: {0}")]
    Transport(String),
    #[error("repository returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("repository returned an invalid redirect")]
    InvalidRedirect,
    #[error("repository redirect crossed an origin boundary")]
    CrossOriginRedirect,
    #[error("repository redirect limit exceeded")]
    RedirectLimitExceeded,
    #[error("repository response exceeded {limit} bytes")]
    ResponseTooLarge { limit: u64 },
    #[error("repository package was not found")]
    PackageNotFound,
    #[error("plugin archive is invalid: {0}")]
    InvalidArchive(&'static str),
    #[error("plugin manifest is missing or exceeds its fixed limit")]
    ManifestUnavailable,
    #[error("plugin manifest does not match repository field {0}")]
    ManifestMismatch(&'static str),
    #[error("plugin component is not a valid WebAssembly Component")]
    InvalidComponent,
    #[error("plugin installation state is corrupt")]
    CorruptInstallState,
    #[error("plugin version already exists with a different package digest")]
    VersionDigestConflict,
    #[error("plugin version is already active or durably prepared")]
    AlreadyPreparedOrActive,
    #[error("prepared installation token is invalid")]
    PreparedTokenInvalid,
    #[error("prepared installation is unavailable or corrupt")]
    PreparedInstallationUnavailable,
    #[error("prepared installation descriptor does not match its durable journal")]
    PreparedDescriptorMismatch,
    #[error("active installation changed after the package was prepared")]
    PreparedStateChanged,
    #[error("manual install cannot downgrade or reinstall an inactive version")]
    NotANewerVersion,
    #[error("the requested verified rollback version is unavailable")]
    RollbackUnavailable,
    #[error("plugin rollback state requires native recovery before continuing")]
    RollbackRecoveryRequired,
    #[error("plugin filesystem root is unsafe")]
    UnsafeFilesystemRoot,
    #[error("plugin data exceeds its fixed limit")]
    PluginDataLimitExceeded,
    #[error("filesystem operation failed")]
    Io(#[source] std::io::Error),
    #[error("installation metadata serialization failed")]
    StateEncoding(#[source] serde_json::Error),
}

impl From<std::io::Error> for RepositoryError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_gate_executes_io_error_projection_without_path_disclosure() {
        let error = RepositoryError::from(std::io::Error::other("private path"));
        assert_eq!(error.to_string(), "filesystem operation failed");
    }
}
