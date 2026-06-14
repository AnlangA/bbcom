use crate::models::errors::AppError;
use std::path::Path;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};

// Per-call guard against a runaway caller pushing huge buffers through IPC.
// A single append is normally one log line (well under 1 KiB); this is just a
// backstop.
const MAX_APPEND_BYTES: usize = 1024 * 1024;

/// Append `content` to a log file, creating it if it does not exist. Used by
/// the auto-log feature to stream TX/RX frames to disk as they arrive. The
/// command is stateless — it opens, writes, flushes, and closes on each call —
/// so a crash never loses more than the in-flight line and there is no file
/// handle to leak. The frontend serializes calls per session to preserve order.
#[tauri::command]
pub async fn append_log(path: String, content: String) -> Result<(), AppError> {
    validate_log_path(&path)?;

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
        .open(&path)
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

fn validate_log_path(path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: "日志路径不能为空".to_string(),
            field: "path".to_string(),
        });
    }

    let path_ref = Path::new(path);
    if path_ref.is_dir() {
        return Err(AppError::ValidationError {
            message: "日志路径不能是目录".to_string(),
            field: "path".to_string(),
        });
    }

    if let Some(parent) = path_ref.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::ValidationError {
                message: "日志目录不存在".to_string(),
                field: "path".to_string(),
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static LOG_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> String {
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
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn creates_file_when_missing() {
        let path = temp_path();
        append_log(path.clone(), "first line\n".to_string())
            .await
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert_eq!(content, "first line\n");
    }

    #[tokio::test]
    async fn appends_without_truncating() {
        let path = temp_path();
        append_log(path.clone(), "line one\n".to_string())
            .await
            .unwrap();
        append_log(path.clone(), "line two\n".to_string())
            .await
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert_eq!(content, "line one\nline two\n");
    }

    #[tokio::test]
    async fn rejects_empty_path() {
        let err = append_log("".to_string(), "x".to_string())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[tokio::test]
    async fn rejects_directory_path() {
        let dir = std::env::temp_dir();
        let err = append_log(dir.to_string_lossy().to_string(), "x".to_string())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[tokio::test]
    async fn rejects_nonexistent_parent() {
        let mut path = std::env::temp_dir();
        path.push("bbcom-log-nonexistent-subdir-xyz");
        path.push("out.txt");
        let err = append_log(path.to_string_lossy().to_string(), "x".to_string())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }
}
