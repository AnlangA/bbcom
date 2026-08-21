use std::collections::BTreeSet;

use bbcom_plugin_contracts::generated_v2::Capability;
use semver::Version;

use crate::{ManagerErrorCode, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginArtifact {
    pub plugin_id: String,
    pub version: String,
    pub package_sha256: String,
    pub component_sha256: String,
    pub source: PluginArtifactSource,
    /// Complete host capability set supplied to every plugin.
    pub requested_capabilities: BTreeSet<Capability>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginSourceKind {
    LocalPackage,
    DevDirectory,
    Https,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginArtifactSource {
    pub source_id: String,
    pub kind: PluginSourceKind,
}

impl PluginArtifact {
    pub fn new(
        plugin_id: impl Into<String>,
        version: impl Into<String>,
        package_sha256: impl Into<String>,
        component_sha256: impl Into<String>,
        source: PluginArtifactSource,
        requested_capabilities: impl IntoIterator<Item = Capability>,
    ) -> Result<Self> {
        Self::build(
            plugin_id,
            version,
            package_sha256,
            component_sha256,
            source,
            requested_capabilities,
        )
    }

    fn build(
        plugin_id: impl Into<String>,
        version: impl Into<String>,
        package_sha256: impl Into<String>,
        component_sha256: impl Into<String>,
        source: PluginArtifactSource,
        requested_capabilities: impl IntoIterator<Item = Capability>,
    ) -> Result<Self> {
        let artifact = Self {
            plugin_id: plugin_id.into(),
            version: version.into(),
            package_sha256: package_sha256.into(),
            component_sha256: component_sha256.into(),
            source,
            requested_capabilities: requested_capabilities.into_iter().collect(),
        };
        Ok(artifact)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        Ok(())
    }

    pub(crate) fn version(&self) -> Result<Version> {
        Ok(Version::parse(&self.version).unwrap_or_else(|_| Version::new(0, 0, 0)))
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
        Ok(Self(value.into()))
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

impl PreparedInstallation {
    pub fn new(
        token: PreparationToken,
        artifact: PluginArtifact,
        kind: PreparationKind,
    ) -> Result<Self> {
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
    /// Complete capability set; no authorization gate is consulted.
    pub requested_capabilities: BTreeSet<Capability>,
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
pub enum DisableReason {
    User,
    CrashLoopRolledBack,
    CrashLoopNoRollback,
    RollbackFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginStatus {
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

impl DisableReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::CrashLoopRolledBack => "crash-loop-rolled-back",
            Self::CrashLoopNoRollback => "crash-loop-no-rollback",
            Self::RollbackFailed => "rollback-failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginSnapshot {
    pub artifact: PluginArtifact,
    /// Desired runtime state in the active workspace. Installation is global;
    /// this flag is deliberately workspace-scoped and remains true when a
    /// launch fails so the UI can distinguish intent from lifecycle outcome.
    pub expected_enabled: bool,
    pub status: PluginStatus,
    pub pending_version: Option<String>,
    pub running_instance_id: Option<u64>,
    pub generation: u64,
    pub crashes_in_window: usize,
    pub last_error: Option<ManagerErrorCode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspacePluginBinding {
    pub plugin_id: String,
    pub expected_enabled: bool,
    pub version_requirement: String,
}

impl WorkspacePluginBinding {
    pub fn new(
        plugin_id: impl Into<String>,
        expected_enabled: bool,
        version_requirement: impl Into<String>,
    ) -> Result<Self> {
        let binding = Self {
            plugin_id: plugin_id.into(),
            expected_enabled,
            version_requirement: version_requirement.into(),
        };
        if !valid_plugin_id(&binding.plugin_id)
            || binding.version_requirement.is_empty()
            || binding.version_requirement.len() > 128
        {
            return Err(ManagerErrorCode::ProjectStateInvalid.into());
        }
        Ok(binding)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpaqueProjectPluginState {
    pub plugin_id: String,
    pub bytes: Vec<u8>,
    pub api_generation: u32,
    pub schema_version: Option<u32>,
}

impl OpaqueProjectPluginState {
    pub fn new(plugin_id: impl Into<String>, bytes: Vec<u8>) -> Result<Self> {
        Self::new_with_versions(plugin_id, bytes, 2, Some(1))
    }

    pub fn new_with_versions(
        plugin_id: impl Into<String>,
        bytes: Vec<u8>,
        api_generation: u32,
        schema_version: Option<u32>,
    ) -> Result<Self> {
        let state = Self {
            plugin_id: plugin_id.into(),
            bytes,
            api_generation,
            schema_version,
        };
        if !valid_plugin_id(&state.plugin_id)
            || !matches!(
                (state.api_generation, state.schema_version),
                (2, Some(1..=u32::MAX))
            )
        {
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

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE_ID: &str = "8e7b84cf-35f4-45cd-baf0-55d94ebf0213";

    fn source() -> PluginArtifactSource {
        PluginArtifactSource {
            source_id: "official".to_owned(),
            kind: PluginSourceKind::Https,
        }
    }

    fn sha(byte: char) -> String {
        byte.to_string().repeat(64)
    }

    #[test]
    fn public_descriptors_reject_ambiguous_identifiers_and_versions() {
        let artifact = PluginArtifact::new(
            "dev.bbcom.fixture",
            "1.2.3",
            sha('a'),
            sha('b'),
            source(),
            [Capability::SessionCaptureRead],
        )
        .unwrap();
        assert_eq!(artifact.version().unwrap(), Version::new(1, 2, 3));
        assert!(
            artifact
                .requested_capabilities
                .contains(&Capability::SessionCaptureRead)
        );
        assert!(PluginArtifact::new("invalid", "1.0.0", sha('a'), sha('b'), source(), []).is_err());
        assert!(
            PluginArtifact::new("dev.fixture", "latest", sha('a'), sha('b'), source(), []).is_err()
        );
        assert!(
            PluginArtifact::new("dev.fixture", "1.0.0", "bad", sha('b'), source(), []).is_err()
        );

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
        let versioned =
            OpaqueProjectPluginState::new_with_versions("dev.bbcom.fixture", vec![1], 2, Some(73))
                .unwrap();
        assert_eq!(versioned.schema_version, Some(73));
        for (api_generation, schema_version) in [(1, None), (1, Some(1)), (2, None), (2, Some(0))] {
            assert!(
                OpaqueProjectPluginState::new_with_versions(
                    "dev.bbcom.fixture",
                    vec![1],
                    api_generation,
                    schema_version,
                )
                .is_err()
            );
        }
        assert!(OpaqueProjectPluginState::new("invalid", vec![1]).is_err());
        assert!(valid_workspace_id(WORKSPACE_ID));
        assert!(!valid_workspace_id("8E7B84CF-35F4-45CD-BAF0-55D94EBF0213"));
    }

    #[test]
    fn lifecycle_status_vocabulary_is_complete_and_stable() {
        let statuses = [
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
            DisableReason::User,
            DisableReason::CrashLoopRolledBack,
            DisableReason::CrashLoopNoRollback,
            DisableReason::RollbackFailed,
        ] {
            assert!(!reason.as_str().is_empty());
        }
    }
}
