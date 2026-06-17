//! Z.ai chat client dispatch + shared input-validation/truncation helpers.
//!
//! The model dispatch is a `match` (a dispatch-table), not `Box<dyn Model>` —
//! `zai_rs`'s `ModelName: Into<String>` is not dyn-safe, so each supported model
//! is a concrete arm. `send_chat` is the single generic hot point that builds
//! the `ChatCompletion` for a concrete model type.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use zai_rs::model::{
    chat_base_request::ChatBody, chat_base_response::ChatCompletionResponse, traits::*, *,
};

use crate::models::errors::AppError;

pub(crate) const AI_REQUEST_TIMEOUT_SECS: u64 = 60;
pub(crate) const MAX_AI_CONTEXT_BYTES: usize = 512_000;

/// Validate the two inputs every AI command shares: a non-blank prompt and a
/// non-blank API key. The `prompt_empty_msg` lets each command give a specific
/// field-level error. Returns the fields that passed (trimmed) implicitly via
/// the early-return errors.
pub(crate) fn validate_ai_inputs(
    prompt: &str,
    api_key: &str,
    prompt_empty_msg: &str,
) -> Result<(), AppError> {
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

/// Truncate `s` to at most `max_bytes`, walking back to the nearest UTF-8 char
/// boundary so the result is always valid UTF-8. Logs when truncation occurs.
pub(crate) fn truncate_to_utf8_boundary(s: &str, max_bytes: usize, label: &str) -> String {
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

/// Run a chat completion for `model`, returning the first choice's text content
/// or `empty_error` when the model returned no usable text.
pub(crate) async fn run_ai_chat(
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

/// Dispatch a concrete model name to its `zai_rs` struct. Unknown names return
/// a `ValidationError` on the `model` field — no network call is attempted.
pub(crate) async fn send_chat_by_name(
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
        tokio::time::timeout(
            Duration::from_secs(AI_REQUEST_TIMEOUT_SECS),
            client.with_coding_plan().send(),
        )
        .await
    } else {
        tokio::time::timeout(Duration::from_secs(AI_REQUEST_TIMEOUT_SECS), client.send()).await
    };

    match result {
        Ok(result) => result.map_err(|e| {
            tracing::warn!("AI chat request failed: {e}");
            AppError::AiError {
                message: e.to_string(),
            }
        }),
        Err(_elapsed) => {
            tracing::warn!("AI chat request timed out after {AI_REQUEST_TIMEOUT_SECS}s");
            Err(AppError::AiError {
                message: format!("AI 请求超时 ({}s)", AI_REQUEST_TIMEOUT_SECS),
            })
        }
    }
}

/// Pull a non-empty text string out of a model `content` value, which may be a
/// bare string or a `{"text": "..."}` object. Returns `None` for any other
/// shape (numbers, null, unknown object keys).
pub(crate) fn extract_text_from_content(value: &Value) -> Option<String> {
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
