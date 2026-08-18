pub use bbcom_contracts::{AiWindowState, ResizeAiWindowRequest};
use tauri::{Emitter, LogicalSize, Manager};

use crate::commands::ai::AI_WINDOW_LABEL;
use crate::models::errors::AppError;

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
    if let Err(e) = window.set_focus() {
        // Some Linux WMs refuse focus stealing; the window is still shown, so
        // degrade to a log line instead of failing the command.
        tracing::warn!("failed to focus AI window: {e}");
    }
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
    if !request.width.is_finite() || !request.height.is_finite() {
        return Err(AppError::ValidationError {
            message: "window dimensions must be finite".to_string(),
            field: "size".to_string(),
        });
    }
    let window = app
        .get_webview_window("ai-assistant")
        .ok_or_else(|| AppError::AiError {
            message: "AI 窗口不存在".to_string(),
        })?;
    // The frontend reports CONTENT size only. Add the current decoration
    // height (outer minus inner) so the visible client area matches the
    // measured content instead of a hardcoded per-OS titlebar guess.
    let decoration_height = window
        .outer_size()
        .ok()
        .zip(window.inner_size().ok())
        .map(|(outer, inner)| {
            (outer.height.saturating_sub(inner.height)) as f64
                / window.scale_factor().unwrap_or(1.0)
        })
        .unwrap_or(0.0);
    let (width, height) =
        clamp_window_size(request.width, request.height + decoration_height.max(0.0));
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| AppError::AiError {
            message: e.to_string(),
        })
}

/// Hard bounds for resize requests; the builder itself is non-resizable, so
/// these constants are the only enforcement (unit-tested below).
pub const AI_WINDOW_MIN_WIDTH: f64 = 420.0;
pub const AI_WINDOW_MAX_WIDTH: f64 = 920.0;
pub const AI_WINDOW_MIN_HEIGHT: f64 = 120.0;
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
    if window.label() != AI_WINDOW_LABEL {
        return Err(AppError::ValidationError {
            message: "window is not allowed to start the AI drag operation".to_string(),
            field: "window".to_string(),
        });
    }
    window.start_dragging().map_err(|e| AppError::AiError {
        message: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_undersized_request_to_minimum() {
        assert_eq!(clamp_window_size(100.0, 50.0), (420.0, 120.0));
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
