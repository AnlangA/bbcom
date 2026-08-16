//! Crash-consistent native authority for the one-time 0.7.3 reset.
//!
//! The journal is written under app-data with private permissions and an
//! fsync-before-rename commit. Renderer localStorage is never consulted here.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bbcom_contracts::{
    AppErrorCode, BeginLegacyDiscardRequest, BeginLegacyDiscardResponse,
    CompleteLegacyResetRequest, CompleteLegacyResetResponse, GetLegacyResetJournalRequest,
    GetLegacyResetJournalResponse, IpcError, LegacyResetJournal, LegacyResetJournalPhase,
    PrepareLegacyResetRequest, PrepareLegacyResetResponse,
};
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::Mutex as AsyncMutex;

use crate::utils::window::require_main_window_label;

use super::legacy_backup::LegacyBackupManager;
use super::workspace::WorkspaceManager;

const JOURNAL_FORMAT: &str = "bbcom-native-reset-journal-v1";
const JOURNAL_FILE: &str = "journal.json";
const RESET_WORKSPACE_NAME: &str = "bbcom 0.7.3 reset";
const RESET_EXPECTED_REVISION: u64 = 0;
const DISCARD_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_DISCARD_TOKENS: usize = 4;

#[derive(Debug)]
pub struct LegacyResetManager {
    root: PathBuf,
    journal: Mutex<LegacyResetJournal>,
    discard_tokens: Mutex<HashMap<String, Instant>>,
    operation: AsyncMutex<()>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalFile {
    format: String,
    journal: LegacyResetJournal,
}

impl LegacyResetManager {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let root = root.as_ref().to_path_buf();
        create_private_directory(&root)?;
        let path = root.join(JOURNAL_FILE);
        let journal = if path.is_file() {
            read_journal(&path)?
        } else {
            let initial = required_journal();
            persist_journal(&root, &initial)?;
            initial
        };
        validate_journal(&journal)?;
        Ok(Self {
            root,
            journal: Mutex::new(journal),
            discard_tokens: Mutex::new(HashMap::new()),
            operation: AsyncMutex::new(()),
        })
    }

    fn snapshot(&self, operation: &'static str) -> Result<LegacyResetJournal, IpcError> {
        self.journal
            .lock()
            .map(|journal| journal.clone())
            .map_err(|_| busy(operation))
    }

    fn replace(
        &self,
        next: LegacyResetJournal,
        operation: &'static str,
    ) -> Result<LegacyResetJournal, IpcError> {
        validate_journal(&next).map_err(|error| io_error(error, operation))?;
        if let Err(error) = persist_journal(&self.root, &next) {
            // A directory fsync can report an error after rename committed.
            // Keep in-memory authority converged with an independently parsed
            // destination even while reporting the durability failure.
            if read_journal(&self.root.join(JOURNAL_FILE)).ok().as_ref() == Some(&next) {
                *self.journal.lock().map_err(|_| busy(operation))? = next;
            }
            return Err(io_error(error, operation));
        }
        *self.journal.lock().map_err(|_| busy(operation))? = next.clone();
        Ok(next)
    }

    fn issue_discard_token(&self, operation: &'static str) -> Result<String, IpcError> {
        let mut tokens = self.discard_tokens.lock().map_err(|_| busy(operation))?;
        tokens.retain(|_, issued| issued.elapsed() <= DISCARD_TOKEN_TTL);
        if tokens.len() >= MAX_DISCARD_TOKENS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field("discardToken")
            .with_size(MAX_DISCARD_TOKENS, tokens.len().saturating_add(1)));
        }
        for _ in 0..4 {
            let token = random_id("legacy-discard", operation)?;
            if tokens.insert(token.clone(), Instant::now()).is_none() {
                return Ok(token);
            }
        }
        Err(busy(operation))
    }

    fn consume_discard_token(&self, token: &str, operation: &'static str) -> Result<(), IpcError> {
        validate_opaque_id(token, "discardToken", operation)?;
        let mut tokens = self.discard_tokens.lock().map_err(|_| busy(operation))?;
        tokens.retain(|_, issued| issued.elapsed() <= DISCARD_TOKEN_TTL);
        tokens
            .remove(token)
            .ok_or_else(|| IpcError::invalid_input(operation, "discardToken"))?;
        Ok(())
    }

    fn clear_discard_tokens(&self, operation: &'static str) -> Result<(), IpcError> {
        self.discard_tokens
            .lock()
            .map_err(|_| busy(operation))?
            .clear();
        Ok(())
    }
}

