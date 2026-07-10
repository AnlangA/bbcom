use crate::commands::file_grants::{FileGrantManager, ensure_main_window};
use crate::models::data_frame::{DataFrame, Direction};
use crate::models::errors::AppError;
use crate::models::ipc_error::{IpcError, from_app_error};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{State, WebviewWindow};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

const MAX_AUTO_LOG_BATCH_FRAMES: usize = 256;
const MAX_AUTO_LOG_BATCH_RAW_BYTES: usize = 256 * 1024;
const MAX_AUTO_LOG_FRAME_ID_BYTES: usize = 256;
const MAX_ACTIVE_AUTO_LOG_SESSIONS: usize = 32;
const AUTO_LOG_SESSION_TTL: Duration = Duration::from_secs(4 * 60 * 60);

type SharedAutoLogSession = Arc<Mutex<AutoLogSession>>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutoLogFormat {
    Hex,
    Text,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginAutoLogRequest {
    pub token: String,
    pub format: AutoLogFormat,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeginAutoLogResponse {
    pub log_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendAutoLogBatchRequest {
    pub log_id: String,
    pub frames: Vec<DataFrame>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoLogAppendStats {
    pub frames: usize,
    pub raw_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLogSessionRequest {
    pub log_id: String,
}

pub struct AutoLogSessionManager {
    sessions: Mutex<HashMap<String, SharedAutoLogSession>>,
    slots: Arc<Semaphore>,
    session_ttl: Duration,
}

struct AutoLogSession {
    target: crate::commands::file_grants::AuthorizedLogTarget,
    format: AutoLogFormat,
    frames: usize,
    raw_bytes: usize,
    output_bytes: usize,
    last_activity: Instant,
    writer: Option<BufWriter<tokio::fs::File>>,
    _slot: OwnedSemaphorePermit,
}

impl Default for AutoLogSessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAX_ACTIVE_AUTO_LOG_SESSIONS)),
            session_ttl: AUTO_LOG_SESSION_TTL,
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
        let slot = Arc::clone(&self.slots).try_acquire_owned().map_err(|_| {
            limit_error(
                "logId",
                MAX_ACTIVE_AUTO_LOG_SESSIONS,
                MAX_ACTIVE_AUTO_LOG_SESSIONS + 1,
            )
        })?;
        validate_log_path(&target.path)?;
        let write_lock = Arc::clone(&target.write_lock);
        let _write_guard = write_lock.lock().await;
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&target.path)
            .await
            .map_err(AppError::from)?;
        let writer = BufWriter::with_capacity(64 * 1024, file);
        let mut sessions = self.sessions.lock().await;
        for _ in 0..8 {
            let log_id = random_log_id()?;
            if sessions.contains_key(&log_id) {
                continue;
            }
            sessions.insert(
                log_id.clone(),
                Arc::new(Mutex::new(AutoLogSession {
                    target,
                    format,
                    frames: 0,
                    raw_bytes: 0,
                    output_bytes: 0,
                    last_activity: Instant::now(),
                    writer: Some(writer),
                    _slot: slot,
                })),
            );
            return Ok(log_id);
        }
        Err(AppError::IoError {
            message: "failed to allocate a unique auto-log session id".to_string(),
            kind: std::io::ErrorKind::Other,
        })
    }

    async fn append(
        &self,
        log_id: &str,
        frames: &[DataFrame],
    ) -> Result<AutoLogAppendStats, AppError> {
        validate_log_id(log_id)?;
        let batch_raw_bytes = validate_auto_log_batch(frames)?;
        let shared = self
            .sessions
            .lock()
            .await
            .get(log_id)
            .cloned()
            .ok_or_else(|| validation_error("logId", "unknown or expired auto-log session"))?;
        let mut session = shared.lock().await;
        let output = format_auto_log_batch(frames, session.format);
        let write_lock = Arc::clone(&session.target.write_lock);
        let _write_guard = write_lock.lock().await;
        let writer = session
            .writer
            .as_mut()
            .ok_or_else(|| validation_error("logId", "auto-log session is already finishing"))?;
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
            .sessions
            .lock()
            .await
            .remove(log_id)
            .ok_or_else(|| validation_error("logId", "unknown or expired auto-log session"))?;
        let (write_lock, mut writer) = {
            let mut session = shared.lock().await;
            (
                Arc::clone(&session.target.write_lock),
                session.writer.take().ok_or_else(|| {
                    validation_error("logId", "auto-log session is already finishing")
                })?,
            )
        };
        let _write_guard = write_lock.lock().await;
        writer.flush().await.map_err(AppError::from)?;
        writer.get_ref().sync_all().await.map_err(AppError::from)?;
        Ok(())
    }

    async fn abort(&self, log_id: &str) -> Result<(), AppError> {
        validate_log_id(log_id)?;
        self.sessions.lock().await.remove(log_id);
        Ok(())
    }

    async fn cleanup_expired(&self) -> usize {
        let now = Instant::now();
        let snapshot = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for (id, session) in snapshot {
            let Ok(session) = session.try_lock() else {
                continue;
            };
            if now.saturating_duration_since(session.last_activity) >= self.session_ttl {
                expired.push(id);
            }
        }
        if expired.is_empty() {
            return 0;
        }
        let mut sessions = self.sessions.lock().await;
        let count = expired.len();
        for id in expired {
            sessions.remove(&id);
        }
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
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
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
    request: AppendAutoLogBatchRequest,
) -> Result<AutoLogAppendStats, IpcError> {
    const OPERATION: &str = "append_auto_log_batch";
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
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
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
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
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
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

fn format_auto_log_batch(frames: &[DataFrame], format: AutoLogFormat) -> Vec<u8> {
    let raw_bytes = frames.iter().map(|frame| frame.data.len()).sum::<usize>();
    let multiplier = if format == AutoLogFormat::Hex { 3 } else { 1 };
    let mut output =
        String::with_capacity(raw_bytes.saturating_mul(multiplier) + frames.len() * 32);
    for frame in frames {
        let direction = match frame.direction {
            Direction::Tx => "TX",
            Direction::Rx => "RX",
        };
        let _ = write!(
            output,
            "[{}] {direction} | ",
            format_auto_log_timestamp(frame.timestamp)
        );
        match format {
            AutoLogFormat::Hex => {
                for (index, byte) in frame.data.iter().enumerate() {
                    if index > 0 {
                        output.push(' ');
                    }
                    let _ = write!(output, "{byte:02X}");
                }
            }
            AutoLogFormat::Text => output.push_str(&String::from_utf8_lossy(&frame.data)),
        }
        output.push('\n');
    }
    output.into_bytes()
}

fn format_auto_log_timestamp(timestamp: f64) -> String {
    TimeZone::timestamp_millis_opt(&Local, timestamp as i64)
        .single()
        .map(|date| date.format("%H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| format!("{timestamp:.3}"))
}

fn random_log_id() -> Result<String, AppError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| AppError::IoError {
        message: format!("failed to obtain randomness for auto-log session id: {error}"),
        kind: std::io::ErrorKind::Other,
    })?;
    let mut id = String::with_capacity(32);
    for byte in random {
        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

fn validate_log_id(log_id: &str) -> Result<(), AppError> {
    if log_id.len() != 32
        || !log_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(validation_error("logId", "invalid auto-log session id"));
    }
    Ok(())
}

fn validation_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::ValidationError {
        message: message.into(),
        field: field.to_string(),
    }
}

fn limit_error(field: &str, limit: usize, actual: usize) -> AppError {
    AppError::LimitError {
        message: format!("{field} exceeds its limit"),
        field: field.to_string(),
        limit,
        actual,
    }
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
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
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
        }
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
        let first = random_log_id().unwrap();
        let second = random_log_id().unwrap();
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
        assert!(hex.contains("TX | 41 42"));
        assert!(hex.contains("RX | FF"));
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
        assert_eq!(
            format_auto_log_timestamp(f64::MAX),
            format!("{:.3}", f64::MAX)
        );
        assert!(format_auto_log_timestamp(0.0).contains(':'));
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
        let shared = manager.sessions.lock().await.get(&id).unwrap().clone();
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
        let locked = manager
            .sessions
            .lock()
            .await
            .get(&locked_id)
            .unwrap()
            .clone();
        let mut guard = locked.lock().await;
        guard.last_activity = expired_at;
        assert_eq!(manager.cleanup_expired().await, 0);
        drop(guard);
        assert_eq!(manager.cleanup_expired().await, 1);
        fs::remove_file(locked_path).ok();
    }

    #[tokio::test]
    async fn session_state_errors_do_not_write_after_finish_starts() {
        let path = temp_path();
        let manager = AutoLogSessionManager::default();
        let id = manager
            .begin(target(path.clone()), AutoLogFormat::Hex)
            .await
            .unwrap();
        let shared = manager.sessions.lock().await.get(&id).unwrap().clone();
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
