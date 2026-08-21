//! Renderer-safe plugin protocol v2 contracts.
//!
//! These values cross the native/WebView boundary. Native resource tokens,
//! paths and payload bytes deliberately stay out of this module; the renderer
//! only receives revocable identities and host-renderable presentation data.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RuntimeInstanceKey;

/// Closed capability vocabulary for `bbcom:plugin@2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
pub enum PluginCapabilityV2 {
    #[serde(rename = "ui.workspace")]
    UiWorkspace,
    #[serde(rename = "ui.detached-window")]
    UiDetachedWindow,
    #[serde(rename = "serial.ports.read")]
    SerialPortsRead,
    #[serde(rename = "serial.sessions.manage")]
    SerialSessionsManage,
    #[serde(rename = "serial.io")]
    SerialIo,
    #[serde(rename = "serial.control-lines")]
    SerialControlLines,
    #[serde(rename = "session.capture.read")]
    SessionCaptureRead,
    #[serde(rename = "session.commands.read-write")]
    SessionCommandsReadWrite,
    #[serde(rename = "file.open-read")]
    FileOpenRead,
    #[serde(rename = "file.save-write")]
    FileSaveWrite,
    #[serde(rename = "plugin.storage")]
    PluginStorage,
    #[serde(rename = "project.state.read-write")]
    ProjectStateReadWrite,
}

impl PluginCapabilityV2 {
    pub const ALL: [Self; 12] = [
        Self::UiWorkspace,
        Self::UiDetachedWindow,
        Self::SerialPortsRead,
        Self::SerialSessionsManage,
        Self::SerialIo,
        Self::SerialControlLines,
        Self::SessionCaptureRead,
        Self::SessionCommandsReadWrite,
        Self::FileOpenRead,
        Self::FileSaveWrite,
        Self::PluginStorage,
        Self::ProjectStateReadWrite,
    ];

