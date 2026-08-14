use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Process/window that originated a revisioned state message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum StateOrigin {
    Main,
    AiAssistant,
    PluginHost,
}

/// Revisioned state/event envelope shared by the main and auxiliary windows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateEnvelope<T> {
    pub schema_version: u32,
    pub workspace_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub origin: StateOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
    pub payload: T,
}
