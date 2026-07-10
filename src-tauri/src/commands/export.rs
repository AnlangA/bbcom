//! Thin Tauri command adapters for bounded export services.

use crate::export::session::{
    ExportSessionManager, validate_export_path as validate_session_export_path,
};
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use serde::Deserialize;
use tauri::State;

pub use crate::export::ExportFormat;

#[derive(Debug, Deserialize)]
pub struct BeginExportRequest {
    pub format: ExportFormat,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendExportBatchRequest {
    pub export_id: String,
    pub frames: Vec<DataFrame>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionRequest {
    pub export_id: String,
}

#[tauri::command]
pub async fn begin_export(
    manager: State<'_, ExportSessionManager>,
    request: BeginExportRequest,
) -> Result<String, AppError> {
    let format = request.format;
    let path =
        tokio::task::spawn_blocking(move || validate_session_export_path(&request.path, format))
            .await
            .map_err(|error| AppError::ExportError {
                message: format!("export validation task failed: {error}"),
                format: format.label().to_string(),
                path: String::new(),
            })??;
    manager.begin(format, path).await
}

#[tauri::command]
pub async fn append_export_batch(
    manager: State<'_, ExportSessionManager>,
    request: AppendExportBatchRequest,
) -> Result<(), AppError> {
    manager.append(&request.export_id, &request.frames).await
}

#[tauri::command]
pub async fn finish_export(
    manager: State<'_, ExportSessionManager>,
    request: ExportSessionRequest,
) -> Result<(), AppError> {
    manager.finish(&request.export_id).await
}

#[tauri::command]
pub async fn abort_export(
    manager: State<'_, ExportSessionManager>,
    request: ExportSessionRequest,
) -> Result<(), AppError> {
    manager.abort(&request.export_id).await
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
        let err = validate_session_export_path("", ExportFormat::Csv).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }

    #[test]
    fn rejects_mismatched_extension() {
        let mut path = std::env::temp_dir();
        path.push("capture.txt");
        let err =
            validate_session_export_path(&path.to_string_lossy(), ExportFormat::Csv).unwrap_err();
        assert!(matches!(err, AppError::ValidationError { field, .. } if field == "path"));
    }
}
