use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;

/// Raw capture direction used by export and auto-log commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
pub enum Direction {
    Tx,
    Rx,
}

/// Bounded frame payload transferred over JSON IPC.
///
/// Frame bytes cross the boundary over exactly one of two channels: the legacy
/// `data` number array (~4x wire expansion per byte) or the preferred
/// `dataB64` base64 string (~4/3). Old number-array senders keep working.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct DataFramePayload {
    pub id: String,
    pub direction: Direction,
    pub timestamp: f64,
    #[serde(default)]
    pub data: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_b64: Option<String>,
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

/// Checksum input over the same dual `data`/`dataB64` channels as frame
/// payloads; see [`DataFramePayload`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChecksumRequest {
    #[serde(default)]
    pub data: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_b64: Option<String>,
    pub algorithm: ChecksumType,
}

/// Failure modes shared by every dual `data`/`dataB64` IPC field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataB64Error {
    /// Both channels carried payload bytes; exactly one must.
    BothChannels,
    /// The base64 text is not canonical standard-alphabet base64.
    InvalidBase64,
    /// The payload exceeds the receiving command's byte limit. `actual` is the
    /// decoded byte length, or the tightest pre-decode upper bound when the
    /// payload was rejected before being materialized.
    LimitExceeded { limit: usize, actual: usize },
}

impl fmt::Display for DataB64Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BothChannels => {
                write!(
                    formatter,
                    "exactly one of data and dataB64 must carry the payload"
                )
            }
            Self::InvalidBase64 => write!(formatter, "dataB64 is not valid base64"),
            Self::LimitExceeded { limit, actual } => {
                write!(formatter, "payload too large: {actual} bytes (max {limit})")
            }
        }
    }
}

impl std::error::Error for DataB64Error {}

/// Encode frame bytes for the `dataB64` IPC channel.
pub fn encode_data_b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Decode one `dataB64` value with the command's byte limit enforced before
/// decoding (so an oversized payload is rejected without allocation) and again
/// on the decoded length.
pub fn decode_data_b64(encoded: &str, limit: usize) -> Result<Vec<u8>, DataB64Error> {
    // A padded standard-alphabet string with `u` significant characters decodes
    // to exactly `u / 4 * 3` bytes plus one per two trailing significant
    // characters of the final partial group. That bound is tight for every
    // valid remainder: an at-limit payload is never rejected pre-decode, while
    // anything larger is refused before its buffer is allocated.
    let significant = encoded.trim_end_matches('=').len();
    let worst_case_bytes = significant / 4 * 3
        + match significant % 4 {
            2 => 1,
            3 => 2,
            _ => 0,
        };
    if worst_case_bytes > limit {
        return Err(DataB64Error::LimitExceeded {
            limit,
            actual: worst_case_bytes,
        });
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| DataB64Error::InvalidBase64)?;
    if bytes.len() > limit {
        return Err(DataB64Error::LimitExceeded {
            limit,
            actual: bytes.len(),
        });
    }
    Ok(bytes)
}

/// Resolve the dual representation into materialized bytes: when `data_b64` is
/// present it must be the only carrier and is decoded against `limit`;
/// otherwise the legacy number array passes through unchanged.
pub fn resolve_dual_data(
    data: &[u8],
    data_b64: Option<&str>,
    limit: usize,
) -> Result<Vec<u8>, DataB64Error> {
    match data_b64 {
        Some(encoded) => {
            if !data.is_empty() {
                return Err(DataB64Error::BothChannels);
            }
            decode_data_b64(encoded, limit)
        }
        None => Ok(data.to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dual_channel_payloads_accept_either_representation() {
        let legacy: DataFramePayload =
            serde_json::from_str(r#"{"id":"f1","direction":"TX","timestamp":1,"data":[1,2,3]}"#)
                .unwrap();
        assert_eq!(legacy.data, vec![1, 2, 3]);
        assert_eq!(legacy.data_b64, None);

        // The legacy crate keeps the raw channel fields; command entry points
        // materialize `data_b64` via `resolve_dual_data`.
        let encoded: DataFramePayload = serde_json::from_str(
            r#"{"id":"f1","direction":"TX","timestamp":1,"data":[],"dataB64":"AQID"}"#,
        )
        .unwrap();
        assert_eq!(encoded.data, Vec::<u8>::new());
        assert_eq!(encoded.data_b64.as_deref(), Some("AQID"));
        assert_eq!(
            resolve_dual_data(&encoded.data, encoded.data_b64.as_deref(), 64).unwrap(),
            vec![1, 2, 3]
        );

        let checksum: ChecksumRequest =
            serde_json::from_str(r#"{"data":[],"dataB64":"AQ==","algorithm":"CRC16"}"#).unwrap();
        assert_eq!(checksum.data, Vec::<u8>::new());
        assert_eq!(checksum.data_b64.as_deref(), Some("AQ=="));
        assert_eq!(
            resolve_dual_data(&checksum.data, checksum.data_b64.as_deref(), 64).unwrap(),
            vec![1]
        );
    }

    #[test]
    fn dual_channel_decoding_enforces_exactly_one_channel_and_limits() {
        // Both channels present deserialize, but the shared resolver rejects
        // the ambiguity at the command boundary.
        let both: DataFramePayload = serde_json::from_str(
            r#"{"id":"f1","direction":"TX","timestamp":1,"data":[1],"dataB64":"AQ=="}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_dual_data(&both.data, both.data_b64.as_deref(), 64),
            Err(DataB64Error::BothChannels)
        );

        assert_eq!(decode_data_b64("AQ==", 1).unwrap(), vec![1]);
        // The pre-decode bound is tight: an at-limit payload decodes.
        let at_limit = encode_data_b64(&[7_u8; 64]);
        assert_eq!(decode_data_b64(&at_limit, 64).unwrap().len(), 64);
        // Oversized payloads are rejected before allocation, with the exact
        // decoded size reported from the encoded form.
        let oversized = encode_data_b64(&[7_u8; 65]);
        assert_eq!(
            decode_data_b64(&oversized, 64),
            Err(DataB64Error::LimitExceeded {
                limit: 64,
                actual: 65
            })
        );
        assert_eq!(
            decode_data_b64("not base64!", 64),
            Err(DataB64Error::InvalidBase64)
        );
        assert_eq!(
            resolve_dual_data(&[1], Some("AQ=="), 64),
            Err(DataB64Error::BothChannels)
        );
        assert_eq!(resolve_dual_data(&[1, 2], None, 64).unwrap(), vec![1, 2]);
    }
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

/// Backend-owned export source. Absent on the begin request, the renderer
/// streams its in-memory frames batch by batch (the original wire shape);
/// present, the backend reads the frames itself and renderer appends for that
/// export session are rejected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ExportSource {
    /// Whole-session frames read from the durable workspace SQLite file,
    /// strictly below `to_seq_exclusive` (the caller's next append sequence
    /// after flushing its save queue). Frames at or above the ceiling are
    /// excluded even once they are persisted.
    #[serde(rename_all = "camelCase")]
    WorkspaceFrames {
        workspace_id: String,
        session_id: String,
        #[ts(type = "number")]
        to_seq_exclusive: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginExportRequest {
    pub format: ExportFormat,
    pub token: String,
    pub expected_frames: usize,
    pub expected_raw_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<ExportSource>,
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
    /// Backend-source mode only: the frame total the backend committed to
    /// enforce at finish, read from the durable source. Absent for
    /// renderer-source exports (the renderer already knows its own total).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_frames: Option<usize>,
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
