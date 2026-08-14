use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Raw capture direction used by export and auto-log commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
pub enum Direction {
    Tx,
    Rx,
}

/// Bounded frame payload transferred over JSON IPC.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataFramePayload {
    pub id: String,
    pub direction: Direction,
    pub timestamp: f64,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChecksumType {
    Checksum,
    Crc8,
    Crc16,
    Crc16Modbus,
    Crc32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecksumRequest {
    pub data: Vec<u8>,
    pub algorithm: ChecksumType,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecksumResponse {
    pub result: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    #[serde(alias = "txt")]
    TxtHex,
    TxtAscii,
    Csv,
    Jsonl,
    Bin,
}

impl ExportFormat {
    pub const fn extension(self) -> &'static str {
        match self {
            Self::TxtHex | Self::TxtAscii => "txt",
            Self::Csv => "csv",
            Self::Jsonl => "jsonl",
            Self::Bin => "bin",
        }
    }

    pub const fn label(self) -> &'static str {
        self.extension()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginExportRequest {
    pub format: ExportFormat,
    pub token: String,
    pub expected_frames: usize,
    pub expected_raw_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendExportBatchRequest {
    pub export_id: String,
    pub frames: Vec<DataFramePayload>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSessionRequest {
    pub export_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginExportResponse {
    pub export_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportAppendStats {
    pub total_frames: usize,
    pub total_raw_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportFinishStats {
    pub frames: usize,
    pub raw_bytes: usize,
    pub output_bytes: usize,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AutoLogFormat {
    Hex,
    Text,
}

impl AutoLogFormat {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Hex => "hex",
            Self::Text => "text",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginAutoLogRequest {
    pub token: String,
    pub format: AutoLogFormat,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginAutoLogResponse {
    pub log_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendAutoLogBatchRequest {
    pub log_id: String,
    pub frames: Vec<DataFramePayload>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoLogAppendStats {
    pub frames: usize,
    pub raw_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoLogSessionRequest {
    pub log_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SaveTargetPurpose {
    ExportTxtHex,
    ExportTxtAscii,
    ExportCsv,
    ExportJsonl,
    ExportBin,
    AutoLog,
}

impl SaveTargetPurpose {
    pub const fn extension(self) -> &'static str {
        match self {
            Self::ExportTxtHex | Self::ExportTxtAscii | Self::AutoLog => "txt",
            Self::ExportCsv => "csv",
            Self::ExportJsonl => "jsonl",
            Self::ExportBin => "bin",
        }
    }

    pub const fn filter_name(self) -> &'static str {
        match self {
            Self::ExportTxtHex | Self::ExportTxtAscii | Self::AutoLog => "Text",
            Self::ExportCsv => "CSV",
            Self::ExportJsonl => "JSON Lines",
            Self::ExportBin => "Binary",
        }
    }

    pub const fn export_format(self) -> Option<ExportFormat> {
        match self {
            Self::ExportTxtHex => Some(ExportFormat::TxtHex),
            Self::ExportTxtAscii => Some(ExportFormat::TxtAscii),
            Self::ExportCsv => Some(ExportFormat::Csv),
            Self::ExportJsonl => Some(ExportFormat::Jsonl),
            Self::ExportBin => Some(ExportFormat::Bin),
            Self::AutoLog => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSaveTargetRequest {
    pub purpose: SaveTargetPurpose,
    pub suggested_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveTargetGrantResponse {
    pub token: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeFileGrantRequest {
    pub token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AiRequestKind {
    Terminal,
    Log,
}

/// Credential-free AI request. The backend retrieves its own key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct RunAiRequest {
    pub request_id: String,
    pub kind: AiRequestKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_meta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub prompt: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AiRisk {
    Safe,
    Caution,
    Dangerous,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAiResponse {
    pub command: String,
    pub explanation: String,
    pub risk: AiRisk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogAiResponse {
    pub answer: String,
    pub evidence: Vec<String>,
    pub suggestions: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum AiRequestResult {
    Terminal {
        command: String,
        explanation: String,
        risk: AiRisk,
    },
    Log {
        answer: String,
        evidence: Vec<String>,
        suggestions: Vec<String>,
        truncated: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelAiRequest {
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiWindowState {
    pub visible: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeAiWindowRequest {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AiKeyDurability {
    Os,
    Session,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiKeyStatus {
    pub configured: bool,
    pub durability: AiKeyDurability,
}

impl AiKeyStatus {
    pub const fn missing() -> Self {
        Self {
            configured: false,
            durability: AiKeyDurability::Missing,
        }
    }

    pub const fn os() -> Self {
        Self {
            configured: true,
            durability: AiKeyDurability::Os,
        }
    }

    pub const fn session() -> Self {
        Self {
            configured: true,
            durability: AiKeyDurability::Session,
        }
    }
}

/// Write-only secret command. Its value is intentionally absent from responses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAiApiKeyRequest {
    pub value: String,
}

/// One-way migration request. Its value is intentionally absent from responses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct MigrateAiApiKeyRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}