#[tauri::command]
pub fn get_legacy_reset_journal(
    window: WebviewWindow,
    manager: State<'_, LegacyResetManager>,
    request: GetLegacyResetJournalRequest,
) -> Result<GetLegacyResetJournalResponse, IpcError> {
    const OPERATION: &str = "get_legacy_reset_journal";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    Ok(GetLegacyResetJournalResponse {
        request_id: request.request_id,
        journal: manager.snapshot(OPERATION)?,
    })
}

#[tauri::command]
pub async fn begin_legacy_discard(
    window: WebviewWindow,
    manager: State<'_, LegacyResetManager>,
    request: BeginLegacyDiscardRequest,
) -> Result<BeginLegacyDiscardResponse, IpcError> {
    const OPERATION: &str = "begin_legacy_discard";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let _operation = manager.operation.lock().await;
    if manager.snapshot(OPERATION)?.phase != LegacyResetJournalPhase::Required {
        return Err(IpcError::invalid_input(OPERATION, "phase"));
    }
    let confirmed = window
        .dialog()
        .message(
            "Continue without creating a legacy backup? The reset cannot be undone, although bbcom will not delete the old data.",
        )
        .title("Confirm legacy reset without backup")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Continue without backup".to_owned(),
            "Cancel".to_owned(),
        ))
        .blocking_show();
    if !confirmed {
        return Err(IpcError::new(
            AppErrorCode::Cancelled,
            "error.cancelled",
            false,
            OPERATION,
        ));
    }
    Ok(BeginLegacyDiscardResponse {
        request_id: request.request_id,
        discard_token: manager.issue_discard_token(OPERATION)?,
    })
}

#[tauri::command]
pub async fn prepare_legacy_reset(
    window: WebviewWindow,
    reset: State<'_, LegacyResetManager>,
    backups: State<'_, LegacyBackupManager>,
    workspaces: State<'_, WorkspaceManager>,
    request: PrepareLegacyResetRequest,
) -> Result<PrepareLegacyResetResponse, IpcError> {
    const OPERATION: &str = "prepare_legacy_reset";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let _operation = reset.operation.lock().await;
    let mut journal = reset.snapshot(OPERATION)?;

    match journal.phase {
        LegacyResetJournalPhase::Required => {
            match (
                &request.verified_backup_id,
                &request.discard_token,
                request.empty_legacy_state,
            ) {
                (Some(backup_id), None, None) => {
                    backups.consume_verified(backup_id, OPERATION).await?
                }
                (None, Some(token), None) => reset.consume_discard_token(token, OPERATION)?,
                (None, None, Some(true)) => {}
                _ => return Err(IpcError::invalid_input(OPERATION, "authorization")),
            }
            reset.clear_discard_tokens(OPERATION)?;
            journal = LegacyResetJournal {
                phase: LegacyResetJournalPhase::Intent,
                workspace_id: Some(random_workspace_id(OPERATION)?),
                expected_revision: Some(RESET_EXPECTED_REVISION),
            };
            // This is the durable commit point for reset authorization. No
            // project is touched before the intent reaches stable storage.
            journal = reset.replace(journal, OPERATION)?;
        }
        LegacyResetJournalPhase::Intent => {
            if request.verified_backup_id.is_some()
                || request.discard_token.is_some()
                || request.empty_legacy_state.is_some()
            {
                return Err(IpcError::invalid_input(OPERATION, "authorization"));
            }
        }
        LegacyResetJournalPhase::WorkspaceReady | LegacyResetJournalPhase::Completed => {
            if request.verified_backup_id.is_some()
                || request.discard_token.is_some()
                || request.empty_legacy_state.is_some()
            {
                return Err(IpcError::invalid_input(OPERATION, "authorization"));
            }
            return Ok(PrepareLegacyResetResponse {
                request_id: request.request_id,
                journal,
            });
        }
    }

    let (workspace_id, expected_revision) = journal_workspace(&journal, OPERATION)?;
    workspaces.ensure_empty_reset_workspace(
        workspace_id,
        RESET_WORKSPACE_NAME,
        expected_revision,
        current_time_millis(OPERATION)?,
        OPERATION,
    )?;
    let journal = reset.replace(
        LegacyResetJournal {
            phase: LegacyResetJournalPhase::WorkspaceReady,
            workspace_id: Some(workspace_id.to_owned()),
            expected_revision: Some(expected_revision),
        },
        OPERATION,
    )?;
    Ok(PrepareLegacyResetResponse {
        request_id: request.request_id,
        journal,
    })
}

