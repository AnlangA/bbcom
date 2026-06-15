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
