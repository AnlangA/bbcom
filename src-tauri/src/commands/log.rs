use crate::commands::file_grants::FileGrantManager;
use crate::commands::streaming_sessions::{
    SharedStreamingSession, StreamingSession, StreamingSessionNaming, StreamingSessionTable,
    limit_error, validate_hex_session_id, validation_error,
};
use crate::export::ExportFormat;
use crate::export::formatter;
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use crate::models::ipc_error::{AppErrorCode, IpcError, from_app_error};
use crate::utils::timestamp::format_timestamp;
use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    DataB64Error, MAX_AUTO_LOG_BATCH_BYTES as MAX_AUTO_LOG_BATCH_RAW_BYTES,
    MAX_AUTO_LOG_BATCH_FRAMES, MAX_AUTO_LOG_FRAME_ID_BYTES, decode_data_b64,
};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{State, WebviewWindow};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::Mutex;

const MAX_ACTIVE_AUTO_LOG_SESSIONS: usize = 32;
const AUTO_LOG_SESSION_TTL: Duration = Duration::from_secs(4 * 60 * 60);

type SharedAutoLogSession = SharedStreamingSession<AutoLogSession>;

pub use bbcom_contracts::{
    AppendAutoLogBatchRequest, AutoLogAppendStats, AutoLogFormat, AutoLogSessionRequest,
    BeginAutoLogRequest, BeginAutoLogResponse,
};

pub struct AutoLogSessionManager {
    table: StreamingSessionTable<AutoLogSession>,
}

struct AutoLogSession {
    target: crate::commands::file_grants::AuthorizedLogTarget,
    format: AutoLogFormat,
    frames: usize,
    raw_bytes: usize,
    output_bytes: usize,
    last_activity: Instant,
    terminal: bool,
    writer: Option<BufWriter<tokio::fs::File>>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}

impl StreamingSession for AutoLogSession {
    type Detached = Option<BufWriter<tokio::fs::File>>;

    fn last_activity(&self) -> Instant {
        self.last_activity
    }

    fn seal_expired(&mut self) {
        self.terminal = true;
        self.last_activity = Instant::now();
    }

    fn detach_expired(&mut self) -> Self::Detached {
        self.writer.take()
    }
}

impl Default for AutoLogSessionManager {
    fn default() -> Self {
        Self {
            table: StreamingSessionTable::new(
                MAX_ACTIVE_AUTO_LOG_SESSIONS,
                AUTO_LOG_SESSION_TTL,
                StreamingSessionNaming {
                    id_field: "logId",
                    noun: "auto-log",
                    unknown_message: "unknown or expired auto-log session",
                },
            ),
        }
    }
}

