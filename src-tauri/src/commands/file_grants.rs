//! Backend-owned save dialogs and opaque file grants.
//!
//! The WebView never authorizes an arbitrary path by sending a string to a
//! write command. Instead Rust opens the native save dialog, stores the chosen
//! path in memory and returns an opaque token. Export grants are one-shot;
//! auto-log grants are reusable until revoked or expired.

use crate::export::ExportFormat;
use crate::models::errors::AppError;
use crate::models::ipc_error::{IpcError, from_app_error};
pub use bbcom_contracts::{
    RequestSaveTargetRequest, RevokeFileGrantRequest, SaveTargetGrantResponse, SaveTargetPurpose,
};
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_ACTIVE_GRANTS: usize = 32;
const MAX_SUGGESTED_NAME_BYTES: usize = 128;
const EXPORT_GRANT_TTL: Duration = Duration::from_secs(10 * 60);
const AUTO_LOG_GRANT_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const LOG_WRITE_SHARDS: usize = 16;

pub struct FileGrantManager {
    grants: Mutex<HashMap<String, FileGrant>>,
    log_write_locks: [Arc<Mutex<()>>; LOG_WRITE_SHARDS],
    export_ttl: Duration,
    auto_log_ttl: Duration,
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
            export_ttl: EXPORT_GRANT_TTL,
            auto_log_ttl: AUTO_LOG_GRANT_TTL,
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
        cleanup_expired_locked(&mut grants, self.export_ttl, self.auto_log_ttl);
        if grants.len() >= MAX_ACTIVE_GRANTS {
            return Err(limit_error(
                "token",
                MAX_ACTIVE_GRANTS,
                grants.len().saturating_add(1),
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
        ensure_grant_not_expired_locked(&mut grants, token, self.export_ttl, self.auto_log_ttl)?;
        cleanup_expired_locked(&mut grants, self.export_ttl, self.auto_log_ttl);
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

    /// Consume an auto-log grant when ownership moves into a backend log
    /// session. The WebView never needs to send the grant again after begin.
    pub(crate) async fn consume_auto_log(
        &self,
        token: &str,
    ) -> Result<AuthorizedLogTarget, AppError> {
        validate_token(token)?;
        let mut grants = self.grants.lock().await;
        ensure_grant_not_expired_locked(&mut grants, token, self.export_ttl, self.auto_log_ttl)?;
        cleanup_expired_locked(&mut grants, self.export_ttl, self.auto_log_ttl);
        let grant = grants
            .remove(token)
            .ok_or_else(|| validation_error("token", "unknown or expired file grant"))?;
        if grant.purpose != SaveTargetPurpose::AutoLog {
            return Err(validation_error(
                "token",
                "file grant is not valid for auto-log",
            ));
        }
        let shard = log_write_shard(&grant.path);
        Ok(AuthorizedLogTarget {
            path: grant.path,
            write_lock: Arc::clone(&self.log_write_locks[shard]),
        })
    }

    pub async fn revoke(&self, token: &str) -> Result<(), AppError> {
        validate_token(token)?;
        self.grants.lock().await.remove(token);
        Ok(())
    }

    fn new_token(&self) -> Result<String, AppError> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|error| AppError::IoError {
            message: format!("failed to obtain OS randomness: {error}"),
            kind: std::io::ErrorKind::Other,
        })?;
        let mut token = String::with_capacity(32);
        for byte in random {
            use std::fmt::Write as _;
            write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
        }
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
) -> Result<Option<SaveTargetGrantResponse>, IpcError> {
    const OPERATION: &str = "request_save_target";
    ensure_main_window(window.label()).map_err(|error| from_app_error(&error, OPERATION))?;
    validate_suggested_name(&request.suggested_name, request.purpose)
        .map_err(|error| from_app_error(&error, OPERATION))?;

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
    let path = selected
        .into_path()
        .map_err(|_| IpcError::invalid_input(OPERATION, "path"))?;
    let (path, display_name) = normalize_selected_path(path, request.purpose)
        .map_err(|error| from_app_error(&error, OPERATION))?;
    let token = manager
        .issue(request.purpose, path)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))?;
    Ok(Some(SaveTargetGrantResponse {
        token,
        display_name,
    }))
}

async fn revoke_file_grant_from_label(
    label: &str,
    manager: &FileGrantManager,
    request: RevokeFileGrantRequest,
) -> Result<(), IpcError> {
    const OPERATION: &str = "revoke_file_grant";
    ensure_main_window(label).map_err(|error| from_app_error(&error, OPERATION))?;
    manager
        .revoke(&request.token)
        .await
        .map_err(|error| from_app_error(&error, OPERATION))
}

