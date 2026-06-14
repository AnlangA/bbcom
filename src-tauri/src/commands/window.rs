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
    let (width, height) = clamp_window_size(request.width, request.height);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| AppError::AiError {
            message: e.to_string(),
        })
}

/// Bounds enforced by the AI window's resizable range (see lib.rs builder).
pub const AI_WINDOW_MIN_WIDTH: f64 = 420.0;
pub const AI_WINDOW_MAX_WIDTH: f64 = 920.0;
pub const AI_WINDOW_MIN_HEIGHT: f64 = 112.0;
pub const AI_WINDOW_MAX_HEIGHT: f64 = 560.0;

/// Clamp a requested AI window size to its allowed range. Pure so it can be unit-tested
/// independently of the Tauri window handle.
pub fn clamp_window_size(width: f64, height: f64) -> (f64, f64) {
    (
        width.clamp(AI_WINDOW_MIN_WIDTH, AI_WINDOW_MAX_WIDTH),
        height.clamp(AI_WINDOW_MIN_HEIGHT, AI_WINDOW_MAX_HEIGHT),
    )
}

#[tauri::command]
pub fn start_ai_window_drag(window: tauri::Window) -> Result<(), AppError> {
    window.start_dragging().map_err(|e| AppError::AiError {
        message: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_undersized_request_to_minimum() {
        assert_eq!(clamp_window_size(100.0, 50.0), (420.0, 112.0));
    }

    #[test]
    fn clamps_oversized_request_to_maximum() {
        assert_eq!(clamp_window_size(2000.0, 900.0), (920.0, 560.0));
    }

    #[test]
    fn leaves_in_range_request_unchanged() {
        assert_eq!(clamp_window_size(760.0, 170.0), (760.0, 170.0));
    }

    #[test]
    fn clamps_each_axis_independently() {
        assert_eq!(clamp_window_size(100.0, 170.0), (420.0, 170.0));
        assert_eq!(clamp_window_size(760.0, 5000.0), (760.0, 560.0));
    }
}
