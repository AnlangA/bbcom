use thiserror::Error;

pub type Result<T> = std::result::Result<T, ManagerError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagerErrorCode {
    WorkspaceNotOpen,
    PluginNotFound,
    PluginAlreadyInstalled,
    InvalidPluginArtifact,
    InvalidStateTransition,
    StaleHostReport,
    AuthorizationRequired,
    AuthorizationInvalid,
    AuthorizationUnavailable,
    ArtifactRevoked,
    RevocationUnavailable,
    InstallationPrepareFailed,
    InstallationCommitFailed,
    InstallationDiscardFailed,
    UpdateTargetInvalid,
    HostStartFailed,
    HostInitializationFailed,
    HostStopFailed,
    HostIdentityInvalid,
    HostCrashed,
    HostMemoryLimit,
    HostExecutionTimeout,
    HostProtocolFailure,
    RollbackUnavailable,
    RollbackFailed,
    ProjectStateInvalid,
    ProjectStateLimitExceeded,
}

impl ManagerErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceNotOpen => "PLUGIN_WORKSPACE_NOT_OPEN",
            Self::PluginNotFound => "PLUGIN_NOT_FOUND",
            Self::PluginAlreadyInstalled => "PLUGIN_ALREADY_INSTALLED",
            Self::InvalidPluginArtifact => "PLUGIN_ARTIFACT_INVALID",
            Self::InvalidStateTransition => "PLUGIN_STATE_INVALID",
            Self::StaleHostReport => "PLUGIN_HOST_REPORT_STALE",
            Self::AuthorizationRequired => "PLUGIN_AUTHORIZATION_REQUIRED",
            Self::AuthorizationInvalid => "PLUGIN_AUTHORIZATION_INVALID",
            Self::AuthorizationUnavailable => "PLUGIN_AUTHORIZATION_UNAVAILABLE",
            Self::ArtifactRevoked => "PLUGIN_ARTIFACT_REVOKED",
            Self::RevocationUnavailable => "PLUGIN_REVOCATION_UNAVAILABLE",
            Self::InstallationPrepareFailed => "PLUGIN_INSTALL_PREPARE_FAILED",
            Self::InstallationCommitFailed => "PLUGIN_INSTALL_COMMIT_FAILED",
            Self::InstallationDiscardFailed => "PLUGIN_INSTALL_DISCARD_FAILED",
            Self::UpdateTargetInvalid => "PLUGIN_UPDATE_TARGET_INVALID",
            Self::HostStartFailed => "PLUGIN_HOST_START_FAILED",
            Self::HostInitializationFailed => "PLUGIN_HOST_INITIALIZATION_FAILED",
            Self::HostStopFailed => "PLUGIN_HOST_STOP_FAILED",
            Self::HostIdentityInvalid => "PLUGIN_HOST_IDENTITY_INVALID",
            Self::HostCrashed => "PLUGIN_HOST_CRASHED",
            Self::HostMemoryLimit => "PLUGIN_HOST_MEMORY_LIMIT",
            Self::HostExecutionTimeout => "PLUGIN_HOST_EXECUTION_TIMEOUT",
            Self::HostProtocolFailure => "PLUGIN_HOST_PROTOCOL_FAILED",
            Self::RollbackUnavailable => "PLUGIN_ROLLBACK_UNAVAILABLE",
            Self::RollbackFailed => "PLUGIN_ROLLBACK_FAILED",
            Self::ProjectStateInvalid => "PLUGIN_PROJECT_STATE_INVALID",
            Self::ProjectStateLimitExceeded => "PLUGIN_PROJECT_STATE_LIMIT_EXCEEDED",
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::WorkspaceNotOpen => "plugin.error.workspaceNotOpen",
            Self::PluginNotFound => "plugin.error.notFound",
            Self::PluginAlreadyInstalled => "plugin.error.alreadyInstalled",
            Self::InvalidPluginArtifact => "plugin.error.componentInvalid",
            Self::InvalidStateTransition => "plugin.error.stateInvalid",
            Self::StaleHostReport => "plugin.error.hostReportStale",
            Self::AuthorizationRequired => "plugin.error.authorizationRequired",
            Self::AuthorizationInvalid => "plugin.error.authorizationKeyInvalid",
            Self::AuthorizationUnavailable => "plugin.error.authorizationStoreUnavailable",
            Self::ArtifactRevoked => "plugin.error.artifactRevoked",
            Self::RevocationUnavailable => "plugin.error.revocationUnavailable",
            Self::InstallationPrepareFailed => "plugin.error.installPrepareFailed",
            Self::InstallationCommitFailed => "plugin.error.installCommitFailed",
            Self::InstallationDiscardFailed => "plugin.error.installDiscardFailed",
            Self::UpdateTargetInvalid => "plugin.error.updateTargetInvalid",
            Self::HostStartFailed => "plugin.error.hostStartFailed",
            Self::HostInitializationFailed => "plugin.error.hostInitializationFailed",
            Self::HostStopFailed => "plugin.error.hostStopFailed",
            Self::HostIdentityInvalid => "plugin.error.hostIdentityInvalid",
            Self::HostCrashed => "plugin.error.hostCrashed",
            Self::HostMemoryLimit => "plugin.error.memoryLimit",
            Self::HostExecutionTimeout => "plugin.error.executionTimeout",
            Self::HostProtocolFailure => "plugin.error.protocolInvalid",
            Self::RollbackUnavailable => "plugin.error.rollbackUnavailable",
            Self::RollbackFailed => "plugin.error.rollbackFailed",
            Self::ProjectStateInvalid => "plugin.error.projectStateInvalid",
            Self::ProjectStateLimitExceeded => "plugin.error.projectStateLimitExceeded",
        }
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("plugin manager operation failed: {code:?}")]
pub struct ManagerError {
    code: ManagerErrorCode,
}

