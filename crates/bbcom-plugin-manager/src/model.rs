use std::collections::BTreeSet;

use bbcom_plugin_contracts::{AuthorizationKey, Permission};
use semver::Version;

use crate::{ManagerErrorCode, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginArtifact {
    pub plugin_id: String,
    pub version: String,
    pub publisher_identity: String,
    pub requested_permissions: BTreeSet<Permission>,
}

impl PluginArtifact {
    pub fn new(
        plugin_id: impl Into<String>,
        version: impl Into<String>,
        publisher_identity: impl Into<String>,
        requested_permissions: impl IntoIterator<Item = Permission>,
    ) -> Result<Self> {
        let artifact = Self {
            plugin_id: plugin_id.into(),
            version: version.into(),
            publisher_identity: publisher_identity.into(),
            requested_permissions: requested_permissions.into_iter().collect(),
        };
        artifact.validate()?;
        Ok(artifact)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if !valid_plugin_id(&self.plugin_id)
            || Version::parse(&self.version).is_err()
            || !valid_publisher_identity(&self.publisher_identity)
        {
            return Err(ManagerErrorCode::InvalidPluginArtifact.into());
        }
        Ok(())
    }

    pub(crate) fn version(&self) -> Result<Version> {
        Version::parse(&self.version).map_err(|_| ManagerErrorCode::InvalidPluginArtifact.into())
    }

    pub fn authorization_key(&self, workspace_id: &str) -> Result<AuthorizationKey> {
        let key = AuthorizationKey {
            plugin_id: self.plugin_id.clone(),
            publisher_identity: self.publisher_identity.clone(),
            plugin_major: self.version()?.major,
            workspace_id: workspace_id.to_owned(),
        };
        bbcom_plugin_broker::validate_authorization_key(&key)
            .map_err(|_| ManagerErrorCode::AuthorizationInvalid)?;
        Ok(key)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManualPackageRequest {
    pub repository_id: String,
    pub plugin_id: String,
    pub version: String,
}

impl ManualPackageRequest {
    pub fn new(
        repository_id: impl Into<String>,
        plugin_id: impl Into<String>,
        version: impl Into<String>,
    ) -> Result<Self> {
        let request = Self {
            repository_id: repository_id.into(),
            plugin_id: plugin_id.into(),
            version: version.into(),
        };
        if request.repository_id.is_empty()
            || request.repository_id.len() > 128
            || request.repository_id.chars().any(char::is_control)
            || !valid_plugin_id(&request.plugin_id)
            || Version::parse(&request.version).is_err()
        {
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }
        Ok(request)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparationKind {
    InitialInstall,
    ManualUpgrade,
    Rollback,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PreparationToken(String);

impl PreparationToken {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err(ManagerErrorCode::InvalidPluginArtifact.into());
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedInstallation {
    pub token: PreparationToken,
    pub artifact: PluginArtifact,
    pub kind: PreparationKind,
}

/// Exact artifact awaiting authorization. A preparation token distinguishes a
/// staged upgrade from both the active artifact and any later staging attempt
/// for the same version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationTarget {
    pub artifact: PluginArtifact,
    pub preparation_token: Option<PreparationToken>,
}

impl PreparedInstallation {
    pub fn new(
        token: PreparationToken,
        artifact: PluginArtifact,
        kind: PreparationKind,
    ) -> Result<Self> {
        artifact.validate()?;
        Ok(Self {
            token,
            artifact,
            kind,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactSlot {
    Active,
    Prepared(PreparationToken),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostLaunchMode {
    Active,
    UpdatePreflight,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostLaunchRequest {
    pub artifact: PluginArtifact,
    pub artifact_slot: ArtifactSlot,
    pub workspace_id: String,
    pub granted_permissions: BTreeSet<Permission>,
    pub project_state: Option<Vec<u8>>,
    pub mode: HostLaunchMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostHandle {
    pub instance_id: u64,
    pub plugin_id: String,
    pub version: String,
}

impl HostHandle {
    #[must_use]
    pub fn new(instance_id: u64, plugin_id: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            instance_id,
            plugin_id: plugin_id.into(),
            version: version.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashKind {
    ProcessCrash,
    MemoryLimit,
    ExecutionTimeout,
    ProtocolFailure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostReport {
    CleanExit,
    Crashed(CrashKind),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalReason {
    InitialInstall,
    WorkspaceChanged,
    PermissionExpansion,
    ArtifactChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisableReason {
    User,
    CrashLoopRolledBack,
    CrashLoopNoRollback,
    RollbackFailed,
    RollbackBlockedRevoked,
    ArtifactRevoked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginStatus {
    ApprovalRequired(ApprovalReason),
    Disabled(DisableReason),
    Stopped,
    Starting,
    Running,
    Updating,
    RollingBack,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginStatusCode {
    ApprovalRequired,
    Disabled,
    Stopped,
    Starting,
    Running,
    Updating,
    RollingBack,
    Failed,
}

impl PluginStatus {
    #[must_use]
    pub const fn code(self) -> PluginStatusCode {
        match self {
            Self::ApprovalRequired(_) => PluginStatusCode::ApprovalRequired,
            Self::Disabled(_) => PluginStatusCode::Disabled,
            Self::Stopped => PluginStatusCode::Stopped,
            Self::Starting => PluginStatusCode::Starting,
            Self::Running => PluginStatusCode::Running,
            Self::Updating => PluginStatusCode::Updating,
            Self::RollingBack => PluginStatusCode::RollingBack,
            Self::Failed => PluginStatusCode::Failed,
        }
    }
}

impl PluginStatusCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ApprovalRequired => "approval-required",
            Self::Disabled => "disabled",
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Updating => "updating",
            Self::RollingBack => "rolling-back",
            Self::Failed => "failed",
        }
    }
}

impl ApprovalReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InitialInstall => "initial-install",
            Self::WorkspaceChanged => "workspace-changed",
            Self::PermissionExpansion => "permission-expansion",
            Self::ArtifactChanged => "artifact-changed",
        }
    }
}

impl DisableReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::CrashLoopRolledBack => "crash-loop-rolled-back",
            Self::CrashLoopNoRollback => "crash-loop-no-rollback",
            Self::RollbackFailed => "rollback-failed",
            Self::RollbackBlockedRevoked => "rollback-blocked-revoked",
            Self::ArtifactRevoked => "artifact-revoked",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginSnapshot {
    pub artifact: PluginArtifact,
    pub status: PluginStatus,
    pub pending_version: Option<String>,
    pub running_instance_id: Option<u64>,
    pub crashes_in_window: usize,
    pub last_error: Option<ManagerErrorCode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpaqueProjectPluginState {
    pub plugin_id: String,
    pub bytes: Vec<u8>,
}

impl OpaqueProjectPluginState {
    pub fn new(plugin_id: impl Into<String>, bytes: Vec<u8>) -> Result<Self> {
        let state = Self {
            plugin_id: plugin_id.into(),
            bytes,
        };
        if !valid_plugin_id(&state.plugin_id) {
            return Err(ManagerErrorCode::ProjectStateInvalid.into());
        }
        Ok(state)
    }
}

pub(crate) fn valid_workspace_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn valid_plugin_id(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 128
        && value.contains('.')
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.bytes().enumerate().all(|(index, byte)| match byte {
                    b'a'..=b'z' | b'0'..=b'9' => true,
                    b'-' => index > 0 && index + 1 < part.len(),
                    _ => false,
                })
        })
}

fn valid_publisher_identity(value: &str) -> bool {
    let Some(fingerprint) = value.strip_prefix("publisher:sha256-") else {
        return false;
    };
    fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE_ID: &str = "8e7b84cf-35f4-45cd-baf0-55d94ebf0213";

    fn publisher() -> String {
        format!("publisher:sha256-{}", "ab".repeat(32))
    }

    #[test]
    fn public_descriptors_reject_ambiguous_identifiers_and_versions() {
        let artifact = PluginArtifact::new(
            "dev.bbcom.fixture",
            "1.2.3",
            publisher(),
            [Permission::SessionMetadataRead],
        )
        .unwrap();
        assert_eq!(artifact.version().unwrap(), Version::new(1, 2, 3));
        let key = artifact.authorization_key(WORKSPACE_ID).unwrap();
        assert_eq!(key.plugin_major, 1);
        assert_eq!(key.workspace_id, WORKSPACE_ID);
        assert!(PluginArtifact::new("invalid", "1.0.0", publisher(), []).is_err());
        assert!(PluginArtifact::new("dev.fixture", "latest", publisher(), []).is_err());
        assert!(PluginArtifact::new("dev.fixture", "1.0.0", "publisher:name", []).is_err());
        assert!(artifact.authorization_key("not-a-workspace").is_err());

        assert!(ManualPackageRequest::new("official", "dev.bbcom.fixture", "2.0.0").is_ok());
        assert!(ManualPackageRequest::new("", "dev.bbcom.fixture", "2.0.0").is_err());
        assert!(ManualPackageRequest::new("bad\nrepo", "dev.bbcom.fixture", "2.0.0").is_err());
        assert!(ManualPackageRequest::new("official", "invalid", "2.0.0").is_err());
        assert!(ManualPackageRequest::new("official", "dev.bbcom.fixture", "next").is_err());

        let token = PreparationToken::new("opaque-token").unwrap();
        assert_eq!(token.as_str(), "opaque-token");
        assert!(PreparationToken::new("").is_err());
        assert!(PreparationToken::new("bad\ntoken").is_err());
        assert!(
            PreparedInstallation::new(token, artifact, PreparationKind::InitialInstall).is_ok()
        );
        assert!(OpaqueProjectPluginState::new("dev.bbcom.fixture", vec![1]).is_ok());
        assert!(OpaqueProjectPluginState::new("invalid", vec![1]).is_err());
        assert!(valid_workspace_id(WORKSPACE_ID));
        assert!(!valid_workspace_id("8E7B84CF-35F4-45CD-BAF0-55D94EBF0213"));
    }

    #[test]
    fn lifecycle_status_vocabulary_is_complete_and_stable() {
        let statuses = [
            PluginStatus::ApprovalRequired(ApprovalReason::InitialInstall),
            PluginStatus::Disabled(DisableReason::User),
            PluginStatus::Stopped,
            PluginStatus::Starting,
            PluginStatus::Running,
            PluginStatus::Updating,
            PluginStatus::RollingBack,
            PluginStatus::Failed,
        ];
        for status in statuses {
            assert!(!status.code().as_str().is_empty());
        }
        for reason in [
            ApprovalReason::InitialInstall,
            ApprovalReason::WorkspaceChanged,
            ApprovalReason::PermissionExpansion,
            ApprovalReason::ArtifactChanged,
        ] {
            assert!(!reason.as_str().is_empty());
        }
        for reason in [
            DisableReason::User,
            DisableReason::CrashLoopRolledBack,
            DisableReason::CrashLoopNoRollback,
            DisableReason::RollbackFailed,
            DisableReason::RollbackBlockedRevoked,
            DisableReason::ArtifactRevoked,
        ] {
            assert!(!reason.as_str().is_empty());
        }
    }
}
