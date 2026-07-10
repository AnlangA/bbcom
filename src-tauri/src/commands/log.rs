use crate::commands::file_grants::{FileGrantManager, ensure_main_window};
use crate::models::errors::AppError;
use serde::Deserialize;
use std::path::Path;
use tauri::{State, WebviewWindow};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};

// Per-call guard against a runaway caller pushing huge buffers through IPC.
// A single append is normally one log line (well under 1 KiB); this is just a
// backstop.
const MAX_APPEND_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendLogRequest {
    pub token: String,
    pub content: String,
}

/// Append `content` to an authorized log file, creating it if it does not
/// exist. Used by the auto-log feature to stream TX/RX frames to disk as they
/// arrive. The
/// command is stateless — it opens, writes, flushes, and closes on each call —
/// so a process crash never loses more than the in-flight bounded batch and there is no file
/// handle to leak. The frontend serializes calls per session to preserve order.
#[tauri::command]
pub async fn append_log(
    window: WebviewWindow,
    grants: State<'_, FileGrantManager>,
    request: AppendLogRequest,
) -> Result<(), AppError> {
    ensure_main_window(window.label())?;
    let target = grants.resolve_auto_log(&request.token).await?;
    // A fixed set of path-hashed locks prevents two grants targeting the same
    // file from interleaving large append batches without serializing unrelated
    // log files behind one global disk lock.
    let _write_guard = target.write_lock.lock().await;
    append_log_to_path(&target.path, &request.content).await
}

async fn append_log_to_path(path: &Path, content: &str) -> Result<(), AppError> {
    validate_log_path(path)?;

    if content.len() > MAX_APPEND_BYTES {
        tracing::warn!(
            "append_log rejected: content too large ({} > max {})",
            content.len(),
            MAX_APPEND_BYTES
        );
        return Err(AppError::ValidationError {
            message: format!(
                "日志内容过大: {} (上限 {})",
                content.len(),
                MAX_APPEND_BYTES
            ),
            field: "content".to_string(),
        });
    }

    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .await
        .map_err(AppError::from)?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(content.as_bytes())
        .await
        .map_err(AppError::from)?;
    writer.flush().await.map_err(AppError::from)?;
    Ok(())
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

    #[tokio::test]
    async fn creates_file_when_missing() {
        let path = temp_path();
        append_log_to_path(&path, "first line\n").await.unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert_eq!(content, "first line\n");
    }

    #[tokio::test]
    async fn appends_without_truncating() {
        let path = temp_path();
        append_log_to_path(&path, "line one\n").await.unwrap();
        append_log_to_path(&path, "line two\n").await.unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert_eq!(content, "line one\nline two\n");
    }

    #[tokio::test]
    async fn rejects_empty_path() {
        let err = append_log_to_path(Path::new(""), "x").await.unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[tokio::test]
    async fn rejects_directory_path() {
        let dir = std::env::temp_dir();
        let err = append_log_to_path(&dir, "x").await.unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[tokio::test]
    async fn rejects_nonexistent_parent() {
        let mut path = std::env::temp_dir();
        path.push("bbcom-log-nonexistent-subdir-xyz");
        path.push("out.txt");
        let err = append_log_to_path(&path, "x").await.unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }
}
