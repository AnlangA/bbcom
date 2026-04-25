use serde::{Deserialize, Serialize};
use serde_json::Value;
use zai_rs::model::{chat_base_response::ChatCompletionResponse, *};

use crate::models::errors::AppError;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAiRequest {
    pub prompt: String,
    pub api_key: String,
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

#[tauri::command]
pub async fn terminal_ai_assist(
    request: TerminalAiRequest,
) -> Result<TerminalAiResponse, AppError> {
    let prompt = request.prompt.trim();
    let api_key = request.api_key.trim();

    if prompt.is_empty() {
        return Err(AppError::ValidationError {
            message: "请输入要生成的终端命令".to_string(),
            field: "prompt".to_string(),
        });
    }
    if api_key.is_empty() {
        return Err(AppError::ValidationError {
            message: "请先配置 Z.ai API Key".to_string(),
            field: "apiKey".to_string(),
        });
    }

    let shell = request.shell.unwrap_or_else(|| "linux/busybox".to_string());
    let context = request.context.unwrap_or_default();
    let user_prompt = format!(
        "System prompt:\n{TERMINAL_SYSTEM_PROMPT}\n\nTarget shell: {shell}\nRecent serial console context:\n{context}\n\nUser request: {prompt}"
    );

    let model = GLM4_5_flash {};
    let body: ChatCompletionResponse = ChatCompletion::new(
        model,
        TextMessage::user(user_prompt),
        api_key.to_string(),
    )
    .with_temperature(0.1)
    .with_top_p(0.8)
    .with_thinking(ThinkingType::disabled())
    .send()
    .await
    .map_err(|e| AppError::AiError {
        message: e.to_string(),
    })?;

    let content = body
        .choices()
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.message().content())
        .and_then(extract_text_from_content)
        .ok_or_else(|| AppError::AiError {
            message: "AI 没有返回可用命令".to_string(),
        })?;

    parse_terminal_ai_response(&content)
}

fn extract_text_from_content(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string).or_else(|| {
        value
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn parse_terminal_ai_response(content: &str) -> Result<TerminalAiResponse, AppError> {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let mut response: TerminalAiResponse =
        serde_json::from_str(cleaned).map_err(|e| AppError::AiError {
            message: format!("AI 返回格式无效: {e}"),
        })?;

    response.command = response.command.trim().lines().next().unwrap_or("").to_string();
    response.explanation = response.explanation.trim().to_string();
    response.risk = match response.risk.as_str() {
        "safe" | "caution" | "dangerous" => response.risk,
        _ => "caution".to_string(),
    };

    Ok(response)
}
