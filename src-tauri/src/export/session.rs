//! Bounded, backend-owned export sessions.

use crate::export::{ExportFormat, formatter};
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncWrite, AsyncWriteExt, BufWriter};
use tokio::sync::Mutex;

pub const MAX_EXPORT_FRAMES: usize = 100_000;
pub const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BATCH_FRAMES: usize = 512;
pub const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTIVE_EXPORTS: usize = 8;
const MAX_FRAME_ID_BYTES: usize = 256;
const EXPORT_SESSION_TTL: Duration = Duration::from_secs(30 * 60);

pub struct ExportSessionManager {
    sessions: Mutex<HashMap<String, ExportSession>>,
    next_id: AtomicU64,
    session_ttl: Duration,
}

struct ExportSession {
    format: ExportFormat,
    target: PathBuf,
    temp: PathBuf,
    writer: BufWriter<File>,
    frame_count: usize,
    raw_bytes: usize,
    last_activity: Instant,
}

impl Default for ExportSessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            session_ttl: EXPORT_SESSION_TTL,
        }
    }
}

impl ExportSessionManager {
    pub async fn begin(&self, format: ExportFormat, target: PathBuf) -> Result<String, AppError> {
        self.cleanup_expired().await;
        let mut sessions = self.sessions.lock().await;
        if sessions.len() >= MAX_ACTIVE_EXPORTS {
            return Err(validation_error(
                "exportId",
                format!("too many active exports (max {MAX_ACTIVE_EXPORTS})"),
            ));
        }

        let id = self.new_id();
        let (temp, file) = create_temp_file(&target, &id, format).await?;
        let writer = BufWriter::with_capacity(64 * 1024, file);
        let mut header = Vec::new();
        formatter::append_header(&mut header, format);
        let writer = initialize_writer(writer, &header, &temp, format, &target).await?;

        sessions.insert(
            id.clone(),
            ExportSession {
                format,
                target,
                temp,
                writer,
                frame_count: 0,
                raw_bytes: 0,
                last_activity: Instant::now(),
            },
        );
        Ok(id)
    }

    pub async fn append(&self, id: &str, frames: &[DataFrame]) -> Result<(), AppError> {
        self.cleanup_expired().await;
        let batch_bytes = validate_frame_batch(frames, MAX_BATCH_FRAMES, MAX_BATCH_BYTES)?;
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| validation_error("exportId", "unknown or finished export session"))?;

        let next_frame_count = session.frame_count.saturating_add(frames.len());
        let next_raw_bytes = session.raw_bytes.saturating_add(batch_bytes);
        if next_frame_count > MAX_EXPORT_FRAMES {
            return Err(validation_error(
                "frames",
                format!("too many frames: {next_frame_count} (max {MAX_EXPORT_FRAMES})"),
            ));
        }
        if next_raw_bytes > MAX_EXPORT_BYTES {
            return Err(validation_error(
                "frames",
                format!("export data exceeds {MAX_EXPORT_BYTES} bytes"),
            ));
        }

        let mut encoded = Vec::with_capacity(batch_bytes.min(64 * 1024));
        formatter::append_frames(
            &mut encoded,
            frames,
            session.format,
            &session.target.to_string_lossy(),
        )?;
        session
            .writer
            .write_all(&encoded)
            .await
            .map_err(|error| export_error(error, session.format, &session.target))?;
        session.frame_count = next_frame_count;
        session.raw_bytes = next_raw_bytes;
        session.last_activity = Instant::now();
        Ok(())
    }

    pub async fn finish(&self, id: &str) -> Result<(), AppError> {
        self.cleanup_expired().await;
        let session = self.take(id).await?;
        let ExportSession {
            format,
            target,
            temp,
            mut writer,
            ..
        } = session;

        if let Err(error) = writer.flush().await {
            drop(writer);
            remove_if_exists(&temp).await;
            return Err(export_error(error, format, &target));
        }
        if let Err(error) = writer.get_ref().sync_all().await {
            drop(writer);
            remove_if_exists(&temp).await;
            return Err(export_error(error, format, &target));
        }
        drop(writer);
        replace_target(&temp, &target, id, format).await
    }

    pub async fn abort(&self, id: &str) -> Result<(), AppError> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(id)
        };
        if let Some(session) = session {
            let path = session.temp.clone();
            drop(session);
            remove_if_exists(&path).await;
        }
        Ok(())
    }

    async fn take(&self, id: &str) -> Result<ExportSession, AppError> {
        self.sessions
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| validation_error("exportId", "unknown or finished export session"))
    }

    async fn cleanup_expired(&self) -> usize {
        let now = Instant::now();
        let expired = {
            let mut sessions = self.sessions.lock().await;
            let expired_ids: Vec<String> = sessions
                .iter()
                .filter(|(_, session)| {
                    now.saturating_duration_since(session.last_activity) >= self.session_ttl
                })
                .map(|(id, _)| id.clone())
                .collect();
            expired_ids
                .into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect::<Vec<_>>()
        };

        let count = expired.len();
        for session in expired {
            let temp = session.temp.clone();
            drop(session);
            remove_if_exists(&temp).await;
        }
        if count > 0 {
            tracing::info!(count, "removed expired export sessions");
        }
        count
    }

    fn new_id(&self) -> String {
        let counter = self.next_id.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        format!("export-{nanos:x}-{counter:x}")
    }
}

