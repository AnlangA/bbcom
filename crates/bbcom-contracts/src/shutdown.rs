use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ShutdownState {
    Idle,
    Requested,
    Draining,
    Ready,
    TimedOut,
    Failed,
    Confirming,
    Confirmed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ShutdownDecisionState {
    Ready,
    TimedOut,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ShutdownParticipantStatus {
    Pending,
    Running,
    Completed,
    Failed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ShutdownParticipantMessageKey {
    #[serde(rename = "shutdown.participant.pending")]
    Pending,
    #[serde(rename = "shutdown.participant.running")]
    Running,
    #[serde(rename = "shutdown.participant.completed")]
    Completed,
    #[serde(rename = "shutdown.participant.failed")]
    Failed,
    #[serde(rename = "shutdown.participant.timed_out")]
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownParticipantReport {
    pub name: String,
    pub priority: i32,
    pub status: ShutdownParticipantStatus,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub message_key: ShutdownParticipantMessageKey,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownReport {
    pub attempt_id: String,
    pub state: ShutdownState,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub participants: Vec<ShutdownParticipantReport>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownCloseRequest {
    pub attempt_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownDrainResult {
    pub attempt_id: String,
    pub round: u32,
    pub state: ShutdownDecisionState,
    pub needs_decision: bool,
    #[ts(type = "true")]
    pub requires_confirm_exit: bool,
    pub report: ShutdownReport,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownConfirmation {
    pub attempt_id: String,
    pub forced: bool,
    pub report: ShutdownReport,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownCancellation {
    pub attempt_id: String,
    pub report: ShutdownReport,
}
