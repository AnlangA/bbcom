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
    // The frontend reports CONTENT size; on macOS the webview lays out to the
    // safe area (under-titlebar inset), which the frontend measures after the
    // first pass and re-requests with the deficit. Bounds apply to the frame.
    let work_area_height = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.work_area().size.height as f64 / m.scale_factor());
    let max_height = work_area_height
        .map(|available| AI_WINDOW_MAX_HEIGHT.min(available.max(AI_WINDOW_MIN_HEIGHT)))
        .unwrap_or(AI_WINDOW_MAX_HEIGHT);
    let (width, height) = clamp_window_size_within(
        request.width,
        request.height,
        AI_WINDOW_MAX_WIDTH,
        max_height,
    );
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| AppError::AiError {
            message: e.to_string(),
        })?;
    // A window that grew toward the screen edge would leave its lower rows
    // unreachable, so nudge the frame back inside the monitor work area.
    if let Some(monitor) = window.current_monitor().ok().flatten() {
        let area = monitor.work_area();
        let (area_x, area_y) = (area.position.x, area.position.y);
        let (area_w, area_h) = (area.size.width as i32, area.size.height as i32);
        if let (Ok(position), Ok(outer)) = (window.outer_position(), window.outer_size()) {
            let (x, y) = clamp_position_into_work_area(
                position.x,
                position.y,
                (area_x, area_y, area_w, area_h),
                (outer.width as i32, outer.height as i32),
            );
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    Ok(())
}

/// Hard bounds for resize requests; the builder itself is non-resizable, so
/// these constants are the only enforcement (unit-tested below).
pub const AI_WINDOW_MIN_WIDTH: f64 = 420.0;
pub const AI_WINDOW_MAX_WIDTH: f64 = 920.0;
pub const AI_WINDOW_MIN_HEIGHT: f64 = 120.0;
// The log-assistant tab stacks its bounded regions (message list 200px +
// result card 320px + controls) inside ~106px of panel chrome, topping out
// near 720px of client area; the clamp bounds the OUTER frame (content +
// decoration), so it must admit ~750. Short monitors tighten this further
// against their work area at resize time.
pub const AI_WINDOW_MAX_HEIGHT: f64 = 800.0;

/// Clamp a requested AI window size to its allowed range. Pure so it can be unit-tested
/// independently of the Tauri window handle.
pub fn clamp_window_size(width: f64, height: f64) -> (f64, f64) {
    clamp_window_size_within(width, height, AI_WINDOW_MAX_WIDTH, AI_WINDOW_MAX_HEIGHT)
}

fn clamp_window_size_within(
    width: f64,
    height: f64,
    max_width: f64,
    max_height: f64,
) -> (f64, f64) {
    (
        width.clamp(AI_WINDOW_MIN_WIDTH, max_width),
        height.clamp(AI_WINDOW_MIN_HEIGHT, max_height),
    )
}

/// Shift a frame so it fits inside a work area, keeping its top-left corner
/// visible when the area is smaller than the frame. Pure for unit tests.
pub fn clamp_position_into_work_area(
    x: i32,
    y: i32,
    area: (i32, i32, i32, i32),
    frame_size: (i32, i32),
) -> (i32, i32) {
    let (area_x, area_y, area_w, area_h) = area;
    let (w, h) = frame_size;
    let max_x = area_x + (area_w - w).max(0);
    let max_y = area_y + (area_h - h).max(0);
    (x.clamp(area_x, max_x), y.clamp(area_y, max_y))
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
        assert_eq!(clamp_window_size(2000.0, 900.0), (920.0, 800.0));
    }

    #[test]
    fn leaves_in_range_request_unchanged() {
        assert_eq!(clamp_window_size(760.0, 170.0), (760.0, 170.0));
    }

    #[test]
    fn clamps_each_axis_independently() {
        assert_eq!(clamp_window_size(100.0, 170.0), (420.0, 170.0));
        assert_eq!(clamp_window_size(760.0, 5000.0), (760.0, 800.0));
    }

    #[test]
    fn work_area_tightens_the_height_bound() {
        // A short monitor's work area (e.g. 600 logical px) overrides the
        // static max so the window still fits on screen.
        assert_eq!(
            clamp_window_size_within(820.0, 900.0, 920.0, 600.0),
            (820.0, 600.0)
        );
        assert_eq!(
            clamp_window_size_within(820.0, 540.0, 920.0, 600.0),
            (820.0, 540.0)
        );
    }

    #[test]
    fn position_shifts_back_inside_the_work_area() {
        let area = (0, 0, 1000, 800);
        // Bottom edge past the work area: y moves up by the overflow.
        assert_eq!(
            clamp_position_into_work_area(100, 700, area, (400, 300)),
            (100, 500)
        );
        // Fully inside: unchanged.
        assert_eq!(
            clamp_position_into_work_area(100, 100, area, (400, 300)),
            (100, 100)
        );
        // Negative coordinates pull back to the origin.
        assert_eq!(
            clamp_position_into_work_area(-50, -50, area, (400, 300)),
            (0, 0)
        );
        // Frame taller than the area: top-left stays visible.
        assert_eq!(
            clamp_position_into_work_area(100, 100, area, (400, 900)),
            (100, 0)
        );
    }
}