async fn initialize_writer<W: AsyncWrite + Unpin>(
    mut writer: W,
    header: &[u8],
    temp: &Path,
    format: ExportFormat,
    target: &Path,
) -> Result<W, AppError> {
    if !header.is_empty()
        && let Err(error) = writer.write_all(header).await
    {
        drop(writer);
        remove_if_exists(temp).await;
        return Err(export_error(error, format, target));
    }
    Ok(writer)
}

pub fn validate_frame_batch(
    frames: &[DataFrame],
    max_frames: usize,
    max_bytes: usize,
) -> Result<usize, AppError> {
    if frames.len() > max_frames {
        return Err(validation_error(
            "frames",
            format!("too many frames: {} (max {max_frames})", frames.len()),
        ));
    }
    let mut total = 0usize;
    for frame in frames {
        if frame.id.len() > MAX_FRAME_ID_BYTES {
            return Err(validation_error(
                "frames",
                format!("frame id exceeds {MAX_FRAME_ID_BYTES} bytes"),
            ));
        }
        if frame.data.len() > MAX_FRAME_BYTES {
            return Err(validation_error(
                "frames",
                format!("single frame exceeds {MAX_FRAME_BYTES} bytes"),
            ));
        }
        total = total
            .checked_add(frame.data.len())
            .ok_or_else(|| validation_error("frames", "frame byte count overflow"))?;
        if total > max_bytes {
            return Err(validation_error(
                "frames",
                format!("frame data exceeds {max_bytes} bytes"),
            ));
        }
    }
    Ok(total)
}

