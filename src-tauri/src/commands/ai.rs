use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{Emitter, LogicalSize, Manager};
use zai_rs::model::{
    chat_base_request::ChatBody, chat_base_response::ChatCompletionResponse, traits::*, *,
};

use crate::models::errors::AppError;

pub const AI_WINDOW_LABEL: &str = "ai-assistant";
const AI_WINDOW_STATE_EVENT: &str = "ai-window-state";
const AI_REQUEST_TIMEOUT_SECS: u64 = 60;
const MAX_AI_CONTEXT_BYTES: usize = 512_000;

const TERMINAL_SYSTEM_PROMPT: &str = r#"You are an expert Linux terminal command generator for an embedded serial console.
Convert the user's natural-language request into the single safest shell command that should be typed into a Linux-like serial terminal.
Rules:
- Output JSON only: {"command":"...","explanation":"...","risk":"safe|caution|dangerous"}.
- The command must be one line.
- Do not wrap the command in Markdown.
- Prefer POSIX/Linux BusyBox-compatible commands.
- Never execute anything yourself.
- If the user asks for destructive, privileged, network, credential, or irreversible actions, set risk to "dangerous" and return the safest non-destructive inspection command when possible.
- If more information is required, return an empty command and explain what is missing.
- For simple navigation/inspection tasks, return only the direct command, e.g. "查看当前路径" -> "pwd"."#;

const LOG_SYSTEM_PROMPT: &str = r#"You are an expert embedded serial log analysis assistant.
Answer the user's question using only the provided serial log context.
Rules:
- Output JSON only: {"answer":"...","evidence":["..."],"suggestions":["..."],"truncated":false}.
- Do not wrap the response in Markdown.
- If the log context is insufficient, say so clearly and list what evidence is missing.
- Cite concrete timestamps, directions, error codes, or log fragments in evidence when available.
- Keep suggestions practical and safe for serial debugging."#;

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWindowState {
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeAiWindowRequest {
    pub width: f64,
    pub height: f64,
}

fn get_ai_window(app: &tauri::AppHandle, action: &str) -> Result<tauri::WebviewWindow, AppError> {
    app.get_webview_window(AI_WINDOW_LABEL).ok_or_else(|| {
        AppError::AiError {
            message: format!("AI 窗口不存在 ({})", action),
        }
    })
}

fn toggle_ai_window_visibility(app: &tauri::AppHandle, visible: bool) -> Result<(), AppError> {
    let window = get_ai_window(app, if visible { "show" } else { "hide" })?;
    if visible {
        window.show().map_err(|e| AppError::AiError { message: e.to_string() })?;
        if let Err(e) = window.set_focus() {
            tracing::warn!("failed to focus AI window: {e}");
        }
    } else {
        window.hide().map_err(|e| AppError::AiError { message: e.to_string() })?;
    }
    if let Err(e) = app.emit(AI_WINDOW_STATE_EVENT, AiWindowState { visible }) {
        tracing::warn!("failed to emit {}: {e}", AI_WINDOW_STATE_EVENT);
    }
    Ok(())
}

#[tauri::command]
pub fn show_ai_window(app: tauri::AppHandle) -> Result<(), AppError> {
    toggle_ai_window_visibility(&app, true)
}

#[tauri::command]
pub fn hide_ai_window(app: tauri::AppHandle) -> Result<(), AppError> {
    toggle_ai_window_visibility(&app, false)
}

#[tauri::command]
pub fn get_ai_window_state(app: tauri::AppHandle) -> Result<AiWindowState, AppError> {
    let visible = app
        .get_webview_window(AI_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    Ok(AiWindowState { visible })
}

#[tauri::command]
pub fn resize_ai_window(
    app: tauri::AppHandle,
    request: ResizeAiWindowRequest,
) -> Result<(), AppError> {
    let window = get_ai_window(&app, "resize")?;
    let width = request.width.clamp(420.0, 920.0);
    let height = request.height.clamp(112.0, 560.0);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| AppError::AiError {
            message: e.to_string(),
        })
}

#[tauri::command]
pub fn start_ai_window_drag(window: tauri::Window) -> Result<(), AppError> {
    window.start_dragging().map_err(|e| AppError::AiError {
        message: e.to_string(),
    })
}

fn truncate_to_utf8_boundary(s: &str, max_bytes: usize, label: &str) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    tracing::warn!("{} truncated from {} to {} bytes", label, s.len(), boundary);
    s[..boundary].to_string()
}

