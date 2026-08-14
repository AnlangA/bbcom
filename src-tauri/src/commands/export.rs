//! Thin Tauri command adapters for bounded export services.

use crate::commands::file_grants::{FileGrantManager, ensure_main_window};
use crate::export::session::ExportSessionManager;
use crate::models::ipc_error::{AppErrorCode, IpcError, from_app_error};
use bbcom_contracts::{MAX_EXPORT_BYTES, MAX_EXPORT_FRAMES};
use tauri::{State, WebviewWindow};

pub use bbcom_contracts::{
    AppendExportBatchRequest, BeginExportRequest, BeginExportResponse, ExportAppendStats,
    ExportFinishStats, ExportFormat, ExportSessionRequest,
};

async fn begin_export_from_label(
    label: &str,
    grants: &FileGrantManager,
    manager: &ExportSessionManager,
    request: BeginExportRequest,
) -> Result<BeginExportResponse, IpcError> {
    const OPERATION: &str = "begin_export";
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
    validate_expected_totals(
        request.expected_frames,
        request.expected_raw_bytes,
        OPERATION,
    )?;
    let format = request.format;
    let path = grants
        .consume_export(&request.token, format)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))?;
    manager
        .begin_with_expected_totals(
            format,
            path,
            request.expected_frames,
            request.expected_raw_bytes,
        )
        .await
        .map(|export_id| BeginExportResponse { export_id })
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn begin_export(
    window: WebviewWindow,
    grants: State<'_, FileGrantManager>,
    manager: State<'_, ExportSessionManager>,
    request: BeginExportRequest,
) -> Result<BeginExportResponse, IpcError> {
    begin_export_from_label(window.label(), grants.inner(), manager.inner(), request).await
}

fn validate_expected_totals(
    expected_frames: usize,
    expected_raw_bytes: usize,
    operation: &'static str,
) -> Result<(), IpcError> {
    if expected_frames == 0 {
        return Err(IpcError::invalid_input(operation, "expectedFrames"));
    }
    if expected_frames > MAX_EXPORT_FRAMES {
        return Err(IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field("expectedFrames")
        .with_size(MAX_EXPORT_FRAMES, expected_frames));
    }
    if expected_raw_bytes > MAX_EXPORT_BYTES {
        return Err(IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field("expectedRawBytes")
        .with_size(MAX_EXPORT_BYTES, expected_raw_bytes));
    }
    Ok(())
}

