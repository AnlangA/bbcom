//! Public IPC wire types for the AI commands.
//!
//! These structs are the deserialization targets for the frontend's
//! `invoke('terminal_ai_assist'|'log_ai_assist', ...)` payloads (see
//! src/lib/ipc.ts). Every field is `#[serde(rename_all = "camelCase")]` so the
//! Rust snake_case fields line up with the frontend's camelCase keys; optionals
//! default to `None` when omitted by the caller.

use serde::{Deserialize, Serialize};

// Deliberately no `Debug`: this request contains the user's API key.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAiRequest {
    pub prompt: String,
    pub api_key: String,
    pub model: Option<String>,
    pub enable_coding_plan: Option<bool>,
    pub shell: Option<String>,
    pub context: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAiResponse {
    pub command: String,
    pub explanation: String,
    pub risk: String,
}

// Deliberately no `Debug`: this request contains the user's API key.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAiRequest {
    pub prompt: String,
    pub api_key: String,
    pub model: Option<String>,
    pub enable_coding_plan: Option<bool>,
    pub context: String,
    pub context_mode: Option<String>,
    pub context_truncated: Option<bool>,
    pub session_meta: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAiResponse {
    pub answer: String,
    pub evidence: Vec<String>,
    pub suggestions: Vec<String>,
    pub truncated: bool,
}
