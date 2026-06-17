//! Unit tests for the AI module. These exercise the public command contracts
//! (request/response parsing, risk defaulting, truncation) and the input
//! validation / model-dispatch guards without touching the network.

use serde_json::json;

use crate::commands::ai::parser::{
    clean_markdown_fence, extract_json_payload, parse_log_ai_response, parse_terminal_ai_response,
};
use crate::commands::ai::service::{
    extract_text_from_content, send_chat_by_name, truncate_to_utf8_boundary, validate_ai_inputs,
};
use crate::models::errors::AppError;

#[test]
fn extract_text_from_string_content() {
    let v = json!("hello world");
    assert_eq!(
        extract_text_from_content(&v),
        Some("hello world".to_string())
    );
}

#[test]
fn extract_text_from_text_object() {
    let v = json!({"text": "world"});
    assert_eq!(extract_text_from_content(&v), Some("world".to_string()));
}

#[test]
fn extract_text_returns_none_for_empty_or_unknown_shapes() {
    assert_eq!(extract_text_from_content(&json!("")), None);
    assert_eq!(extract_text_from_content(&json!({"text": ""})), None);
    assert_eq!(extract_text_from_content(&json!(42)), None);
    assert_eq!(extract_text_from_content(&json!({"other": "x"})), None);
    assert_eq!(extract_text_from_content(&json!(null)), None);
}

#[test]
fn parses_plain_json_response() {
    let response = parse_terminal_ai_response(
        r#"{"command":"pwd","explanation":"显示当前目录","risk":"safe"}"#,
    )
    .unwrap();

    assert_eq!(response.command, "pwd");
    assert_eq!(response.explanation, "显示当前目录");
    assert_eq!(response.risk, "safe");
}

#[test]
fn parses_fenced_json_response() {
    let response = parse_terminal_ai_response(
        "```json\n{\"command\":\"ls -la\",\"explanation\":\"列出文件\",\"risk\":\"caution\"}\n```",
    )
    .unwrap();

    assert_eq!(response.command, "ls -la");
    assert_eq!(response.risk, "caution");
}

#[test]
fn extracts_embedded_json_response() {
    let response = parse_terminal_ai_response(
        "result: {\"command\":\"cat /proc/cpuinfo\",\"explanation\":\"查看 CPU 信息\",\"risk\":\"safe\"}",
    )
    .unwrap();

    assert_eq!(response.command, "cat /proc/cpuinfo");
}

#[test]
fn trims_command_to_one_line_and_defaults_unknown_risk_to_dangerous() {
    let response = parse_terminal_ai_response(
        r#"{"command":"pwd\nrm -rf /","explanation":"  test  ","risk":"unknown"}"#,
    )
    .unwrap();

    assert_eq!(response.command, "pwd");
    assert_eq!(response.explanation, "test");
    // Unknown risk defaults to the most conservative level (no auto-fill).
    assert_eq!(response.risk, "dangerous");
}

#[test]
fn rejects_invalid_json_response() {
    let err = parse_terminal_ai_response("not json").unwrap_err();
    assert!(matches!(err, AppError::AiError { .. }));
}

#[tokio::test]
async fn rejects_unknown_chat_model_without_network() {
    let err = send_chat_by_name("glm-bogus", "hi".into(), "key", false)
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        AppError::ValidationError { field, .. } if field == "model"
    ));
}

#[test]
fn truncate_returns_input_within_limit_unchanged() {
    let s = "hello";
    assert_eq!(truncate_to_utf8_boundary(s, 100, "test"), s);
    // exactly at the boundary is not truncated
    assert_eq!(truncate_to_utf8_boundary(s, s.len(), "test"), s);
}

#[test]
fn truncate_falls_back_to_a_valid_utf8_boundary() {
    // "中文" is 6 bytes: 中(0..3), 文(3..6)
    let s = "中文";
    assert_eq!(s.len(), 6);

    // 4 is inside 文 — must walk back to the 3-byte boundary
    assert_eq!(truncate_to_utf8_boundary(s, 4, "test"), "中");
    assert_eq!(truncate_to_utf8_boundary(s, 3, "test"), "中");
    // 1 byte cannot hold a full char, falls back to empty
    assert_eq!(truncate_to_utf8_boundary(s, 1, "test"), "");
}

#[test]
fn clean_markdown_fence_strips_json_and_plain_fences() {
    assert_eq!(clean_markdown_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    assert_eq!(clean_markdown_fence("```\n{\"a\":1}\n```"), "{\"a\":1}");
    assert_eq!(clean_markdown_fence("  {\"a\":1}  "), "{\"a\":1}");
}

#[test]
fn extract_json_payload_isolates_braced_fragment() {
    assert_eq!(
        extract_json_payload("noise {\"a\":1} trailing"),
        "{\"a\":1}"
    );
    // fenced payload extracts the JSON body, not the fence
    assert_eq!(extract_json_payload("```json\n{\"a\":1}\n```"), "{\"a\":1}");
}

#[test]
fn extract_json_payload_without_braces_returns_trimmed_input() {
    assert_eq!(extract_json_payload("totally not json"), "totally not json");
}

#[test]
fn validate_ai_inputs_rejects_blank_prompt_and_key() {
    let prompt_err = validate_ai_inputs("   ", "key", "need prompt").unwrap_err();
    assert!(matches!(
        prompt_err,
        AppError::ValidationError { field, .. } if field == "prompt"
    ));

    let key_err = validate_ai_inputs("cmd", "  ", "need prompt").unwrap_err();
    assert!(matches!(
        key_err,
        AppError::ValidationError { field, .. } if field == "apiKey"
    ));

    assert!(validate_ai_inputs("cmd", "key", "need prompt").is_ok());
}

#[test]
fn log_response_dedupes_and_preserves_truncation_flag() {
    let response = parse_log_ai_response(
        r#"{"answer":"ok","evidence":["","a "," "],"suggestions":["x","","y"],"truncated":false}"#,
        true,
    )
    .unwrap();

    assert_eq!(response.answer, "ok");
    assert_eq!(response.evidence, vec!["a"]);
    assert_eq!(response.suggestions, vec!["x", "y"]);
    // fallback truncation flag ORs into the result
    assert!(response.truncated);
}
