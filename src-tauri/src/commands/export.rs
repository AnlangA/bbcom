use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use crate::export::formatter;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportRequest {
    pub frames: Vec<DataFrame>,
    pub format: String,
    pub path: String,
}

#[tauri::command]
pub async fn export_data(request: ExportRequest) -> Result<(), AppError> {
    formatter::export(&request.frames, &request.format, &request.path).await
}
