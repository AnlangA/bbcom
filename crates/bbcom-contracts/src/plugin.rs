use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginLifecycleStatus {
    Disabled,
    Stopped,
    Starting,
    Running,
    Updating,
    RollingBack,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginStatusReason {
    User,
    CrashLoopRolledBack,
    CrashLoopNoRollback,
    RollbackFailed,
    RollbackBlockedRevoked,
    ArtifactRevoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalogItem {
    pub catalog_id: String,
    pub plugin_id: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub publisher_name: String,
    pub installed_version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSourceKind {
    Https,
    LocalPackage,
    DevDirectory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSourceHealth {
    Idle,
    Healthy,
    Error,
    Disconnected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSourceView {
    pub source_id: String,
    pub kind: PluginSourceKind,
    pub display_name: String,
    pub url: Option<String>,
    pub enabled: bool,
    pub watch_enabled: bool,
    pub health: PluginSourceHealth,
    #[ts(type = "number | null")]
    pub last_attempt_ms: Option<u64>,
    #[ts(type = "number | null")]
    pub last_success_ms: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledPluginView {
    pub plugin_id: String,
    pub display_name: String,
    pub version: String,
    pub status: PluginLifecycleStatus,
    pub status_reason: Option<PluginStatusReason>,
    pub enabled: bool,
    pub pending_version: Option<String>,
    /// Canonical capabilities requested by the verified manifest.
    pub requested_capabilities: Vec<crate::PluginCapabilityV2>,
    /// Capabilities active in the current runtime instance. Empty while the
    /// plugin is stopped or awaiting authorization.
    pub effective_capabilities: Vec<crate::PluginCapabilityV2>,
    pub runtime: Option<RuntimeInstanceKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInstanceKey {
    pub workspace_id: String,
    pub plugin_id: String,
    #[ts(type = "number")]
    pub instance_id: u64,
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCenterData {
    #[ts(type = "number")]
    pub revision: u64,
    pub catalog: Vec<PluginCatalogItem>,
    pub installed: Vec<InstalledPluginView>,
    pub sources: Vec<PluginSourceView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub surfaces: Option<Vec<crate::PluginSurfaceSnapshot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tasks: Option<Vec<crate::PluginTaskViewV2>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command_contributions: Option<Vec<crate::PluginCommandContributionV2>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFailureCode {
    Unavailable,
    InvalidResponse,
    InvalidSurface,
    InvalidInput,
    OperationConflict,
    InstallationFailed,
    HostFailed,
    CancelFailed,
    /// The lifecycle rejected the action because no workspace is open (e.g.
    /// enabling a plugin before a workspace exists) — distinct from a generic
    /// service-unavailable so the UI can tell the user what to do next.
    WorkspaceMissing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginFailure {
    pub code: PluginFailureCode,
}

/// Result envelope for every plugin command. The discriminant maps directly
/// to `PluginPortOutcome`; the three correlation fields never need inference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum PluginCommandResponse {
    Completed {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[ts(type = "number")]
        revision: u64,
        data: PluginCenterData,
    },
    Cancelled {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[ts(type = "number")]
        revision: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        data: Option<PluginCenterData>,
    },
    Failed {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[ts(type = "number")]
        revision: u64,
        failure: PluginFailure,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        data: Option<PluginCenterData>,
    },
}

impl PluginCommandResponse {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Completed { request_id, .. }
            | Self::Cancelled { request_id, .. }
            | Self::Failed { request_id, .. } => request_id,
        }
    }

    pub fn operation_id(&self) -> &str {
        match self {
            Self::Completed { operation_id, .. }
            | Self::Cancelled { operation_id, .. }
            | Self::Failed { operation_id, .. } => operation_id,
        }
    }

    pub const fn revision(&self) -> u64 {
        match self {
            Self::Completed { revision, .. }
            | Self::Cancelled { revision, .. }
            | Self::Failed { revision, .. } => *revision,
        }
    }

    pub const fn data(&self) -> Option<&PluginCenterData> {
        match self {
            Self::Completed { data, .. } => Some(data),
            Self::Cancelled { data, .. } | Self::Failed { data, .. } => data.as_ref(),
        }
    }
}

macro_rules! plugin_request {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            pub request_id: String,
            #[ts(type = "number")]
            pub revision: u64,
            pub operation_id: String,
            $(pub $field: $ty,)*
        }
    };
}

plugin_request!(PluginSnapshotRequest {});
plugin_request!(InstallPluginRequest { catalog_id: String });
plugin_request!(InstallLocalPluginRequest { grant_id: String });
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginLocalSourceKind {
    LocalPackage,
    DevDirectory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestPluginLocalSourceGrantRequest {
    pub request_id: String,
    pub source_kind: PluginLocalSourceKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginLocalSourceGrantResponse {
    pub request_id: String,
    pub grant_id: String,
    pub display_name: String,
    pub source_kind: PluginLocalSourceKind,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginContributionDisposition {
    #[default]
    Delete,
    ConvertToUser,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallPluginRequest {
    pub request_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub operation_id: String,
    pub plugin_id: String,
    #[serde(default)]
    pub contribution_disposition: PluginContributionDisposition,
}
plugin_request!(SetPluginEnabledRequest {
    plugin_id: String,
    enabled: bool,
});
plugin_request!(AddPluginSourceRequest {
    source_id: String,
    url: String,
    enabled: bool,
});
plugin_request!(UpdatePluginSourceRequest {
    source_id: String,
    url: String,
    enabled: bool,
});
plugin_request!(RemovePluginSourceRequest { source_id: String });
plugin_request!(RefreshPluginSourceRequest { source_id: String });
plugin_request!(SetPluginWatchEnabledRequest {
    source_id: String,
    enabled: bool,
});
// `operation_id` is the existing target operation, not a new cancel action.
plugin_request!(CancelPluginOperationRequest {});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_wire_shape_matches_the_frontend_domain() {
        let input: PluginSnapshotRequest = serde_json::from_value(serde_json::json!({
            "requestId": "request-1",
            "revision": 7,
            "operationId": "operation-1"
        }))
        .expect("snapshot request shape");

        let response = PluginCommandResponse::Failed {
            request_id: input.request_id,
            operation_id: input.operation_id,
            revision: 8,
            failure: PluginFailure {
                code: PluginFailureCode::OperationConflict,
            },
            data: None,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "outcome": "failed",
                "requestId": "request-1",
                "operationId": "operation-1",
                "revision": 8,
                "failure": { "code": "operation-conflict" }
            })
        );
    }

    #[test]
    fn sensitive_or_unversioned_fields_are_not_part_of_command_requests() {
        for forbidden in ["path", "url", "apiKey", "handle"] {
            let value = serde_json::json!({
                "requestId": "request-1",
                "revision": 0,
                "operationId": "operation-1",
                forbidden: "forbidden"
            });
            assert!(serde_json::from_value::<PluginSnapshotRequest>(value).is_err());
        }
    }

    #[test]
    fn uninstall_contribution_policy_defaults_to_delete_and_accepts_explicit_conversion() {
        let base = serde_json::json!({
            "requestId": "request-1",
            "revision": 1,
            "operationId": "operation-1",
            "pluginId": "dev.bbcom.fixture"
        });
        let default_request: UninstallPluginRequest =
            serde_json::from_value(base.clone()).expect("default uninstall policy");
        assert_eq!(
            default_request.contribution_disposition,
            PluginContributionDisposition::Delete
        );

        let mut explicit = base;
        explicit["contributionDisposition"] = serde_json::json!("convert-to-user");
        let explicit_request: UninstallPluginRequest =
            serde_json::from_value(explicit).expect("explicit uninstall policy");
        assert_eq!(
            explicit_request.contribution_disposition,
            PluginContributionDisposition::ConvertToUser
        );
    }
}
