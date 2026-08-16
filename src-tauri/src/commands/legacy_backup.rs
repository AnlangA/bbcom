//! Native boundary for the one-time encrypted 0.7.3 backup.
//!
//! File selection happens in the trusted main window. The renderer receives a
//! random `backup_id` grant, never a path, and verification resolves that grant
//! before reopening the final encrypted artifact from disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::utils::window::require_main_window_label;
use bbcom_contracts::{
    AppErrorCode, BeginLegacyBackupRequest, BeginLegacyBackupResponse, IpcError,
    VerifyLegacyBackupRequest, VerifyLegacyBackupResponse,
};
use bbcom_workspace::container::{
    AgeScryptPassphraseStreams, LegacyBackupFile, NeverCancel, ProjectContainerError,
    verify_encrypted_legacy_backup, write_encrypted_legacy_backup,
};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use zeroize::Zeroize;

const MAX_ACTIVE_BACKUP_GRANTS: usize = 8;
const BACKUP_GRANT_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_PASSPHRASE_CHARS: usize = 1_024;
const MIN_PASSPHRASE_CHARS: usize = 12;

#[derive(Debug, Default)]
pub struct LegacyBackupManager {
    grants: Mutex<HashMap<String, BackupGrant>>,
}

#[derive(Debug)]
struct BackupGrant {
    path: PathBuf,
    issued_at: Instant,
    state: BackupGrantState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackupGrantState {
    Reserved,
    Ready,
    Verified,
}

impl LegacyBackupManager {
    async fn reserve(&self, path: PathBuf, operation: &'static str) -> Result<String, IpcError> {
        let mut grants = self.grants.lock().await;
        cleanup_expired(&mut grants);
        if grants.len() >= MAX_ACTIVE_BACKUP_GRANTS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field("backupId")
            .with_size(MAX_ACTIVE_BACKUP_GRANTS, grants.len().saturating_add(1)));
        }

