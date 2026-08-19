//! Secure AI-key configuration commands.
//!
//! The OS-keyring contract, the zeroizing session fallback and the legacy
//! plaintext-store migration live in [`credential_store`] and
//! [`legacy_migration`]; this module keeps the reviewed Tauri commands and the
//! core save/load/clear/migrate operations that sit on top of them.

mod credential_store;
mod legacy_migration;

pub use bbcom_contracts::{
    AiKeyDurability, AiKeyStatus, MigrateAiApiKeyRequest, SetAiApiKeyRequest,
};
pub use credential_store::SecureSettingsState;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State, WebviewWindow};
use zeroize::Zeroizing;

use crate::models::ipc_error::{AppErrorCode, IpcError};
use crate::utils::window::require_main_window_label;

use credential_store::{
    AI_API_KEY, CredentialStore, OsCredentialStore, clear_from, current_session_key, key_error,
    load_from, save_to, session_key_present, set_session_key, validate_secret_value,
};
use legacy_migration::{
    legacy_store_path_from_dir, read_legacy_store_value, remove_legacy_store_value,
};

fn validate_ai_key(value: &str, operation: &'static str) -> Result<(), IpcError> {
    validate_secret_value(value).map_err(|error| key_error(error, operation))
}

fn status_from_store<S: CredentialStore>(
    store: &S,
    state: &SecureSettingsState,
) -> Result<AiKeyStatus, IpcError> {
    // A session value represents the user's newest key when a durable update
    // failed. It must override an older credential that may still be readable
    // from the OS store for the rest of this process.
    if session_key_present(state)? {
        return Ok(AiKeyStatus::session());
    }
    match load_from(store, AI_API_KEY) {
        Ok(Some(_)) => Ok(AiKeyStatus::os()),
        Ok(None) | Err(credential_store::SecureSettingsError::StorageUnavailable) => {
            Ok(AiKeyStatus::missing())
        }
        Err(error) => Err(key_error(error, "get_ai_key_status")),
    }
}

fn load_ai_key_from_store<S: CredentialStore>(
    store: &S,
    state: &SecureSettingsState,
) -> Result<Zeroizing<String>, IpcError> {
    if let Some(value) = current_session_key(state)? {
        return Ok(value);
    }
    match load_from(store, AI_API_KEY) {
        Ok(Some(value)) => Ok(Zeroizing::new(value)),
        Ok(None) | Err(credential_store::SecureSettingsError::StorageUnavailable) => {
            Err(IpcError::new(
                AppErrorCode::SecurityDenied,
                "error.ai_key_missing",
                false,
                "run_ai_request",
            ))
        }
        Err(error) => Err(key_error(error, "run_ai_request")),
    }
}

fn save_ai_key_to_store<S: CredentialStore>(
    store: &S,
    state: &SecureSettingsState,
    value: String,
) -> Result<AiKeyStatus, IpcError> {
    validate_ai_key(&value, "set_ai_api_key")?;

    // A durable save counts only after an independent read-back matches. This
    // is intentionally not a generic get command and the retrieved value
    // never crosses a Tauri boundary.
    let durable = save_to(store, AI_API_KEY, &value)
        .and_then(|()| load_from(store, AI_API_KEY))
        .is_ok_and(|stored| stored.as_deref() == Some(value.as_str()));
    if durable {
        set_session_key(state, None)?;
        return Ok(AiKeyStatus::os());
    }

    set_session_key(state, Some(Zeroizing::new(value)))?;
    Ok(AiKeyStatus::session())
}

fn clear_ai_key_from_store<S: CredentialStore>(
    store: &S,
    state: &SecureSettingsState,
) -> Result<(), IpcError> {
    // Always clear the process-memory fallback before returning. If an OS
    // keyring delete fails, report it rather than pretending the durable key
    // was removed.
    set_session_key(state, None)?;
    clear_from(store, AI_API_KEY).map_err(|error| key_error(error, "clear_ai_api_key"))
}

fn storage_unavailable(operation: &'static str) -> IpcError {
    IpcError::new(
        AppErrorCode::IoPermissionDenied,
        "error.keyring_unavailable",
        true,
        operation,
    )
}

async fn run_store_operation<S, T, F>(
    state: SecureSettingsState,
    store: S,
    operation: &'static str,
    work: F,
) -> Result<T, IpcError>
where
    S: CredentialStore + Send + 'static,
    T: Send + 'static,
    F: FnOnce(&S, &SecureSettingsState) -> Result<T, IpcError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _guard = state
            .operation_lock
            .lock()
            .map_err(|_| storage_unavailable(operation))?;
        work(&store, &state)
    })
    .await
    .map_err(|_| storage_unavailable(operation))?
}