async fn append_export_batch_from_label(
    label: &str,
    manager: &ExportSessionManager,
    request: AppendExportBatchRequest,
) -> Result<ExportAppendStats, IpcError> {
    const OPERATION: &str = "append_export_batch";
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
    manager
        .append(&request.export_id, &request.frames)
        .await
        .map(|stats| ExportAppendStats {
            total_frames: stats.total_frames,
            total_raw_bytes: stats.total_raw_bytes,
        })
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn append_export_batch(
    window: WebviewWindow,
    manager: State<'_, ExportSessionManager>,
    request: AppendExportBatchRequest,
) -> Result<ExportAppendStats, IpcError> {
    append_export_batch_from_label(window.label(), manager.inner(), request).await
}

async fn finish_export_from_label(
    label: &str,
    manager: &ExportSessionManager,
    request: ExportSessionRequest,
) -> Result<ExportFinishStats, IpcError> {
    const OPERATION: &str = "finish_export";
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
    manager
        .finish(&request.export_id)
        .await
        .map(|stats| ExportFinishStats {
            frames: stats.frames,
            raw_bytes: stats.raw_bytes,
            output_bytes: stats.output_bytes,
            duration_ms: stats.duration_ms,
        })
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn finish_export(
    window: WebviewWindow,
    manager: State<'_, ExportSessionManager>,
    request: ExportSessionRequest,
) -> Result<ExportFinishStats, IpcError> {
    finish_export_from_label(window.label(), manager.inner(), request).await
}

async fn abort_export_from_label(
    label: &str,
    manager: &ExportSessionManager,
    request: ExportSessionRequest,
) -> Result<(), IpcError> {
    const OPERATION: &str = "abort_export";
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
    manager
        .abort(&request.export_id)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn abort_export(
    window: WebviewWindow,
    manager: State<'_, ExportSessionManager>,
    request: ExportSessionRequest,
) -> Result<(), IpcError> {
    abort_export_from_label(window.label(), manager.inner(), request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::data_frame::{DataFrame, Direction};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TARGET_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn target_path(extension: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "bbcom-export-command-{}-{nanos}-{}.{}",
            std::process::id(),
            TARGET_COUNTER.fetch_add(1, Ordering::Relaxed),
            extension
        ))
    }

    fn frame() -> DataFrame {
        DataFrame {
            id: "frame-1".to_string(),
            direction: Direction::Tx,
            timestamp: 0.0,
            data: vec![0x41],
        }
    }

    #[test]
    fn deserializes_frontend_export_formats() {
        assert_eq!(
            serde_json::from_str::<ExportFormat>("\"txt-hex\"").unwrap(),
            ExportFormat::TxtHex
        );
        assert_eq!(
            serde_json::from_str::<ExportFormat>("\"txt-ascii\"").unwrap(),
            ExportFormat::TxtAscii
        );
        assert_eq!(
            serde_json::from_str::<ExportFormat>("\"jsonl\"").unwrap(),
            ExportFormat::Jsonl
        );
    }

    #[test]
    fn begin_request_accepts_only_an_opaque_token() {
        let request: BeginExportRequest = serde_json::from_str(
            r#"{"format":"csv","token":"opaque-grant","expectedFrames":0,"expectedRawBytes":0}"#,
        )
        .unwrap();
        assert_eq!(request.format, ExportFormat::Csv);
        assert_eq!(request.token, "opaque-grant");
        assert!(
            serde_json::from_str::<BeginExportRequest>(
                r#"{"format":"csv","path":"C:\\unsafe.csv"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn expected_totals_are_required_and_hard_bounded() {
        const OPERATION: &str = "begin_export";
        assert!(
            serde_json::from_str::<BeginExportRequest>(
                r#"{"format":"csv","token":"opaque-grant"}"#
            )
            .is_err()
        );
        assert!(validate_expected_totals(0, 0, OPERATION).is_err());
        assert!(validate_expected_totals(MAX_EXPORT_FRAMES, MAX_EXPORT_BYTES, OPERATION,).is_ok());
        let frames = validate_expected_totals(MAX_EXPORT_FRAMES + 1, MAX_EXPORT_BYTES, OPERATION)
            .unwrap_err();
        assert_eq!(frames.code, AppErrorCode::LimitExceeded);
        assert_eq!(frames.field, Some("expectedFrames"));
        assert_eq!(frames.limit, Some(MAX_EXPORT_FRAMES));
        assert_eq!(frames.actual, Some(MAX_EXPORT_FRAMES + 1));
        let bytes = validate_expected_totals(MAX_EXPORT_FRAMES, MAX_EXPORT_BYTES + 1, OPERATION)
            .unwrap_err();
        assert_eq!(bytes.field, Some("expectedRawBytes"));
        assert_eq!(bytes.limit, Some(MAX_EXPORT_BYTES));
        assert_eq!(bytes.actual, Some(MAX_EXPORT_BYTES + 1));
    }

    #[test]
    fn export_responses_use_the_fixed_camel_case_contract() {
        let begin = serde_json::to_value(BeginExportResponse {
            export_id: "0123456789abcdef0123456789abcdef".to_string(),
        })
        .unwrap();
        assert_eq!(
            begin,
            serde_json::json!({"exportId":"0123456789abcdef0123456789abcdef"})
        );

        let append = serde_json::to_value(ExportAppendStats {
            total_frames: 2,
            total_raw_bytes: 3,
        })
        .unwrap();
        assert_eq!(
            append,
            serde_json::json!({"totalFrames":2,"totalRawBytes":3})
        );

        let finish = serde_json::to_value(ExportFinishStats {
            frames: 2,
            raw_bytes: 3,
            output_bytes: 9,
            duration_ms: 4,
        })
        .unwrap();
        assert_eq!(
            finish,
            serde_json::json!({"frames":2,"rawBytes":3,"outputBytes":9,"durationMs":4})
        );
    }

    #[tokio::test]
    async fn command_cores_enforce_window_grants_and_streamed_lifecycle() {
        let grants = FileGrantManager::default();
        let manager = ExportSessionManager::default();
        let path = target_path("csv");
        let token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::ExportCsv,
                path.clone(),
            )
            .await
            .unwrap();
        let request = BeginExportRequest {
            format: ExportFormat::Csv,
            token,
            expected_frames: 1,
            expected_raw_bytes: 1,
        };
        let denied = begin_export_from_label("ai-assistant", &grants, &manager, request)
            .await
            .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);

        let token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::ExportCsv,
                path.clone(),
            )
            .await
            .unwrap();
        let started = begin_export_from_label(
            "main",
            &grants,
            &manager,
            BeginExportRequest {
                format: ExportFormat::Csv,
                token,
                expected_frames: 1,
                expected_raw_bytes: 1,
            },
        )
        .await
        .unwrap();
        let append = append_export_batch_from_label(
            "main",
            &manager,
            AppendExportBatchRequest {
                export_id: started.export_id.clone(),
                frames: vec![frame()],
            },
        )
        .await
        .unwrap();
        assert_eq!(append.total_frames, 1);
        assert_eq!(append.total_raw_bytes, 1);
        let finished = finish_export_from_label(
            "main",
            &manager,
            ExportSessionRequest {
                export_id: started.export_id,
            },
        )
        .await
        .unwrap();
        assert_eq!(finished.frames, 1);
        assert_eq!(finished.raw_bytes, 1);
        assert!(std::fs::read_to_string(&path).unwrap().contains("41"));
        std::fs::remove_file(&path).ok();

        let token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::ExportCsv,
                target_path("csv"),
            )
            .await
            .unwrap();
        let rejected = begin_export_from_label(
            "main",
            &grants,
            &manager,
            BeginExportRequest {
                format: ExportFormat::Csv,
                token,
                expected_frames: 0,
                expected_raw_bytes: 0,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.code, AppErrorCode::InvalidInput);

        let denied_append = append_export_batch_from_label(
            "other",
            &manager,
            AppendExportBatchRequest {
                export_id: "0".repeat(32),
                frames: vec![],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(denied_append.code, AppErrorCode::SecurityDenied);
        assert!(
            abort_export_from_label(
                "other",
                &manager,
                ExportSessionRequest {
                    export_id: "0".repeat(32)
                }
            )
            .await
            .is_err()
        );

        let token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::ExportCsv,
                target_path("csv"),
            )
            .await
            .unwrap();
        let started = begin_export_from_label(
            "main",
            &grants,
            &manager,
            BeginExportRequest {
                format: ExportFormat::Csv,
                token,
                expected_frames: 1,
                expected_raw_bytes: 1,
            },
        )
        .await
        .unwrap();
        abort_export_from_label(
            "main",
            &manager,
            ExportSessionRequest {
                export_id: started.export_id,
            },
        )
        .await
        .unwrap();
    }
}