        for _ in 0..4 {
            let backup_id = random_opaque_id(operation)?;
            if grants.contains_key(&backup_id) {
                continue;
            }
            grants.insert(
                backup_id.clone(),
                BackupGrant {
                    path: path.clone(),
                    issued_at: Instant::now(),
                    state: BackupGrantState::Reserved,
                },
            );
            return Ok(backup_id);
        }
        Err(IpcError::new(
            AppErrorCode::Busy,
            "error.busy",
            true,
            operation,
        ))
    }

    async fn mark_ready(&self, backup_id: &str, operation: &'static str) -> Result<(), IpcError> {
        let mut grants = self.grants.lock().await;
        let grant = grants
            .get_mut(backup_id)
            .ok_or_else(|| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))?;
        grant.state = BackupGrantState::Ready;
        grant.issued_at = Instant::now();
        Ok(())
    }

    async fn revoke(&self, backup_id: &str) {
        self.grants.lock().await.remove(backup_id);
    }

    async fn resolve(&self, backup_id: &str, operation: &'static str) -> Result<PathBuf, IpcError> {
        validate_opaque_id(backup_id, "backupId", operation)?;
        let mut grants = self.grants.lock().await;
        cleanup_expired(&mut grants);
        let grant = grants
            .get_mut(backup_id)
            .filter(|grant| grant.state != BackupGrantState::Reserved)
            .ok_or_else(|| IpcError::invalid_input(operation, "backupId"))?;
        grant.issued_at = Instant::now();
        Ok(grant.path.clone())
    }

    async fn mark_verified(
        &self,
        backup_id: &str,
        operation: &'static str,
    ) -> Result<(), IpcError> {
        validate_opaque_id(backup_id, "backupId", operation)?;
        let mut grants = self.grants.lock().await;
        cleanup_expired(&mut grants);
        let grant = grants
            .get_mut(backup_id)
            .filter(|grant| grant.state == BackupGrantState::Ready)
            .ok_or_else(|| IpcError::invalid_input(operation, "backupId"))?;
        grant.state = BackupGrantState::Verified;
        grant.issued_at = Instant::now();
        Ok(())
    }

    /// Consume verified-backup authority exactly once. The reset journal owns
    /// all subsequent recovery; retaining the file grant would permit a
    /// second reset intent to reuse one verification.
    pub(crate) async fn consume_verified(
        &self,
        backup_id: &str,
        operation: &'static str,
    ) -> Result<(), IpcError> {
        validate_opaque_id(backup_id, "verifiedBackupId", operation)?;
        let mut grants = self.grants.lock().await;
        cleanup_expired(&mut grants);
        let _grant = grants
            .remove(backup_id)
            .filter(|grant| grant.state == BackupGrantState::Verified)
            .ok_or_else(|| IpcError::invalid_input(operation, "verifiedBackupId"))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn begin_legacy_backup(
    window: WebviewWindow,
    manager: State<'_, LegacyBackupManager>,
    request: BeginLegacyBackupRequest,
) -> Result<BeginLegacyBackupResponse, IpcError> {
    const OPERATION: &str = "begin_legacy_backup";
    require_main_window_label(window.label(), OPERATION)?;
    let BeginLegacyBackupRequest {
        request_id,
        suggested_name,
        mut passphrase,
        mut passphrase_confirmation,
        content,
    } = request;
    let validation = validate_opaque_id(&request_id, "requestId", OPERATION)
        .and_then(|()| validate_suggested_name(&suggested_name, OPERATION))
        .and_then(|()| validate_passphrase(&passphrase, OPERATION))
        .and_then(|()| validate_passphrase(&passphrase_confirmation, OPERATION));
    if let Err(error) = validation {
        passphrase.zeroize();
        passphrase_confirmation.zeroize();
        return Err(error);
    }
    if passphrase != passphrase_confirmation {
        passphrase.zeroize();
        passphrase_confirmation.zeroize();
        return Err(IpcError::invalid_input(OPERATION, "passphraseConfirmation"));
    }
    passphrase_confirmation.zeroize();
    let passphrase = AgeScryptPassphraseStreams::new(passphrase)
        .map_err(|error| map_container_error(error, OPERATION))?;

    // The native save dialog parks the calling thread until the user picks a
    // destination, so it must stay off the async executor.
    let dialog_result = tauri::async_runtime::spawn_blocking({
        let window = window.clone();
        let suggested_name = suggested_name.clone();
        move || -> Result<(PathBuf, String), IpcError> {
            let selected = window
                .dialog()
                .file()
                .add_filter("bbcom encrypted legacy backup", &["age"])
                .set_file_name(&suggested_name)
                .blocking_save_file()
                .ok_or_else(|| cancelled(OPERATION))?;
            let mut path = selected
                .into_path()
                .map_err(|_| IpcError::invalid_input(OPERATION, "destination"))?;
            if path.extension().is_none() {
                path.set_extension("age");
            }
            validate_target_path(&path, OPERATION)?;
            let display_name = display_name(&path, OPERATION)?;
            Ok((path, display_name))
        }
    })
    .await
    .map_err(|_| io_failure(OPERATION, true))??;
    let (path, display_name) = dialog_result;
    let backup_id = manager.reserve(path.clone(), OPERATION).await?;

    let destination = LegacyBackupFile::from_native_path(path);
    // The age scrypt encryption is CPU- and disk-bound; run it on the
    // blocking pool so the executor keeps serving IPC while it runs.
    let write_result = tauri::async_runtime::spawn_blocking(move || {
        write_encrypted_legacy_backup(&destination, &content, &passphrase, &NeverCancel)
    })
    .await;
    match write_result {
        Ok(Ok(_written_bytes)) => {}
        Ok(Err(error)) => {
            manager.revoke(&backup_id).await;
            return Err(map_container_error(error, OPERATION));
        }
        Err(_) => {
            manager.revoke(&backup_id).await;
            return Err(io_failure(OPERATION, true));
        }
    }
    if let Err(error) = manager.mark_ready(&backup_id, OPERATION).await {
        manager.revoke(&backup_id).await;
        return Err(error);
    }

    Ok(BeginLegacyBackupResponse {
        request_id,
        backup_id,
        display_name,
    })
}

#[tauri::command]
pub async fn verify_legacy_backup(
    window: WebviewWindow,
    manager: State<'_, LegacyBackupManager>,
    request: VerifyLegacyBackupRequest,
) -> Result<VerifyLegacyBackupResponse, IpcError> {
    const OPERATION: &str = "verify_legacy_backup";
    require_main_window_label(window.label(), OPERATION)?;
    let VerifyLegacyBackupRequest {
        request_id,
        backup_id,
        mut passphrase,
        expected_content,
    } = request;
    let validation = validate_opaque_id(&request_id, "requestId", OPERATION)
        .and_then(|()| validate_opaque_id(&backup_id, "backupId", OPERATION))
        .and_then(|()| validate_passphrase(&passphrase, OPERATION));
    if let Err(error) = validation {
        passphrase.zeroize();
        return Err(error);
    }
    let passphrase = AgeScryptPassphraseStreams::new(passphrase)
        .map_err(|error| map_container_error(error, OPERATION))?;
    let path = manager.resolve(&backup_id, OPERATION).await?;
    let source = LegacyBackupFile::from_native_path(path);
    let verified =
        verify_encrypted_legacy_backup(&source, &expected_content, &passphrase, &NeverCancel)
            .map_err(|error| map_container_error(error, OPERATION))?;
    if verified {
        manager.mark_verified(&backup_id, OPERATION).await?;
    }

    Ok(VerifyLegacyBackupResponse {
        request_id,
        backup_id,
        verified,
    })
}

fn cleanup_expired(grants: &mut HashMap<String, BackupGrant>) {
    grants.retain(|_, grant| grant.issued_at.elapsed() <= BACKUP_GRANT_TTL);
}

fn validate_passphrase(value: &str, operation: &'static str) -> Result<(), IpcError> {
    let chars = value.chars().count();
    if (MIN_PASSPHRASE_CHARS..=MAX_PASSPHRASE_CHARS).contains(&chars) {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, "passphrase"))
    }
}