#[tauri::command]
pub async fn complete_legacy_reset(
    window: WebviewWindow,
    reset: State<'_, LegacyResetManager>,
    workspaces: State<'_, WorkspaceManager>,
    request: CompleteLegacyResetRequest,
) -> Result<CompleteLegacyResetResponse, IpcError> {
    const OPERATION: &str = "complete_legacy_reset";
    require_main_window_label(window.label(), OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    validate_opaque_id(&request.workspace_id, "workspaceId", OPERATION)?;
    let _operation = reset.operation.lock().await;
    let journal = reset.snapshot(OPERATION)?;
    if !matches!(
        journal.phase,
        LegacyResetJournalPhase::WorkspaceReady | LegacyResetJournalPhase::Completed
    ) {
        return Err(IpcError::invalid_input(OPERATION, "phase"));
    }
    let (workspace_id, expected_revision) = journal_workspace(&journal, OPERATION)?;
    if request.workspace_id != workspace_id || request.expected_revision != expected_revision {
        return Err(IpcError::invalid_input(OPERATION, "workspaceId"));
    }
    workspaces.verify_empty_reset_workspace(
        workspace_id,
        RESET_WORKSPACE_NAME,
        expected_revision,
        OPERATION,
    )?;
    let journal = if journal.phase == LegacyResetJournalPhase::Completed {
        journal
    } else {
        reset.replace(
            LegacyResetJournal {
                phase: LegacyResetJournalPhase::Completed,
                workspace_id: Some(workspace_id.to_owned()),
                expected_revision: Some(expected_revision),
            },
            OPERATION,
        )?
    };
    Ok(CompleteLegacyResetResponse {
        request_id: request.request_id,
        journal,
    })
}

fn required_journal() -> LegacyResetJournal {
    LegacyResetJournal {
        phase: LegacyResetJournalPhase::Required,
        workspace_id: None,
        expected_revision: None,
    }
}

fn journal_workspace<'a>(
    journal: &'a LegacyResetJournal,
    operation: &'static str,
) -> Result<(&'a str, u64), IpcError> {
    let workspace_id = journal.workspace_id.as_deref().ok_or_else(|| {
        IpcError::new(
            AppErrorCode::WorkspaceCorrupt,
            "error.workspace_corrupt",
            false,
            operation,
        )
    })?;
    let revision = journal.expected_revision.ok_or_else(|| {
        IpcError::new(
            AppErrorCode::WorkspaceCorrupt,
            "error.workspace_corrupt",
            false,
            operation,
        )
    })?;
    Ok((workspace_id, revision))
}

fn validate_journal(journal: &LegacyResetJournal) -> Result<(), std::io::Error> {
    let valid = match journal.phase {
        LegacyResetJournalPhase::Required => {
            journal.workspace_id.is_none() && journal.expected_revision.is_none()
        }
        LegacyResetJournalPhase::Intent
        | LegacyResetJournalPhase::WorkspaceReady
        | LegacyResetJournalPhase::Completed => {
            journal
                .workspace_id
                .as_deref()
                .is_some_and(valid_workspace_id)
                && journal.expected_revision == Some(RESET_EXPECTED_REVISION)
        }
    };
    if valid {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid native reset journal",
        ))
    }
}

fn read_journal(path: &Path) -> Result<LegacyResetJournal, std::io::Error> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid native reset journal size",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    let stored: JournalFile = serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if stored.format != JOURNAL_FORMAT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsupported native reset journal",
        ));
    }
    validate_journal(&stored.journal)?;
    Ok(stored.journal)
}

fn persist_journal(root: &Path, journal: &LegacyResetJournal) -> Result<(), std::io::Error> {
    let bytes = serde_json::to_vec(&JournalFile {
        format: JOURNAL_FORMAT.to_owned(),
        journal: journal.clone(),
    })
    .map_err(std::io::Error::other)?;
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).map_err(std::io::Error::other)?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let staged = root.join(format!(".{JOURNAL_FILE}.{suffix}.part"));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staged)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        atomic_replace(&staged, &root.join(JOURNAL_FILE))?;
        sync_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

