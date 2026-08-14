//! Compatibility exports for the canonical AI IPC contracts.

pub use bbcom_contracts::{
    AiRequestKind, AiRequestResult, AiRisk, CancelAiRequest, LogAiResponse, RunAiRequest,
    TerminalAiResponse,
};

/// Bounded request identity supplied solely for cancellation and correlation.
pub use bbcom_contracts::MAX_AI_REQUEST_ID_BYTES;
