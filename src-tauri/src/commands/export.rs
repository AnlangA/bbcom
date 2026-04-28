use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use crate::export::formatter;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const MAX_EXPORT_FRAMES: usize = 100_000;

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportRequest {
    pub frames: Vec<DataFrame>,
    pub format: String,
    pub path: String,
}

#[tauri::command]
pub async fn export_data(app: tauri::AppHandle, request: ExportRequest) -> Result<(), AppError> {
    if request.frames.len() > MAX_EXPORT_FRAMES {
        return Err(AppError::ValidationError {
            message: format!("too many frames: {} (max {})", request.frames.len(), MAX_EXPORT_FRAMES),
            field: "frames".to_string(),
        });
    }

    let safe_base = app
        .path()
        .document_dir()
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?
        .join("bbcom_exports");

    tokio::fs::create_dir_all(&safe_base)
        .await
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?;

    let canonical_base = tokio::fs::canonicalize(&safe_base)
        .await
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?;

    // Validate the path component only (no directory traversal, no absolute paths).
    let path_component = std::path::Path::new(&request.path);
    if path_component.is_absolute()
        || path_component.components().any(|c| c == std::path::Component::ParentDir)
    {
        return Err(AppError::ValidationError {
            message: "invalid export path: path must be a relative filename within the exports directory".to_string(),
            field: "path".to_string(),
        });
    }

    let resolved = canonical_base.join(path_component);

    // Ensure the resolved path stays within the canonical base.
    if !resolved.starts_with(&canonical_base) {
        return Err(AppError::ValidationError {
            message: "invalid export path: path must be within the exports directory".to_string(),
            field: "path".to_string(),
        });
    }

    formatter::export(&request.frames, &request.format, &resolved.to_string_lossy()).await
}
