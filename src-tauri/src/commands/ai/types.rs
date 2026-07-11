//! Public IPC wire types for the v0.5 AI commands.

use serde::{Deserialize, Serialize};

/// Bounded request identity supplied by the caller solely for cancellation and
/// correlation. It is not a secret and is never used as a filesystem name.
pub const MAX_AI_REQUEST_ID_BYTES: usize = 128;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAiResponse {
    pub command: String,
    pub explanation: String,
    pub risk: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAiResponse {
    pub answer: String,
    pub evidence: Vec<String>,
    pub suggestions: Vec<String>,
    pub truncated: bool,
}

/// The v0.5 request surface. Deliberately no `api_key` field: credential
/// retrieval happens entirely inside Rust through `SecureSettingsState`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunAiRequest {
    pub request_id: String,
    pub kind: AiRequestKind,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub session_meta: Option<String>,
    #[serde(default)]
    pub context_mode: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    pub prompt: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiRequestKind {
    Terminal,
    Log,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AiRequestResult {
    Terminal {
        command: String,
        explanation: String,
        risk: String,
    },
    Log {
        answer: String,
        evidence: Vec<String>,
        suggestions: Vec<String>,
        truncated: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAiRequest {
    pub request_id: String,
}