#[tauri::command]
pub async fn revoke_file_grant(
    window: WebviewWindow,
    manager: State<'_, FileGrantManager>,
    request: RevokeFileGrantRequest,
) -> Result<(), IpcError> {
    revoke_file_grant_from_label(window.label(), manager.inner(), request).await
}

fn cleanup_expired_locked(
    grants: &mut HashMap<String, FileGrant>,
    export_ttl: Duration,
    auto_log_ttl: Duration,
) {
    let now = Instant::now();
    grants.retain(|_, grant| {
        let ttl = if grant.purpose == SaveTargetPurpose::AutoLog {
            auto_log_ttl
        } else {
            export_ttl
        };
        now.saturating_duration_since(grant.last_activity) < ttl
    });
}

fn ensure_grant_not_expired_locked(
    grants: &mut HashMap<String, FileGrant>,
    token: &str,
    export_ttl: Duration,
    auto_log_ttl: Duration,
) -> Result<(), AppError> {
    let Some(grant) = grants.get(token) else {
        return Ok(());
    };
    let ttl = if grant.purpose == SaveTargetPurpose::AutoLog {
        auto_log_ttl
    } else {
        export_ttl
    };
    let age = Instant::now().saturating_duration_since(grant.last_activity);
    if age < ttl {
        return Ok(());
    }
    grants.remove(token);
    Err(limit_error(
        "token",
        duration_millis(ttl),
        duration_millis(age),
    ))
}

fn duration_millis(duration: Duration) -> usize {
    usize::try_from(duration.as_millis()).unwrap_or(usize::MAX)
}