fn validate_ai_inputs(prompt: &str, api_key: &str, prompt_empty_msg: &str) -> Result<(), AppError> {
    if prompt.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: prompt_empty_msg.to_string(),
            field: "prompt".to_string(),
        });
    }
    if api_key.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: "请先配置 Z.ai API Key".to_string(),
            field: "apiKey".to_string(),
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_ai_assist(
    request: TerminalAiRequest,
) -> Result<TerminalAiResponse, AppError> {
    validate_ai_inputs(&request.prompt, &request.api_key, "请输入要生成的终端命令")?;

    let context = truncate_to_utf8_boundary(
        &request.context.unwrap_or_default(),
        MAX_AI_CONTEXT_BYTES,
        "terminal AI context",
    );

    let shell = request.shell.unwrap_or_else(|| "linux/busybox".to_string());
    let user_prompt = format!(
        "System prompt:\n{TERMINAL_SYSTEM_PROMPT}\n\nTarget shell: {shell}\nRecent serial console context:\n{context}\n\nUser request: {}",
        request.prompt.trim()
    );

    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    let use_coding_plan = request.enable_coding_plan.unwrap_or(false);
    let content = run_ai_chat(model, user_prompt, &request.api_key, use_coding_plan, "AI 没有返回可用命令").await?;

    parse_terminal_ai_response(&content)
}

#[tauri::command]
pub async fn log_ai_assist(request: LogAiRequest) -> Result<LogAiResponse, AppError> {
    validate_ai_inputs(&request.prompt, &request.api_key, "请输入日志分析问题")?;

    if request.context.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: "当前串口会话没有可分析的日志".to_string(),
            field: "context".to_string(),
        });
    }

    let context = truncate_to_utf8_boundary(&request.context, MAX_AI_CONTEXT_BYTES, "log AI context");
    let context_mode = request.context_mode.unwrap_or_else(|| "latest-10k".to_string());
    let context_truncated = request.context_truncated.unwrap_or(false);
    let session_meta = request.session_meta.unwrap_or_default();
    let user_prompt = format!(
        "System prompt:\n{LOG_SYSTEM_PROMPT}\n\nSession:\n{session_meta}\n\nContext mode: {context_mode}\nContext truncated: {context_truncated}\nSerial log context:\n{context}\n\nUser question: {}",
        request.prompt.trim()
    );

    let model = request.model.as_deref().unwrap_or("glm-4.5-air");
    let use_coding_plan = request.enable_coding_plan.unwrap_or(false);
    let content = run_ai_chat(model, user_prompt, &request.api_key, use_coding_plan, "AI 没有返回可用日志分析").await?;

    parse_log_ai_response(&content, context_truncated)
}

async fn run_ai_chat(
    model: &str,
    user_prompt: String,
    api_key: &str,
    use_coding_plan: bool,
    empty_error: &str,
) -> Result<String, AppError> {
    let body = send_chat_by_name(model, user_prompt, api_key, use_coding_plan).await?;
    body.choices()
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.message().content())
        .and_then(extract_text_from_content)
        .ok_or_else(|| AppError::AiError {
            message: empty_error.to_string(),
        })
}

