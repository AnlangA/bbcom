use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How the Rust MCUmgr backend opens the serial port for one operation. The
/// frontend yields the port (clean close) before invoking and reconnects after
/// the command settles, so every operation is stateless on the Rust side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrPortRequest {
    /// Native port path exactly as enumerated by the serial plugin.
    pub path: String,
    pub baud_rate: u32,
    /// Per-request response timeout in milliseconds.
    pub timeout_ms: u32,
    /// Extra read-only attempts after the first try.
    pub retries: u8,
    /// Negotiate the SMP frame size from the device's reported buffer sizes.
    pub auto_frame_size: bool,
    /// Manual SMP frame size used when auto negotiation is off or fails.
    pub frame_size: u32,
}

/// One quick MCUmgr operation dispatched through `mcumgr_execute`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum McumgrOp {
    OsEcho { message: String },
    OsTasks,
    OsMemoryPools,
    OsDatetime,
    OsInfo { format: Option<String> },
    OsParams,
    OsBootloaderInfo,
    OsReset { force: bool },
    ImageState,
    ImageTest { hash_hex: String },
    ImageConfirm { hash_hex: Option<String> },
    ImageErase { slot: Option<u32> },
    ImageSlotInfo,
    Shell { line: String },
    FsStatus { path: String },
    FsHash { path: String },
    FsClose,
    SettingsRead { name: String },
    SettingsWrite { name: String, value_b64: String },
    SettingsDelete { name: String },
    SettingsCommit,
    SettingsLoad,
    SettingsSave,
    StatsList,
    StatsShow { name: String },
    EnumCount,
    EnumList,
    EnumDetails,
    ZephyrEraseStorage,
    Raw {
        group: u16,
        command: u8,
        write: bool,
        /// JSON object encoded to CBOR as the request payload.
        payload_json: Option<String>,
        /// Raw CBOR payload bytes; wins over `payloadJson` when both are set.
        payload_b64: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrExecuteRequest {
    pub port: McumgrPortRequest,
    pub op: McumgrOp,
}

/// Result of a quick command: the device response rendered as a JSON value.
/// The panel pretty-prints it; no per-command response mirror is maintained.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McumgrCommandResult {
    pub result_json: String,
}

/// Stable failure classes; the UI branches on `kind`, never on prose.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum McumgrErrorKind {
    /// Another MCUmgr operation is still running.
    Busy,
    Cancelled,
    Timeout,
    /// Opening or configuring the serial port failed.
    Port,
    /// The device answered with an SMP error response.
    Device,
    /// Transport/encoding failure while talking to the device.
    Protocol,
    InvalidInput,
    /// Local file read/write failed during a transfer.
    Io,
}

/// MCUmgr operation failure. `message` carries the device/toolkit diagnostic
/// chain for display; it never contains local file paths (grants stay opaque).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McumgrError {
    pub kind: McumgrErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rc: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<u16>,
}

impl McumgrError {
    pub fn new(kind: McumgrErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            rc: None,
            group: None,
        }
    }
}

/// Progress phase of a long-running MCUmgr operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum McumgrPhase {
    DetectingBootloader,
    BootloaderFound,
    ParsingImage,
    QueryingState,
    UpdateInfo,
    Uploading,
    Activating,
    Rebooting,
    Downloading,
}

/// Progress event streamed over a Tauri channel during long operations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct McumgrProgress {
    pub phase: McumgrPhase,
    /// Human-readable phase detail (bootloader name, version transition).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub total: Option<u64>,
}

/// What a picked local file will be used for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum McumgrFilePurpose {
    Firmware,
    FsUpload,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrPickFileRequest {
    pub purpose: McumgrFilePurpose,
}

/// Opaque grant to a file chosen in the native open dialog. The WebView only
/// ever sees the token, display name, and size; never the path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McumgrFilePick {
    pub token: String,
    pub display_name: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrPickSaveRequest {
    pub suggested_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McumgrSavePick {
    pub token: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrFirmwareUpdateRequest {
    pub port: McumgrPortRequest,
    pub file_token: String,
    pub skip_reboot: bool,
    pub force_confirm: bool,
    pub upgrade_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct McumgrImageUploadRequest {
    pub port: McumgrPortRequest,
    pub file_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<u32>,
    pub upgrade_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrFsUploadRequest {
    pub port: McumgrPortRequest,
    pub file_token: String,
    pub remote_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McumgrFsDownloadRequest {
    pub port: McumgrPortRequest,
    pub remote_path: String,
    pub save_token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McumgrFsDownloadResult {
    #[ts(type = "number")]
    pub bytes: u64,
    pub display_name: String,
}
