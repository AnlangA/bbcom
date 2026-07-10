//! Cross-language IPC contract tests.
//!
//! Each `#[tauri::command]` is invoked from the frontend with a specific JSON
//! shape (see src/lib/ipc.ts). These tests assert the EXACT wire payload the
//! frontend sends deserializes into the Rust request struct and executes
//! correctly — so a renamed field, a changed serde case, or a drifted enum tag
//! is caught here rather than at runtime in the webview.
//!
//! This covers checksum, log, streamed export, and AI request validation.

#[cfg(test)]
mod tests {
    use crate::commands::ai::{AiRequestKind, RunAiRequest};
    use crate::commands::checksum::{ChecksumRequest, calculate_checksum};
    use crate::commands::export::{
        AppendExportBatchRequest, BeginExportRequest, ExportSessionRequest,
    };
    use crate::commands::file_grants::{FileGrantManager, SaveTargetPurpose};
    use crate::commands::log::{
        AppendAutoLogBatchRequest, AutoLogFormat, AutoLogSessionRequest, BeginAutoLogRequest,
    };
    use crate::export::session::ExportSessionManager;
    use crate::models::checksum_type::ChecksumType;

    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_path(ext: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let c = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!("bbcom-contract-{nanos}-{c}.{ext}"));
        path.to_string_lossy().into_owned()
    }

    // ---- calculate_checksum: frontend sends { request: { data: [...], algorithm: "CRC16" } } ----

    #[test]
    fn checksum_deserializes_frontend_wire_payload_and_executes() {
        // EXACT JSON shape from ipc.ts calculateChecksum: the algorithm uses the
        // SCREAMING_SNAKE_CASE tag, data is a JSON number[] (Array.from over a
        // Uint8Array). "123456789" -> ASCII bytes [49..57].
        let json = r#"{"data":[49,50,51,52,53,54,55,56,57],"algorithm":"CRC16"}"#;
        let req: ChecksumRequest = serde_json::from_str(json).expect("checksum payload shape");

        // Keep the legacy CRC16 wire tag and CRC-16/X-25 result stable.
        assert_eq!(calculate_checksum(req).unwrap().result, "906E");
    }

    #[test]
    fn checksum_deserializes_modbus_tag_and_returns_wire_order() {
        let json = r#"{"data":[49,50,51,52,53,54,55,56,57],"algorithm":"CRC16_MODBUS"}"#;
        let req: ChecksumRequest = serde_json::from_str(json).expect("Modbus checksum payload");
        assert_eq!(calculate_checksum(req).unwrap().result, "374B");
    }

    #[test]
    fn checksum_deserializes_every_frontend_algorithm_tag() {
        // Each tag in src/lib/checksum-constants.ts must deserialize and dispatch.
        for (tag, expected) in [
            (ChecksumType::Checksum, "checksum"),
            (ChecksumType::Crc8, "crc8"),
            (ChecksumType::Crc16, "crc16"),
            (ChecksumType::Crc16Modbus, "crc16-modbus"),
            (ChecksumType::Crc32, "crc32"),
        ] {
            let tag_str = serde_json::to_string(&tag).unwrap();
            let json = format!(r#"{{"data":[1,2,3],"algorithm":{tag_str}}}"#);
            let req: ChecksumRequest =
                serde_json::from_str(&json).unwrap_or_else(|_| panic!("{expected} payload"));
            // Just confirm dispatch runs and yields a non-empty hex result.
            let result = calculate_checksum(req).unwrap().result;
            assert!(!result.is_empty(), "{expected} produced empty result");
        }
    }

    #[test]
    fn checksum_rejects_unknown_algorithm_tag() {
        // An algorithm tag the frontend never sends must fail to deserialize, not
        // silently default.
        let json = r#"{"data":[1],"algorithm":"md5"}"#;
        assert!(serde_json::from_str::<ChecksumRequest>(json).is_err());
    }

    // ---- auto-log session: grant appears only in begin; batches use logId ----

    #[test]
    fn auto_log_session_payloads_match_frontend_camel_case() {
        let begin: BeginAutoLogRequest =
            serde_json::from_str(r#"{"token":"0123456789abcdef0123456789abcdef","format":"hex"}"#)
                .expect("begin_auto_log payload shape");
        assert_eq!(begin.format, AutoLogFormat::Hex);

        let append: AppendAutoLogBatchRequest = serde_json::from_str(
            r#"{"logId":"0123456789abcdef0123456789abcdef","frames":[{"id":"1","direction":"RX","timestamp":1,"data":[65]}]}"#,
        )
        .expect("append_auto_log_batch payload shape");
        assert_eq!(append.frames.len(), 1);

        let finish: AutoLogSessionRequest =
            serde_json::from_str(r#"{"logId":"0123456789abcdef0123456789abcdef"}"#)
                .expect("finish_auto_log payload shape");
        assert_eq!(finish.log_id, append.log_id);
    }

    // ---- streamed export: begin -> append batches -> finish ----

    #[tokio::test]
    async fn streamed_export_payloads_deserialize_and_execute() {
        let path = unique_path("txt");
        let grants = FileGrantManager::default();
        let token = grants
            .issue(SaveTargetPurpose::ExportTxtAscii, path.clone().into())
            .await
            .unwrap();
        let begin_json = format!(
            r#"{{"format":"txt-ascii","token":{token_json},"expectedFrames":1,"expectedRawBytes":2}}"#,
            token_json = serde_json::to_string(&token).unwrap()
        );
        let begin: BeginExportRequest =
            serde_json::from_str(&begin_json).expect("begin export payload shape");
        assert_eq!(begin.expected_frames, 1);
        assert_eq!(begin.expected_raw_bytes, 2);
        let target = grants
            .consume_export(&begin.token, begin.format)
            .await
            .unwrap();
        let manager = ExportSessionManager::default();
        let export_id = manager.begin(begin.format, target).await.unwrap();

        let append_json = format!(
            r#"{{"exportId":{id_json},"frames":[{{"id":"1","direction":"TX","timestamp":0.0,"data":[72,105]}}]}}"#,
            id_json = serde_json::to_string(&export_id).unwrap()
        );
        let append: AppendExportBatchRequest =
            serde_json::from_str(&append_json).expect("append batch payload shape");
        assert_eq!(append.frames.len(), 1);
        manager
            .append(&append.export_id, &append.frames)
            .await
            .unwrap();

        let finish_json = format!(
            r#"{{"exportId":{id_json}}}"#,
            id_json = serde_json::to_string(&export_id).unwrap()
        );
        let finish: ExportSessionRequest =
            serde_json::from_str(&finish_json).expect("finish export payload shape");
        manager.finish(&finish.export_id).await.unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert!(
            on_disk.contains("Hi"),
            "txt-ascii decoded the bytes: {on_disk}"
        );
    }

    // ---- v0.5 AI request boundary (no credential DTO) ----

    #[test]
    fn run_ai_request_deserializes_credential_free_terminal_payload() {
        let json = r#"{"requestId":"req-1","kind":"terminal","prompt":"list files","model":"glm-4.5-air","shell":"linux/busybox","context":"$ ls"}"#;
        let req: RunAiRequest = serde_json::from_str(json).expect("v0.5 terminal AI payload shape");
        assert_eq!(req.request_id, "req-1");
        assert_eq!(req.kind, AiRequestKind::Terminal);
        assert_eq!(req.prompt, "list files");
        assert_eq!(req.model.as_deref(), Some("glm-4.5-air"));
        assert_eq!(req.shell.as_deref(), Some("linux/busybox"));
        assert_eq!(req.context.as_deref(), Some("$ ls"));
    }

    #[test]
    fn run_ai_request_optionals_default_to_none_when_omitted() {
        let json = r#"{"requestId":"req-2","kind":"terminal","prompt":"hi"}"#;
        let req: RunAiRequest = serde_json::from_str(json).unwrap();
        assert!(req.model.is_none());
        assert!(req.shell.is_none());
        assert!(req.context.is_none());
    }

    #[test]
    fn run_ai_request_rejects_an_attempt_to_include_api_key() {
        let json = r#"{"requestId":"req-3","kind":"log","prompt":"summarize","apiKey":"must-not-cross-ipc","context":"log lines"}"#;
        assert!(serde_json::from_str::<RunAiRequest>(json).is_err());
    }

    #[test]
    fn run_ai_request_deserializes_log_context_metadata() {
        let json = r#"{"requestId":"req-4","kind":"log","prompt":"summarize","model":"glm-4.5-air","context":"log lines","contextMode":"latest-10k","sessionMeta":"COM1@115200"}"#;
        let req: RunAiRequest = serde_json::from_str(json).expect("log AI payload shape");
        assert_eq!(req.kind, AiRequestKind::Log);
        assert_eq!(req.prompt, "summarize");
        assert_eq!(req.context.as_deref(), Some("log lines"));
        assert_eq!(req.context_mode.as_deref(), Some("latest-10k"));
        assert_eq!(req.session_meta.as_deref(), Some("COM1@115200"));
    }
}
