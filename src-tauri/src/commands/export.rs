//! Thin Tauri command adapters for bounded export services.

use crate::commands::file_grants::FileGrantManager;
use crate::export::session::{
    BackendExportBegin, ExportSessionManager, WorkspaceFrameQuery, WorkspaceFrameSlice,
    WorkspaceFrameSource, WorkspaceFrameTotals,
};
use crate::models::data_frame::{DataFrame, Direction};
use crate::models::errors::AppError;
use crate::models::ipc_error::{AppErrorCode, IpcError, from_app_error};
use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    DataB64Error, DataFramePayload, ExportSource, MAX_EXPORT_BYTES, MAX_EXPORT_FRAME_BYTES,
    MAX_EXPORT_FRAMES,
};
use bbcom_workspace::WorkspaceService;
use bbcom_workspace::container::{ProjectContainerError, ProjectLibrary, WorkspaceUuid};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{Manager, State, WebviewWindow};

pub use bbcom_contracts::{
    AppendExportBatchRequest, BeginExportRequest, BeginExportResponse, ExportAppendStats,
    ExportFinishStats, ExportFormat, ExportSessionRequest,
};

async fn begin_export_from_label(
    label: &str,
    grants: &FileGrantManager,
    manager: &ExportSessionManager,
    request: BeginExportRequest,
    source: Option<Arc<dyn WorkspaceFrameSource>>,
) -> Result<BeginExportResponse, IpcError> {
    const OPERATION: &str = "begin_export";
    require_main_window_label(label, OPERATION)?;
    match (&request.source, source) {
        // Backend-source mode: the renderer-supplied totals are advisory
        // only; the backend commits to totals read from the durable source.
        (
            Some(ExportSource::WorkspaceFrames {
                workspace_id,
                session_id,
                to_seq_exclusive,
            }),
            Some(frame_source),
        ) => {
            let format = request.format;
            let path = grants
                .consume_export(&request.token, format)
                .await
                .map_err(|error| from_app_error(&error, OPERATION))?;
            let query = WorkspaceFrameQuery {
                workspace_id: workspace_id.clone(),
                session_id: session_id.clone(),
                to_seq_exclusive: *to_seq_exclusive,
            };
            manager
                .begin_backend_sourced(format, path, frame_source, query)
                .await
                .map(backend_begin_response)
                .map_err(|error| from_app_error(&error, OPERATION))
        }
        // A source selector without a resolved source means the caller wired
        // the command incorrectly; fail closed instead of falling back.
        (Some(_), None) => Err(IpcError::invalid_input(OPERATION, "source")),
        (None, _) => {
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
                .map(|export_id| BeginExportResponse {
                    export_id,
                    expected_frames: None,
                })
                .map_err(|error| from_app_error(&error, OPERATION))
        }
    }
}

fn backend_begin_response(begin: BackendExportBegin) -> BeginExportResponse {
    BeginExportResponse {
        export_id: begin.export_id,
        expected_frames: Some(begin.expected_frames),
    }
}

#[tauri::command]
pub async fn begin_export(
    window: WebviewWindow,
    app: tauri::AppHandle,
    grants: State<'_, FileGrantManager>,
    manager: State<'_, ExportSessionManager>,
    request: BeginExportRequest,
) -> Result<BeginExportResponse, IpcError> {
    const OPERATION: &str = "begin_export";
    let label = window.label().to_string();
    // Resolve the read-only frame source before the one-shot grant token is
    // consumed so a bad workspace identity cannot burn the export grant.
    let source: Option<Arc<dyn WorkspaceFrameSource>> = match &request.source {
        Some(ExportSource::WorkspaceFrames { workspace_id, .. }) => {
            let root = managed_workspace_root(&app)?;
            let workspace_id = workspace_id.clone();
            let opened = tokio::task::spawn_blocking(move || {
                ManagedWorkspaceFrameSource::open(&root, &workspace_id)
            })
            .await
            .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))??;
            Some(Arc::new(opened))
        }
        None => None,
    };
    begin_export_from_label(&label, grants.inner(), manager.inner(), request, source).await
}