impl ManagerError {
    #[must_use]
    pub const fn new(code: ManagerErrorCode) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> ManagerErrorCode {
        self.code
    }

    #[must_use]
    pub const fn code_str(self) -> &'static str {
        self.code.as_str()
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        self.code.message_key()
    }
}

impl From<ManagerErrorCode> for ManagerError {
    fn from(code: ManagerErrorCode) -> Self {
        Self::new(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manager_failure_has_a_stable_public_code_and_message_key() {
        let codes = [
            ManagerErrorCode::WorkspaceNotOpen,
            ManagerErrorCode::PluginNotFound,
            ManagerErrorCode::PluginAlreadyInstalled,
            ManagerErrorCode::InvalidPluginArtifact,
            ManagerErrorCode::InvalidStateTransition,
            ManagerErrorCode::StaleHostReport,
            ManagerErrorCode::AuthorizationRequired,
            ManagerErrorCode::AuthorizationInvalid,
            ManagerErrorCode::AuthorizationUnavailable,
            ManagerErrorCode::ArtifactRevoked,
            ManagerErrorCode::RevocationUnavailable,
            ManagerErrorCode::InstallationPrepareFailed,
            ManagerErrorCode::InstallationCommitFailed,
            ManagerErrorCode::InstallationDiscardFailed,
            ManagerErrorCode::UpdateTargetInvalid,
            ManagerErrorCode::HostStartFailed,
            ManagerErrorCode::HostInitializationFailed,
            ManagerErrorCode::HostStopFailed,
            ManagerErrorCode::HostIdentityInvalid,
            ManagerErrorCode::HostCrashed,
            ManagerErrorCode::HostMemoryLimit,
            ManagerErrorCode::HostExecutionTimeout,
            ManagerErrorCode::HostProtocolFailure,
            ManagerErrorCode::RollbackUnavailable,
            ManagerErrorCode::RollbackFailed,
            ManagerErrorCode::ProjectStateInvalid,
            ManagerErrorCode::ProjectStateLimitExceeded,
        ];
        for code in codes {
            let error = ManagerError::from(code);
            assert_eq!(error.code(), code);
            assert_eq!(error.code_str(), code.as_str());
            assert_eq!(error.message_key(), code.message_key());
            assert!(error.code_str().starts_with("PLUGIN_"));
            assert!(error.message_key().starts_with("plugin.error."));
        }
    }
}
