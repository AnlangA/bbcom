use crate::models::errors::AppError;
use crate::models::port_config::PortConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    pub default_port_config: Option<PortConfig>,
    pub window_layout: Option<WindowLayout>,
    pub send_history: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WindowLayout {
    pub width: u32,
    pub height: u32,
}

async fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub async fn load_config(app: tauri::AppHandle) -> Result<AppConfig, AppError> {
    let path = config_path(&app).await?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?;
    let config = serde_json::from_str(&content).map_err(|e| AppError::ConfigError { message: e.to_string() })?;
    Ok(config)
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), AppError> {
    let path = config_path(&app).await?;
    let content =
        serde_json::to_string_pretty(&config).map_err(|e| AppError::ConfigError { message: e.to_string() })?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| AppError::ConfigError { message: e.to_string() })?;
    Ok(())
}
