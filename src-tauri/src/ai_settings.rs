//! Plain AI-key configuration stored in the application data directory.

pub use bbcom_contracts::{AiKeyStatus, SetAiApiKeyRequest};

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::models::ipc_error::{AppErrorCode, IpcError};

const AI_SETTINGS_FILE: &str = "ai-settings.json";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiSettingsFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    ai_api_key: Option<String>,
}

fn storage_error(operation: &'static str) -> IpcError {
    IpcError::new(
        AppErrorCode::IoPermissionDenied,
        "error.ai_key_storage",
        true,
        operation,
    )
}

fn settings_path(app: &AppHandle, operation: &'static str) -> Result<PathBuf, IpcError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| storage_error(operation))?;
    fs::create_dir_all(&dir).map_err(|_| storage_error(operation))?;
    Ok(dir.join(AI_SETTINGS_FILE))
}

fn read_settings(app: &AppHandle, operation: &'static str) -> Result<AiSettingsFile, IpcError> {
    let path = settings_path(app, operation)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AiSettingsFile::default()),
        Err(_) => Err(storage_error(operation)),
    }
}

fn write_settings(
    app: &AppHandle,
    settings: &AiSettingsFile,
    operation: &'static str,
) -> Result<(), IpcError> {
    let path = settings_path(app, operation)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| storage_error(operation))?;
    fs::write(&path, bytes).map_err(|_| storage_error(operation))
}

fn current_key(app: &AppHandle, operation: &'static str) -> Result<Option<String>, IpcError> {
    Ok(read_settings(app, operation)?
        .ai_api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

/// Report configuration state without exposing the API key itself.
#[tauri::command]
pub fn get_ai_key_status(app: AppHandle) -> Result<AiKeyStatus, IpcError> {
    Ok(if current_key(&app, "get_ai_key_status")?.is_some() {
        AiKeyStatus::configured()
    } else {
        AiKeyStatus::missing()
    })
}

#[tauri::command]
pub fn set_ai_api_key(
    app: AppHandle,
    request: SetAiApiKeyRequest,
) -> Result<AiKeyStatus, IpcError> {
    const OPERATION: &str = "set_ai_api_key";
    let value = request.value.trim().to_string();
    if value.is_empty() {
        return Err(IpcError::new(
            AppErrorCode::InvalidInput,
            "error.ai_key_invalid",
            false,
            OPERATION,
        ));
    }
    write_settings(
        &app,
        &AiSettingsFile {
            ai_api_key: Some(value),
        },
        OPERATION,
    )?;
    Ok(AiKeyStatus::configured())
}

#[tauri::command]
pub fn clear_ai_api_key(app: AppHandle) -> Result<(), IpcError> {
    write_settings(&app, &AiSettingsFile::default(), "clear_ai_api_key")
}

pub fn load_ai_key_for_request(app: &AppHandle) -> Result<String, IpcError> {
    current_key(app, "run_ai_request")?.ok_or_else(|| {
        IpcError::new(
            AppErrorCode::SecurityDenied,
            "error.ai_key_missing",
            false,
            "run_ai_request",
        )
    })
}