fn validate_suggested_name(value: &str, operation: &'static str) -> Result<(), IpcError> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || !value.to_ascii_lowercase().ends_with(".age")
    {
        Err(IpcError::invalid_input(operation, "suggestedName"))
    } else {
        Ok(())
    }
}

fn validate_target_path(path: &Path, operation: &'static str) -> Result<(), IpcError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("age"))
        || path.parent().is_none_or(|parent| !parent.is_dir())
        || path.is_dir()
    {
        Err(IpcError::invalid_input(operation, "destination"))
    } else {
        Ok(())
    }
}

fn display_name(path: &Path, operation: &'static str) -> Result<String, IpcError> {
    let value = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| IpcError::invalid_input(operation, "displayName"))?;
    validate_suggested_name(value, operation)?;
    Ok(value.to_owned())
}

fn validate_opaque_id(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Err(IpcError::invalid_input(operation, field))
    } else {
        Ok(())
    }
}

fn random_opaque_id(operation: &'static str) -> Result<String, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation, true))?;
    let mut value = String::with_capacity(47);
    value.push_str("legacy-backup-");
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn map_container_error(error: ProjectContainerError, operation: &'static str) -> IpcError {
    match error {
        ProjectContainerError::InvalidInput { field } => IpcError::invalid_input(operation, field),
        ProjectContainerError::LimitExceeded {
            field,
            limit,
            actual,
        } => IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field(field)
        .with_size(
            usize::try_from(limit).unwrap_or(usize::MAX),
            usize::try_from(actual).unwrap_or(usize::MAX),
        ),
        ProjectContainerError::Cancelled { .. } => cancelled(operation),
        ProjectContainerError::Integrity | ProjectContainerError::AgeStream => IpcError::new(
            AppErrorCode::WorkspaceCorrupt,
            "error.workspace_corrupt",
            false,
            operation,
        ),
        ProjectContainerError::AgeIo(error) | ProjectContainerError::Io(error) => {
            io_error(error.kind(), operation)
        }
        ProjectContainerError::AlreadyExists | ProjectContainerError::Workspace(_) => {
            io_failure(operation, false)
        }
    }
}

fn io_error(kind: std::io::ErrorKind, operation: &'static str) -> IpcError {
    match kind {
        std::io::ErrorKind::PermissionDenied => IpcError::new(
            AppErrorCode::IoPermissionDenied,
            "error.io_permission_denied",
            false,
            operation,
        ),
        std::io::ErrorKind::StorageFull => IpcError::new(
            AppErrorCode::IoDiskFull,
            "error.io_disk_full",
            true,
            operation,
        ),
        _ => io_failure(operation, true),
    }
}

fn cancelled(operation: &'static str) -> IpcError {
    IpcError::new(AppErrorCode::Cancelled, "error.cancelled", false, operation)
}

fn io_failure(operation: &'static str, retryable: bool) -> IpcError {
    IpcError::new(
        AppErrorCode::WorkspaceCorrupt,
        "error.workspace_io_failed",
        retryable,
        operation,
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, io};

    use bbcom_workspace::WorkspaceError;

    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let suffix = random_opaque_id("test")
            .expect("test entropy")
            .replace("legacy-backup-", "");
        std::env::temp_dir().join(format!("bbcom-legacy-backup-{label}-{suffix}"))
    }

    #[tokio::test]
    async fn backup_grants_enforce_phase_single_use_capacity_and_expiry() {
        let root = temporary_root("grants");
        fs::create_dir_all(&root).expect("create root");
        let manager = LegacyBackupManager::default();
        let path = root.join("backup.age");

        let backup_id = manager
            .reserve(path.clone(), "test")
            .await
            .expect("reserve grant");
        assert!(manager.resolve(&backup_id, "test").await.is_err());
        assert!(manager.mark_verified(&backup_id, "test").await.is_err());
        manager
            .mark_ready(&backup_id, "test")
            .await
            .expect("mark ready");
        assert_eq!(
            manager.resolve(&backup_id, "test").await.expect("resolve"),
            path
        );
        manager
            .mark_verified(&backup_id, "test")
            .await
            .expect("mark verified");
        manager
            .consume_verified(&backup_id, "test")
            .await
            .expect("consume verified grant");
        assert!(manager.consume_verified(&backup_id, "test").await.is_err());
        assert!(manager.mark_ready("missing", "test").await.is_err());

        for index in 0..MAX_ACTIVE_BACKUP_GRANTS {
            manager
                .reserve(root.join(format!("backup-{index}.age")), "test")
                .await
                .expect("fill grant registry");
        }
        let limited = manager
            .reserve(root.join("overflow.age"), "test")
            .await
            .unwrap_err();
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!(limited.limit, Some(MAX_ACTIVE_BACKUP_GRANTS));
        manager
            .grants
            .lock()
            .await
            .values_mut()
            .next()
            .expect("stored grant")
            .issued_at = Instant::now()
            .checked_sub(BACKUP_GRANT_TTL + Duration::from_secs(1))
            .expect("past instant");
        let replacement = manager
            .reserve(root.join("replacement.age"), "test")
            .await
            .expect("expired grant frees capacity");
        manager.revoke(&replacement).await;

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn backup_validators_and_error_mapping_are_stable() {
        let root = temporary_root("validation");
        fs::create_dir_all(&root).expect("create root");
        let target = root.join("Backup.AGE");
        assert!(validate_target_path(&target, "test").is_ok());
        assert_eq!(display_name(&target, "test").unwrap(), "Backup.AGE");
        let directory = root.join("directory.age");
        fs::create_dir(&directory).expect("create directory");
        assert!(validate_target_path(&directory, "test").is_err());
        assert!(validate_target_path(&root.join("backup.zip"), "test").is_err());

        assert!(validate_passphrase(&"密".repeat(MIN_PASSPHRASE_CHARS), "test").is_ok());
        assert!(validate_passphrase(&"x".repeat(MIN_PASSPHRASE_CHARS - 1), "test").is_err());
        assert!(validate_passphrase(&"x".repeat(MAX_PASSPHRASE_CHARS + 1), "test").is_err());
        assert!(validate_suggested_name("Backup.AGE", "test").is_ok());
        for invalid in ["", "backup.zip", "nested/backup.age", "nested\\backup.age"] {
            assert!(validate_suggested_name(invalid, "test").is_err());
        }
        assert!(validate_opaque_id("backup.id_1:value-2", "backupId", "test").is_ok());
        assert!(validate_opaque_id("bad id", "backupId", "test").is_err());

        let limited = map_container_error(
            ProjectContainerError::LimitExceeded {
                field: "content",
                limit: 2,
                actual: 3,
            },
            "test",
        );
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!((limited.limit, limited.actual), (Some(2), Some(3)));
        assert_eq!(
            map_container_error(
                ProjectContainerError::Cancelled {
                    checkpoint:
                        bbcom_workspace::container::ContainerCheckpoint::LegacyBackupBeforeCommit,
                },
                "test"
            )
            .code,
            AppErrorCode::Cancelled
        );
        for error in [
            ProjectContainerError::Integrity,
            ProjectContainerError::AgeStream,
        ] {
            assert_eq!(
                map_container_error(error, "test").code,
                AppErrorCode::WorkspaceCorrupt
            );
        }
        assert_eq!(
            map_container_error(
                ProjectContainerError::AgeIo(io::Error::from(io::ErrorKind::PermissionDenied)),
                "test"
            )
            .code,
            AppErrorCode::IoPermissionDenied
        );
        assert_eq!(
            map_container_error(
                ProjectContainerError::Io(io::Error::from(io::ErrorKind::StorageFull)),
                "test"
            )
            .code,
            AppErrorCode::IoDiskFull
        );
        assert!(
            !map_container_error(
                ProjectContainerError::Workspace(WorkspaceError::ReadOnly),
                "test"
            )
            .retryable
        );
        assert_eq!(
            map_container_error(ProjectContainerError::AlreadyExists, "test").code,
            AppErrorCode::WorkspaceCorrupt
        );
        fs::remove_dir_all(root).expect("remove test root");
    }
}
