use crate::export::formatter;
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_EXPORT_FRAMES: usize = 100_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    #[serde(alias = "txt")]
    TxtHex,
    TxtAscii,
    Csv,
    Jsonl,
    Bin,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportRequest {
    pub frames: Vec<DataFrame>,
    pub format: ExportFormat,
    pub path: String,
}

#[tauri::command]
pub async fn export_data(request: ExportRequest) -> Result<(), AppError> {
    if request.frames.len() > MAX_EXPORT_FRAMES {
        return Err(AppError::ValidationError {
            message: format!(
                "too many frames: {} (max {})",
                request.frames.len(),
                MAX_EXPORT_FRAMES
            ),
            field: "frames".to_string(),
        });
    }

    // validate_export_path issues blocking fs stat syscalls (is_dir / parent.exists);
    // run them off the tokio async worker so a slow/network mount can't stall it.
    let path_for_validation = request.path.clone();
    let fmt = request.format;
    let validation =
        tokio::task::spawn_blocking(move || validate_export_path(&path_for_validation, fmt))
            .await
            .map_err(|e| AppError::ExportError {
                message: format!("export validation task failed: {e}"),
                format: "unknown".to_string(),
                path: request.path.clone(),
            })?;
    validation?;

    formatter::export(&request.frames, &request.format, &request.path).await
}

/// Capture-file export. The frontend serializes the capture to a JSONL temp
/// file (one `DataFrame` per line — the same shape the JSONL export emits) and
/// passes only the temp-file path through IPC, instead of pushing up to 100 000
/// `DataFrame` objects (each with a `data: Vec<u8>` that serde expands to a JSON
/// number array) through `invoke`. The Rust side reads and parses the file in a
/// `spawn_blocking` task, then runs the normal formatter.
///
/// This avoids the dominant export cost — serializing the `frames` argument
/// across the IPC boundary — at the price of one temp-file write+read. For a
/// 10k-frame capture the temp file is far cheaper to transfer than 10k JSON
/// objects.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFileExportRequest {
    /// Path to a JSONL temp file written by the frontend (one DataFrame/line).
    pub capture_file: String,
    pub format: ExportFormat,
    pub path: String,
}

#[tauri::command]
pub async fn export_data_from_capture_file(
    request: CaptureFileExportRequest,
) -> Result<(), AppError> {
    let fmt = request.format;
    let target = request.path.clone();
    let capture_file = request.capture_file.clone();

    // Validate the target path + read+parse the capture file off the async
    // worker (blocking fs + parse work).
    let parsed = tokio::task::spawn_blocking(move || -> Result<Vec<DataFrame>, AppError> {
        validate_export_path(&target, fmt)?;
        read_capture_file(&capture_file, &target)
    })
    .await
    .map_err(|e| AppError::ExportError {
        message: format!("capture-file export task failed: {e}"),
        format: "unknown".to_string(),
        path: request.path.clone(),
    })??;

    if parsed.len() > MAX_EXPORT_FRAMES {
        return Err(AppError::ValidationError {
            message: format!(
                "too many frames: {} (max {})",
                parsed.len(),
                MAX_EXPORT_FRAMES
            ),
            field: "frames".to_string(),
        });
    }

    formatter::export(&parsed, &request.format, &request.path).await
}

/// Read a JSONL capture file (one `DataFrame` per line) into a `Vec<DataFrame>`.
/// Empty lines are skipped; a malformed line yields an ExportError. The `target`
/// is used only for a more helpful error message.
fn read_capture_file(capture_file: &str, target: &str) -> Result<Vec<DataFrame>, AppError> {
    let content = std::fs::read_to_string(capture_file).map_err(|e| AppError::ExportError {
        message: format!("failed to read capture file '{capture_file}': {e}"),
        format: "jsonl".to_string(),
        path: target.to_string(),
    })?;
    let mut frames = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame: DataFrame =
            serde_json::from_str(trimmed).map_err(|e| AppError::ExportError {
                message: format!("capture file line {} is not a valid frame: {e}", i + 1),
                format: "jsonl".to_string(),
                path: target.to_string(),
            })?;
        frames.push(frame);
    }
    Ok(frames)
}

fn validate_export_path(path: &str, format: ExportFormat) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::ValidationError {
            message: "导出路径不能为空".to_string(),
            field: "path".to_string(),
        });
    }

    let path_ref = Path::new(path);
    if path_ref.is_dir() {
        return Err(AppError::ValidationError {
            message: "导出路径不能是目录".to_string(),
            field: "path".to_string(),
        });
    }

    if let Some(parent) = path_ref.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::ValidationError {
                message: "导出目录不存在".to_string(),
                field: "path".to_string(),
            });
        }
    }

    let expected_ext = format.extension();
    let ext = path_ref
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ext.is_empty() && ext != expected_ext {
        return Err(AppError::ValidationError {
            message: format!("导出文件扩展名应为 .{expected_ext}"),
            field: "path".to_string(),
        });
    }

    Ok(())
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::TxtHex | ExportFormat::TxtAscii => "txt",
            ExportFormat::Csv => "csv",
            ExportFormat::Jsonl => "jsonl",
            ExportFormat::Bin => "bin",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rejects_empty_export_path() {
        let err = validate_export_path("", ExportFormat::Csv).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[test]
    fn rejects_mismatched_extension() {
        let err = validate_export_path("capture.txt", ExportFormat::Csv).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }
}