/// Managed project library root, mirroring the setup wiring in `lib.rs`
/// (`<app data dir>/projects-v1`).
fn managed_workspace_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, IpcError> {
    const OPERATION: &str = "begin_export";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| IpcError::invalid_input(OPERATION, "source"))?;
    Ok(data_dir.join("projects-v1"))
}

fn project_container_ipc_error(error: ProjectContainerError) -> IpcError {
    const OPERATION: &str = "begin_export";
    match error {
        ProjectContainerError::InvalidInput { field } => IpcError::invalid_input(OPERATION, field),
        ProjectContainerError::Workspace(inner) => inner.to_ipc_error(OPERATION),
        _ => IpcError::invalid_input(OPERATION, "workspaceId"),
    }
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
    mut request: AppendExportBatchRequest,
) -> Result<ExportAppendStats, IpcError> {
    const OPERATION: &str = "append_export_batch";
    require_main_window_label(label, OPERATION)?;
    for frame in &mut request.frames {
        resolve_export_frame_bytes(frame).map_err(|error| data_b64_ipc_error(error, OPERATION))?;
    }
    manager
        .append(&request.export_id, &request.frames)
        .await
        .map(|stats| ExportAppendStats {
            total_frames: stats.total_frames,
            total_raw_bytes: stats.total_raw_bytes,
        })
        .map_err(|error| from_app_error(&error, OPERATION))
}

/// Materialize one frame's bytes from the `dataB64` channel (if used) before
/// the session manager validates per-frame and batch limits on plain bytes.
fn resolve_export_frame_bytes(frame: &mut DataFramePayload) -> Result<(), DataB64Error> {
    let Some(encoded) = frame.data_b64.take() else {
        return Ok(());
    };
    if !frame.data.is_empty() {
        return Err(DataB64Error::BothChannels);
    }
    frame.data = bbcom_contracts::decode_data_b64(&encoded, MAX_EXPORT_FRAME_BYTES)?;
    Ok(())
}

fn data_b64_ipc_error(error: DataB64Error, operation: &'static str) -> IpcError {
    match error {
        DataB64Error::BothChannels | DataB64Error::InvalidBase64 => {
            IpcError::invalid_input(operation, "frames")
        }
        DataB64Error::LimitExceeded { limit, actual } => IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field("frames")
        .with_size(limit, actual),
    }
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
    require_main_window_label(label, OPERATION)?;
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
    require_main_window_label(label, OPERATION)?;
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

/// Read-only paged frame source over one managed workspace project, used for
/// backend-sourced exports. It opens a single short-lived [`WorkspaceService`]
/// through the same public library APIs the workspace commands use (the
/// catalog path already opens non-active projects the same way), reads only
/// through `hydrate_frames`, and closes the connection when the export begin
/// finishes and the adapter is dropped.
#[derive(Debug)]
pub struct ManagedWorkspaceFrameSource {
    service: StdMutex<WorkspaceService>,
}

impl ManagedWorkspaceFrameSource {
    pub fn open(root: &Path, workspace_id: &str) -> Result<Self, IpcError> {
        const OPERATION: &str = "begin_export";
        let uuid = WorkspaceUuid::parse(workspace_id)
            .map_err(|_| IpcError::invalid_input(OPERATION, "workspaceId"))?;
        let library = ProjectLibrary::open(root).map_err(project_container_ipc_error)?;
        let service = library
            .open_project(&uuid)
            .map_err(project_container_ipc_error)?;
        let summary = service
            .summary()
            .map_err(|error| error.to_ipc_error(OPERATION))?;
        if summary.workspace_id != workspace_id {
            return Err(IpcError::invalid_input(OPERATION, "workspaceId"));
        }
        Ok(Self {
            service: StdMutex::new(service),
        })
    }
}

impl WorkspaceFrameSource for ManagedWorkspaceFrameSource {
    fn expected_totals(
        &self,
        query: &WorkspaceFrameQuery,
    ) -> Result<WorkspaceFrameTotals, AppError> {
        let service = lock_source_service(&self.service)?;
        let mut frames = 0_usize;
        let mut raw_bytes = 0_usize;
        let mut from_seq = 0_u64;
        loop {
            let page = hydrate_bounded_page(&service, query, from_seq)?;
            if page.frames.is_empty() {
                break;
            }
            // The bounded source matches the export batch byte budget with one
            // exception: a single frame may exceed the normal batch budget up
            // to the per-frame limit, so count frames individually.
            for frame in &page.frames {
                raw_bytes = raw_bytes.saturating_add(frame.data.len());
            }
            frames += page.frames.len();
            let Some(next_seq) = page.next_seq else {
                break;
            };
            if next_seq <= from_seq || next_seq >= query.to_seq_exclusive {
                break;
            }
            from_seq = next_seq;
        }
        Ok(WorkspaceFrameTotals { frames, raw_bytes })
    }

    fn read_page(
        &self,
        query: &WorkspaceFrameQuery,
        from_seq: u64,
    ) -> Result<WorkspaceFrameSlice, AppError> {
        let service = lock_source_service(&self.service)?;
        hydrate_bounded_page(&service, query, from_seq)
    }
}

fn lock_source_service(
    service: &StdMutex<WorkspaceService>,
) -> Result<std::sync::MutexGuard<'_, WorkspaceService>, AppError> {
    service.lock().map_err(|poisoned| AppError::Busy {
        message: format!("workspace frame source lock poisoned: {poisoned}"),
    })
}

