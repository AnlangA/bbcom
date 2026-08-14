pub mod commands;
pub mod export;
pub mod models;
pub mod plugins;
pub mod secure_settings;
pub mod utils;

use bbcom_contracts::ShutdownCloseRequest;
use commands::ai::AI_WINDOW_LABEL;
use std::sync::Arc;
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
        .manage(commands::shutdown::ShutdownGate::default())
        .manage(commands::legacy_backup::LegacyBackupManager::default())
        .setup(|app| {
            let app_data_root = app.path().app_data_dir()?;
            let workspace_root = app_data_root.join("projects-v1");
            app.manage(commands::workspace::WorkspaceManager::open(workspace_root)?);
            app.manage(plugins::NativePluginSecurityStore::open(&app_data_root)?);
            app.manage(commands::plugin::PluginCommandState::new(Arc::new(
                commands::plugin::UnavailablePluginCommandService,
            )));
            app.manage(commands::legacy_reset::LegacyResetManager::open(
                app_data_root.join("reset-v1"),
            )?);
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
                let event_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let shutdown = app_handle.state::<commands::shutdown::ShutdownGate>();
                        if shutdown.is_exiting() {
                            return;
                        }
                        api.prevent_close();
                        match shutdown.begin_close_attempt() {
                            Ok(Some(attempt_id)) => {
                                if let Err(error) = event_window.emit(
                                    "shutdown-close-request",
                                    ShutdownCloseRequest { attempt_id },
                                ) {
                                    tracing::error!(
                                        "failed to emit shutdown close request: {error}"
                                    );
                                }
                            }
                            Ok(None) => {}
                            Err(error) => {
                                tracing::error!(
                                    code = ?error.code,
                                    "failed to create shutdown close attempt"
                                );
                            }
                        }
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
            commands::serial_drain::drain_serial_input,
            commands::legacy_backup::begin_legacy_backup,
            commands::legacy_backup::verify_legacy_backup,
            commands::legacy_reset::get_legacy_reset_journal,
            commands::legacy_reset::begin_legacy_discard,
            commands::legacy_reset::prepare_legacy_reset,
            commands::legacy_reset::complete_legacy_reset,
            commands::shutdown::submit_shutdown_report,
            commands::shutdown::confirm_exit,
            commands::shutdown::cancel_exit,
            secure_settings::clear_ai_api_key,
            secure_settings::get_ai_key_status,
            secure_settings::migrate_ai_api_key,
            secure_settings::set_ai_api_key,
            commands::window::get_ai_window_state,
            commands::window::hide_ai_window,
            commands::window::resize_ai_window,
            commands::window::show_ai_window,
            commands::window::start_ai_window_drag,
            commands::workspace::workspace_catalog,
            commands::workspace::create_workspace,
            commands::workspace::open_workspace,
            commands::workspace::apply_workspace_batch,
            commands::workspace::flush_workspace,
            commands::workspace::hydrate_workspace_sessions,
            commands::workspace::hydrate_workspace_frames,
            commands::workspace::hydrate_workspace_collections,
            commands::workspace::hydrate_workspace_ai_messages,
            commands::workspace::hydrate_workspace_waveform,
            commands::workspace::request_project_source_grant,
            commands::workspace::request_project_target_grant,
            commands::workspace::import_project,
            commands::workspace::export_project,
            commands::workspace::cancel_workspace_operation,
            commands::plugin::plugin_center_snapshot,
            commands::plugin::plugin_install,
            commands::plugin::plugin_set_enabled,
            commands::plugin::plugin_submit_authorization,
            commands::plugin::plugin_dismiss_authorization,
            commands::plugin::plugin_resolve_serial_proposal,
            commands::plugin::plugin_emit_panel_event,
            commands::plugin::plugin_cancel_operation,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!("error while running tauri application: {}", e);
        std::process::exit(1);
    }
}