    /// Stable wire/display spelling used when capability collections cross
    /// the native-to-renderer boundary. Renderer contracts canonicalize those
    /// collections lexicographically by this value, not by Rust enum order.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UiWorkspace => "ui.workspace",
            Self::UiDetachedWindow => "ui.detached-window",
            Self::SerialPortsRead => "serial.ports.read",
            Self::SerialSessionsManage => "serial.sessions.manage",
            Self::SerialIo => "serial.io",
            Self::SerialControlLines => "serial.control-lines",
            Self::SessionCaptureRead => "session.capture.read",
            Self::SessionCommandsReadWrite => "session.commands.read-write",
            Self::FileOpenRead => "file.open-read",
            Self::FileSaveWrite => "file.save-write",
            Self::PluginStorage => "plugin.storage",
            Self::ProjectStateReadWrite => "project.state.read-write",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginErrorCodeV2 {
    InvalidInput,
    PermissionDenied,
    Unavailable,
    Busy,
    NotFound,
    StaleHandle,
    Disconnected,
    Timeout,
    Cancelled,
    LimitExceeded,
    PartialWrite,
    UnknownOutcome,
    ProtocolError,
    IoError,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginFailureV2 {
    pub code: PluginErrorCodeV2,
    /// Stable, host-owned localization key. Guest-supplied details are shown
    /// separately and are never interpreted as markup.
    pub message_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSurfacePlacement {
    Workspace,
    DetachedWindow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTextTone {
    Default,
    Muted,
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginUiTab {
    pub id: String,
    pub label: String,
    pub children: Vec<PluginUiNode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginKeyValueEntry {
    pub key: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tone: Option<PluginTextTone>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginTableColumn {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSelectOption {
    pub value: String,
    pub label: String,
}

/// Host-rendered component tree. No HTML, URL, script, style or DOM escape
/// exists in the vocabulary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginUiNode {
    Column {
        id: String,
        children: Vec<PluginUiNode>,
    },
    Row {
        id: String,
        children: Vec<PluginUiNode>,
    },
    Group {
        id: String,
        label: String,
        children: Vec<PluginUiNode>,
    },
    Tabs {
        id: String,
        #[serde(rename = "selectedId")]
        selected_id: String,
        tabs: Vec<PluginUiTab>,
    },
    Text {
        id: String,
        text: String,
        tone: PluginTextTone,
    },
    Badge {
        id: String,
        text: String,
        tone: PluginTextTone,
    },
    KeyValueList {
        id: String,
        entries: Vec<PluginKeyValueEntry>,
    },
    Progress {
        id: String,
        label: String,
        #[ts(type = "number")]
        completed: u64,
        #[ts(type = "number")]
        total: u64,
    },
    Log {
        id: String,
        text: String,
        #[serde(rename = "maxLines")]
        max_lines: u32,
    },
    Code {
        id: String,
        text: String,
        language: String,
    },
    Table {
        id: String,
        columns: Vec<PluginTableColumn>,
        rows: Vec<Vec<String>>,
        page: u32,
        #[serde(rename = "pageCount")]
        page_count: u32,
    },
    TextInput {
        id: String,
        label: String,
        value: String,
        disabled: bool,
    },
    NumberInput {
        id: String,
        label: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        min: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        max: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        step: Option<String>,
        disabled: bool,
    },
    Select {
        id: String,
        label: String,
        value: String,
        options: Vec<PluginSelectOption>,
        disabled: bool,
    },
    Toggle {
        id: String,
        label: String,
        value: bool,
        disabled: bool,
    },
    Button {
        id: String,
        label: String,
        disabled: bool,
        dangerous: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        confirmation: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSurfaceSnapshot {
    pub runtime: RuntimeInstanceKey,
    pub surface_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub title: String,
    pub placement: PluginSurfacePlacement,
    pub detached_allowed: bool,
    pub editable: bool,
    pub root: PluginUiNode,
}

/// Deliberately small atomic patch vocabulary. Structural guest changes use
/// `replace-node`; control and text changes can avoid republishing the tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginUiPatchOperation {
    ReplaceNode {
        #[serde(rename = "nodeId")]
        node_id: String,
        node: PluginUiNode,
    },
    SetText {
        #[serde(rename = "nodeId")]
        node_id: String,
        text: String,
    },
    SetValue {
        #[serde(rename = "nodeId")]
        node_id: String,
        value: String,
    },
    SetDisabled {
        #[serde(rename = "nodeId")]
        node_id: String,
        disabled: bool,
    },
    SelectTab {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "selectedId")]
        selected_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSurfacePatch {
    pub runtime: RuntimeInstanceKey,
    pub surface_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    #[ts(type = "number")]
    pub next_revision: u64,
    pub operations: Vec<PluginUiPatchOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginSurfaceUpdateV2 {
    Snapshot {
        surface: PluginSurfaceSnapshot,
    },
    Patch {
        patch: PluginSurfacePatch,
    },
    Remove {
        runtime: RuntimeInstanceKey,
        #[serde(rename = "surfaceId")]
        surface_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSurfaceEventKind {
    Activate,
    Input,
    Change,
    SelectTab,
    RequestPage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSurfaceEventV2 {
    pub runtime: RuntimeInstanceKey,
    pub surface_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub node_id: String,
    pub event: PluginSurfaceEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskStatusV2 {
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    UnknownOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginTaskViewV2 {
    pub runtime: RuntimeInstanceKey,
    pub task_id: String,
    pub command_id: String,
    pub title: String,
    pub status: PluginTaskStatusV2,
    #[ts(type = "number")]
    pub completed: u64,
    #[ts(type = "number")]
    pub total: u64,
    pub status_text: String,
    pub cancellable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<PluginFailureV2>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCommandContributionV2 {
    pub runtime: RuntimeInstanceKey,
    pub command_id: String,
    pub title: String,
    pub description: String,
    pub dangerous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub confirmation: Option<String>,
}

/// Main-window actions are generation-bound and carry the same optimistic
/// revision/correlation tuple as the existing plugin-center commands.
macro_rules! plugin_v2_request {
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

plugin_v2_request!(EmitPluginSurfaceEventRequestV2 {
    event: PluginSurfaceEventV2,
});

plugin_v2_request!(CancelPluginTaskRequestV2 {
    runtime: RuntimeInstanceKey,
    task_id: String,
});

plugin_v2_request!(RunPluginCommandRequestV2 {
    runtime: RuntimeInstanceKey,
    command_id: String,
});

plugin_v2_request!(SetPluginSurfacePlacementRequestV2 {
    runtime: RuntimeInstanceKey,
    surface_id: String,
    placement: PluginSurfacePlacement,
});

/// Renderer transport identity for one native protocol-v2 gateway session.
/// `instance_id` remains a string because it is an opaque Protobuf identity,
/// not a JavaScript counter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginGatewayContextV2 {
    pub workspace_id: String,
    pub plugin_id: String,
    pub instance_id: String,
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginResourceBindingV2 {
    pub workspace_id: String,
    pub plugin_id: String,
    pub instance_id: String,
    #[ts(type = "number")]
    pub generation: u64,
    pub resource_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialConfigV2 {
    pub baud_rate: u32,
    pub data_bits: u32,
    /// Numeric values are the frozen Protobuf v2 enum discriminants.
    pub parity: u32,
    pub stop_bits: u32,
    pub flow_control: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialPortV2 {
    /// Runtime-scoped opaque identity. This value is never an operating-system
    /// device path and becomes invalid when the renderer port catalog drops it.
    pub port_id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usb_vendor_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usb_product_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub serial_number: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSerialSessionLifetimeV2 {
    Persistent,
    Runtime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialSessionV2 {
    pub session_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port_id: Option<String>,
    pub config: PluginSerialConfigV2,
    pub connected: bool,
    #[ts(type = "number")]
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialLeaseOptionsV2 {
    pub pause_automation: bool,
    pub rx_buffer_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialCreateSessionV2 {
    pub local_id: String,
    pub name: String,
    pub lifetime: PluginSerialSessionLifetimeV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port_id: Option<String>,
    pub config: PluginSerialConfigV2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialOutputLinesV2 {
    pub dtr: bool,
    pub rts: bool,
    pub break_active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialInputLinesV2 {
    pub cts: bool,
    pub dsr: bool,
    pub ri: bool,
    pub cd: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSerialFrameDirectionV2 {
    Rx,
    Tx,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialCaptureFrameV2 {
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub direction: PluginSerialFrameDirectionV2,
    pub payload: Vec<u8>,
}

/// Closed renderer projection of the serial subset of
/// `bbcom.plugin.host.v2.Request.operation`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginSerialCapabilityOperationV2 {
    ListPorts,
    ListSessions,
    CreateSession {
        request: PluginSerialCreateSessionV2,
    },
    UpdateSession {
        session: PluginSerialSessionV2,
    },
    ConnectSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    DisconnectSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    DeleteSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    AcquireSerialLease {
        #[serde(rename = "sessionId")]
        session_id: String,
        options: PluginSerialLeaseOptionsV2,
    },
    ReleaseSerialLease {
        lease: PluginResourceBindingV2,
    },
    SerialRead {
        lease: PluginResourceBindingV2,
        #[serde(rename = "maxBytes")]
        max_bytes: u32,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u32,
    },
    SerialWrite {
        lease: PluginResourceBindingV2,
        payload: Vec<u8>,
    },
    ClearSerialBuffers {
        lease: PluginResourceBindingV2,
    },
    PendingSerialBytes {
        lease: PluginResourceBindingV2,
    },
    SetOutputLines {
        lease: PluginResourceBindingV2,
        lines: PluginSerialOutputLinesV2,
    },
    ReadInputLines {
        lease: PluginResourceBindingV2,
    },
    CaptureRead {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "fromSequence")]
        #[ts(type = "number")]
        from_sequence: u64,
        #[serde(rename = "maxFrames")]
        max_frames: u32,
        #[serde(rename = "maxBytes")]
        max_bytes: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginSerialCapabilityResultV2 {
    ListPorts {
        ports: Vec<PluginSerialPortV2>,
    },
    ListSessions {
        sessions: Vec<PluginSerialSessionV2>,
    },
    CreateSession {
        session: PluginSerialSessionV2,
    },
    UpdateSession {
        session: PluginSerialSessionV2,
    },
    ConnectSession {
        session: PluginSerialSessionV2,
    },
    DisconnectSession,
    DeleteSession,
    AcquireSerialLease {
        lease: PluginResourceBindingV2,
        #[serde(rename = "sessionGeneration")]
        #[ts(type = "number")]
        session_generation: u64,
    },
    ReleaseSerialLease,
    SerialRead {
        payload: Vec<u8>,
        #[serde(rename = "timedOut")]
        timed_out: bool,
        disconnected: bool,
    },
    SerialWrite {
        #[ts(type = "number")]
        requested: u64,
        #[ts(type = "number")]
        sent: u64,
        outcome: PluginSerialWriteOutcomeV2,
    },
    ClearSerialBuffers,
    PendingSerialBytes {
        #[ts(type = "number")]
        rx: u64,
        #[ts(type = "number")]
        tx: u64,
    },
    SetOutputLines,
    ReadInputLines {
        lines: PluginSerialInputLinesV2,
    },
    CaptureRead {
        frames: Vec<PluginSerialCaptureFrameV2>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "nextSequence")]
        #[ts(optional, type = "number")]
        next_sequence: Option<u64>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSerialWriteOutcomeV2 {
    Completed,
    PartialWrite,
    UnknownOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginSerialCapabilityInboundV2 {
    Request {
        context: PluginGatewayContextV2,
        #[serde(rename = "messageId")]
        #[ts(type = "number")]
        message_id: u64,
        operation: PluginSerialCapabilityOperationV2,
    },
    Cancel {
        context: PluginGatewayContextV2,
        #[serde(rename = "targetMessageId")]
        #[ts(type = "number")]
        target_message_id: u64,
    },
    /// One-way reclamation for a lease that the renderer created but whose
    /// successful result was discarded before the guest could own it.
    RevokeLease {
        context: PluginGatewayContextV2,
        lease: PluginResourceBindingV2,
        #[serde(rename = "sessionGeneration")]
        #[ts(type = "number")]
        session_generation: u64,
    },
    RevokeRuntime {
        context: PluginGatewayContextV2,
    },
    RevokeAll,
}

/// Exact-one result/error response. Native validates `ok` against presence of
/// `result` and `error_code` before waking a sidecar waiter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialCapabilityResponseV2 {
    pub context: PluginGatewayContextV2,
    #[ts(type = "number")]
    pub reply_to: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<PluginSerialCapabilityResultV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<PluginErrorCodeV2>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginSerialCapabilityOutboundV2 {
    Response {
        response: PluginSerialCapabilityResponseV2,
    },
    CancelResult {
        context: PluginGatewayContextV2,
        #[serde(rename = "targetMessageId")]
        #[ts(type = "number")]
        target_message_id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "errorCode")]
        #[ts(optional)]
        error_code: Option<PluginErrorCodeV2>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialCapabilityReplyRequestV2 {
    pub event: PluginSerialCapabilityOutboundV2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginHostLocaleV2 {
    En,
    Zh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginHostThemeV2 {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginHostSessionSummaryV2 {
    pub session_id: String,
    pub name: String,
    pub connected: bool,
    #[ts(type = "number")]
    pub rx_bytes: u64,
    #[ts(type = "number")]
    pub tx_bytes: u64,
    #[ts(type = "number")]
    pub generation: u64,
}

/// Main-window projection of the real application appearance and session
/// catalog. Native binds the optional workspace id to the active workspace;
/// no port path or renderer-selected plugin/runtime identity is accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginHostContextUpdateRequestV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    pub locale: PluginHostLocaleV2,
    pub theme: PluginHostThemeV2,
    pub sessions: Vec<PluginHostSessionSummaryV2>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDetachedSurfaceViewV2 {
    #[ts(type = "number")]
    pub center_revision: u64,
    pub surface: PluginSurfaceSnapshot,
    pub tasks: Vec<PluginTaskViewV2>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDetachedSurfaceSnapshotRequestV2 {
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDetachedSurfaceEventRequestV2 {
    pub token: String,
    #[ts(type = "number")]
    pub surface_revision: u64,
    pub node_id: String,
    pub event: PluginSurfaceEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDetachedTaskCancelRequestV2 {
    pub token: String,
    pub task_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_wire_values_are_the_frozen_v2_vocabulary() {
        let values = PluginCapabilityV2::ALL
            .into_iter()
            .map(|capability| serde_json::to_value(capability).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::Value::Array(values),
            serde_json::json!([
                "ui.workspace",
                "ui.detached-window",
                "serial.ports.read",
                "serial.sessions.manage",
                "serial.io",
                "serial.control-lines",
                "session.capture.read",
                "session.commands.read-write",
                "file.open-read",
                "file.save-write",
                "plugin.storage",
                "project.state.read-write"
            ])
        );
    }

    #[test]
    fn surface_contract_has_no_markup_or_native_resource_field() {
        let declaration = PluginUiNode::decl(&ts_rs::Config::default());
        for forbidden in ["html", "script", "url", "path", "handle", "token"] {
            assert!(!declaration.to_ascii_lowercase().contains(forbidden));
        }
    }
}
