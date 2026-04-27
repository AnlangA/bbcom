pub mod commands;
pub mod export;
pub mod models;
pub mod utils;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let result = tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "ai-assistant", WebviewUrl::App("index.html?window=ai".into()))
                .title("AI 终端助手")
                .inner_size(760.0, 170.0)
                .min_inner_size(420.0, 120.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(true)
                .always_on_top(true)
                .visible(false)
                .build()?;
            if let Some(window) = app.get_webview_window("ai-assistant") {
                let app_handle = app.handle().clone();
                let window_for_event = window.clone();
                window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            if let Err(e) = window_for_event.hide() {
                                tracing::warn!("failed to hide AI window: {e}");
                            }
                            let _ = app_handle.emit(
                            "ai-window-state",
                            commands::ai::AiWindowState { visible: false },
                        );
                    }
                });
            }
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        if let Some(ai_window) = app_handle.get_webview_window("ai-assistant") {
                            if let Err(e) = ai_window.close() {
                                tracing::warn!("failed to close AI window on exit: {e}");
                            }
                        }
                        app_handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::ai::get_ai_window_state,
            commands::ai::hide_ai_window,
            commands::ai::resize_ai_window,
            commands::ai::show_ai_window,
            commands::ai::start_ai_window_drag,
            commands::ai::log_ai_assist,
            commands::ai::terminal_ai_assist,
            commands::checksum::calculate_checksum,
            commands::export::export_data,
            commands::config::load_config,
            commands::config::save_config,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!("error while running tauri application: {}", e);
        std::process::exit(1);
    }
}
