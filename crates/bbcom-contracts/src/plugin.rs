use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum PluginPermission {
    #[serde(rename = "ui.panel")]
    UiPanel,
    #[serde(rename = "plugin.storage")]
    PluginStorage,
    #[serde(rename = "session.metadata.read")]
    SessionMetadataRead,
    #[serde(rename = "session.capture.read")]
    SessionCaptureRead,
    #[serde(rename = "project.settings.read-write")]
    ProjectSettingsReadWrite,
    #[serde(rename = "serial.ports.read")]
    SerialPortsRead,
    #[serde(rename = "serial.control")]
    SerialControl,
    #[serde(rename = "serial.write-proposal")]
    SerialWriteProposal,
    #[serde(rename = "ai.conversation.read")]
    AiConversationRead,
    #[serde(rename = "ai.request")]
    AiRequest,
    #[serde(rename = "file.open-save")]
    FileOpenSave,
    #[serde(rename = "clipboard")]
    Clipboard,
    #[serde(rename = "notification")]
    Notification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginLifecycleStatus {
    ApprovalRequired,
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
    InitialInstall,
    WorkspaceChanged,
    PermissionExpansion,
    ArtifactChanged,
    User,
    CrashLoopRolledBack,
    CrashLoopNoRollback,
    RollbackFailed,
    RollbackBlockedRevoked,
    ArtifactRevoked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginRiskCombination {
    CaptureWithNetwork,
    ConversationWithNetwork,
    CaptureWithExternalSink,
    ConversationWithExternalSink,
    SerialControlAndWriteProposal,
}

/// Closed capability set. `Network` remains explicitly unavailable in v1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum PluginUnavailableCapability {
    #[serde(rename = "ui.panel")]
    UiPanel,
    #[serde(rename = "plugin.storage")]
    PluginStorage,
    #[serde(rename = "session.metadata.read")]
    SessionMetadataRead,
    #[serde(rename = "session.capture.read")]
    SessionCaptureRead,
    #[serde(rename = "project.settings.read-write")]
    ProjectSettingsReadWrite,
    #[serde(rename = "serial.ports.read")]
    SerialPortsRead,
    #[serde(rename = "serial.control")]
    SerialControl,
    #[serde(rename = "serial.write-proposal")]
    SerialWriteProposal,
    #[serde(rename = "ai.conversation.read")]
    AiConversationRead,
    #[serde(rename = "ai.request")]
    AiRequest,
    #[serde(rename = "file.open-save")]
    FileOpenSave,
    #[serde(rename = "clipboard")]
    Clipboard,
    #[serde(rename = "notification")]
    Notification,
    #[serde(rename = "network")]
    Network,
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
    pub publisher_verified: bool,
    pub installed_version: Option<String>,
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
    pub requested_permissions: Vec<PluginPermission>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginAuthorizationReview {
    pub review_id: String,
    pub plugin_id: String,
    pub display_name: String,
    pub version: String,
    pub persistent_permissions: Vec<PluginPermission>,
    pub per_request_permissions: Vec<PluginPermission>,
    pub unavailable_capabilities: Vec<PluginUnavailableCapability>,
    pub extra_confirmation_reasons: Vec<PluginRiskCombination>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginPermissionDecisionState {
    Granted,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPermissionDecision {
    pub permission: PluginPermission,
    pub state: PluginPermissionDecisionState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialProposal {
    pub proposal_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub session_label: String,
    pub display_label: String,
    pub byte_count: usize,
    pub hex_preview: String,
    #[ts(type = "number")]
    pub expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginPanelFieldKind {
    Text,
    Number,
    Toggle,
    Select,
    Button,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPanelField {
    pub id: String,
    pub label: String,
    pub kind: PluginPanelFieldKind,
    pub value: String,
    pub options: Vec<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDeclarativePanel {
    pub plugin_id: String,
    pub title: String,
    pub fields: Vec<PluginPanelField>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPanelEvent {
    pub plugin_id: String,
    pub field_id: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCenterData {
    #[ts(type = "number")]
    pub revision: u64,
    pub catalog: Vec<PluginCatalogItem>,
    pub installed: Vec<InstalledPluginView>,
    pub authorization_review: Option<PluginAuthorizationReview>,
    pub serial_proposals: Vec<PluginSerialProposal>,
    pub panels: Vec<PluginDeclarativePanel>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFailureCode {
    Unavailable,
    InvalidResponse,
    InvalidPanel,
    OperationConflict,
    InstallationFailed,
    AuthorizationFailed,
    HostFailed,
    ProposalExpired,
    ProposalContextChanged,
    ProposalConsumed,
    PanelEventRejected,
    CancelFailed,
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
plugin_request!(SetPluginEnabledRequest {
    plugin_id: String,
    enabled: bool,
});
plugin_request!(SubmitPluginAuthorizationRequest {
    review_id: String,
    decisions: Vec<PluginPermissionDecision>,
    per_request_capabilities_acknowledged: Vec<PluginPermission>,
    extra_confirmation_acknowledged: bool,
});
plugin_request!(DismissPluginAuthorizationRequest { review_id: String });

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginSerialProposalDecision {
    Approve,
    Reject,
}

plugin_request!(ResolvePluginSerialProposalRequest {
    proposal_id: String,
    decision: PluginSerialProposalDecision,
});
plugin_request!(EmitPluginPanelEventRequest {
    event: PluginPanelEvent,
});

// `operation_id` is the existing target operation, not a new cancel action.
plugin_request!(CancelPluginOperationRequest {});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_and_result_wire_shapes_match_the_frontend_domain() {
        let input: SubmitPluginAuthorizationRequest = serde_json::from_value(serde_json::json!({
            "requestId": "request-1",
            "revision": 7,
            "operationId": "operation-1",
            "reviewId": "review-1",
            "decisions": [{ "permission": "ui.panel", "state": "granted" }],
            "perRequestCapabilitiesAcknowledged": ["serial.write-proposal"],
            "extraConfirmationAcknowledged": true
        }))
        .expect("authorization request shape");
        assert_eq!(input.decisions[0].permission, PluginPermission::UiPanel);

        let response = PluginCommandResponse::Failed {
            request_id: input.request_id,
            operation_id: input.operation_id,
            revision: 8,
            failure: PluginFailure {
                code: PluginFailureCode::AuthorizationFailed,
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
                "failure": { "code": "authorization-failed" }
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
}
