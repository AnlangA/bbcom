//! Thin Tauri command adapters for bounded export services.

use crate::commands::file_grants::{FileGrantManager, ensure_main_window};
use crate::export::session::ExportSessionManager;
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use serde::Deserialize;
use tauri::{State, WebviewWindow};

pub use crate::export::ExportFormat;

#[derive(Debug, Deserialize)]
pub struct BeginExportRequest {
    pub format: ExportFormat,
    pub token: String,
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
    window: WebviewWindow,
    grants: State<'_, FileGrantManager>,
    manager: State<'_, ExportSessionManager>,
    request: BeginExportRequest,
) -> Result<String, AppError> {
    ensure_main_window(window.label())?;
    let format = request.format;
    let path = grants.consume_export(&request.token, format).await?;
    manager.begin(format, path).await
}

#[tauri::command]
pub async fn append_export_batch(
    window: WebviewWindow,
    manager: State<'_, ExportSessionManager>,
    request: AppendExportBatchRequest,
) -> Result<(), AppError> {
    ensure_main_window(window.label())?;
    manager.append(&request.export_id, &request.frames).await
}

#[tauri::command]
pub async fn finish_export(
    window: WebviewWindow,
    manager: State<'_, ExportSessionManager>,
    request: ExportSessionRequest,
) -> Result<(), AppError> {
    ensure_main_window(window.label())?;
    manager.finish(&request.export_id).await
}

#[tauri::command]
pub async fn abort_export(
    window: WebviewWindow,
    manager: State<'_, ExportSessionManager>,
    request: ExportSessionRequest,
) -> Result<(), AppError> {
    ensure_main_window(window.label())?;
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
    fn begin_request_accepts_only_an_opaque_token() {
        let request: BeginExportRequest =
            serde_json::from_str(r#"{"format":"csv","token":"opaque-grant"}"#).unwrap();
        assert_eq!(request.format, ExportFormat::Csv);
        assert_eq!(request.token, "opaque-grant");
        assert!(
            serde_json::from_str::<BeginExportRequest>(
                r#"{"format":"csv","path":"C:\\unsafe.csv"}"#
            )
            .is_err()
        );
    }
}
