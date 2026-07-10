//! Backend-owned save dialogs and opaque file grants.
//!
//! The WebView never authorizes an arbitrary path by sending a string to a
//! write command. Instead Rust opens the native save dialog, stores the chosen
//! path in memory and returns an opaque token. Export grants are one-shot;
//! auto-log grants are reusable until revoked or expired.

use crate::export::ExportFormat;
use crate::models::errors::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_ACTIVE_GRANTS: usize = 32;
const MAX_TOKEN_BYTES: usize = 128;
const MAX_SUGGESTED_NAME_BYTES: usize = 128;
const GRANT_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const LOG_WRITE_SHARDS: usize = 16;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SaveTargetPurpose {
    ExportTxtHex,
    ExportTxtAscii,
    ExportCsv,
    ExportJsonl,
    ExportBin,
    AutoLog,
}

impl SaveTargetPurpose {
    fn extension(self) -> &'static str {
        match self {
            Self::ExportTxtHex | Self::ExportTxtAscii | Self::AutoLog => "txt",
            Self::ExportCsv => "csv",
            Self::ExportJsonl => "jsonl",
            Self::ExportBin => "bin",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::ExportTxtHex | Self::ExportTxtAscii | Self::AutoLog => "Text",
            Self::ExportCsv => "CSV",
            Self::ExportJsonl => "JSON Lines",
            Self::ExportBin => "Binary",
        }
    }

    fn export_format(self) -> Option<ExportFormat> {
        match self {
            Self::ExportTxtHex => Some(ExportFormat::TxtHex),
            Self::ExportTxtAscii => Some(ExportFormat::TxtAscii),
            Self::ExportCsv => Some(ExportFormat::Csv),
            Self::ExportJsonl => Some(ExportFormat::Jsonl),
            Self::ExportBin => Some(ExportFormat::Bin),
            Self::AutoLog => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSaveTargetRequest {
    purpose: SaveTargetPurpose,
    suggested_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTargetGrantResponse {
    token: String,
    display_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeFileGrantRequest {
    token: String,
}

pub struct FileGrantManager {
    grants: Mutex<HashMap<String, FileGrant>>,
    log_write_locks: [Arc<Mutex<()>>; LOG_WRITE_SHARDS],
    next_id: AtomicU64,
    ttl: Duration,
}

pub(crate) struct AuthorizedLogTarget {
    pub path: PathBuf,
    pub write_lock: Arc<Mutex<()>>,
}

struct FileGrant {
    path: PathBuf,
    purpose: SaveTargetPurpose,
    last_activity: Instant,
}

impl Default for FileGrantManager {
    fn default() -> Self {
        Self {
            grants: Mutex::new(HashMap::new()),
            log_write_locks: std::array::from_fn(|_| Arc::new(Mutex::new(()))),
            next_id: AtomicU64::new(0),
            ttl: GRANT_TTL,
        }
    }
}

impl FileGrantManager {
    pub(crate) async fn issue(
        &self,
        purpose: SaveTargetPurpose,
        path: PathBuf,
    ) -> Result<String, AppError> {
        validate_selected_path(&path, purpose)?;
        let mut grants = self.grants.lock().await;
        cleanup_expired_locked(&mut grants, self.ttl);
        if grants.len() >= MAX_ACTIVE_GRANTS {
            return Err(validation_error(
                "token",
                format!("too many active file grants (max {MAX_ACTIVE_GRANTS})"),
            ));
        }

        for _ in 0..4 {
            let token = self.new_token()?;
            if grants.contains_key(&token) {
                continue;
            }
            grants.insert(
                token.clone(),
                FileGrant {
                    path: path.clone(),
                    purpose,
                    last_activity: Instant::now(),
                },
            );
            return Ok(token);
        }
        Err(AppError::IoError {
            message: "failed to allocate a unique file grant".to_string(),
            kind: std::io::ErrorKind::Other,
        })
    }

    pub async fn consume_export(
        &self,
        token: &str,
        format: ExportFormat,
    ) -> Result<PathBuf, AppError> {
        validate_token(token)?;
        let mut grants = self.grants.lock().await;
        cleanup_expired_locked(&mut grants, self.ttl);
        let grant = grants
            .remove(token)
            .ok_or_else(|| validation_error("token", "unknown or expired file grant"))?;
        if grant.purpose.export_format() != Some(format) {
            return Err(validation_error(
                "token",
                "file grant does not match the requested export format",
            ));
        }
        Ok(grant.path)
    }

    pub(crate) async fn resolve_auto_log(
        &self,
        token: &str,
    ) -> Result<AuthorizedLogTarget, AppError> {
        validate_token(token)?;
        let mut grants = self.grants.lock().await;
        cleanup_expired_locked(&mut grants, self.ttl);
        let grant = grants
            .get_mut(token)
            .ok_or_else(|| validation_error("token", "unknown or expired file grant"))?;
        if grant.purpose != SaveTargetPurpose::AutoLog {
            return Err(validation_error(
                "token",
                "file grant is not valid for auto-log",
            ));
        }
        grant.last_activity = Instant::now();
        let path = grant.path.clone();
        drop(grants);
        let shard = log_write_shard(&path);
        Ok(AuthorizedLogTarget {
            path,
            write_lock: Arc::clone(&self.log_write_locks[shard]),
        })
    }

    pub async fn revoke(&self, token: &str) -> Result<(), AppError> {
        validate_token(token)?;
        self.grants.lock().await.remove(token);
        Ok(())
    }

    fn new_token(&self) -> Result<String, AppError> {
        let mut random = [0_u8; 24];
        getrandom::fill(&mut random).map_err(|error| AppError::IoError {
            message: format!("failed to obtain OS randomness: {error}"),
            kind: std::io::ErrorKind::Other,
        })?;
        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut token = String::with_capacity(64);
        for byte in random {
            use std::fmt::Write as _;
            write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
        }
        use std::fmt::Write as _;
        write!(&mut token, "-{sequence:x}").expect("writing to String cannot fail");
        Ok(token)
    }
}

fn log_write_shard(path: &Path) -> usize {
    let mut hasher = DefaultHasher::new();
    #[cfg(windows)]
    path.to_string_lossy().to_lowercase().hash(&mut hasher);
    #[cfg(not(windows))]
    path.hash(&mut hasher);
    (hasher.finish() as usize) % LOG_WRITE_SHARDS
}

#[tauri::command]
pub async fn request_save_target(
    window: WebviewWindow,
    manager: State<'_, FileGrantManager>,
    request: RequestSaveTargetRequest,
) -> Result<Option<SaveTargetGrantResponse>, AppError> {
    ensure_main_window(window.label())?;
    validate_suggested_name(&request.suggested_name, request.purpose)?;

    let selected = window
        .dialog()
        .file()
        .add_filter(
            request.purpose.filter_name(),
            &[request.purpose.extension()],
        )
        .set_file_name(&request.suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut path = selected.into_path().map_err(|_| {
        validation_error(
            "path",
            "the selected save target is not a local filesystem path",
        )
    })?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(str::is_empty)
    {
        path.set_extension(request.purpose.extension());
    }
    let token = manager.issue(request.purpose, path.clone()).await?;
    Ok(Some(SaveTargetGrantResponse {
        token,
        display_path: path.to_string_lossy().into_owned(),
    }))
}

#[tauri::command]
pub async fn revoke_file_grant(
    window: WebviewWindow,
    manager: State<'_, FileGrantManager>,
    request: RevokeFileGrantRequest,
) -> Result<(), AppError> {
    ensure_main_window(window.label())?;
    manager.revoke(&request.token).await
}

fn cleanup_expired_locked(grants: &mut HashMap<String, FileGrant>, ttl: Duration) {
    let now = Instant::now();
    grants.retain(|_, grant| now.saturating_duration_since(grant.last_activity) < ttl);
}

fn validate_suggested_name(
    suggested_name: &str,
    purpose: SaveTargetPurpose,
) -> Result<(), AppError> {
    if suggested_name.is_empty() || suggested_name.len() > MAX_SUGGESTED_NAME_BYTES {
        return Err(validation_error(
            "suggestedName",
            format!("suggested file name must be 1-{MAX_SUGGESTED_NAME_BYTES} bytes"),
        ));
    }
    if !suggested_name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(validation_error(
            "suggestedName",
            "suggested file name contains unsupported characters",
        ));
    }
    let extension = Path::new(suggested_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case(purpose.extension()) {
        return Err(validation_error(
            "suggestedName",
            format!("suggested file name must end in .{}", purpose.extension()),
        ));
    }
    Ok(())
}

fn validate_selected_path(path: &Path, purpose: SaveTargetPurpose) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(validation_error(
            "path",
            "selected save path must be absolute",
        ));
    }
    if path.is_dir() {
        return Err(validation_error(
            "path",
            "selected save path cannot be a directory",
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case(purpose.extension()) {
        return Err(validation_error(
            "path",
            format!("selected save path must end in .{}", purpose.extension()),
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.exists()
    {
        return Err(validation_error(
            "path",
            "selected save directory does not exist",
        ));
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), AppError> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Err(validation_error("token", "invalid file grant token"));
    }
    Ok(())
}

pub(crate) fn ensure_main_window(label: &str) -> Result<(), AppError> {
    if label != MAIN_WINDOW_LABEL {
        return Err(validation_error(
            "window",
            "this window is not allowed to request file access",
        ));
    }
    Ok(())
}

fn validation_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::ValidationError {
        message: message.into(),
        field: field.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TARGET_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_target(extension: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "bbcom-file-grant-{}-{}.{}",
            std::process::id(),
            TARGET_COUNTER.fetch_add(1, Ordering::Relaxed),
            extension
        ));
        path
    }

    #[tokio::test]
    async fn export_grants_are_one_shot_and_format_bound() {
        let manager = FileGrantManager::default();
        let token = manager
            .issue(SaveTargetPurpose::ExportCsv, temp_target("csv"))
            .await
            .unwrap();

        assert!(
            manager
                .consume_export(&token, ExportFormat::Jsonl)
                .await
                .is_err()
        );
        assert!(
            manager
                .consume_export(&token, ExportFormat::Csv)
                .await
                .is_err(),
            "a failed/mismatched attempt still burns the one-shot grant"
        );
    }

    #[tokio::test]
    async fn matching_export_grant_returns_the_path_exactly_once() {
        let manager = FileGrantManager::default();
        let path = temp_target("jsonl");
        let token = manager
            .issue(SaveTargetPurpose::ExportJsonl, path.clone())
            .await
            .unwrap();
        assert_eq!(
            manager
                .consume_export(&token, ExportFormat::Jsonl)
                .await
                .unwrap(),
            path
        );
        assert!(
            manager
                .consume_export(&token, ExportFormat::Jsonl)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn auto_log_grants_are_reusable_until_revoked() {
        let manager = FileGrantManager::default();
        let path = temp_target("txt");
        let token = manager
            .issue(SaveTargetPurpose::AutoLog, path.clone())
            .await
            .unwrap();
        assert_eq!(manager.resolve_auto_log(&token).await.unwrap().path, path);
        assert!(manager.resolve_auto_log(&token).await.is_ok());
        manager.revoke(&token).await.unwrap();
        assert!(manager.resolve_auto_log(&token).await.is_err());
    }

    #[tokio::test]
    async fn auto_log_grants_for_the_same_path_share_a_write_lock() {
        let manager = FileGrantManager::default();
        let path = temp_target("txt");
        let first = manager
            .issue(SaveTargetPurpose::AutoLog, path.clone())
            .await
            .unwrap();
        let second = manager
            .issue(SaveTargetPurpose::AutoLog, path)
            .await
            .unwrap();

        let first_target = manager.resolve_auto_log(&first).await.unwrap();
        let second_target = manager.resolve_auto_log(&second).await.unwrap();
        assert!(Arc::ptr_eq(
            &first_target.write_lock,
            &second_target.write_lock
        ));
    }

    #[tokio::test]
    async fn expired_grants_are_removed_before_capacity_checks() {
        let manager = FileGrantManager {
            ttl: Duration::ZERO,
            ..FileGrantManager::default()
        };
        for _ in 0..MAX_ACTIVE_GRANTS + 2 {
            manager
                .issue(SaveTargetPurpose::AutoLog, temp_target("txt"))
                .await
                .unwrap();
        }
        assert!(manager.grants.lock().await.len() <= 1);
    }

    #[test]
    fn suggested_names_and_calling_window_are_strictly_validated() {
        assert!(validate_suggested_name("capture.csv", SaveTargetPurpose::ExportCsv).is_ok());
        assert!(validate_suggested_name("../capture.csv", SaveTargetPurpose::ExportCsv).is_err());
        assert!(validate_suggested_name("capture.txt", SaveTargetPurpose::ExportCsv).is_err());
        assert!(ensure_main_window(MAIN_WINDOW_LABEL).is_ok());
        assert!(ensure_main_window("ai-assistant").is_err());
    }
}