/// One ascending page of frames with `from_seq <= seq < to_seq_exclusive`,
/// read through the public hydration API (which enforces the page frame/byte
/// caps) and truncated strictly at the caller's seq ceiling.
fn hydrate_bounded_page(
    service: &WorkspaceService,
    query: &WorkspaceFrameQuery,
    from_seq: u64,
) -> Result<WorkspaceFrameSlice, AppError> {
    let page = service
        .hydrate_frames(
            &query.session_id,
            from_seq,
            crate::export::session::SOURCE_PAGE_FRAMES,
        )
        .map_err(source_app_error)?;
    let mut frames = Vec::with_capacity(page.frames.len());
    let mut next_seq = page.next_seq;
    for frame in page.frames {
        if frame.seq >= query.to_seq_exclusive {
            // Everything at or above the ceiling is excluded by contract;
            // nothing below it can remain after this page.
            next_seq = None;
            break;
        }
        frames.push(DataFrame {
            id: frame.id,
            direction: match frame.direction.as_str() {
                "TX" => Direction::Tx,
                "RX" => Direction::Rx,
                _ => {
                    return Err(AppError::ValidationError {
                        message: "workspace frame direction is invalid".to_owned(),
                        field: "sessionId".to_owned(),
                    });
                }
            },
            timestamp: frame.timestamp_ms as f64,
            data: frame.data,
            data_b64: None,
        });
    }
    Ok(WorkspaceFrameSlice { frames, next_seq })
}