fn validate_suggested_name(
    suggested_name: &str,
    purpose: SaveTargetPurpose,
) -> Result<(), AppError> {
    if suggested_name.is_empty() {
        return Err(validation_error(
            "suggestedName",
            format!("suggested file name must be 1-{MAX_SUGGESTED_NAME_BYTES} bytes"),
        ));
    }
    if suggested_name.len() > MAX_SUGGESTED_NAME_BYTES {
        return Err(limit_error(
            "suggestedName",
            MAX_SUGGESTED_NAME_BYTES,
            suggested_name.len(),
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

/// Normalize the one path returned by the native dialog. This remains behind
/// the dialog boundary: callers only receive an opaque grant token, never the
/// normalized absolute path.
fn normalize_selected_path(
    mut path: PathBuf,
    purpose: SaveTargetPurpose,
) -> Result<(PathBuf, String), AppError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(str::is_empty)
    {
        path.set_extension(purpose.extension());
    }
    validate_selected_path(&path, purpose)?;
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| validation_error("path", "selected save path must have a file name"))?;
    Ok((path, display_name))
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
    if token.len() != 32
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
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

fn limit_error(field: &str, limit: usize, actual: usize) -> AppError {
    AppError::LimitError {
        message: format!("{field} exceeds its limit"),
        field: field.to_string(),
        limit,
        actual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

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
    async fn revoked_auto_log_grant_cannot_begin_a_session() {
        let manager = FileGrantManager::default();
        let path = temp_target("txt");
        let token = manager
            .issue(SaveTargetPurpose::AutoLog, path.clone())
            .await
            .unwrap();
        manager.revoke(&token).await.unwrap();
        assert!(manager.consume_auto_log(&token).await.is_err());
    }

    #[tokio::test]
    async fn revoke_command_core_requires_main_window_and_consumes_the_grant() {
        let manager = FileGrantManager::default();
        let token = manager
            .issue(SaveTargetPurpose::AutoLog, temp_target("txt"))
            .await
            .unwrap();
        let denied = revoke_file_grant_from_label(
            "ai-assistant",
            &manager,
            RevokeFileGrantRequest {
                token: token.clone(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            denied.code,
            crate::models::ipc_error::AppErrorCode::SecurityDenied
        );
        revoke_file_grant_from_label("main", &manager, RevokeFileGrantRequest { token })
            .await
            .unwrap();
        assert!(manager.grants.lock().await.is_empty());
        assert!(
            revoke_file_grant_from_label(
                "main",
                &manager,
                RevokeFileGrantRequest {
                    token: "invalid".to_string()
                }
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn auto_log_grant_moves_exactly_once_into_a_backend_session() {
        let manager = FileGrantManager::default();
        let path = temp_target("txt");
        let token = manager
            .issue(SaveTargetPurpose::AutoLog, path.clone())
            .await
            .unwrap();

        assert_eq!(manager.consume_auto_log(&token).await.unwrap().path, path);
        assert!(manager.consume_auto_log(&token).await.is_err());
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

        let first_target = manager.consume_auto_log(&first).await.unwrap();
        let second_target = manager.consume_auto_log(&second).await.unwrap();
        assert!(Arc::ptr_eq(
            &first_target.write_lock,
            &second_target.write_lock
        ));
    }

    #[tokio::test]
    async fn expired_grants_are_removed_before_capacity_checks() {
        let manager = FileGrantManager {
            export_ttl: Duration::ZERO,
            auto_log_ttl: Duration::ZERO,
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

    #[tokio::test]
    async fn active_grant_limit_reports_limit_and_actual() {
        let manager = FileGrantManager::default();
        for _ in 0..MAX_ACTIVE_GRANTS {
            manager
                .issue(SaveTargetPurpose::AutoLog, temp_target("txt"))
                .await
                .unwrap();
        }
        let error = manager
            .issue(SaveTargetPurpose::AutoLog, temp_target("txt"))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::LimitError {
                field,
                limit: MAX_ACTIVE_GRANTS,
                actual,
                ..
            } if field == "token" && actual == MAX_ACTIVE_GRANTS + 1
        ));
    }

    #[test]
    fn suggested_names_and_calling_window_are_strictly_validated() {
        assert!(validate_suggested_name("capture.csv", SaveTargetPurpose::ExportCsv).is_ok());
        assert!(validate_suggested_name("../capture.csv", SaveTargetPurpose::ExportCsv).is_err());
        assert!(validate_suggested_name("capture.txt", SaveTargetPurpose::ExportCsv).is_err());
        assert!(matches!(
            validate_suggested_name(
                &format!("{}.csv", "a".repeat(MAX_SUGGESTED_NAME_BYTES)),
                SaveTargetPurpose::ExportCsv,
            ),
            Err(AppError::LimitError {
                limit: MAX_SUGGESTED_NAME_BYTES,
                ..
            })
        ));
        assert!(ensure_main_window(MAIN_WINDOW_LABEL).is_ok());
        assert!(ensure_main_window("ai-assistant").is_err());
    }

    #[test]
    fn grant_tokens_are_exactly_128_bit_lowercase_hex() {
        let manager = FileGrantManager::default();
        for _ in 0..32 {
            let token = manager.new_token().unwrap();
            assert_eq!(token.len(), 32);
            assert!(validate_token(&token).is_ok());
        }
        for invalid in [
            "",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcdeg",
        ] {
            assert!(validate_token(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn save_target_response_exposes_only_a_display_name() {
        let value = serde_json::to_value(SaveTargetGrantResponse {
            token: "0123456789abcdef0123456789abcdef".to_string(),
            display_name: "capture.csv".to_string(),
        })
        .unwrap();
        assert_eq!(value["displayName"], "capture.csv");
        assert!(value.get("displayPath").is_none());
        assert_eq!(value.as_object().unwrap().len(), 2);
    }

    #[test]
    fn save_target_purposes_have_only_the_fixed_extensions_and_formats() {
        let cases = [
            (
                SaveTargetPurpose::ExportTxtHex,
                "txt",
                "Text",
                Some(ExportFormat::TxtHex),
            ),
            (
                SaveTargetPurpose::ExportTxtAscii,
                "txt",
                "Text",
                Some(ExportFormat::TxtAscii),
            ),
            (
                SaveTargetPurpose::ExportCsv,
                "csv",
                "CSV",
                Some(ExportFormat::Csv),
            ),
            (
                SaveTargetPurpose::ExportJsonl,
                "jsonl",
                "JSON Lines",
                Some(ExportFormat::Jsonl),
            ),
            (
                SaveTargetPurpose::ExportBin,
                "bin",
                "Binary",
                Some(ExportFormat::Bin),
            ),
            (SaveTargetPurpose::AutoLog, "txt", "Text", None),
        ];
        for (purpose, extension, name, format) in cases {
            assert_eq!(purpose.extension(), extension);
            assert_eq!(purpose.filter_name(), name);
            assert_eq!(purpose.export_format(), format);
        }
    }

    #[test]
    fn selected_paths_are_normalized_only_after_native_selection() {
        let directory = std::env::temp_dir();
        let (path, display_name) = normalize_selected_path(
            directory.join("bbcom-normalized-save-target"),
            SaveTargetPurpose::ExportCsv,
        )
        .unwrap();
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("csv")
        );
        assert_eq!(display_name, "bbcom-normalized-save-target.csv");

        let upper_case = directory.join("bbcom-normalized-save-target.CSV");
        assert!(normalize_selected_path(upper_case, SaveTargetPurpose::ExportCsv).is_ok());
        assert!(
            normalize_selected_path(
                directory.join("bbcom-normalized-save-target.txt"),
                SaveTargetPurpose::ExportCsv,
            )
            .is_err()
        );
    }

    #[test]
    fn selected_paths_reject_relative_directories_and_missing_parents() {
        assert!(
            validate_selected_path(Path::new("capture.csv"), SaveTargetPurpose::ExportCsv).is_err()
        );
        assert!(
            validate_selected_path(&std::env::temp_dir(), SaveTargetPurpose::ExportCsv).is_err()
        );
        let missing = std::env::temp_dir()
            .join("bbcom-file-grant-missing-parent")
            .join("capture.csv");
        assert!(validate_selected_path(&missing, SaveTargetPurpose::ExportCsv).is_err());
    }

    #[test]
    fn cleanup_and_expiry_use_the_purpose_specific_ttl() {
        let now = Instant::now();
        let mut grants = HashMap::from([
            (
                "a".repeat(32),
                FileGrant {
                    path: temp_target("csv"),
                    purpose: SaveTargetPurpose::ExportCsv,
                    last_activity: now - Duration::from_secs(2),
                },
            ),
            (
                "b".repeat(32),
                FileGrant {
                    path: temp_target("txt"),
                    purpose: SaveTargetPurpose::AutoLog,
                    last_activity: now - Duration::from_secs(2),
                },
            ),
        ]);
        cleanup_expired_locked(&mut grants, Duration::from_secs(1), Duration::from_secs(3));
        assert!(!grants.contains_key(&"a".repeat(32)));
        assert!(grants.contains_key(&"b".repeat(32)));

        let token = "b".repeat(32);
        let error = ensure_grant_not_expired_locked(
            &mut grants,
            &token,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .unwrap_err();
        assert!(matches!(error, AppError::LimitError { field, limit: 0, .. } if field == "token"));
        assert!(!grants.contains_key(&token));
        assert!(
            ensure_grant_not_expired_locked(
                &mut grants,
                "c0000000000000000000000000000000",
                Duration::ZERO,
                Duration::ZERO,
            )
            .is_ok()
        );
    }

    #[test]
    fn duration_conversion_and_name_validation_cover_boundary_inputs() {
        assert_eq!(duration_millis(Duration::from_millis(123)), 123);
        assert_eq!(duration_millis(Duration::MAX), usize::MAX);
        assert!(validate_suggested_name("CAPTURE.CSV", SaveTargetPurpose::ExportCsv).is_ok());
        assert!(validate_suggested_name("", SaveTargetPurpose::ExportCsv).is_err());
        assert!(validate_suggested_name("capture csv", SaveTargetPurpose::ExportCsv).is_err());
    }

    #[tokio::test]
    async fn invalid_or_wrong_purpose_grants_never_authorize_a_write() {
        let manager = FileGrantManager::default();
        assert!(manager.revoke("invalid").await.is_err());
        assert!(
            manager
                .issue(SaveTargetPurpose::ExportCsv, PathBuf::from("relative.csv"))
                .await
                .is_err()
        );

        let export = manager
            .issue(SaveTargetPurpose::ExportCsv, temp_target("csv"))
            .await
            .unwrap();
        assert!(manager.consume_auto_log(&export).await.is_err());
        assert!(
            manager
                .consume_export(&export, ExportFormat::Csv)
                .await
                .is_err()
        );

        let log = manager
            .issue(SaveTargetPurpose::AutoLog, temp_target("txt"))
            .await
            .unwrap();
        assert!(
            manager
                .consume_export(&log, ExportFormat::TxtHex)
                .await
                .is_err()
        );
        assert!(manager.consume_auto_log(&log).await.is_err());
    }

    #[tokio::test]
    async fn export_and_auto_log_grants_use_distinct_ttls() {
        let manager = FileGrantManager {
            export_ttl: Duration::ZERO,
            auto_log_ttl: Duration::from_secs(60),
            ..FileGrantManager::default()
        };
        let auto_log = manager
            .issue(SaveTargetPurpose::AutoLog, temp_target("txt"))
            .await
            .unwrap();
        // Issue the zero-TTL grant last: issuing another grant performs an
        // eager cleanup, so this keeps the assertion focused on the TTL
        // chosen for the export grant rather than the cleanup path.
        let export = manager
            .issue(SaveTargetPurpose::ExportCsv, temp_target("csv"))
            .await
            .unwrap();

        let expired = manager
            .consume_export(&export, ExportFormat::Csv)
            .await
            .unwrap_err();
        assert!(matches!(
            expired,
            AppError::LimitError {
                field,
                limit: 0,
                ..
            } if field == "token"
        ));
        assert!(manager.consume_auto_log(&auto_log).await.is_ok());
    }
}
