use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Direction, MAX_WORKSPACE_FRAME_BYTES, resolve_dual_data};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSaveHealth {
    Clean,
    Pending,
    Saving,
    Degraded,
    ReadOnly,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSummary {
    pub workspace_id: String,
    pub name: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub updated_at_ms: f64,
    pub save_health: WorkspaceSaveHealth,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCatalogRequest {
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceCatalogResponse {
    pub request_id: String,
    pub workspaces: Vec<WorkspaceSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_workspace_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceCommandRequest {
    pub request_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceCommandResponse {
    pub request_id: String,
    pub workspace: WorkspaceSummary,
    pub header: WorkspaceDocumentHeader,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceRequest {
    pub request_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceResponse {
    pub request_id: String,
    pub workspace: WorkspaceSummary,
    pub header: WorkspaceDocumentHeader,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteWorkspaceRequest {
    pub request_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteWorkspaceResponse {
    pub request_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HydrateWorkspaceSessionsRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSessionSnapshot {
    pub id: String,
    pub sort_order: u32,
    pub kind: WorkspaceSessionKind,
    pub name: String,
    pub needs_rebind: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_port_hint: Option<WorkspacePortHint>,
    #[ts(type = "Record<string, unknown>")]
    pub port_config: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub document: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub display_preferences: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub send_preferences: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub parser_state: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub feature_state: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub modbus_config: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub mcumgr_config: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct HydrateWorkspaceSessionsResponse {
    pub request_id: String,
    pub workspace_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub sessions: Vec<WorkspaceSessionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HydrateWorkspaceFramesRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub from_seq: u64,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceHydratedFrame {
    #[ts(type = "number")]
    pub seq: u64,
    pub id: String,
    pub direction: Direction,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub data: Vec<u8>,
    /// Base64 frame bytes. Hydrate responses carry payloads only over this
    /// channel; `data` serializes as an empty array for wire-shape stability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub requested_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub omitted_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct HydrateWorkspaceFramesResponse {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub frames: Vec<WorkspaceHydratedFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub next_seq: Option<u64>,
}

/// Persisted document header; runtime activities are intentionally absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceDocumentHeader {
    pub workspace_id: String,
    pub name: String,
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    pub session_ids: Vec<String>,
    #[ts(type = "Record<string, unknown>")]
    pub layout: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceMutationKind {
    SetMetadata,
    SetActiveSession,
    UpsertSession,
    RemoveSession,
    AppendFrames,
    ReplaceCapture,
    TrimCapture,
    UpsertFeatureState,
    ReplaceSessionCollections,
    AppendAiMessages,
    ClearAiMessages,
    ReplaceWaveformChannels,
    AppendWaveformSamples,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceMetadataPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown>")]
    pub layout: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspacePortHint {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_type: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceSessionKind {
    Live,
    Offline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceSessionUpsertPayload {
    pub name: String,
    pub sort_order: u32,
    pub kind: WorkspaceSessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_port_hint: Option<WorkspacePortHint>,
    #[ts(type = "Record<string, unknown>")]
    pub port_config: serde_json::Value,
    #[ts(type = "Record<string, unknown>")]
    pub document: serde_json::Value,
}

/// Frame payload appended to a capture over the dual `data`/`dataB64` IPC
/// channels (see [`crate::DataFramePayload`]). The base64 channel is decoded
/// and materialized into `data` during deserialization, so persistence and
/// validators only ever observe plain bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WorkspaceFramePayload {
    pub id: String,
    pub direction: Direction,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub data: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub requested_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub omitted_bytes: Option<u64>,
}

impl<'de> Deserialize<'de> for WorkspaceFramePayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Raw {
            id: String,
            direction: Direction,
            timestamp_ms: u64,
            #[serde(default)]
            data: Vec<u8>,
            #[serde(default)]
            data_b64: Option<String>,
            #[serde(default)]
            tx_status: Option<String>,
            #[serde(default)]
            requested_bytes: Option<u64>,
            #[serde(default)]
            omitted_bytes: Option<u64>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let data = resolve_dual_data(
            &raw.data,
            raw.data_b64.as_deref(),
            MAX_WORKSPACE_FRAME_BYTES,
        )
        .map_err(serde::de::Error::custom)?;
        Ok(Self {
            id: raw.id,
            direction: raw.direction,
            timestamp_ms: raw.timestamp_ms,
            data,
            data_b64: None,
            tx_status: raw.tx_status,
            requested_bytes: raw.requested_bytes,
            omitted_bytes: raw.omitted_bytes,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAppendFramesPayload {
    #[ts(type = "number")]
    pub start_seq: u64,
    pub frames: Vec<WorkspaceFramePayload>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReplaceCapturePayload {
    pub frames: Vec<WorkspaceFramePayload>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTrimCapturePayload {
    /// Number of oldest persisted rows to remove for this session.
    pub frame_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceFeatureKind {
    Preferences,
    Parser,
    Modbus,
    Waveform,
    Shell,
    Mcumgr,
    Plugin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSendHistoryEntry {
    pub data: String,
    pub is_hex: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceQuickCommand {
    pub id: String,
    pub name: String,
    pub data: String,
    pub is_hex: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub owner_plugin_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceMacroStep {
    pub data: String,
    pub is_hex: bool,
    pub delay_ms: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceMacro {
    pub id: String,
    pub name: String,
    pub steps: Vec<WorkspaceMacroStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub owner_plugin_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceConfigRow {
    pub id: String,
    #[ts(type = "Record<string, unknown>")]
    pub config: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSessionCollectionsPayload {
    pub send_history: Vec<WorkspaceSendHistoryEntry>,
    pub quick_commands: Vec<WorkspaceQuickCommand>,
    pub macros: Vec<WorkspaceMacro>,
    pub triggers: Vec<WorkspaceConfigRow>,
    pub highlights: Vec<WorkspaceConfigRow>,
    pub modbus_registers: Vec<WorkspaceConfigRow>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HydrateWorkspaceCollectionsRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HydrateWorkspaceCollectionsResponse {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub collections: WorkspaceSessionCollectionsPayload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAiRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAiMessage {
    pub id: String,
    pub role: WorkspaceAiRole,
    pub content: String,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAiMessagesPayload {
    pub start_position: u32,
    pub messages: Vec<WorkspaceAiMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HydrateWorkspaceAiMessagesRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct HydrateWorkspaceAiMessagesResponse {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub messages: Vec<WorkspaceAiMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWaveformSample {
    pub channel_index: u8,
    #[ts(type = "number")]
    pub seq: u64,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWaveformChannel {
    pub channel_index: u8,
    #[ts(type = "Record<string, unknown>")]
    pub config: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWaveformChannelsPayload {
    pub channels: Vec<WorkspaceWaveformChannel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWaveformSamplesPayload {
    pub samples: Vec<WorkspaceWaveformSample>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HydrateWorkspaceWaveformRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct HydrateWorkspaceWaveformResponse {
    pub request_id: String,
    pub workspace_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub channels: Vec<WorkspaceWaveformChannel>,
    pub samples: Vec<WorkspaceWaveformSample>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFeatureStatePayload {
    pub feature: WorkspaceFeatureKind,
    #[ts(type = "Record<string, unknown>")]
    pub state: serde_json::Value,
}

/// Every mutation variant fixes its own fields and payload at the Rust source.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceMutation {
    SetMetadata {
        sequence: u32,
        payload: WorkspaceMetadataPayload,
    },
    SetActiveSession {
        sequence: u32,
        session_id: Option<String>,
    },
    UpsertSession {
        sequence: u32,
        session_id: String,
        payload: WorkspaceSessionUpsertPayload,
    },
    RemoveSession {
        sequence: u32,
        session_id: String,
    },
    AppendFrames {
        sequence: u32,
        session_id: String,
        payload: WorkspaceAppendFramesPayload,
    },
    ReplaceCapture {
        sequence: u32,
        session_id: String,
        payload: WorkspaceReplaceCapturePayload,
    },
    TrimCapture {
        sequence: u32,
        session_id: String,
        payload: WorkspaceTrimCapturePayload,
    },
    UpsertFeatureState {
        sequence: u32,
        entity_id: String,
        payload: WorkspaceFeatureStatePayload,
    },
    ReplaceSessionCollections {
        sequence: u32,
        session_id: String,
        payload: WorkspaceSessionCollectionsPayload,
    },
    AppendAiMessages {
        sequence: u32,
        session_id: String,
        payload: WorkspaceAiMessagesPayload,
    },
    ClearAiMessages {
        sequence: u32,
        session_id: String,
    },
    ReplaceWaveformChannels {
        sequence: u32,
        session_id: String,
        payload: WorkspaceWaveformChannelsPayload,
    },
    AppendWaveformSamples {
        sequence: u32,
        session_id: String,
        payload: WorkspaceWaveformSamplesPayload,
    },
}

impl WorkspaceMutation {
    pub const fn sequence(&self) -> u32 {
        match self {
            Self::SetMetadata { sequence, .. }
            | Self::SetActiveSession { sequence, .. }
            | Self::UpsertSession { sequence, .. }
            | Self::RemoveSession { sequence, .. }
            | Self::AppendFrames { sequence, .. }
            | Self::ReplaceCapture { sequence, .. }
            | Self::TrimCapture { sequence, .. }
            | Self::UpsertFeatureState { sequence, .. } => *sequence,
            Self::ReplaceSessionCollections { sequence, .. }
            | Self::AppendAiMessages { sequence, .. }
            | Self::ClearAiMessages { sequence, .. }
            | Self::ReplaceWaveformChannels { sequence, .. }
            | Self::AppendWaveformSamples { sequence, .. } => *sequence,
        }
    }

    pub const fn kind(&self) -> WorkspaceMutationKind {
        match self {
            Self::SetMetadata { .. } => WorkspaceMutationKind::SetMetadata,
            Self::SetActiveSession { .. } => WorkspaceMutationKind::SetActiveSession,
            Self::UpsertSession { .. } => WorkspaceMutationKind::UpsertSession,
            Self::RemoveSession { .. } => WorkspaceMutationKind::RemoveSession,
            Self::AppendFrames { .. } => WorkspaceMutationKind::AppendFrames,
            Self::ReplaceCapture { .. } => WorkspaceMutationKind::ReplaceCapture,
            Self::TrimCapture { .. } => WorkspaceMutationKind::TrimCapture,
            Self::UpsertFeatureState { .. } => WorkspaceMutationKind::UpsertFeatureState,
            Self::ReplaceSessionCollections { .. } => {
                WorkspaceMutationKind::ReplaceSessionCollections
            }
            Self::AppendAiMessages { .. } => WorkspaceMutationKind::AppendAiMessages,
            Self::ClearAiMessages { .. } => WorkspaceMutationKind::ClearAiMessages,
            Self::ReplaceWaveformChannels { .. } => WorkspaceMutationKind::ReplaceWaveformChannels,
            Self::AppendWaveformSamples { .. } => WorkspaceMutationKind::AppendWaveformSamples,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyWorkspaceBatchRequest {
    pub workspace_id: String,
    pub client_batch_id: String,
    #[ts(type = "number")]
    pub base_revision: u64,
    pub mutations: Vec<WorkspaceMutation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyWorkspaceBatchResponse {
    pub client_batch_id: String,
    #[ts(type = "number")]
    pub committed_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlushWorkspaceRequest {
    pub workspace_id: String,
    #[ts(type = "number")]
    pub target_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlushWorkspaceResponse {
    #[ts(type = "number")]
    pub committed_revision: u64,
    pub save_health: WorkspaceSaveHealth,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestProjectSourceGrantRequest {
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSourceGrantResponse {
    pub request_id: String,
    pub source_grant_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestProjectTargetGrantRequest {
    pub request_id: String,
    pub suggested_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectTargetGrantResponse {
    pub request_id: String,
    pub target_grant_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProjectRequest {
    pub request_id: String,
    pub operation_id: String,
    pub source_grant_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProjectResponse {
    pub request_id: String,
    pub operation_id: String,
    pub workspace: WorkspaceSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportProjectRequest {
    pub request_id: String,
    pub operation_id: String,
    pub workspace_id: String,
    pub target_grant_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportProjectResponse {
    pub request_id: String,
    pub operation_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelWorkspaceOperationRequest {
    pub request_id: String,
    pub operation_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelWorkspaceOperationResponse {
    pub request_id: String,
    pub operation_id: String,
    pub cancellation_requested: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_json(data_field: &str) -> String {
        format!(r#"{{"id":"f1","direction":"TX","timestampMs":9,{data_field}}}"#)
    }

    #[test]
    fn frame_payload_materializes_the_base64_channel_during_deserialization() {
        let legacy: WorkspaceFramePayload =
            serde_json::from_str(&frame_json(r#""data":[1,2,3]"#)).unwrap();
        assert_eq!(legacy.data, vec![1, 2, 3]);
        assert_eq!(legacy.data_b64, None);

        let encoded: WorkspaceFramePayload =
            serde_json::from_str(&frame_json(r#""dataB64":"AQID""#)).unwrap();
        assert_eq!(encoded.data, vec![1, 2, 3]);
        assert_eq!(encoded.data_b64, None);
        // Round-tripping a materialized payload keeps the legacy shape.
        assert_eq!(
            serde_json::to_value(&encoded).unwrap(),
            serde_json::json!({"id":"f1","direction":"TX","timestampMs":9,"data":[1,2,3]})
        );

        assert!(
            serde_json::from_str::<WorkspaceFramePayload>(&frame_json(
                r#""data":[1],"dataB64":"AQ=="#
            ))
            .is_err()
        );
        assert!(
            serde_json::from_str::<WorkspaceFramePayload>(&frame_json(r#""dataB64":"!!""#))
                .is_err()
        );
        let oversized = crate::encode_data_b64(&vec![7_u8; MAX_WORKSPACE_FRAME_BYTES + 1]);
        assert!(
            serde_json::from_str::<WorkspaceFramePayload>(&frame_json(&format!(
                r#""dataB64":"{oversized}""#
            )))
            .is_err()
        );
        assert!(
            serde_json::from_str::<WorkspaceFramePayload>(
                r#"{"id":"f1","direction":"TX","timestampMs":9,"data":[1],"grantToken":"x"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn hydrated_frame_serializes_bytes_only_over_the_base64_channel() {
        let frame = WorkspaceHydratedFrame {
            seq: 4,
            id: "f1".to_owned(),
            direction: Direction::Tx,
            timestamp_ms: 9,
            data: Vec::new(),
            data_b64: Some(crate::encode_data_b64(&[1, 2, 3])),
            tx_status: None,
            requested_bytes: None,
            omitted_bytes: None,
        };
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            serde_json::json!({
                "seq": 4,
                "id": "f1",
                "direction": "TX",
                "timestampMs": 9,
                "data": [],
                "dataB64": "AQID",
            })
        );
        // The legacy number-array representation still deserializes.
        let legacy: WorkspaceHydratedFrame = serde_json::from_str(
            r#"{"seq":0,"id":"f1","direction":"TX","timestampMs":9,"data":[1,2,3]}"#,
        )
        .unwrap();
        assert_eq!(legacy.data, vec![1, 2, 3]);
        assert_eq!(legacy.data_b64, None);
    }
}