fn migrate_ai_key_from_store<S: CredentialStore>(
    store: &S,
    state: &SecureSettingsState,
    requested_value: Option<String>,
    legacy_path: Option<&Path>,
) -> Result<AiKeyStatus, IpcError> {
    let current = status_from_store(store, state)?;
    if current.configured {
        // A previous v0.5 OS-keyring write is already verified durable, so a
        // stale plaintext copy can be removed safely. A session-only key is
        // deliberately not sufficient authority to delete the legacy value.
        if current.durability == AiKeyDurability::Os
            && let Some(path) = legacy_path
        {
            remove_legacy_store_value(path);
        }
        return Ok(current);
    }
    let candidate = requested_value
        .filter(|value| !value.trim().is_empty())
        .or_else(|| legacy_path.and_then(read_legacy_store_value));
    let Some(candidate) = candidate else {
        return Ok(current);
    };
    let status = save_ai_key_to_store(store, state, candidate.trim().to_string())?;
    if status.durability == AiKeyDurability::Os
        && let Some(path) = legacy_path
    {
        remove_legacy_store_value(path);
    }
    Ok(status)
}

async fn get_ai_key_status_from_label<S>(
    label: &str,
    state: SecureSettingsState,
    store: S,
) -> Result<AiKeyStatus, IpcError>
where
    S: CredentialStore + Send + 'static,
{
    const OPERATION: &str = "get_ai_key_status";
    require_main_window_label(label, OPERATION)?;
    run_store_operation(state, store, OPERATION, status_from_store).await
}

async fn set_ai_api_key_from_label<S>(
    label: &str,
    state: SecureSettingsState,
    store: S,
    value: String,
) -> Result<AiKeyStatus, IpcError>
where
    S: CredentialStore + Send + 'static,
{
    const OPERATION: &str = "set_ai_api_key";
    require_main_window_label(label, OPERATION)?;
    run_store_operation(state, store, OPERATION, move |store, state| {
        save_ai_key_to_store(store, state, value)
    })
    .await
}

async fn migrate_ai_api_key_from_label<S>(
    label: &str,
    state: SecureSettingsState,
    store: S,
    requested_value: Option<String>,
    legacy_path: Option<PathBuf>,
) -> Result<AiKeyStatus, IpcError>
where
    S: CredentialStore + Send + 'static,
{
    const OPERATION: &str = "migrate_ai_api_key";
    require_main_window_label(label, OPERATION)?;
    run_store_operation(state, store, OPERATION, move |store, state| {
        migrate_ai_key_from_store(store, state, requested_value, legacy_path.as_deref())
    })
    .await
}

async fn clear_ai_api_key_from_label<S>(
    label: &str,
    state: SecureSettingsState,
    store: S,
) -> Result<(), IpcError>
where
    S: CredentialStore + Send + 'static,
{
    const OPERATION: &str = "clear_ai_api_key";
    require_main_window_label(label, OPERATION)?;
    run_store_operation(state, store, OPERATION, clear_ai_key_from_store).await
}

/// Report configuration state without exposing the API key itself.
#[tauri::command]
pub async fn get_ai_key_status(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
) -> Result<AiKeyStatus, IpcError> {
    get_ai_key_status_from_label(window.label(), state.inner().clone(), OsCredentialStore).await
}

/// Save a key to the OS keyring, falling back only to zeroizing process memory.
#[tauri::command]
pub async fn set_ai_api_key(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
    request: SetAiApiKeyRequest,
) -> Result<AiKeyStatus, IpcError> {
    set_ai_api_key_from_label(
        window.label(),
        state.inner().clone(),
        OsCredentialStore,
        request.value,
    )
    .await
}

/// Atomically migrate a legacy value only when no durable/session key exists.
/// The caller removes plaintext only after receiving OS durability.
#[tauri::command]
pub async fn migrate_ai_api_key(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
    request: MigrateAiApiKeyRequest,
) -> Result<AiKeyStatus, IpcError> {
    let legacy_path = legacy_store_path_from_dir(app.path().app_data_dir().ok());
    migrate_ai_api_key_from_label(
        window.label(),
        state.inner().clone(),
        OsCredentialStore,
        request.value,
        legacy_path,
    )
    .await
}