impl AutoLogSessionManager {
    async fn begin(
        &self,
        target: crate::commands::file_grants::AuthorizedLogTarget,
        format: AutoLogFormat,
    ) -> Result<String, AppError> {
        self.cleanup_expired().await;
        let slot = self.table.acquire_slot()?;
        validate_log_path(&target.path)?;
        let write_lock = Arc::clone(&target.write_lock);
        let _write_guard = write_lock.lock().await;
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&target.path)
            .await
            .map_err(AppError::from)?;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        // Session marker: in append mode the file may hold many sessions, so
        // each one is bracketed by human-readable start/finish lines.
        let header = format!(
            "# bbcom auto-log started {} format={}\n",
            format_timestamp(now_millis()),
            format.label()
        );
        writer
            .write_all(header.as_bytes())
            .await
            .map_err(AppError::from)?;
        writer.flush().await.map_err(AppError::from)?;
        let log_id = self.table.reserve_new_id().await?;
        let replaced = self
            .table
            .insert(
                log_id.clone(),
                Arc::new(Mutex::new(AutoLogSession {
                    target,
                    format,
                    frames: 0,
                    raw_bytes: 0,
                    output_bytes: 0,
                    last_activity: Instant::now(),
                    terminal: false,
                    writer: Some(writer),
                    _slot: slot,
                })),
            )
            .await;
        self.table.release_reserved(&log_id).await;
        debug_assert!(
            replaced.is_none(),
            "auto-log ids must be unique per manager"
        );
        Ok(log_id)
    }

    async fn append(
        &self,
        log_id: &str,
        frames: &[DataFrame],
    ) -> Result<AutoLogAppendStats, AppError> {
        validate_log_id(log_id)?;
        let batch_raw_bytes = validate_auto_log_batch(frames)?;
        let shared = self.get(log_id).await?;
        let mut session = shared.lock().await;
        Self::append_locked(&mut session, frames, batch_raw_bytes).await
    }

    async fn append_locked(
        session: &mut AutoLogSession,
        frames: &[DataFrame],
        batch_raw_bytes: usize,
    ) -> Result<AutoLogAppendStats, AppError> {
        if session.terminal || session.writer.is_none() {
            return Err(validation_error(
                "logId",
                "unknown or finished auto-log session",
            ));
        }

        let output = format_auto_log_batch(frames, session.format);
        let write_lock = Arc::clone(&session.target.write_lock);
        let _write_guard = write_lock.lock().await;
        let writer = session
            .writer
            .as_mut()
            .expect("active auto-log session must own its writer");
        writer.write_all(&output).await.map_err(AppError::from)?;
        writer.flush().await.map_err(AppError::from)?;
        session.frames = session.frames.saturating_add(frames.len());
        session.raw_bytes = session.raw_bytes.saturating_add(batch_raw_bytes);
        session.output_bytes = session.output_bytes.saturating_add(output.len());
        session.last_activity = Instant::now();
        Ok(AutoLogAppendStats {
            frames: session.frames,
            raw_bytes: session.raw_bytes,
        })
    }

    async fn finish(&self, log_id: &str) -> Result<(), AppError> {
        validate_log_id(log_id)?;
        let shared = self
            .table
            .remove(log_id)
            .await
            .ok_or_else(|| validation_error("logId", "unknown or expired auto-log session"))?;
        let (write_lock, mut writer) = {
            let mut session = shared.lock().await;
            if session.terminal || session.writer.is_none() {
                return Err(validation_error(
                    "logId",
                    "auto-log session is already finishing",
                ));
            }
            session.terminal = true;
            session.last_activity = Instant::now();
            let writer = session
                .writer
                .take()
                .expect("active auto-log session must own its writer");
            (Arc::clone(&session.target.write_lock), writer)
        };
        let _write_guard = write_lock.lock().await;
        let footer = format!(
            "# bbcom auto-log finished {}\n",
            format_timestamp(now_millis())
        );
        writer
            .write_all(footer.as_bytes())
            .await
            .map_err(AppError::from)?;
        writer.flush().await.map_err(AppError::from)?;
        writer.get_ref().sync_all().await.map_err(AppError::from)?;
        Ok(())
    }

    async fn abort(&self, log_id: &str) -> Result<(), AppError> {
        validate_log_id(log_id)?;
        let Ok(shared) = self.get(log_id).await else {
            return Ok(());
        };
        let writer = {
            let mut session = shared.lock().await;
            session.terminal = true;
            session.last_activity = Instant::now();
            session.writer.take()
        };
        self.remove_current(log_id, &shared).await;
        drop(writer);
        Ok(())
    }

    async fn get(&self, log_id: &str) -> Result<SharedAutoLogSession, AppError> {
        self.table.get(log_id).await
    }

    async fn remove_current(&self, log_id: &str, shared: &SharedAutoLogSession) -> bool {
        self.table.remove_current(log_id, shared).await
    }

    async fn cleanup_expired(&self) -> usize {
        // A session holding its mutex is actively writing/flushing; it is
        // skipped rather than made to wait and reconsidered next begin. The
        // expired writers simply drop: every append flushes before returning.
        let (count, expired_writers) = self.table.sweep_expired().await;
        drop(expired_writers);
        count
    }
}

async fn begin_auto_log_from_label(
    label: &str,
    grants: &FileGrantManager,
    manager: &AutoLogSessionManager,
    request: BeginAutoLogRequest,
) -> Result<BeginAutoLogResponse, IpcError> {
    const OPERATION: &str = "begin_auto_log";
    require_main_window_label(label, OPERATION)?;
    let target = grants
        .consume_auto_log(&request.token)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))?;
    manager
        .begin(target, request.format)
        .await
        .map(|log_id| BeginAutoLogResponse { log_id })
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn begin_auto_log(
    window: WebviewWindow,
    grants: State<'_, FileGrantManager>,
    manager: State<'_, AutoLogSessionManager>,
    request: BeginAutoLogRequest,
) -> Result<BeginAutoLogResponse, IpcError> {
    begin_auto_log_from_label(window.label(), grants.inner(), manager.inner(), request).await
}