pub fn validate_export_path(path: &str, format: ExportFormat) -> Result<PathBuf, AppError> {
    if path.trim().is_empty() {
        return Err(validation_error("path", "export path cannot be empty"));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(validation_error("path", "export path must be absolute"));
    }
    if path.is_dir() {
        return Err(validation_error(
            "path",
            "export path cannot be a directory",
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        return Err(validation_error("path", "export directory does not exist"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !extension.is_empty() && extension != format.extension() {
        return Err(validation_error(
            "path",
            format!("export file extension must be .{}", format.extension()),
        ));
    }
    Ok(path)
}

async fn create_temp_file(
    target: &Path,
    id: &str,
    format: ExportFormat,
) -> Result<(PathBuf, File), AppError> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    for attempt in 0..8 {
        let temp = parent.join(format!(".{name}.bbcom-{id}-{attempt}.tmp"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
        {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(export_error(error, format, target)),
        }
    }
    Err(AppError::ExportError {
        message: "failed to allocate a unique export temp file".to_string(),
        format: format.label().to_string(),
        path: target.to_string_lossy().into_owned(),
    })
}

async fn replace_target(
    temp: &Path,
    target: &Path,
    id: &str,
    format: ExportFormat,
) -> Result<(), AppError> {
    let backup = target.with_file_name(format!(".bbcom-{id}.backup"));
    let had_target = fs::try_exists(target).await.unwrap_or(false);
    if had_target {
        fs::rename(target, &backup)
            .await
            .map_err(|error| export_error(error, format, target))?;
    }
    match fs::rename(temp, target).await {
        Ok(()) => {
            if had_target {
                remove_if_exists(&backup).await;
            }
            Ok(())
        }
        Err(error) => {
            if had_target && let Err(rollback_error) = fs::rename(&backup, target).await {
                remove_if_exists(temp).await;
                return Err(replacement_rollback_error(
                    error,
                    rollback_error,
                    format,
                    target,
                    &backup,
                ));
            }
            remove_if_exists(temp).await;
            Err(export_error(error, format, target))
        }
    }
}

fn replacement_rollback_error(
    replacement_error: std::io::Error,
    rollback_error: std::io::Error,
    format: ExportFormat,
    target: &Path,
    backup: &Path,
) -> AppError {
    AppError::ExportError {
        message: format!(
            "failed to replace export target: {replacement_error}; rollback also failed: \
             {rollback_error}; original file backup remains at {}",
            backup.display()
        ),
        format: format.label().to_string(),
        path: target.to_string_lossy().into_owned(),
    }
}

async fn remove_if_exists(path: &Path) {
    if let Err(error) = fs::remove_file(path).await
        && error.kind() != ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), "failed to remove export temp file: {error}");
    }
}

fn validation_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::ValidationError {
        message: message.into(),
        field: field.to_string(),
    }
}

fn export_error(error: std::io::Error, format: ExportFormat, path: &Path) -> AppError {
    AppError::ExportError {
        message: error.to_string(),
        format: format.label().to_string(),
        path: path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::data_frame::Direction;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    fn target_path(extension: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("bbcom-export-session-{nonce}.{extension}"));
        path
    }

    fn frame(id: &str, data: &[u8]) -> DataFrame {
        DataFrame {
            id: id.to_string(),
            direction: Direction::Rx,
            timestamp: 1.0,
            data: data.to_vec(),
        }
    }

    #[derive(Debug)]
    struct FailingWriter;

    impl AsyncWrite for FailingWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Err(std::io::Error::other("injected header failure")))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn streams_batches_and_atomically_replaces_target() {
        let target = target_path("csv");
        std::fs::write(&target, "old data").unwrap();
        let manager = ExportSessionManager::default();
        let id = manager
            .begin(ExportFormat::Csv, target.clone())
            .await
            .unwrap();
        manager
            .append(&id, &[frame("1", &[0x41]), frame("2", &[0x42])])
            .await
            .unwrap();
        manager.finish(&id).await.unwrap();

        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.starts_with("timestamp,direction,data\n"));
        assert!(content.contains("41"));
        assert!(content.contains("42"));
        assert!(!content.contains("old data"));
        std::fs::remove_file(target).ok();
    }

    #[tokio::test]
    async fn abort_removes_backend_owned_temp_file() {
        let target = target_path("jsonl");
        let manager = ExportSessionManager::default();
        let id = manager.begin(ExportFormat::Jsonl, target).await.unwrap();
        let temp = manager.sessions.lock().await.get(&id).unwrap().temp.clone();
        assert!(temp.exists());
        manager.abort(&id).await.unwrap();
        assert!(!temp.exists());
    }

    #[tokio::test]
    async fn expired_sessions_are_swept_before_they_consume_capacity() {
        let manager = ExportSessionManager::default();
        let mut temp_files = Vec::new();
        for _ in 0..MAX_ACTIVE_EXPORTS {
            let id = manager
                .begin(ExportFormat::Jsonl, target_path("jsonl"))
                .await
                .unwrap();
            temp_files.push(manager.sessions.lock().await.get(&id).unwrap().temp.clone());
        }

        let replacement_target = target_path("jsonl");
        assert!(
            manager
                .begin(ExportFormat::Jsonl, replacement_target.clone())
                .await
                .is_err()
        );
        let expired_at = Instant::now() - EXPORT_SESSION_TTL - Duration::from_secs(1);
        for session in manager.sessions.lock().await.values_mut() {
            session.last_activity = expired_at;
        }

        let replacement_id = manager
            .begin(ExportFormat::Jsonl, replacement_target)
            .await
            .unwrap();

        assert!(temp_files.iter().all(|path| !path.exists()));
        assert_eq!(manager.sessions.lock().await.len(), 1);
        manager.abort(&replacement_id).await.unwrap();
    }

    #[tokio::test]
    async fn header_write_failure_removes_allocated_temp_file() {
        let target = target_path("csv");
        let temp = target.with_extension("tmp");
        std::fs::write(&temp, b"allocated").unwrap();

        let error = initialize_writer(FailingWriter, b"header", &temp, ExportFormat::Csv, &target)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::ExportError { .. }));
        assert!(!temp.exists());
    }

    #[test]
    fn rollback_failure_reports_both_errors_and_preserved_backup() {
        let target = PathBuf::from("capture.csv");
        let backup = PathBuf::from(".bbcom-export-id.backup");
        let error = replacement_rollback_error(
            std::io::Error::other("replacement failed"),
            std::io::Error::other("restore failed"),
            ExportFormat::Csv,
            &target,
            &backup,
        );

        let AppError::ExportError { message, path, .. } = error else {
            panic!("expected export error");
        };
        assert!(message.contains("replacement failed"));
        assert!(message.contains("restore failed"));
        assert!(message.contains(&backup.display().to_string()));
        assert_eq!(path, target.to_string_lossy());
    }

    #[test]
    fn batch_limits_cover_count_single_frame_and_total_bytes() {
        let too_many = vec![frame("x", &[]); MAX_BATCH_FRAMES + 1];
        assert!(validate_frame_batch(&too_many, MAX_BATCH_FRAMES, MAX_BATCH_BYTES).is_err());
        assert!(
            validate_frame_batch(
                &[frame("large", &vec![0; MAX_FRAME_BYTES + 1])],
                MAX_BATCH_FRAMES,
                MAX_BATCH_BYTES,
            )
            .is_err()
        );
        assert!(
            validate_frame_batch(
                &[frame("a", &[0; 3]), frame("b", &[0; 3])],
                MAX_BATCH_FRAMES,
                5,
            )
            .is_err()
        );
    }
}
