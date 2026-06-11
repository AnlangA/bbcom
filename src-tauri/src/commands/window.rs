use serde::Serialize;
use tauri::{Emitter, LogicalSize, Manager};

use crate::models::errors::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWindowState {
    pub visible: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeAiWindowRequest {
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn show_ai_window(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("ai-assistant")
        .ok_or_else(|| AppError::AiError {
            message: "AI 窗口不存在".to_string(),
        })?;
    window.show().map_err(|e| AppError::AiError {
        message: e.to_string(),
    })?;
    window.set_focus().ok();
    app.emit("ai-window-state", AiWindowState { visible: true })
        .ok();
    Ok(())
}

#[tauri::command]
pub fn hide_ai_window(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("ai-assistant")
        .ok_or_else(|| AppError::AiError {
            message: "AI 窗口不存在".to_string(),
        })?;
    window.hide().map_err(|e| AppError::AiError {
        message: e.to_string(),
    })?;
    app.emit("ai-window-state", AiWindowState { visible: false })
        .ok();
    Ok(())
}

#[tauri::command]
pub fn get_ai_window_state(app: tauri::AppHandle) -> Result<AiWindowState, AppError> {
    let visible = app
        .get_webview_window("ai-assistant")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    Ok(AiWindowState { visible })
}

#[tauri::command]
pub fn resize_ai_window(
    app: tauri::AppHandle,
    request: ResizeAiWindowRequest,
) -> Result<(), AppError> {
    let window = app
        .get_webview_window("ai-assistant")
        .ok_or_else(|| AppError::AiError {
            message: "AI 窗口不存在".to_string(),
        })?;
    let width = request.width.clamp(420.0, 920.0);
    let height = request.height.clamp(112.0, 560.0);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| AppError::AiError {
            message: e.to_string(),
        })
}

#[tauri::command]
pub fn start_ai_window_drag(window: tauri::Window) -> Result<(), AppError> {
    window.start_dragging().map_err(|e| AppError::AiError {
        message: e.to_string(),
    })
}
