use crate::models::errors::AppError;
use crate::models::port_config::PortConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

const MAX_SEND_HISTORY: usize = 200;
const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub version: u32,
    pub default_port_config: Option<PortConfig>,
    pub window_layout: Option<WindowLayout>,
    #[serde(default)]
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
        .map_err(|e| AppError::ConfigError {
            message: e.to_string(),
        })?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::ConfigError {
            message: e.to_string(),
        })?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub async fn load_config(app: tauri::AppHandle) -> Result<AppConfig, AppError> {
    let path = config_path(&app).await?;
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        tracing::info!(
            "config file not found at {}, using defaults",
            path.display()
        );
        return Ok(AppConfig::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::ConfigError {
            message: e.to_string(),
        })?;
    match serde_json::from_str::<AppConfig>(&content) {
        Ok(config) => {
            if config.version > CONFIG_VERSION {
                tracing::warn!(
                    "config version {} is newer than expected {}, resetting to defaults",
                    config.version,
                    CONFIG_VERSION
                );
                return Ok(AppConfig::default());
            }
            Ok(config)
        }
        Err(e) => {
            tracing::warn!(
                "failed to parse config file at {}, using defaults: {e}",
                path.display()
            );
            Ok(AppConfig::default())
        }
    }
}

#[tauri::command]
pub async fn save_config(
    app: tauri::AppHandle,
    mut config: AppConfig,
) -> Result<(), AppError> {
    config.version = CONFIG_VERSION;
    if config.send_history.len() > MAX_SEND_HISTORY {
        let drop = config.send_history.len() - MAX_SEND_HISTORY;
        config.send_history.drain(..drop);
    }

    let path = config_path(&app).await?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| {
        AppError::ConfigError {
            message: e.to_string(),
        }
    })?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| AppError::ConfigError {
            message: e.to_string(),
        })?;
    Ok(())
}