/// Map workspace-crate read failures onto the export manager's error domain;
/// `from_app_error` turns these into the stable IPC codes at the boundary.
fn source_app_error(error: bbcom_workspace::WorkspaceError) -> AppError {
    match error {
        bbcom_workspace::WorkspaceError::InvalidInput { field } => AppError::ValidationError {
            message: "backend export source rejected the request".to_owned(),
            field: field.to_owned(),
        },
        bbcom_workspace::WorkspaceError::LimitExceeded {
            field,
            limit,
            actual,
        } => AppError::LimitError {
            message: "backend export source limit exceeded".to_owned(),
            field: field.to_owned(),
            limit,
            actual,
        },
        bbcom_workspace::WorkspaceError::NotFound => AppError::ValidationError {
            message: "workspace session was not found".to_owned(),
            field: "sessionId".to_owned(),
        },
        other => AppError::ValidationError {
            message: format!("backend export source failed: {other}"),
            field: "workspaceId".to_owned(),
        },
    }
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
            data_b64: None,
        }
    }

    fn frame_b64(data: &[u8]) -> DataFrame {
        DataFrame {
            data: Vec::new(),
            data_b64: Some(bbcom_contracts::encode_data_b64(data)),
            ..frame()
        }
    }

    fn begin_request(token: String, source: Option<ExportSource>) -> BeginExportRequest {
        BeginExportRequest {
            format: ExportFormat::Csv,
            token,
            expected_frames: 1,
            expected_raw_bytes: 1,
            source,
        }
    }

    fn workspace_frames_source() -> ExportSource {
        ExportSource::WorkspaceFrames {
            workspace_id: "01234567-89ab-cdef-0123-456789abcdef".to_owned(),
            session_id: "session-1".to_owned(),
            to_seq_exclusive: 2,
        }
    }

    #[tokio::test]
    async fn append_batches_accept_both_data_channels_exclusively() {
        let manager = ExportSessionManager::default();
        let path = target_path("jsonl");
        std::fs::write(&path, b"").ok();
        let started = manager
            .begin(ExportFormat::Jsonl, path.clone())
            .await
            .unwrap();
        let stats = append_export_batch_from_label(
            "main",
            &manager,
            AppendExportBatchRequest {
                export_id: started.clone(),
                frames: vec![frame_b64(&[0x41, 0x42])],
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.total_raw_bytes, 2);

        let both = append_export_batch_from_label(
            "main",
            &manager,
            AppendExportBatchRequest {
                export_id: started.clone(),
                frames: vec![DataFrame {
                    data: vec![1],
                    data_b64: Some("AQ==".to_string()),
                    ..frame()
                }],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(both.code, AppErrorCode::InvalidInput);

        let malformed = append_export_batch_from_label(
            "main",
            &manager,
            AppendExportBatchRequest {
                export_id: started.clone(),
                frames: vec![frame_b64(&[7; MAX_EXPORT_FRAME_BYTES + 1])],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(malformed.code, AppErrorCode::LimitExceeded);
        assert_eq!(malformed.limit, Some(MAX_EXPORT_FRAME_BYTES));

        manager.finish(&started).await.ok();
        std::fs::remove_file(path).ok();
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
            expected_frames: None,
        })
        .unwrap();
        assert_eq!(
            begin,
            serde_json::json!({"exportId":"0123456789abcdef0123456789abcdef"})
        );

        let backend_begin = serde_json::to_value(BeginExportResponse {
            export_id: "0123456789abcdef0123456789abcdee".to_string(),
            expected_frames: Some(7),
        })
        .unwrap();
        assert_eq!(
            backend_begin,
            serde_json::json!({"exportId":"0123456789abcdef0123456789abcdee","expectedFrames":7})
        );

        let source = serde_json::to_value(workspace_frames_source()).unwrap();
        assert_eq!(
            source,
            serde_json::json!({
                "kind": "workspace-frames",
                "workspaceId": "01234567-89ab-cdef-0123-456789abcdef",
                "sessionId": "session-1",
                "toSeqExclusive": 2,
            })
        );
        assert!(
            serde_json::from_str::<BeginExportRequest>(&format!(
                r#"{{"format":"csv","token":"t","expectedFrames":1,"expectedRawBytes":1,"source":{}}}"#,
                serde_json::to_string(&workspace_frames_source()).unwrap()
            ))
            .is_ok()
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
        let denied = begin_export_from_label(
            "ai-assistant",
            &grants,
            &manager,
            begin_request(token, None),
            None,
        )
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
        let started =
            begin_export_from_label("main", &grants, &manager, begin_request(token, None), None)
                .await
                .unwrap();
        assert_eq!(started.expected_frames, None);
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
                source: None,
            },
            None,
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
                source: None,
            },
            None,
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

    /// Fake durable source: hands out fixed frames and rejects unknown ids.
    struct FakeWorkspaceFrames {
        frames: Vec<DataFrame>,
    }

    impl WorkspaceFrameSource for FakeWorkspaceFrames {
        fn expected_totals(
            &self,
            query: &WorkspaceFrameQuery,
        ) -> Result<WorkspaceFrameTotals, AppError> {
            let frames = self.frames_below(query)?;
            Ok(WorkspaceFrameTotals {
                frames: frames.len(),
                raw_bytes: frames.iter().map(|frame| frame.data.len()).sum(),
            })
        }

        fn read_page(
            &self,
            query: &WorkspaceFrameQuery,
            from_seq: u64,
        ) -> Result<WorkspaceFrameSlice, AppError> {
            let frames = self.frames_below(query)?;
            // The fake source is index-addressed: seq n is frames[n].
            let start = usize::try_from(from_seq).unwrap_or(usize::MAX);
            if start >= frames.len() {
                return Ok(WorkspaceFrameSlice {
                    frames: Vec::new(),
                    next_seq: None,
                });
            }
            let end = (start + crate::export::session::SOURCE_PAGE_FRAMES).min(frames.len());
            Ok(WorkspaceFrameSlice {
                next_seq: (end < frames.len()).then(|| u64::try_from(end).unwrap()),
                frames: frames[start..end].to_vec(),
            })
        }
    }

    impl FakeWorkspaceFrames {
        fn frames_below(&self, query: &WorkspaceFrameQuery) -> Result<&[DataFrame], AppError> {
            if query.workspace_id != "01234567-89ab-cdef-0123-456789abcdef"
                || query.session_id != "session-1"
            {
                return Err(AppError::ValidationError {
                    message: "workspace session was not found".to_owned(),
                    field: "sessionId".to_owned(),
                });
            }
            let limit = usize::try_from(query.to_seq_exclusive).unwrap_or(0);
            Ok(&self.frames[..limit.min(self.frames.len())])
        }
    }

    #[tokio::test]
    async fn backend_sourced_begin_reads_the_source_and_rejects_renderer_appends() {
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
        // Renderer-supplied totals (1 frame) intentionally disagree with the
        // durable source (2 frames): the backend must commit to the source.
        let mut request = begin_request(token, Some(workspace_frames_source()));
        request.expected_frames = 1;
        request.expected_raw_bytes = 1;
        let source: Arc<dyn WorkspaceFrameSource> = Arc::new(FakeWorkspaceFrames {
            frames: vec![
                DataFrame {
                    id: "db-1".to_owned(),
                    direction: Direction::Rx,
                    timestamp: 1.0,
                    data: vec![0x41],
                    data_b64: None,
                },
                DataFrame {
                    id: "db-2".to_owned(),
                    direction: Direction::Tx,
                    timestamp: 2.0,
                    data: vec![0x42],
                    data_b64: None,
                },
                // Persisted after the renderer's flush barrier: excluded.
                DataFrame {
                    id: "db-3".to_owned(),
                    direction: Direction::Rx,
                    timestamp: 3.0,
                    data: vec![0x43],
                    data_b64: None,
                },
            ],
        });

        let started = begin_export_from_label("main", &grants, &manager, request, Some(source))
            .await
            .unwrap();
        assert_eq!(started.expected_frames, Some(2));

        let rejected = append_export_batch_from_label(
            "main",
            &manager,
            AppendExportBatchRequest {
                export_id: started.export_id.clone(),
                frames: vec![frame()],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.code, AppErrorCode::InvalidInput);
        assert_eq!(rejected.field, Some("exportId"));

        let finished = finish_export_from_label(
            "main",
            &manager,
            ExportSessionRequest {
                export_id: started.export_id,
            },
        )
        .await
        .unwrap();
        assert_eq!(finished.frames, 2);
        assert_eq!(finished.raw_bytes, 2);
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("41"));
        assert!(content.contains("42"));
        assert!(
            !content.contains("43"),
            "frames at/above the ceiling are excluded"
        );
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn backend_sourced_begin_without_a_resolved_source_fails_closed() {
        let grants = FileGrantManager::default();
        let manager = ExportSessionManager::default();
        let token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::ExportCsv,
                target_path("csv"),
            )
            .await
            .unwrap();
        let error = begin_export_from_label(
            "main",
            &grants,
            &manager,
            begin_request(token, Some(workspace_frames_source())),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("source"));
    }

    #[test]
    fn managed_source_open_rejects_non_uuid_workspace_ids() {
        let temp = tempfile::tempdir().unwrap();
        let error = ManagedWorkspaceFrameSource::open(temp.path(), "not-a-uuid").unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput);
        assert_eq!(error.field, Some("workspaceId"));
    }
}
