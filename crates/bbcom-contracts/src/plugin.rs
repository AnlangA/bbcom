use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Capability a plugin may request. Single source of truth for both the IPC
/// surface and the plugin contract crates (re-exported there as `Permission`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
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

impl PluginPermission {
    pub const ALL: [Self; 13] = [
        Self::UiPanel,
        Self::PluginStorage,
        Self::SessionMetadataRead,
        Self::SessionCaptureRead,
        Self::ProjectSettingsReadWrite,
        Self::SerialPortsRead,
        Self::SerialControl,
        Self::SerialWriteProposal,
        Self::AiConversationRead,
        Self::AiRequest,
        Self::FileOpenSave,
        Self::Clipboard,
        Self::Notification,
    ];

    #[must_use]
    pub const fn is_implicit(self) -> bool {
        false
    }

    #[must_use]
    pub const fn is_per_request_only(self) -> bool {
        matches!(self, Self::SerialWriteProposal)
    }

    /// Capabilities wired end-to-end in the first unsigned-plugin release.
    #[must_use]
    pub const fn is_implemented(self) -> bool {
        matches!(
            self,
            Self::UiPanel
                | Self::PluginStorage
                | Self::ProjectSettingsReadWrite
                | Self::SessionMetadataRead
                | Self::SessionCaptureRead
                | Self::SerialWriteProposal
        )
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UiPanel => "ui.panel",
            Self::PluginStorage => "plugin.storage",
            Self::SessionMetadataRead => "session.metadata.read",
            Self::SessionCaptureRead => "session.capture.read",
            Self::ProjectSettingsReadWrite => "project.settings.read-write",
            Self::SerialPortsRead => "serial.ports.read",
            Self::SerialControl => "serial.control",
            Self::SerialWriteProposal => "serial.write-proposal",
            Self::AiConversationRead => "ai.conversation.read",
            Self::AiRequest => "ai.request",
            Self::FileOpenSave => "file.open-save",
            Self::Clipboard => "clipboard",
            Self::Notification => "notification",
        }
    }
}

impl fmt::Display for PluginPermission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

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
    pub declared_capabilities: Vec<PluginPermission>,
    pub effective_capabilities: Vec<PluginPermission>,
    pub unavailable_capabilities: Vec<PluginUnavailableCapability>,
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
pub struct PluginSerialProposal {
    pub runtime: RuntimeInstanceKey,
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
    pub runtime: RuntimeInstanceKey,
    pub title: String,
    pub fields: Vec<PluginPanelField>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPanelEvent {
    pub runtime: RuntimeInstanceKey,
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
    pub serial_proposals: Vec<PluginSerialProposal>,
    pub panels: Vec<PluginDeclarativePanel>,
    pub sources: Vec<PluginSourceView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginFailureCode {
    Unavailable,
    InvalidResponse,
    InvalidPanel,
    InvalidInput,
    OperationConflict,
    InstallationFailed,
    HostFailed,
    ProposalExpired,
    ProposalContextChanged,
    ProposalConsumed,
    PanelEventRejected,
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
plugin_request!(UninstallPluginRequest { plugin_id: String });
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginSerialProposalDecision {
    Approve,
    Reject,
}

plugin_request!(ResolvePluginSerialProposalRequest {
    proposal_id: String,
    runtime: RuntimeInstanceKey,
    decision: PluginSerialProposalDecision,
});

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialAction {
    pub correlation_id: String,
    pub proposal_id: String,
    pub operation_id: String,
    pub session_id: String,
    pub runtime: RuntimeInstanceKey,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialActionResultRequest {
    pub correlation_id: String,
    pub runtime: RuntimeInstanceKey,
    pub outcome: crate::SerialSendOutcome,
    pub requested_bytes: usize,
    pub sent_bytes: usize,
}

/// G43: a plugin's session-list / capture-read query, delivered to the main
/// window as `plugin-session-query` and answered via
/// `plugin_session_query_result`. Bounded by the plugin capture-page limits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSessionQuery {
    pub query_id: String,
    pub plugin_id: String,
    #[serde(flatten)]
    pub kind: PluginSessionQueryKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum PluginSessionQueryKind {
    #[serde(rename = "list")]
    List,
    #[serde(rename_all = "camelCase")]
    Capture {
        session_id: String,
        #[ts(type = "number")]
        from_sequence: u32,
        #[ts(type = "number")]
        max_frames: u32,
        #[ts(type = "number")]
        max_bytes: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSessionQueryResult {
    pub query_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<PluginSessionSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<PluginCapturedFrame>,
    #[serde(default)]
    #[ts(type = "number")]
    pub next_sequence: u32,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSessionSummary {
    pub session_id: String,
    pub name: String,
    pub kind: String,
    pub connected: bool,
    #[ts(type = "number")]
    pub rx_bytes: u64,
    #[ts(type = "number")]
    pub tx_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCapturedFrame {
    #[ts(type = "number")]
    pub sequence: u32,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub tx: bool,
    pub bytes: Vec<u8>,
}

plugin_request!(EmitPluginPanelEventRequest {
    event: PluginPanelEvent,
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
}