#[tauri::command]
pub async fn clear_ai_api_key(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
) -> Result<(), IpcError> {
    clear_ai_api_key_from_label(window.label(), state.inner().clone(), OsCredentialStore).await
}

/// Internal accessor for the AI command dispatcher. It shares the exact same
/// lock as configuration writes so an in-flight request sees a coherent key.
pub async fn load_ai_key_for_request(
    state: State<'_, SecureSettingsState>,
) -> Result<Zeroizing<String>, IpcError> {
    run_store_operation(
        state.inner().clone(),
        OsCredentialStore,
        "run_ai_request",
        load_ai_key_from_store,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ai::AI_WINDOW_LABEL;

    use super::credential_store::{
        MemoryCredentialStore, ReadbackMismatchStore, StaleCredentialStore,
    };
    use super::legacy_migration::{LEGACY_AI_API_KEY_FIELD, legacy_path};

    #[test]
    fn key_status_load_and_save_follow_the_os_session_missing_contract() {
        let state = SecureSettingsState::default();
        let store = MemoryCredentialStore::default();
        assert_eq!(
            status_from_store(&store, &state).unwrap(),
            AiKeyStatus::missing()
        );

        set_session_key(&state, Some(Zeroizing::new("session-key".to_string()))).unwrap();
        assert_eq!(
            status_from_store(&store, &state).unwrap(),
            AiKeyStatus::session()
        );
        assert_eq!(
            load_ai_key_from_store(&store, &state).unwrap().to_string(),
            "session-key"
        );

        *store.value.lock().unwrap() = Some("os-key".to_string());
        assert_eq!(
            status_from_store(&store, &state).unwrap(),
            AiKeyStatus::session()
        );
        assert_eq!(
            load_ai_key_from_store(&store, &state).unwrap().to_string(),
            "session-key"
        );

        set_session_key(&state, None).unwrap();
        assert_eq!(
            status_from_store(&store, &state).unwrap(),
            AiKeyStatus::os()
        );
        assert_eq!(
            load_ai_key_from_store(&store, &state).unwrap().to_string(),
            "os-key"
        );

        set_session_key(&state, Some(Zeroizing::new("session-key".to_string()))).unwrap();
        let unavailable = MemoryCredentialStore {
            fail: true,
            ..Default::default()
        };
        assert_eq!(
            status_from_store(&unavailable, &state).unwrap(),
            AiKeyStatus::session()
        );
        assert_eq!(
            load_ai_key_from_store(&unavailable, &state)
                .unwrap()
                .to_string(),
            "session-key"
        );

        set_session_key(&state, None).unwrap();
        assert_eq!(
            status_from_store(&unavailable, &state).unwrap(),
            AiKeyStatus::missing()
        );
        let missing = load_ai_key_from_store(&unavailable, &state).unwrap_err();
        assert_eq!(missing.code, AppErrorCode::SecurityDenied);
        assert_eq!(missing.operation, "run_ai_request");

        let invalid = MemoryCredentialStore::default();
        *invalid.value.lock().unwrap() = Some(String::new());
        assert_eq!(
            status_from_store(&invalid, &SecureSettingsState::default())
                .unwrap_err()
                .code,
            AppErrorCode::InvalidInput
        );
        assert_eq!(
            load_ai_key_from_store(&invalid, &SecureSettingsState::default())
                .unwrap_err()
                .code,
            AppErrorCode::InvalidInput
        );

        // Poisoning must collapse to a typed storage error and never expose
        // key material through the lock-failure path.
        let poisoned = SecureSettingsState::default();
        let lock = std::sync::Arc::clone(&poisoned.session_ai_key);
        let _ = std::thread::spawn(move || {
            let _guard = lock.lock().unwrap();
            panic!("intentional secure settings test poison");
        })
        .join();
        assert_eq!(
            session_key_present(&poisoned).unwrap_err().code,
            AppErrorCode::IoPermissionDenied
        );
        assert_eq!(
            set_session_key(&poisoned, None).unwrap_err().code,
            AppErrorCode::IoPermissionDenied
        );
        assert_eq!(
            current_session_key(&poisoned).unwrap_err().code,
            AppErrorCode::IoPermissionDenied
        );
    }

    #[test]
    fn durable_save_requires_readback_and_clear_never_keeps_session_fallback() {
        let state = SecureSettingsState::default();
        let durable = MemoryCredentialStore::default();
        let status = save_ai_key_to_store(&durable, &state, "durable-key".to_string()).unwrap();
        assert_eq!(status, AiKeyStatus::os());
        assert!(!session_key_present(&state).unwrap());

        let fallback = MemoryCredentialStore {
            fail: true,
            ..Default::default()
        };
        let status = save_ai_key_to_store(&fallback, &state, "session-key".to_string()).unwrap();
        assert_eq!(status, AiKeyStatus::session());
        assert_eq!(
            current_session_key(&state).unwrap().unwrap().to_string(),
            "session-key"
        );

        let mismatch_state = SecureSettingsState::default();
        let status = save_ai_key_to_store(
            &ReadbackMismatchStore,
            &mismatch_state,
            "readback-key".to_string(),
        )
        .unwrap();
        assert_eq!(status, AiKeyStatus::session());
        assert_eq!(
            current_session_key(&mismatch_state)
                .unwrap()
                .unwrap()
                .to_string(),
            "readback-key"
        );
        assert_eq!(
            load_ai_key_from_store(&ReadbackMismatchStore, &mismatch_state)
                .unwrap()
                .to_string(),
            "readback-key"
        );

        let stale_state = SecureSettingsState::default();
        let status = save_ai_key_to_store(
            &StaleCredentialStore,
            &stale_state,
            "new-session-key".to_string(),
        )
        .unwrap();
        assert_eq!(status, AiKeyStatus::session());
        assert_eq!(
            status_from_store(&StaleCredentialStore, &stale_state).unwrap(),
            AiKeyStatus::session()
        );
        assert_eq!(
            load_ai_key_from_store(&StaleCredentialStore, &stale_state)
                .unwrap()
                .to_string(),
            "new-session-key"
        );

        clear_ai_key_from_store(&durable, &state).unwrap();
        assert!(!session_key_present(&state).unwrap());
        set_session_key(&state, Some(Zeroizing::new("to-clear".to_string()))).unwrap();
        let error = clear_ai_key_from_store(&fallback, &state).unwrap_err();
        assert_eq!(error.code, AppErrorCode::IoPermissionDenied);
        assert!(!session_key_present(&state).unwrap());
    }

    #[test]
    fn migration_removes_plaintext_only_after_os_durability_is_verified() {
        let path = legacy_path("migrate");
        std::fs::write(&path, r#"{"ai-api-key":"legacy-key","other":"preserved"}"#).unwrap();

        let durable_store = MemoryCredentialStore::default();
        let durable_state = SecureSettingsState::default();
        let status = migrate_ai_key_from_store(
            &durable_store,
            &durable_state,
            Some("  requested-key  ".to_string()),
            Some(&path),
        )
        .unwrap();
        assert_eq!(status, AiKeyStatus::os());
        assert_eq!(
            durable_store.value.lock().unwrap().as_deref(),
            Some("requested-key")
        );
        let migrated: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(migrated.get(LEGACY_AI_API_KEY_FIELD).is_none());
        assert_eq!(migrated["other"], "preserved");

        // A durable key from an earlier v0.5 run must also clear the stale
        // legacy value. The migration must not overwrite that durable key.
        std::fs::write(&path, r#"{"ai-api-key":"stale-key","other":1}"#).unwrap();
        let status =
            migrate_ai_key_from_store(&durable_store, &durable_state, None, Some(&path)).unwrap();
        assert_eq!(status, AiKeyStatus::os());
        assert_eq!(
            durable_store.value.lock().unwrap().as_deref(),
            Some("requested-key")
        );
        let cleaned: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(cleaned.get(LEGACY_AI_API_KEY_FIELD).is_none());

        std::fs::write(&path, r#"{"ai-api-key":"must-remain"}"#).unwrap();
        let unavailable_store = MemoryCredentialStore {
            fail: true,
            ..Default::default()
        };
        let session_state = SecureSettingsState::default();
        let status =
            migrate_ai_key_from_store(&unavailable_store, &session_state, None, Some(&path))
                .unwrap();
        assert_eq!(status, AiKeyStatus::session());
        assert_eq!(
            read_legacy_store_value(&path).as_deref(),
            Some("must-remain")
        );

        let no_candidate = migrate_ai_key_from_store(
            &MemoryCredentialStore::default(),
            &SecureSettingsState::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(no_candidate, AiKeyStatus::missing());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn key_status_and_request_contracts_never_serialize_the_secret() {
        assert_eq!(
            serde_json::to_value(AiKeyStatus::os()).unwrap(),
            serde_json::json!({"configured":true,"durability":"os"})
        );
        assert_eq!(
            serde_json::to_value(AiKeyStatus::session()).unwrap(),
            serde_json::json!({"configured":true,"durability":"session"})
        );
        assert_eq!(
            serde_json::to_value(AiKeyStatus::missing()).unwrap(),
            serde_json::json!({"configured":false,"durability":"missing"})
        );
        let request: SetAiApiKeyRequest = serde_json::from_str(r#"{"value":"value"}"#).unwrap();
        assert_eq!(request.value, "value");
        let migration: MigrateAiApiKeyRequest = serde_json::from_str("{}").unwrap();
        assert!(migration.value.is_none());

        clear_from(&ReadbackMismatchStore, AI_API_KEY).unwrap();
    }

    #[test]
    fn window_labels_and_legacy_path_are_security_bounded() {
        assert!(require_main_window_label("main", "set_ai_api_key").is_ok());
        let denied = require_main_window_label(AI_WINDOW_LABEL, "set_ai_api_key").unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);
        assert!(require_main_window_label("main", "run_ai_request").is_ok());
        assert_eq!(
            require_main_window_label(AI_WINDOW_LABEL, "run_ai_request")
                .unwrap_err()
                .code,
            AppErrorCode::SecurityDenied
        );
        assert_eq!(
            require_main_window_label("untrusted", "run_ai_request")
                .unwrap_err()
                .code,
            AppErrorCode::SecurityDenied
        );
        assert_eq!(
            legacy_store_path_from_dir(Some(PathBuf::from("/tmp/bbcom"))),
            Some(PathBuf::from("/tmp/bbcom/secure-settings.json"))
        );
        assert_eq!(legacy_store_path_from_dir(None), None);
        assert_eq!(
            storage_unavailable("key-operation").code,
            AppErrorCode::IoPermissionDenied
        );
    }

    #[tokio::test]
    async fn store_operations_share_the_state_lock_and_map_storage_errors() {
        let state = SecureSettingsState::default();
        let status = run_store_operation(
            state.clone(),
            MemoryCredentialStore::default(),
            "set_ai_api_key",
            |store, state| save_ai_key_to_store(store, state, "background-key".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(status, AiKeyStatus::os());

        let error = run_store_operation(
            SecureSettingsState::default(),
            MemoryCredentialStore {
                fail: true,
                ..Default::default()
            },
            "run_ai_request",
            load_ai_key_from_store,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::SecurityDenied);
        assert_eq!(error.operation, "run_ai_request");
    }

    #[tokio::test]
    async fn key_command_cores_enforce_window_boundaries_and_preserve_durability_contracts() {
        let denied = get_ai_key_status_from_label(
            "untrusted-window",
            SecureSettingsState::default(),
            MemoryCredentialStore::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);

        let denied = get_ai_key_status_from_label(
            AI_WINDOW_LABEL,
            SecureSettingsState::default(),
            MemoryCredentialStore::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);

        assert_eq!(
            get_ai_key_status_from_label(
                "main",
                SecureSettingsState::default(),
                MemoryCredentialStore::default(),
            )
            .await
            .unwrap(),
            AiKeyStatus::missing()
        );

        let denied = set_ai_api_key_from_label(
            AI_WINDOW_LABEL,
            SecureSettingsState::default(),
            MemoryCredentialStore::default(),
            "must-not-write".to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);

        assert_eq!(
            set_ai_api_key_from_label(
                "main",
                SecureSettingsState::default(),
                MemoryCredentialStore::default(),
                "durable-key".to_string(),
            )
            .await
            .unwrap(),
            AiKeyStatus::os()
        );

        assert_eq!(
            migrate_ai_api_key_from_label(
                "main",
                SecureSettingsState::default(),
                MemoryCredentialStore::default(),
                Some(" requested-key ".to_string()),
                None,
            )
            .await
            .unwrap(),
            AiKeyStatus::os()
        );

        let session_state = SecureSettingsState::default();
        set_session_key(
            &session_state,
            Some(Zeroizing::new("session-key".to_string())),
        )
        .unwrap();
        clear_ai_api_key_from_label(
            "main",
            session_state.clone(),
            MemoryCredentialStore::default(),
        )
        .await
        .unwrap();
        assert!(!session_key_present(&session_state).unwrap());

        let denied = clear_ai_api_key_from_label(
            AI_WINDOW_LABEL,
            SecureSettingsState::default(),
            MemoryCredentialStore::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);
    }
}
