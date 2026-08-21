//! AI command module — the Tauri command surface for the two AI workflows
//! (terminal-command generation and serial-log analysis).
//!
//! This file is intentionally a thin dispatcher (<120 lines): it owns the
//! `#[tauri::command]` entry points and the prompt composition, and delegates
//! the mechanics to focused submodules:
//!   - [`types`]    — public request/response wire structs (re-exported here)
//!   - [`cooldown`] — global rate-limit guard
//!   - [`prompts`]  — system-prompt constants
//!   - [`service`]  — Z.ai client dispatch + input validation/truncation
//!   - [`parser`]   — defensive JSON extraction + response normalization
//!   - [`tests`]    — unit tests (kept here so they exercise the public surface)

pub(crate) mod parser;
pub(crate) mod prompts;
pub(crate) mod request_manager;
pub(crate) mod service;
pub(crate) mod types;

// Re-export the wire types so existing `crate::commands::ai::{...}` import
// paths keep resolving (pure move + re-export).
pub use types::{
    AiRequestKind, AiRequestResult, AiRisk, CancelAiRequest, LogAiResponse, RunAiRequest,
    TerminalAiResponse,
};

use crate::ai_settings::load_ai_key_for_request;
use crate::models::errors::AppError;
use crate::models::ipc_error::{AppErrorCode, IpcError, from_app_error};
use crate::utils::window::require_main_window_label;
use parser::{parse_log_ai_response, parse_terminal_ai_response};
use prompts::{LOG_SYSTEM_PROMPT, TERMINAL_SYSTEM_PROMPT};
use request_manager::AiRequestManager;
use service::{
    MAX_AI_CONTEXT_BYTES, MAX_AI_CONTEXT_MODE_BYTES, MAX_AI_MODEL_BYTES, MAX_AI_PROMPT_BYTES,
    MAX_AI_SESSION_META_BYTES, MAX_AI_SHELL_BYTES, build_ai_messages, run_ai_chat,
};
use tauri::{Manager, State, WebviewWindow};

/// Webview window label for the standalone AI assistant window.
pub const AI_WINDOW_LABEL: &str = "ai-assistant";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// All AI command failures funnel through the single canonical
// `models::ipc_error::from_app_error` mapper (see T3.5): its stable codes,
// message keys, field names, and retryability win over any AI-specific
// mapping that existed here before.

fn validate_v050_request(request: &RunAiRequest) -> Result<(), IpcError> {
    let operation = "run_ai_request";
    if request.prompt.trim().is_empty() {
        return Err(IpcError::invalid_input(operation, "prompt"));
    }
    for (value, limit, field) in [
        (Some(request.prompt.as_str()), MAX_AI_PROMPT_BYTES, "prompt"),
        (request.model.as_deref(), MAX_AI_MODEL_BYTES, "model"),
        (request.shell.as_deref(), MAX_AI_SHELL_BYTES, "shell"),
        (
            request.session_meta.as_deref(),
            MAX_AI_SESSION_META_BYTES,
            "sessionMeta",
        ),
        (
            request.context_mode.as_deref(),
            MAX_AI_CONTEXT_MODE_BYTES,
            "contextMode",
        ),
        (request.context.as_deref(), MAX_AI_CONTEXT_BYTES, "context"),
    ] {
        if let Some(value) = value
            && value.len() > limit
        {
            return Err(IpcError::invalid_input(operation, field).with_size(limit, value.len()));
        }
    }
    if request.kind == AiRequestKind::Log
        && request
            .context
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err(IpcError::invalid_input(operation, "context"));
    }
    Ok(())
}

async fn dispatch_v050_request(
    request: &RunAiRequest,
    api_key: &str,
) -> Result<AiRequestResult, AppError> {
    let prompt = request.prompt.trim();
    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    match request.kind {
        AiRequestKind::Terminal => {
            let context = request.context.as_deref().unwrap_or_default();
            let shell = request.shell.as_deref().unwrap_or("linux/busybox");
            let untrusted_context = format!(
                "Target shell metadata: {shell}\nRecent serial console context:\n{}",
                if context.is_empty() {
                    "(none)"
                } else {
                    context
                }
            );
            let content = run_ai_chat(
                model,
                build_ai_messages(TERMINAL_SYSTEM_PROMPT, untrusted_context, prompt),
                api_key,
                false,
                "AI 没有返回可用命令",
            )
            .await?;
            let response = parse_terminal_ai_response(&content)?;
            Ok(AiRequestResult::Terminal {
                command: response.command,
                explanation: response.explanation,
                risk: response.risk,
            })
        }
        AiRequestKind::Log => {
            let context = request.context.as_deref().unwrap_or_default();
            let context_mode = request.context_mode.as_deref().unwrap_or("latest-10k");
            let session_meta = request.session_meta.as_deref().unwrap_or_default();
            let untrusted_context = format!(
                "Session metadata:\n{session_meta}\nContext mode: {context_mode}\nSerial log context:\n{context}"
            );
            let content = run_ai_chat(
                model,
                build_ai_messages(LOG_SYSTEM_PROMPT, untrusted_context, prompt),
                api_key,
                false,
                "AI 没有返回可用日志分析",
            )
            .await?;
            let response = parse_log_ai_response(&content, false)?;
            Ok(AiRequestResult::Log {
                answer: response.answer,
                evidence: response.evidence,
                suggestions: response.suggestions,
                truncated: response.truncated,
            })
        }
    }
}

/// v0.5's only AI execution command. The credential is loaded inside Rust;
/// a webview can neither read it nor attach it to an IPC payload.
#[tauri::command]
pub async fn run_ai_request(
    window: WebviewWindow,
    requests: State<'_, AiRequestManager>,
    request: RunAiRequest,
) -> Result<AiRequestResult, IpcError> {
    const OPERATION: &str = "run_ai_request";
    require_main_window_label(window.label(), OPERATION)?;
    validate_v050_request(&request)?;
    let request_id = request.request_id.clone();
    let cancellation = requests.begin(&request_id)?;

    let result = async {
        let api_key = load_ai_key_for_request(window.app_handle())?;
        tokio::select! {
            result = dispatch_v050_request(&request, api_key.as_str()) => {
                result.map_err(|error| from_app_error(&error, OPERATION).with_request_id(&request_id))
            }
            _ = cancellation.cancelled() => Err(
                IpcError::new(AppErrorCode::Cancelled, "error.cancelled", false, OPERATION)
                    .with_request_id(&request_id)
            ),
        }
    }
    .await;
    requests.finish(&request_id);
    result
}

#[tauri::command]
pub fn cancel_ai_request(
    window: WebviewWindow,
    requests: State<'_, AiRequestManager>,
    request: CancelAiRequest,
) -> Result<(), IpcError> {
    require_main_window_label(window.label(), "cancel_ai_request")?;
    requests.cancel(&request.request_id)
}

#[cfg(test)]
mod tests;
