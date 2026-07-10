pub mod commands;
pub mod export;
pub mod models;
pub mod secure_settings;
pub mod utils;

use commands::ai::AI_WINDOW_LABEL;
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
        .manage(commands::file_grants::FileGrantManager::default())
        .manage(export::session::ExportSessionManager::default())
        .manage(commands::log::AutoLogSessionManager::default())
        .manage(secure_settings::SecureSettingsState::default())
        .manage(commands::ai::request_manager::AiRequestManager::default())
        .setup(|app| {
            #[cfg(feature = "devtools")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            WebviewWindowBuilder::new(
                app,
                AI_WINDOW_LABEL,
                WebviewUrl::App("index.html?window=ai".into()),
            )
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

            if let Some(window) = app.get_webview_window(AI_WINDOW_LABEL) {
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
                            commands::window::AiWindowState { visible: false },
                        );
                    }
                });
            }
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                let app_handle2 = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        if let Some(ai_window) = app_handle2.get_webview_window(AI_WINDOW_LABEL)
                            && let Err(e) = ai_window.close()
                        {
                            tracing::warn!("failed to close AI window on exit: {e}");
                        }
                        app_handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_serialplugin::init())
        .invoke_handler(tauri::generate_handler![
            commands::ai::cancel_ai_request,
            commands::ai::run_ai_request,
            commands::checksum::calculate_checksum,
            commands::export::abort_export,
            commands::export::append_export_batch,
            commands::export::begin_export,
            commands::export::finish_export,
            commands::file_grants::request_save_target,
            commands::file_grants::revoke_file_grant,
            commands::log::abort_auto_log,
            commands::log::append_auto_log_batch,
            commands::log::begin_auto_log,
            commands::log::finish_auto_log,
            secure_settings::clear_ai_api_key,
            secure_settings::get_ai_key_status,
            secure_settings::migrate_ai_api_key,
            secure_settings::set_ai_api_key,
            commands::window::get_ai_window_state,
            commands::window::hide_ai_window,
            commands::window::resize_ai_window,
            commands::window::show_ai_window,
            commands::window::start_ai_window_drag,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!("error while running tauri application: {}", e);
        std::process::exit(1);
    }
}