fn create_private_directory(path: &Path) -> Result<(), std::io::Error> {
    let existed = path.exists();
    fs::create_dir_all(path)?;
    if !path.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "native reset root is not a directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    sync_directory(path)?;
    // `fsync(reset-v1)` makes journal contents durable, but the directory's
    // own entry lives in its parent. On the first run, commit that entry before
    // the journal can authorize any reset so a power loss cannot resurrect a
    // fresh `required` journal with a different workspace identity.
    if !existed && let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn atomic_replace(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        }
        let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
        source_wide.push(0);
        let mut destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
        destination_wide.push(0);
        if unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

fn random_workspace_id(operation: &'static str) -> Result<String, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

fn random_id(prefix: &str, operation: &'static str) -> Result<String, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation))?;
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{prefix}-{suffix}"))
}

fn current_time_millis(operation: &'static str) -> Result<u64, IpcError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io_failure(operation))?
        .as_millis();
    u64::try_from(millis).map_err(|_| io_failure(operation))
}

fn valid_workspace_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
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

fn busy(operation: &'static str) -> IpcError {
    IpcError::new(AppErrorCode::Busy, "error.busy", true, operation)
}

fn io_failure(operation: &'static str) -> IpcError {
    IpcError::new(
        AppErrorCode::WorkspaceReadOnly,
        "error.workspace_read_only",
        true,
        operation,
    )
}

fn io_error(error: std::io::Error, operation: &'static str) -> IpcError {
    match error.kind() {
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
        std::io::ErrorKind::InvalidData => IpcError::new(
            AppErrorCode::WorkspaceCorrupt,
            "error.workspace_corrupt",
            false,
            operation,
        ),
        _ => io_failure(operation),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let mut bytes = [0_u8; 8];
        getrandom::fill(&mut bytes).expect("test entropy");
        let suffix = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        std::env::temp_dir().join(format!("bbcom-reset-{label}-{suffix}"))
    }

    #[test]
    fn durable_intent_round_trips_with_the_same_workspace_identity() {
        let root = temporary_root("round-trip");
        let manager = LegacyResetManager::open(&root).expect("open journal");
        assert_eq!(
            manager.snapshot("test").expect("initial journal"),
            required_journal()
        );
        let intent = LegacyResetJournal {
            phase: LegacyResetJournalPhase::Intent,
            workspace_id: Some("00000000-0000-4000-8000-000000000001".to_owned()),
            expected_revision: Some(0),
        };
        manager
            .replace(intent.clone(), "test")
            .expect("persist intent");
        drop(manager);
        let reopened = LegacyResetManager::open(&root).expect("reopen journal");
        assert_eq!(reopened.snapshot("test").expect("journal"), intent);
        fs::remove_dir_all(root).expect("remove test reset root");
    }

    #[test]
    fn discard_authority_is_single_use() {
        let root = temporary_root("discard");
        let manager = LegacyResetManager::open(&root).expect("open journal");
        let token = manager.issue_discard_token("test").expect("issue token");
        manager
            .consume_discard_token(&token, "test")
            .expect("consume token");
        assert!(manager.consume_discard_token(&token, "test").is_err());
        fs::remove_dir_all(root).expect("remove test reset root");
    }

    #[test]
    fn malformed_phase_coordinates_are_rejected() {
        let invalid = LegacyResetJournal {
            phase: LegacyResetJournalPhase::Required,
            workspace_id: Some("00000000-0000-4000-8000-000000000001".to_owned()),
            expected_revision: Some(0),
        };
        assert!(validate_journal(&invalid).is_err());
    }

    #[test]
    fn reset_journal_rejects_unsupported_oversized_and_incomplete_state() {
        let unsupported_root = temporary_root("unsupported-format");
        fs::create_dir_all(&unsupported_root).expect("create root");
        let unsupported = JournalFile {
            format: "future-format".to_owned(),
            journal: required_journal(),
        };
        fs::write(
            unsupported_root.join(JOURNAL_FILE),
            serde_json::to_vec(&unsupported).expect("serialize unsupported journal"),
        )
        .expect("write unsupported journal");
        assert_eq!(
            LegacyResetManager::open(&unsupported_root)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        fs::remove_dir_all(unsupported_root).expect("remove unsupported root");

        let oversized_root = temporary_root("oversized");
        fs::create_dir_all(&oversized_root).expect("create root");
        fs::write(oversized_root.join(JOURNAL_FILE), vec![b'x'; 16 * 1024 + 1])
            .expect("write oversized journal");
        assert_eq!(
            LegacyResetManager::open(&oversized_root)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        fs::remove_dir_all(oversized_root).expect("remove oversized root");

        for journal in [
            LegacyResetJournal {
                phase: LegacyResetJournalPhase::Intent,
                workspace_id: None,
                expected_revision: Some(0),
            },
            LegacyResetJournal {
                phase: LegacyResetJournalPhase::WorkspaceReady,
                workspace_id: Some("INVALID-UUID".to_owned()),
                expected_revision: Some(0),
            },
            LegacyResetJournal {
                phase: LegacyResetJournalPhase::Completed,
                workspace_id: Some("00000000-0000-4000-8000-000000000001".to_owned()),
                expected_revision: Some(1),
            },
        ] {
            assert!(validate_journal(&journal).is_err());
        }

        let incomplete = LegacyResetJournal {
            phase: LegacyResetJournalPhase::Intent,
            workspace_id: None,
            expected_revision: None,
        };
        assert_eq!(
            journal_workspace(&incomplete, "test").unwrap_err().code,
            AppErrorCode::WorkspaceCorrupt
        );
        let complete = LegacyResetJournal {
            phase: LegacyResetJournalPhase::Completed,
            workspace_id: Some("00000000-0000-4000-8000-000000000001".to_owned()),
            expected_revision: Some(0),
        };
        assert_eq!(
            journal_workspace(&complete, "test").unwrap(),
            ("00000000-0000-4000-8000-000000000001", 0)
        );
    }

    #[test]
    fn discard_token_registry_is_bounded_expires_and_clears_authority() {
        let root = temporary_root("discard-limits");
        let manager = LegacyResetManager::open(&root).expect("open journal");
        for _ in 0..MAX_DISCARD_TOKENS {
            manager.issue_discard_token("test").expect("issue token");
        }
        let limited = manager.issue_discard_token("test").unwrap_err();
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!(limited.limit, Some(MAX_DISCARD_TOKENS));

        manager
            .discard_tokens
            .lock()
            .expect("token lock")
            .values_mut()
            .next()
            .expect("stored token")
            .clone_from(
                &Instant::now()
                    .checked_sub(DISCARD_TOKEN_TTL + Duration::from_secs(1))
                    .expect("past instant"),
            );
        let replacement = manager
            .issue_discard_token("test")
            .expect("expired token frees capacity");
        assert!(replacement.starts_with("legacy-discard-"));
        assert_eq!(
            manager
                .consume_discard_token("bad token", "test")
                .unwrap_err()
                .field,
            Some("discardToken")
        );
        manager.clear_discard_tokens("test").expect("clear tokens");
        assert!(manager.discard_tokens.lock().unwrap().is_empty());
        fs::remove_dir_all(root).expect("remove test reset root");
    }

    #[test]
    fn reset_identifiers_and_io_errors_use_stable_public_shapes() {
        let workspace_id = random_workspace_id("test").expect("workspace id");
        assert!(valid_workspace_id(&workspace_id));
        assert!(!valid_workspace_id(
            "abcdefab-cdef-4abc-8abc-abcdefabcdef"
                .to_ascii_uppercase()
                .as_str()
        ));
        assert!(!valid_workspace_id("00000000-0000-4000-8000-00000000001"));
        let token = random_id("prefix", "test").expect("opaque id");
        assert!(token.starts_with("prefix-"));
        assert!(validate_opaque_id(&token, "token", "test").is_ok());
        assert!(validate_opaque_id("bad/token", "token", "test").is_err());
        assert!(current_time_millis("test").unwrap() > 0);

        for (kind, expected) in [
            (
                std::io::ErrorKind::PermissionDenied,
                AppErrorCode::IoPermissionDenied,
            ),
            (std::io::ErrorKind::StorageFull, AppErrorCode::IoDiskFull),
            (
                std::io::ErrorKind::InvalidData,
                AppErrorCode::WorkspaceCorrupt,
            ),
            (std::io::ErrorKind::Other, AppErrorCode::WorkspaceReadOnly),
        ] {
            assert_eq!(io_error(std::io::Error::from(kind), "test").code, expected);
        }
    }
}
