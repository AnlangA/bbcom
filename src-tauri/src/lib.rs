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
    let market_readiness_probe = match plugins::PluginMarketReadinessProbe::from_environment() {
        None => None,
        Some(Ok(probe)) => Some(probe),
        Some(Err(error)) => {
            eprintln!("plugin market-readiness probe failed: {error}");
            std::process::exit(2);
        }
    };
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
        .manage(commands::plugin::PluginLocalGrantState::default())
        .manage(commands::legacy_backup::LegacyBackupManager::default())
        .setup(move |app| {
            let app_data_root = match &market_readiness_probe {
                Some(probe) => {
                    probe.prepare_data_root().map_err(|error| {
                        std::io::Error::other(format!(
                            "plugin market-readiness probe failed: {error}"
                        ))
                    })?;
                    probe.data_root().to_path_buf()
                }
                None => app.path().app_data_dir()?,
            };
            let workspace_root = app_data_root.join("projects-v1");
            if market_readiness_probe.is_some() {
                app.manage(plugins::PluginRuntimeDataRoot(app_data_root.clone()));
            }
            app.manage(commands::workspace::WorkspaceManager::open(workspace_root)?);
            let plugin_sources = Arc::new(
                plugins::NativePluginSourceRegistry::open(
                    app_data_root.join("plugin-sources-v2.json"),
                )
                .map_err(|_| std::io::Error::other("plugin source registry unavailable"))?,
            );
            app.manage(Arc::clone(&plugin_sources));
            plugins::spawn_automatic_source_checks(plugin_sources);
            // Fail-closed default first: if production composition below
            // fails, every plugin command stays unavailable.
            app.manage(commands::plugin::PluginCommandState::new(Arc::new(
                commands::plugin::UnavailablePluginCommandService,
            )));
            plugins::install_managed_defaults(app.handle());
            // A missing active workspace (fresh install) composes later when
            // the first workspace is created or opened.
            plugins::ensure_plugin_runtime(app.handle());
            if let Some(probe) = &market_readiness_probe {
                probe.write_evidence(app.handle()).map_err(|error| {
                    std::io::Error::other(format!("plugin market-readiness probe failed: {error}"))
                })?;
                app.handle().exit(0);
                return Ok(());
            }
            plugins::spawn_dev_directory_watchers(app.handle().clone());
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
            // Matches the fixed content width of AiPanel/AiWindow.vue so the
            // first show never horizontally clips (resize clamps to 920 max).
            .inner_size(820.0, 170.0)
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
        .plugin(tauri_plugin_opener::init())
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
            commands::plugin::plugin_request_local_source_grant,
            commands::plugin::plugin_install,
            commands::plugin::plugin_set_enabled,
            commands::plugin::plugin_source_add,
            commands::plugin::plugin_source_update,
            commands::plugin::plugin_source_remove,
            commands::plugin::plugin_source_refresh,
            commands::plugin::plugin_set_watch_enabled,
            commands::plugin::plugin_resolve_serial_proposal,
            commands::plugin::plugin_emit_panel_event,
            commands::plugin::plugin_cancel_operation,
            commands::plugin::plugin_install_local,
            commands::plugin::plugin_uninstall,
            commands::plugin::plugin_serial_action_result,
            commands::plugin::plugin_session_query_result,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!("error while running tauri application: {}", e);
        std::process::exit(1);
    }
}
