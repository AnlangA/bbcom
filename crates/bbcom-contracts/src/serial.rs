use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::IpcError;

/// Maximum native serial tail returned by the explicit stop-and-drain command.
///
/// The command rejects silent truncation: reaching this bound while more bytes
/// remain produces a non-guaranteed `ByteLimitReached` completion.
pub const MAX_SERIAL_DRAIN_BYTES: usize = 2 * 1024 * 1024;

/// The serialplugin v3 API is path-scoped, so the existing renderer-owned port
/// identifier must temporarily cross this main-window-only command boundary.
/// It is validated, used only to address the already-open native port, and is
/// never returned in either the response or a structured error.
pub const MAX_SERIAL_PORT_PATH_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SerialDrainCompletion {
    /// Both the native hub and driver remained empty for the required idle gap.
    IdleGapObserved,
    /// The bounded total drain deadline elapsed before an idle gap was observed.
    DeadlineReached,
    /// More native input remained after the response byte ceiling was reached.
    ByteLimitReached,
    /// The native port registry, availability probe, or read operation failed.
    NativeReadFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialDrainRequest {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialDrainResponse {
    pub bytes: Vec<u8>,
    /// True only for `IdleGapObserved`; all bounded or failed endings are
    /// explicitly non-guaranteed rather than silently reporting success.
    pub guaranteed: bool,
    pub completion: SerialDrainCompletion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SerialSendOutcome {
    Complete,
    Partial,
    Failed,
    Cancelled,
}

/// Result returned by every logical send, including macros and plugins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SerialSendResult {
    pub outcome: SerialSendOutcome,
    pub requested_bytes: usize,
    pub sent_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<IpcError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PortLeaseState {
    Idle,
    Opening,
    Connected,
    Reconnecting,
    Closing,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortLeaseOwner {
    pub session_id: String,
    pub session_name: String,
    pub canonical_port: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquirePortLeaseRequest {
    pub session_id: String,
    pub session_name: String,
    pub canonical_port: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortLeaseGrant {
    pub lease_id: String,
    pub owner: PortLeaseOwner,
    pub state: PortLeaseState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleasePortLeaseRequest {
    pub lease_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortLeaseConflict {
    pub owner_session_id: String,
    pub owner_session_name: String,
    pub canonical_port: String,
}
