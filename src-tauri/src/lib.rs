pub mod ai_settings;
pub mod commands;
pub mod export;
pub mod models;
pub mod plugins;
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
        .manage(commands::ai::request_manager::AiRequestManager::default())
        .manage(commands::shutdown::ShutdownGate::default())
        .manage(commands::plugin::PluginLocalGrantState::default())
        .setup(move |app| {
            let app_data_root = app.path().app_data_dir()?;
            let workspace_root = app_data_root.join("projects-v1");
            app.manage(commands::workspace::WorkspaceManager::open(workspace_root)?);
            let plugin_sources = Arc::new(
                plugins::NativePluginSourceRegistry::open(
                    app_data_root.join("plugin-sources-v2.json"),
                )
                .map_err(|_| std::io::Error::other("plugin source registry unavailable"))?,
            );
            app.manage(Arc::clone(&plugin_sources));
            app.manage(Arc::new(plugins::PluginDetachedWindowServiceV2::default()));
            app.manage(Arc::new(plugins::PluginFileGrantService::default()));
            app.manage(Arc::new(
                plugins::SerialCapabilityCorrelationRegistryV2::default(),
            ));
            app.manage(Arc::new(plugins::PluginRuntimeProjectionV2::default()));
            app.manage(Arc::new(plugins::PluginHostContextStoreV2::default()));
            plugins::spawn_automatic_source_checks(plugin_sources);
            // Fail-closed default first: if production composition below
            // fails, every plugin command stays unavailable.
            app.manage(commands::plugin::PluginCommandState::new(Arc::new(
                commands::plugin::UnavailablePluginCommandService,
            )));
            app.manage(plugins::PluginUiActionStateV2::new(Arc::new(
                plugins::UnavailablePluginUiActionServiceV2,
            )));
            plugins::install_managed_defaults(app.handle());
            // Normal production composition is deferred until the main
            // window supplies its hydrated locale/theme/session projection.
            // This prevents enabled guests from ever initializing against
            // setup-time placeholder HostContext values.
            plugins::spawn_dev_directory_watchers(app.handle().clone());
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
            commands::shutdown::submit_shutdown_report,
            commands::shutdown::confirm_exit,
            commands::shutdown::cancel_exit,
            ai_settings::clear_ai_api_key,
            ai_settings::get_ai_key_status,
            ai_settings::set_ai_api_key,
            commands::window::get_ai_window_state,
            commands::window::hide_ai_window,
            commands::window::resize_ai_window,
            commands::window::show_ai_window,
            commands::window::start_ai_window_drag,
            commands::workspace::workspace_catalog,
            commands::workspace::create_workspace,
            commands::workspace::open_workspace,
            commands::workspace::delete_workspace,
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
            commands::plugin::plugin_emit_surface_event_v2,
            commands::plugin::plugin_cancel_task_v2,
            commands::plugin::plugin_run_command_v2,
            commands::plugin::plugin_set_surface_placement_v2,
            commands::plugin::plugin_detached_surface_snapshot_v2,
            commands::plugin::plugin_detached_emit_surface_event_v2,
            commands::plugin::plugin_detached_cancel_task_v2,
            commands::plugin::plugin_cancel_operation,
            commands::plugin::plugin_install_local,
            commands::plugin::plugin_uninstall,
            commands::plugin::plugin_serial_capability_reply_v2,
            commands::plugin::plugin_notify_port_catalog_changed_v2,
            commands::plugin::plugin_update_host_context_v2,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!("error while running tauri application: {}", e);
        std::process::exit(1);
    }
}