async fn append_auto_log_batch_from_label(
    label: &str,
    manager: &AutoLogSessionManager,
    mut request: AppendAutoLogBatchRequest,
) -> Result<AutoLogAppendStats, IpcError> {
    const OPERATION: &str = "append_auto_log_batch";
    require_main_window_label(label, OPERATION)?;
    for frame in &mut request.frames {
        resolve_auto_log_frame_bytes(frame)
            .map_err(|error| data_b64_ipc_error(error, OPERATION))?;
    }
    manager
        .append(&request.log_id, &request.frames)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn append_auto_log_batch(
    window: WebviewWindow,
    manager: State<'_, AutoLogSessionManager>,
    request: AppendAutoLogBatchRequest,
) -> Result<AutoLogAppendStats, IpcError> {
    append_auto_log_batch_from_label(window.label(), manager.inner(), request).await
}

async fn finish_auto_log_from_label(
    label: &str,
    manager: &AutoLogSessionManager,
    request: AutoLogSessionRequest,
) -> Result<(), IpcError> {
    const OPERATION: &str = "finish_auto_log";
    require_main_window_label(label, OPERATION)?;
    manager
        .finish(&request.log_id)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn finish_auto_log(
    window: WebviewWindow,
    manager: State<'_, AutoLogSessionManager>,
    request: AutoLogSessionRequest,
) -> Result<(), IpcError> {
    finish_auto_log_from_label(window.label(), manager.inner(), request).await
}

async fn abort_auto_log_from_label(
    label: &str,
    manager: &AutoLogSessionManager,
    request: AutoLogSessionRequest,
) -> Result<(), IpcError> {
    const OPERATION: &str = "abort_auto_log";
    require_main_window_label(label, OPERATION)?;
    manager
        .abort(&request.log_id)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn abort_auto_log(
    window: WebviewWindow,
    manager: State<'_, AutoLogSessionManager>,
    request: AutoLogSessionRequest,
) -> Result<(), IpcError> {
    abort_auto_log_from_label(window.label(), manager.inner(), request).await
}

/// Materialize one frame's bytes from the `dataB64` channel (if used) before
/// batch validation sees plain bytes, mirroring the export append command. A
/// single frame can never exceed the batch byte budget, so the batch cap is
/// also the per-frame decode limit.
fn resolve_auto_log_frame_bytes(frame: &mut DataFrame) -> Result<(), DataB64Error> {
    let Some(encoded) = frame.data_b64.take() else {
        return Ok(());
    };
    if !frame.data.is_empty() {
        return Err(DataB64Error::BothChannels);
    }
    frame.data = decode_data_b64(&encoded, MAX_AUTO_LOG_BATCH_RAW_BYTES)?;
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

fn validate_auto_log_batch(frames: &[DataFrame]) -> Result<usize, AppError> {
    if frames.len() > MAX_AUTO_LOG_BATCH_FRAMES {
        return Err(limit_error(
            "frames",
            MAX_AUTO_LOG_BATCH_FRAMES,
            frames.len(),
        ));
    }
    let mut raw_bytes = 0usize;
    for frame in frames {
        if frame.id.len() > MAX_AUTO_LOG_FRAME_ID_BYTES {
            return Err(limit_error(
                "frames",
                MAX_AUTO_LOG_FRAME_ID_BYTES,
                frame.id.len(),
            ));
        }
        raw_bytes = raw_bytes
            .checked_add(frame.data.len())
            .ok_or_else(|| limit_error("frames", MAX_AUTO_LOG_BATCH_RAW_BYTES, usize::MAX))?;
        if raw_bytes > MAX_AUTO_LOG_BATCH_RAW_BYTES {
            return Err(limit_error(
                "frames",
                MAX_AUTO_LOG_BATCH_RAW_BYTES,
                raw_bytes,
            ));
        }
    }
    Ok(raw_bytes)
}

/// Encode one batch through the shared text formatters: the auto-log `hex`
/// format is the export TXT-HEX dump layout and `text` is export TXT-ASCII,
/// so both stay byte-identical to the exported files.
fn format_auto_log_batch(frames: &[DataFrame], format: AutoLogFormat) -> Vec<u8> {
    let raw_bytes = frames.iter().map(|frame| frame.data.len()).sum::<usize>();
    let multiplier = if format == AutoLogFormat::Hex { 7 } else { 1 };
    let mut output = Vec::with_capacity(raw_bytes.saturating_mul(multiplier) + frames.len() * 64);
    let text_format = match format {
        AutoLogFormat::Hex => ExportFormat::TxtHex,
        AutoLogFormat::Text => ExportFormat::TxtAscii,
    };
    formatter::append_frames(&mut output, frames, text_format, "auto-log")
        .expect("formatting into a Vec cannot fail");
    output
}

fn now_millis() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn validate_log_id(log_id: &str) -> Result<(), AppError> {
    validate_hex_session_id(log_id, "logId", "auto-log")
}

fn validate_log_path(path: &Path) -> Result<(), AppError> {
    if path.as_os_str().is_empty() {
        return Err(AppError::ValidationError {
            message: "日志路径不能为空".to_string(),
            field: "path".to_string(),
        });
    }

    if !path.is_absolute() {
        return Err(AppError::ValidationError {
            message: "日志路径必须是绝对路径".to_string(),
            field: "path".to_string(),
        });
    }

    if path.is_dir() {
        return Err(AppError::ValidationError {
            message: "日志路径不能是目录".to_string(),
            field: "path".to_string(),
        });
    }

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        return Err(AppError::ValidationError {
            message: "日志目录不存在".to_string(),
            field: "path".to_string(),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::streaming_sessions::random_session_id_hex;
    use crate::models::data_frame::Direction;
    use std::fs;
    use std::future::Future;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::task::{Context, Poll, Waker};
    use std::time::{SystemTime, UNIX_EPOCH};

    static LOG_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = LOG_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "bbcom-log-{}-{nanos}-{counter}.txt",
            std::process::id()
        ));
        path
    }

    fn target(path: PathBuf) -> crate::commands::file_grants::AuthorizedLogTarget {
        crate::commands::file_grants::AuthorizedLogTarget {
            path,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    fn frame(id: &str, direction: Direction, data: &[u8]) -> DataFrame {
        DataFrame {
            id: id.to_string(),
            direction,
            timestamp: 1_710_000_000_123.0,
            data: data.to_vec(),
            data_b64: None,
        }
    }

    fn assert_pending<F: Future + ?Sized>(future: Pin<&mut F>) {
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(future.poll(&mut context), Poll::Pending));
    }

    #[test]
    fn rejects_empty_path() {
        let err = validate_log_path(Path::new("")).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[test]
    fn rejects_directory_path() {
        let dir = std::env::temp_dir();
        let err = validate_log_path(&dir).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[test]
    fn rejects_nonexistent_parent() {
        let mut path = std::env::temp_dir();
        path.push("bbcom-log-nonexistent-subdir-xyz");
        path.push("out.txt");
        let err = validate_log_path(&path).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[tokio::test]
    async fn backend_session_holds_writer_and_returns_cumulative_raw_stats() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Hex)
            .await
            .unwrap();
        assert_eq!(id.len(), 32);
        assert!(validate_log_id(&id).is_ok());
        assert!(path.exists(), "begin opens the session-owned writer");

        let first = manager
            .append(&id, &[frame("1", Direction::Rx, &[0x41, 0x42])])
            .await
            .unwrap();
        let second = manager
            .append(&id, &[frame("2", Direction::Tx, &[0x43])])
            .await
            .unwrap();
        assert_eq!(
            first,
            AutoLogAppendStats {
                frames: 1,
                raw_bytes: 2
            }
        );
        assert_eq!(
            second,
            AutoLogAppendStats {
                frames: 2,
                raw_bytes: 3
            }
        );

        manager.finish(&id).await.unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("RX | 41 42"));
        assert!(content.contains("TX | 43"));
        assert!(manager.append(&id, &[]).await.is_err());
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn format_is_frozen_per_session_and_abort_is_idempotent() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();
        manager
            .append(&id, &[frame("1", Direction::Rx, b"hello")])
            .await
            .unwrap();
        manager.abort(&id).await.unwrap();
        manager.abort(&id).await.unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("RX | hello"));
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn append_accepts_base64_channel_frames_and_rejects_dual_channel_payloads() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let started = manager
            .begin(target(path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();

        let appended = append_auto_log_batch_from_label(
            "main",
            &manager,
            AppendAutoLogBatchRequest {
                log_id: started.clone(),
                frames: vec![DataFrame {
                    id: "b64".to_string(),
                    direction: Direction::Tx,
                    timestamp: 1_710_000_000_123.0,
                    data: Vec::new(),
                    data_b64: Some(bbcom_contracts::encode_data_b64(b"hello")),
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(
            appended,
            AutoLogAppendStats {
                frames: 1,
                raw_bytes: 5
            }
        );

        let both_channels = append_auto_log_batch_from_label(
            "main",
            &manager,
            AppendAutoLogBatchRequest {
                log_id: started.clone(),
                frames: vec![DataFrame {
                    id: "dual".to_string(),
                    direction: Direction::Rx,
                    timestamp: 1_710_000_000_123.0,
                    data: vec![0x41],
                    data_b64: Some("QQ==".to_string()),
                }],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            both_channels.code,
            crate::models::ipc_error::AppErrorCode::InvalidInput
        );

        manager.finish(&started).await.unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("TX | hello"));
        assert!(!content.contains("RX | A"), "rejected frames write nothing");
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn abort_waits_for_a_precloned_append_and_seals_the_session() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();
        let shared = manager.get(&id).await.unwrap();
        let session_guard = shared.lock().await;

        // Poll both lock futures while the guard is held. This deterministically
        // queues the pre-cloned append before abort without relying on runtime
        // task scheduling or sleeps.
        let mut append_lock = Box::pin(Arc::clone(&shared).lock_owned());
        assert_pending(append_lock.as_mut());
        let mut abort = Box::pin(manager.abort(&id));
        assert_pending(abort.as_mut());

        drop(session_guard);
        let mut append_session = append_lock.await;
        AutoLogSessionManager::append_locked(
            &mut append_session,
            &[frame("queued", Direction::Rx, b"queued")],
            6,
        )
        .await
        .unwrap();
        drop(append_session);
        abort.await.unwrap();
        let size_after_abort = fs::metadata(&path).unwrap().len();

        // A stale Arc remains sealed even after it has left the global map.
        let mut stale = shared.lock().await;
        assert!(matches!(
            AutoLogSessionManager::append_locked(
                &mut stale,
                &[frame("late", Direction::Rx, b"late")],
                4,
            )
            .await,
            Err(AppError::ValidationError { field, .. }) if field == "logId"
        ));
        drop(stale);
        assert_eq!(fs::metadata(&path).unwrap().len(), size_after_abort);
        assert!(manager.append(&id, &[]).await.is_err());
        manager.abort(&id).await.unwrap();
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn active_session_limit_reports_limit_and_actual() {
        let manager = AutoLogSessionManager::default();
        let mut sessions = Vec::new();
        for _ in 0..MAX_ACTIVE_AUTO_LOG_SESSIONS {
            let path = temp_path();
            let id = manager
                .begin(target(path.clone()), AutoLogFormat::Text)
                .await
                .unwrap();
            sessions.push((id, path));
        }
        let rejected_path = temp_path();
        let error = manager
            .begin(target(rejected_path.clone()), AutoLogFormat::Text)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::LimitError {
                field,
                limit: MAX_ACTIVE_AUTO_LOG_SESSIONS,
                actual,
                ..
            } if field == "logId" && actual == MAX_ACTIVE_AUTO_LOG_SESSIONS + 1
        ));
        for (id, path) in sessions {
            manager.abort(&id).await.unwrap();
            fs::remove_file(path).ok();
        }
        fs::remove_file(rejected_path).ok();
    }

    #[test]
    fn auto_log_ids_formats_and_batches_are_strictly_validated() {
        let first = random_session_id_hex("auto-log").unwrap();
        let second = random_session_id_hex("auto-log").unwrap();
        assert_eq!(first.len(), 32);
        assert_ne!(first, second);
        assert!(validate_log_id(&first).is_ok());
        assert!(validate_log_id("log-1").is_err());
        assert_eq!(
            serde_json::from_str::<AutoLogFormat>("\"hex\"").unwrap(),
            AutoLogFormat::Hex
        );
        assert!(serde_json::from_str::<AutoLogFormat>("\"ascii\"").is_err());

        let too_many = vec![frame("x", Direction::Rx, &[]); MAX_AUTO_LOG_BATCH_FRAMES + 1];
        assert!(matches!(
            validate_auto_log_batch(&too_many),
            Err(AppError::LimitError {
                limit: MAX_AUTO_LOG_BATCH_FRAMES,
                actual,
                ..
            }) if actual == MAX_AUTO_LOG_BATCH_FRAMES + 1
        ));
        let too_large = frame(
            "x",
            Direction::Rx,
            &vec![0; MAX_AUTO_LOG_BATCH_RAW_BYTES + 1],
        );
        assert!(matches!(
            validate_auto_log_batch(&[too_large]),
            Err(AppError::LimitError {
                limit: MAX_AUTO_LOG_BATCH_RAW_BYTES,
                actual,
                ..
            }) if actual == MAX_AUTO_LOG_BATCH_RAW_BYTES + 1
        ));
    }

    #[test]
    fn auto_log_responses_use_the_fixed_camel_case_contract() {
        let begin = serde_json::to_value(BeginAutoLogResponse {
            log_id: "0123456789abcdef0123456789abcdef".to_string(),
        })
        .unwrap();
        assert_eq!(
            begin,
            serde_json::json!({"logId":"0123456789abcdef0123456789abcdef"})
        );
        let append = serde_json::to_value(AutoLogAppendStats {
            frames: 4,
            raw_bytes: 8,
        })
        .unwrap();
        assert_eq!(append, serde_json::json!({"frames":4,"rawBytes":8}));
    }

    #[test]
    fn formatter_and_batch_validation_cover_every_wire_format_boundary() {
        let frames = [
            frame("tx", Direction::Tx, &[0x41, 0x42]),
            frame("rx", Direction::Rx, &[0xFF]),
        ];
        assert_eq!(validate_auto_log_batch(&frames).unwrap(), 3);

        let hex = String::from_utf8(format_auto_log_batch(&frames, AutoLogFormat::Hex)).unwrap();
        let hex_lines: Vec<&str> = hex.lines().collect();
        assert_eq!(hex_lines.len(), 2);
        assert!(hex_lines[0].ends_with("TX | 41 42  |AB              |"));
        assert!(hex_lines[1].ends_with("RX | FF  |.               |"));
        assert!(
            hex_lines
                .iter()
                .all(|line| line.starts_with("[20") && line.contains("] "))
        );
        let text = String::from_utf8(format_auto_log_batch(&frames, AutoLogFormat::Text)).unwrap();
        assert!(text.contains("TX | AB"));
        assert!(text.contains("RX | �"));

        let oversized_id = frame(
            &"x".repeat(MAX_AUTO_LOG_FRAME_ID_BYTES + 1),
            Direction::Rx,
            &[],
        );
        assert!(matches!(
            validate_auto_log_batch(&[oversized_id]),
            Err(AppError::LimitError {
                limit: MAX_AUTO_LOG_FRAME_ID_BYTES,
                ..
            })
        ));
        assert_eq!(format_timestamp(f64::MAX), format!("{:.3}", f64::MAX));
        let dated = format_timestamp(0.0);
        assert!(dated.contains('-') && dated.contains(':'));
    }

    #[tokio::test]
    async fn hex_sessions_write_prefixed_dump_lines_between_session_markers() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Hex)
            .await
            .unwrap();
        manager
            .append(&id, &[frame("1", Direction::Rx, &[0x41_u8; 20])])
            .await
            .unwrap();
        manager.finish(&id).await.unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();

        assert_eq!(lines.len(), 4);
        assert!(lines[0].starts_with("# bbcom auto-log started 20"));
        assert!(lines[0].ends_with(" format=hex"));
        assert!(lines[1].contains(
            "] RX | 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41  |AAAAAAAAAAAAAAAA|"
        ));
        assert!(lines[2].contains("] RX | 41 41 41 41  |AAAA            |"));
        assert!(lines[3].starts_with("# bbcom auto-log finished 20"));
        fs::remove_file(path).ok();
    }

    #[test]
    fn text_formatter_removes_ansi_and_prefixes_every_inferred_record() {
        let data = concat!(
            "*** Booting MCUboot v2.4.0 ***",
            "*** Using Zephyr OS build v4.4.1 ***",
            "I: Starting bootloader",
            "[00:00:00.101,000] \u{1b}[0m<inf> flash: ready\u{1b}[0m"
        );
        let text = String::from_utf8(format_auto_log_batch(
            &[frame("rx", Direction::Rx, data.as_bytes())],
            AutoLogFormat::Text,
        ))
        .unwrap();
        let lines = text.lines().collect::<Vec<_>>();

        assert_eq!(lines.len(), 4);
        assert!(lines.iter().all(|line| line.contains(" RX | ")));
        assert!(lines[0].ends_with("*** Booting MCUboot v2.4.0 ***"));
        assert!(lines[1].ends_with("*** Using Zephyr OS build v4.4.1 ***"));
        assert!(lines[2].ends_with("I: Starting bootloader"));
        assert!(lines[3].ends_with("[00:00:00.101,000] <inf> flash: ready"));
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains("[0m"));
    }

    #[tokio::test]
    async fn sessions_reject_invalid_ids_and_expire_only_when_unlocked() {
        let manager = AutoLogSessionManager::default();
        assert!(manager.append("bad", &[]).await.is_err());
        assert!(manager.finish("bad").await.is_err());
        assert!(manager.abort("bad").await.is_err());

        let path = temp_path();
        assert!(validate_log_path(&path).is_ok());
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();
        let shared = manager.get(&id).await.unwrap();
        let expired_at = Instant::now() - AUTO_LOG_SESSION_TTL - Duration::from_secs(1);
        let guard = shared.lock().await;
        drop(guard);
        shared.lock().await.last_activity = expired_at;
        assert_eq!(manager.cleanup_expired().await, 1);
        assert!(manager.finish(&id).await.is_err());
        fs::remove_file(path).ok();

        let locked_path = temp_path();
        let locked_id = manager
            .begin(target(locked_path.clone()), AutoLogFormat::Hex)
            .await
            .unwrap();
        let locked = manager.get(&locked_id).await.unwrap();
        let mut guard = locked.lock().await;
        guard.last_activity = expired_at;
        assert_eq!(manager.cleanup_expired().await, 0);
        drop(guard);
        assert_eq!(manager.cleanup_expired().await, 1);
        fs::remove_file(locked_path).ok();
    }

    #[tokio::test]
    async fn cleanup_serializes_expiry_against_an_already_cloned_append() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();
        let shared = manager.get(&id).await.unwrap();
        let mut session = shared.lock().await;
        session.last_activity = Instant::now() - AUTO_LOG_SESSION_TTL - Duration::from_secs(1);

        let size_before_cleanup = fs::metadata(&path).unwrap().len();
        let mut append_lock = Box::pin(Arc::clone(&shared).lock_owned());
        assert_pending(append_lock.as_mut());
        assert_eq!(
            manager
                .table
                .expire_locked_candidate(&id, &shared, &mut session, Instant::now())
                .await
                .map(|(removed, _)| removed),
            Some(true)
        );
        drop(session);

        let mut stale = append_lock.await;
        assert!(matches!(
            AutoLogSessionManager::append_locked(
                &mut stale,
                &[frame("refresh", Direction::Rx, b"refresh")],
                7,
            )
            .await,
            Err(AppError::ValidationError { field, .. }) if field == "logId"
        ));
        drop(stale);
        assert_eq!(fs::metadata(&path).unwrap().len(), size_before_cleanup);
        assert!(manager.get(&id).await.is_err());
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn cleanup_never_removes_a_fresh_replacement_with_the_same_id() {
        let expired_path = temp_path();
        let replacement_path = temp_path();
        let manager = AutoLogSessionManager::default();
        let expired_id = manager
            .begin(target(expired_path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();
        let replacement_id = manager
            .begin(target(replacement_path.clone()), AutoLogFormat::Text)
            .await
            .unwrap();
        let expired = manager.get(&expired_id).await.unwrap();
        let replacement = manager.get(&replacement_id).await.unwrap();
        expired.lock().await.last_activity =
            Instant::now() - AUTO_LOG_SESSION_TTL - Duration::from_secs(1);

        // `expired` represents a cleanup snapshot captured before the map was
        // replaced. Process that stale candidate explicitly after replacement.
        let moved_replacement = manager.table.remove(&replacement_id).await.unwrap();
        assert!(Arc::ptr_eq(&moved_replacement, &replacement));
        let displaced = manager
            .table
            .insert(expired_id.clone(), moved_replacement)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&displaced, &expired));

        let mut expired_session = expired.lock().await;
        assert_eq!(
            manager
                .table
                .expire_locked_candidate(
                    &expired_id,
                    &expired,
                    &mut expired_session,
                    Instant::now(),
                )
                .await
                .map(|(removed, _)| removed),
            Some(false)
        );
        assert!(expired_session.terminal);
        assert!(expired_session.writer.is_none());
        drop(expired_session);

        let current = manager.get(&expired_id).await.unwrap();
        assert!(Arc::ptr_eq(&current, &replacement));
        manager
            .append(
                &expired_id,
                &[frame("replacement", Direction::Rx, b"replacement")],
            )
            .await
            .unwrap();
        assert!(
            fs::read_to_string(&replacement_path)
                .unwrap()
                .contains("replacement")
        );

        manager.abort(&expired_id).await.unwrap();
        manager.abort(&replacement_id).await.unwrap();
        fs::remove_file(expired_path).ok();
        fs::remove_file(replacement_path).ok();
    }

    #[tokio::test]
    async fn session_state_errors_do_not_write_after_finish_starts() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Hex)
            .await
            .unwrap();
        let shared = manager.get(&id).await.unwrap();
        shared.lock().await.writer = None;
        assert!(
            manager
                .append(&id, &[frame("x", Direction::Rx, b"x")])
                .await
                .is_err()
        );
        assert!(manager.finish(&id).await.is_err());
        assert!(manager.abort(&id).await.is_ok());
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn command_cores_enforce_window_grants_and_auto_log_lifecycle() {
        let grants = FileGrantManager::default();
        let manager = AutoLogSessionManager::default();
        let path = temp_path();
        let denied_token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::AutoLog,
                path.clone(),
            )
            .await
            .unwrap();
        let denied = begin_auto_log_from_label(
            "ai-assistant",
            &grants,
            &manager,
            BeginAutoLogRequest {
                token: denied_token,
                format: AutoLogFormat::Text,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            denied.code,
            crate::models::ipc_error::AppErrorCode::SecurityDenied
        );

        let token = grants
            .issue(
                crate::commands::file_grants::SaveTargetPurpose::AutoLog,
                path.clone(),
            )
            .await
            .unwrap();
        let started = begin_auto_log_from_label(
            "main",
            &grants,
            &manager,
            BeginAutoLogRequest {
                token,
                format: AutoLogFormat::Text,
            },
        )
        .await
        .unwrap();
        let appended = append_auto_log_batch_from_label(
            "main",
            &manager,
            AppendAutoLogBatchRequest {
                log_id: started.log_id.clone(),
                frames: vec![frame("core", Direction::Tx, b"hello")],
            },
        )
        .await
        .unwrap();
        assert_eq!(
            appended,
            AutoLogAppendStats {
                frames: 1,
                raw_bytes: 5
            }
        );
        finish_auto_log_from_label(
            "main",
            &manager,
            AutoLogSessionRequest {
                log_id: started.log_id,
            },
        )
        .await
        .unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("TX | hello"));
        fs::remove_file(&path).ok();

        let denied_append = append_auto_log_batch_from_label(
            "other",
            &manager,
            AppendAutoLogBatchRequest {
                log_id: "0".repeat(32),
                frames: vec![],
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            denied_append.code,
            crate::models::ipc_error::AppErrorCode::SecurityDenied
        );
        assert!(
            abort_auto_log_from_label(
                "other",
                &manager,
                AutoLogSessionRequest {
                    log_id: "0".repeat(32)
                }
            )
            .await
            .is_err()
        );
    }
}
