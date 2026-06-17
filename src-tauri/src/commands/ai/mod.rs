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

pub(crate) mod cooldown;
pub(crate) mod parser;
pub(crate) mod prompts;
pub(crate) mod service;
pub(crate) mod types;

// Re-export the wire types so existing `crate::commands::ai::{...}` import
// paths keep resolving (pure move + re-export).
pub use types::{LogAiRequest, LogAiResponse, TerminalAiRequest, TerminalAiResponse};

use crate::models::errors::AppError;
use cooldown::enforce_ai_cooldown;
use parser::{parse_log_ai_response, parse_terminal_ai_response};
use prompts::{LOG_SYSTEM_PROMPT, TERMINAL_SYSTEM_PROMPT};
use service::{MAX_AI_CONTEXT_BYTES, run_ai_chat, truncate_to_utf8_boundary, validate_ai_inputs};

/// Webview window label for the standalone AI assistant window.
pub const AI_WINDOW_LABEL: &str = "ai-assistant";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Generate the safest shell command for a Linux-like serial terminal from a
/// natural-language request. Consumes the rate-limit budget only after input
/// validation passes.
#[tauri::command]
pub async fn terminal_ai_assist(
    request: TerminalAiRequest,
) -> Result<TerminalAiResponse, AppError> {
    let prompt = request.prompt.trim();
    let api_key = request.api_key.trim();
    validate_ai_inputs(prompt, api_key, "请输入要生成的终端命令")?;
    enforce_ai_cooldown().await?;

    let context = truncate_to_utf8_boundary(
        &request.context.unwrap_or_default(),
        MAX_AI_CONTEXT_BYTES,
        "terminal AI context",
    );
    let shell = request.shell.unwrap_or_else(|| "linux/busybox".to_string());
    let user_prompt = format!(
        "System prompt:\n{TERMINAL_SYSTEM_PROMPT}\n\nTarget shell: {shell}\nRecent serial console context:\n{context}\n\nUser request: {}",
        prompt
    );

    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    let use_coding_plan = request.enable_coding_plan.unwrap_or(false);
    let content = run_ai_chat(
        model,
        user_prompt,
        api_key,
        use_coding_plan,
        "AI 没有返回可用命令",
    )
    .await?;

    parse_terminal_ai_response(&content)
}

/// Answer a question about a serial session's captured log using only the
/// provided context. Requires non-empty context; consumes the rate-limit budget
/// only after input validation passes.
#[tauri::command]
pub async fn log_ai_assist(request: LogAiRequest) -> Result<LogAiResponse, AppError> {
    let prompt = request.prompt.trim();
    let api_key = request.api_key.trim();
    validate_ai_inputs(prompt, api_key, "请输入日志分析问题")?;

    if request.context.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: "当前串口会话没有可分析的日志".to_string(),
            field: "context".to_string(),
        });
    }

    enforce_ai_cooldown().await?;

    let context =
        truncate_to_utf8_boundary(&request.context, MAX_AI_CONTEXT_BYTES, "log AI context");
    let context_mode = request
        .context_mode
        .unwrap_or_else(|| "latest-10k".to_string());
    let context_truncated = request.context_truncated.unwrap_or(false);
    let session_meta = request.session_meta.unwrap_or_default();
    let user_prompt = format!(
        "System prompt:\n{LOG_SYSTEM_PROMPT}\n\nSession:\n{session_meta}\n\nContext mode: {context_mode}\nContext truncated: {context_truncated}\nSerial log context:\n{context}\n\nUser question: {}",
        prompt
    );

    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    let use_coding_plan = request.enable_coding_plan.unwrap_or(false);
    let content = run_ai_chat(
        model,
        user_prompt,
        api_key,
        use_coding_plan,
        "AI 没有返回可用日志分析",
    )
    .await?;

    parse_log_ai_response(&content, context_truncated)
}

#[cfg(test)]
mod tests;
