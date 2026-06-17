//! Auto-updater command.
//!
//! Wraps `tauri-plugin-updater`'s check + download + install flow behind a
//! typed command so the frontend can trigger "check for updates" without
//! depending on the plugin's JS API directly. The actual update endpoint +
//! signing key are configured in `tauri.conf.json` (the `updater` key); without
//! those, `check` resolves to "no update available" (the plugin returns None).

use crate::models::errors::AppError;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// Check whether a newer version is available on the configured update endpoint.
/// Does NOT install — the frontend prompts the user first. Returns
/// `available: false` when no endpoint is configured or the version is current.
#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateInfo, AppError> {
    let updater = app.updater().map_err(|e| AppError::AiError {
        message: format!("updater init failed: {e}"),
    })?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            pub_date: update.date.map(|d| d.to_string()),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
            pub_date: None,
        }),
        Err(e) => {
            tracing::debug!("updater check failed: {e}");
            Ok(UpdateInfo {
                available: false,
                version: None,
                notes: None,
                pub_date: None,
            })
        }
    }
}

// Bring the UpdaterExt trait into scope so `app.updater()` resolves.
use tauri_plugin_updater::UpdaterExt;
