//! JSON extraction + response shaping for the two AI workflows.
//!
//! The model is instructed to emit JSON only, but it frequently wraps the
//! payload in a Markdown fence or surrounds it with prose. These helpers
//! defensively isolate the JSON object, then normalize the parsed struct
//! (trim, single-line commands, conservative risk defaulting, dedup).

use crate::commands::ai::service::validate_ai_response_size;
use crate::commands::ai::{LogAiResponse, TerminalAiResponse};
use crate::models::errors::AppError;

/// Strip a leading `json` or plain Markdown fence and surrounding whitespace.
pub(crate) fn clean_markdown_fence(content: &str) -> &str {
    content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
}

/// Isolate the first balanced `{ ... }` fragment in `content` (after fence
/// stripping). If no braces are present, the trimmed input is returned as-is so
/// the downstream `serde_json::from_str` produces a precise parse error.
pub(crate) fn extract_json_payload(content: &str) -> String {
    let trimmed = clean_markdown_fence(content);
    let first = trimmed.find('{');
    let last = trimmed.rfind('}');
    match (first, last) {
        (Some(start), Some(end)) if start <= end => {
            let json_fragment = &trimmed[start..=end];
            if start > 0 || end < trimmed.len() - 1 {
                tracing::debug!(
                    "AI response contained extra text outside JSON; extracted {}-byte fragment",
                    json_fragment.len()
                );
            }
            json_fragment.to_string()
        }
        _ => trimmed.to_string(),
    }
}

/// Parse + normalize a terminal-command response: the command is collapsed to
/// its first line, the explanation is trimmed, and any unrecognized `risk` is
/// defaulted to `dangerous` so an unclassified (potentially destructive)
/// command is never auto-filled into the input.
pub(crate) fn parse_terminal_ai_response(content: &str) -> Result<TerminalAiResponse, AppError> {
    validate_ai_response_size(content)?;
    let cleaned = extract_json_payload(content);

    let mut response: TerminalAiResponse =
        serde_json::from_str(&cleaned).map_err(|e| AppError::AiError {
            message: format!("AI 返回格式无效: {e}"),
        })?;

    response.command = response
        .command
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    response.explanation = response.explanation.trim().to_string();
    let risk = response.risk.trim().to_ascii_lowercase();
    response.risk = match risk.as_str() {
        "safe" | "caution" | "dangerous" => risk,
        _ => {
            // Provider output is untrusted and may contain user/serial context,
            // newlines, or terminal escapes. Never echo it into process logs.
            tracing::warn!("unknown AI risk level; defaulting to 'dangerous'");
            "dangerous".to_string()
        }
    };

    Ok(response)
}

/// Parse + normalize a log-analysis response: trims the answer, drops empty
/// evidence/suggestion entries, and ORs the caller-supplied fallback truncation
/// flag into the result.
pub(crate) fn parse_log_ai_response(
    content: &str,
    fallback_truncated: bool,
) -> Result<LogAiResponse, AppError> {
    validate_ai_response_size(content)?;
    let cleaned = extract_json_payload(content);

    let mut response: LogAiResponse =
        serde_json::from_str(&cleaned).map_err(|e| AppError::AiError {
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
