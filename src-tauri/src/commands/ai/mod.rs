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
use service::{
    MAX_AI_CONTEXT_BYTES, MAX_AI_CONTEXT_MODE_BYTES, MAX_AI_MODEL_BYTES, MAX_AI_SESSION_META_BYTES,
    MAX_AI_SHELL_BYTES, build_ai_messages, run_ai_chat, truncate_to_utf8_boundary,
    validate_ai_inputs, validate_optional_max_bytes,
};

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
    validate_ai_inputs(&request.prompt, &request.api_key, "请输入要生成的终端命令")?;
    validate_optional_max_bytes(
        request.model.as_deref(),
        MAX_AI_MODEL_BYTES,
        "model",
        "模型名称",
    )?;
    validate_optional_max_bytes(
        request.shell.as_deref(),
        MAX_AI_SHELL_BYTES,
        "shell",
        "目标 Shell",
    )?;

    let prompt = request.prompt.trim();
    let api_key = request.api_key.trim();
    enforce_ai_cooldown().await?;

    let context = truncate_to_utf8_boundary(
        request.context.as_deref().unwrap_or_default(),
        MAX_AI_CONTEXT_BYTES,
        "terminal AI context",
    );
    let shell = request.shell.as_deref().unwrap_or("linux/busybox");
    let untrusted_context = format!(
        "Target shell metadata: {shell}\nRecent serial console context:\n{}",
        if context.is_empty() {
            "(none)"
        } else {
            &context
        }
    );
    let messages = build_ai_messages(TERMINAL_SYSTEM_PROMPT, untrusted_context, prompt);

    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    let use_coding_plan = request.enable_coding_plan.unwrap_or(false);
    let content = run_ai_chat(
        model,
        messages,
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
    validate_ai_inputs(&request.prompt, &request.api_key, "请输入日志分析问题")?;
    validate_optional_max_bytes(
        request.model.as_deref(),
        MAX_AI_MODEL_BYTES,
        "model",
        "模型名称",
    )?;
    validate_optional_max_bytes(
        request.context_mode.as_deref(),
        MAX_AI_CONTEXT_MODE_BYTES,
        "contextMode",
        "上下文模式",
    )?;
    validate_optional_max_bytes(
        request.session_meta.as_deref(),
        MAX_AI_SESSION_META_BYTES,
        "sessionMeta",
        "会话元数据",
    )?;

    let prompt = request.prompt.trim();
    let api_key = request.api_key.trim();

    if request.context.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: "当前串口会话没有可分析的日志".to_string(),
            field: "context".to_string(),
        });
    }

    enforce_ai_cooldown().await?;

    let backend_context_truncated = request.context.len() > MAX_AI_CONTEXT_BYTES;
    let context =
        truncate_to_utf8_boundary(&request.context, MAX_AI_CONTEXT_BYTES, "log AI context");
    let context_mode = request.context_mode.as_deref().unwrap_or("latest-10k");
    let context_truncated = request.context_truncated.unwrap_or(false) || backend_context_truncated;
    let session_meta = request.session_meta.as_deref().unwrap_or_default();
    let untrusted_context = format!(
        "Session metadata:\n{session_meta}\nContext mode: {context_mode}\nContext truncated: {context_truncated}\nSerial log context:\n{context}"
    );
    let messages = build_ai_messages(LOG_SYSTEM_PROMPT, untrusted_context, prompt);

    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    let use_coding_plan = request.enable_coding_plan.unwrap_or(false);
    let content = run_ai_chat(
        model,
        messages,
        api_key,
        use_coding_plan,
        "AI 没有返回可用日志分析",
    )
    .await?;

    parse_log_ai_response(&content, context_truncated)
}

#[cfg(test)]
mod tests;