async fn send_chat_by_name(
    model: &str,
    user_prompt: String,
    api_key: &str,
    use_coding_plan: bool,
) -> Result<ChatCompletionResponse, AppError> {
    match model {
        "glm-5.1" => send_chat(GLM5_1 {}, user_prompt, api_key, use_coding_plan).await,
        "glm-5-turbo" => send_chat(GLM5_turbo {}, user_prompt, api_key, use_coding_plan).await,
        "glm-4.7" => send_chat(GLM4_7 {}, user_prompt, api_key, use_coding_plan).await,
        "glm-4.5-air" => send_chat(GLM4_5_air {}, user_prompt, api_key, use_coding_plan).await,
        _ => Err(AppError::ValidationError {
            message: format!("不支持的 Chat 模型: {}", model),
            field: "model".to_string(),
        }),
    }
}

async fn send_chat<N>(
    model: N,
    user_prompt: String,
    api_key: &str,
    use_coding_plan: bool,
) -> Result<ChatCompletionResponse, AppError>
where
    N: ModelName + Chat + ThinkEnable + Serialize,
    (N, TextMessage): Bounded,
    ChatBody<N, TextMessage>: Serialize,
{
    let client = ChatCompletion::new(model, TextMessage::user(user_prompt), api_key.to_string())
        .with_temperature(0.1)
        .with_top_p(0.8)
        .with_thinking(ThinkingType::enabled());

    let result = if use_coding_plan {
        tokio::time::timeout(Duration::from_secs(AI_REQUEST_TIMEOUT_SECS), client.with_coding_plan().send()).await
    } else {
        tokio::time::timeout(Duration::from_secs(AI_REQUEST_TIMEOUT_SECS), client.send()).await
    };

    match result {
        Ok(result) => result.map_err(|e| AppError::AiError {
            message: e.to_string(),
        }),
        Err(_elapsed) => Err(AppError::AiError {
            message: format!("AI 请求超时 ({}s)", AI_REQUEST_TIMEOUT_SECS),
        }),
    }
}

fn clean_markdown_fence(content: &str) -> &str {
    content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
}

fn extract_json_from_text(content: &str) -> &str {
    let trimmed = clean_markdown_fence(content);
    let first = trimmed.find('{');
    let last = trimmed.rfind('}');
    match (first, last) {
        (Some(start), Some(end)) if start <= end => {
            let json_fragment = &trimmed[start..=end];
            if start > 0 || end < trimmed.len() - 1 {
                tracing::debug!("AI response contained extra text outside JSON; extracted {}-byte fragment", json_fragment.len());
            }
            json_fragment
        }
        _ => trimmed,
    }
}

fn extract_text_from_content(value: &Value) -> Option<String> {
    let result = value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    if result.is_none() {
        tracing::debug!("failed to extract text from AI response value: {:?}", value);
    }
    result
}

fn parse_terminal_ai_response(content: &str) -> Result<TerminalAiResponse, AppError> {
    let cleaned = extract_json_from_text(content);

    let mut response: TerminalAiResponse =
        serde_json::from_str(cleaned).map_err(|e| AppError::AiError {
            message: format!("AI 返回格式无效: {e}"),
        })?;

    response.command = response.command.trim().lines().next().unwrap_or("").to_string();
    response.explanation = response.explanation.trim().to_string();
    response.risk = match response.risk.as_str() {
        "safe" | "caution" | "dangerous" => response.risk,
        unknown => {
            tracing::warn!("unknown AI risk level '{unknown}', defaulting to 'caution'");
            "caution".to_string()
        }
    };

    Ok(response)
}

fn parse_log_ai_response(content: &str, fallback_truncated: bool) -> Result<LogAiResponse, AppError> {
    let cleaned = extract_json_from_text(content);

    let mut response: LogAiResponse =
        serde_json::from_str(cleaned).map_err(|e| AppError::AiError {
            message: format!("AI 返回格式无效: {e}"),
        })?;

    response.answer = response.answer.trim().to_string();

    response.evidence.retain_mut(|item| {
        *item = item.trim().to_string();
        !item.is_empty()
    });
    response.suggestions.retain_mut(|item| {
        *item = item.trim().to_string();
        !item.is_empty()
    });
    response.truncated = response.truncated || fallback_truncated;

    Ok(response)
}
