use std::sync::{Arc, Mutex as SyncMutex};

use keyring::v1::{Entry, Error as KeyringError};
use serde::Deserialize;
use tauri::{State, WebviewWindow};

use crate::commands::ai::AI_WINDOW_LABEL;

const CREDENTIAL_SERVICE: &str = "com.bbcom.app.secure-settings";
const AI_API_KEY: &str = "ai-api-key";
const MAX_SECRET_BYTES: usize = 4 * 1024;
const STORAGE_ERROR: &str = "secure credential storage unavailable";
const ACCESS_ERROR: &str = "secure credential storage access denied";
const VALUE_ERROR: &str = "secure credential value invalid";

#[derive(Clone, Default)]
pub struct SecureSettingsState(Arc<SyncMutex<()>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SecureSettingsError {
    AccessDenied,
    InvalidValue,
    StorageUnavailable,
}

trait CredentialStore {
    fn load(&self, key: &str) -> Result<Option<String>, SecureSettingsError>;
    fn save(&self, key: &str, value: &str) -> Result<(), SecureSettingsError>;
    fn clear(&self, key: &str) -> Result<(), SecureSettingsError>;
}

struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(key: &str) -> Result<Entry, SecureSettingsError> {
        Entry::new(CREDENTIAL_SERVICE, key).map_err(|_| SecureSettingsError::StorageUnavailable)
    }
}

impl CredentialStore for OsCredentialStore {
    fn load(&self, key: &str) -> Result<Option<String>, SecureSettingsError> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(SecureSettingsError::StorageUnavailable),
        }
    }

    fn save(&self, key: &str, value: &str) -> Result<(), SecureSettingsError> {
        Self::entry(key)?
            .set_password(value)
            .map_err(|_| SecureSettingsError::StorageUnavailable)
    }

    fn clear(&self, key: &str) -> Result<(), SecureSettingsError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(SecureSettingsError::StorageUnavailable),
        }
    }
}

fn ensure_allowed_key(key: &str) -> Result<(), SecureSettingsError> {
    if key == AI_API_KEY {
        Ok(())
    } else {
        Err(SecureSettingsError::AccessDenied)
    }
}

fn validate_secret_value(value: &str) -> Result<(), SecureSettingsError> {
    if value.is_empty() || value.len() > MAX_SECRET_BYTES {
        Err(SecureSettingsError::InvalidValue)
    } else {
        Ok(())
    }
}

fn load_from<S: CredentialStore>(
    store: &S,
    key: &str,
) -> Result<Option<String>, SecureSettingsError> {
    ensure_allowed_key(key)?;
    let value = store.load(key)?;
    if let Some(value) = value.as_deref() {
        validate_secret_value(value)?;
    }
    Ok(value)
}

fn save_to<S: CredentialStore>(
    store: &S,
    key: &str,
    value: &str,
) -> Result<(), SecureSettingsError> {
    ensure_allowed_key(key)?;
    validate_secret_value(value)?;
    store.save(key, value)
}

fn migrate_if_missing_from<S: CredentialStore>(
    store: &S,
    key: &str,
    value: &str,
) -> Result<String, SecureSettingsError> {
    ensure_allowed_key(key)?;
    validate_secret_value(value)?;

    if let Some(current_value) = store.load(key)? {
        validate_secret_value(&current_value)?;
        return Ok(current_value);
    }

    store.save(key, value)?;
    Ok(value.to_string())
}

fn clear_from<S: CredentialStore>(store: &S, key: &str) -> Result<(), SecureSettingsError> {
    ensure_allowed_key(key)?;
    store.clear(key)
}

fn ensure_allowed_window(label: &str) -> Result<(), String> {
    if label == "main" || label == AI_WINDOW_LABEL {
        Ok(())
    } else {
        Err(ACCESS_ERROR.to_string())
    }
}

fn command_error(error: SecureSettingsError) -> String {
    match error {
        SecureSettingsError::AccessDenied => ACCESS_ERROR,
        SecureSettingsError::InvalidValue => VALUE_ERROR,
        SecureSettingsError::StorageUnavailable => STORAGE_ERROR,
    }
    .to_string()
}

fn run_with_lock<T, F>(lock: Arc<SyncMutex<()>>, operation: F) -> Result<T, SecureSettingsError>
where
    F: FnOnce() -> Result<T, SecureSettingsError>,
{
    let _guard = lock
        .lock()
        .map_err(|_| SecureSettingsError::StorageUnavailable)?;
    operation()
}

async fn run_serialized<T, F>(
    state: State<'_, SecureSettingsState>,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&OsCredentialStore) -> Result<T, SecureSettingsError> + Send + 'static,
{
    // Native credential APIs can fail under concurrent access on Windows and
    // Linux. Move the lock into the blocking task so cancellation of this
    // future cannot release serialization while the native call still runs.
    let lock = Arc::clone(&state.0);
    tokio::task::spawn_blocking(move || run_with_lock(lock, || operation(&OsCredentialStore)))
        .await
        .map_err(|_| STORAGE_ERROR.to_string())?
        .map_err(command_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKeyRequest {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValueRequest {
    key: String,
    value: String,
}

#[tauri::command]
pub async fn secure_settings_load(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
    request: SecretKeyRequest,
) -> Result<Option<String>, String> {
    ensure_allowed_window(window.label())?;
    run_serialized(state, move |store| load_from(store, &request.key)).await
}

#[tauri::command]
pub async fn secure_settings_save(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
    request: SecretValueRequest,
) -> Result<(), String> {
    ensure_allowed_window(window.label())?;
    run_serialized(state, move |store| {
        save_to(store, &request.key, &request.value)
    })
    .await
}

#[tauri::command]
pub async fn secure_settings_migrate_if_missing(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
    request: SecretValueRequest,
) -> Result<String, String> {
    ensure_allowed_window(window.label())?;
    // The load and conditional save execute under the same process-wide lock,
    // so a normal save from another application window always wins the race.
    run_serialized(state, move |store| {
        migrate_if_missing_from(store, &request.key, &request.value)
    })
    .await
}

#[tauri::command]
pub async fn secure_settings_clear(
    window: WebviewWindow,
    state: State<'_, SecureSettingsState>,
    request: SecretKeyRequest,
) -> Result<(), String> {
    ensure_allowed_window(window.label())?;
    run_serialized(state, move |store| clear_from(store, &request.key)).await
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Mutex, mpsc},
        thread,
        time::Duration,
    };

    use super::*;

    #[derive(Default)]
    struct MemoryCredentialStore {
        value: Mutex<Option<String>>,
        operations: Mutex<Vec<&'static str>>,
        fail: bool,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn load(&self, _key: &str) -> Result<Option<String>, SecureSettingsError> {
            self.operations.lock().unwrap().push("load");
            if self.fail {
                return Err(SecureSettingsError::StorageUnavailable);
            }
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, _key: &str, value: &str) -> Result<(), SecureSettingsError> {
            self.operations.lock().unwrap().push("save");
            if self.fail {
                return Err(SecureSettingsError::StorageUnavailable);
            }
            *self.value.lock().unwrap() = Some(value.to_string());
            Ok(())
        }

        fn clear(&self, _key: &str) -> Result<(), SecureSettingsError> {
            self.operations.lock().unwrap().push("clear");
            if self.fail {
                return Err(SecureSettingsError::StorageUnavailable);
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn allowlisted_secret_round_trips_without_debugging_its_value() {
        let store = MemoryCredentialStore::default();
        save_to(&store, AI_API_KEY, "test-only-secret").unwrap();
        assert_eq!(
            load_from(&store, AI_API_KEY).unwrap().as_deref(),
            Some("test-only-secret")
        );
        clear_from(&store, AI_API_KEY).unwrap();
        assert_eq!(load_from(&store, AI_API_KEY).unwrap(), None);
        assert_eq!(
            *store.operations.lock().unwrap(),
            ["save", "load", "clear", "load"]
        );
    }

    #[test]
    fn unknown_keys_are_rejected_before_the_backend_is_touched() {
        let store = MemoryCredentialStore::default();
        assert_eq!(
            load_from(&store, "unexpected-key"),
            Err(SecureSettingsError::AccessDenied)
        );
        assert!(store.operations.lock().unwrap().is_empty());
    }

    #[test]
    fn migration_compare_and_set_preserves_normal_saves_in_either_order() {
        let store = MemoryCredentialStore::default();

        assert_eq!(
            migrate_if_missing_from(&store, AI_API_KEY, "legacy-first").unwrap(),
            "legacy-first"
        );
        save_to(&store, AI_API_KEY, "normal-new").unwrap();
        assert_eq!(
            migrate_if_missing_from(&store, AI_API_KEY, "legacy-late").unwrap(),
            "normal-new"
        );
        assert_eq!(
            load_from(&store, AI_API_KEY).unwrap().as_deref(),
            Some("normal-new")
        );
        assert_eq!(
            *store.operations.lock().unwrap(),
            ["load", "save", "save", "load", "load"]
        );
    }

    #[test]
    fn backend_failures_collapse_to_a_non_secret_error() {
        let store = MemoryCredentialStore {
            fail: true,
            ..Default::default()
        };
        let error = save_to(&store, AI_API_KEY, "must-not-leak").unwrap_err();
        assert_eq!(error, SecureSettingsError::StorageUnavailable);
        assert!(!format!("{error:?}").contains("must-not-leak"));
        assert_eq!(command_error(error), STORAGE_ERROR);
    }

    #[test]
    fn empty_and_oversized_values_are_rejected_before_backend_access() {
        let store = MemoryCredentialStore::default();
        assert_eq!(
            save_to(&store, AI_API_KEY, ""),
            Err(SecureSettingsError::InvalidValue)
        );
        let oversized = "x".repeat(MAX_SECRET_BYTES + 1);
        let error = save_to(&store, AI_API_KEY, &oversized).unwrap_err();
        assert_eq!(error, SecureSettingsError::InvalidValue);
        assert_eq!(command_error(error), VALUE_ERROR);
        assert!(!command_error(error).contains(&oversized));
        assert!(store.operations.lock().unwrap().is_empty());
    }

    #[test]
    fn invalid_existing_values_are_rejected_by_load_and_migration_without_leaking() {
        for invalid_value in [String::new(), "x".repeat(MAX_SECRET_BYTES + 1)] {
            let store = MemoryCredentialStore::default();
            *store.value.lock().unwrap() = Some(invalid_value.clone());

            assert_eq!(
                load_from(&store, AI_API_KEY),
                Err(SecureSettingsError::InvalidValue)
            );
            assert_eq!(
                migrate_if_missing_from(&store, AI_API_KEY, "safe-legacy"),
                Err(SecureSettingsError::InvalidValue)
            );
            assert_eq!(
                command_error(SecureSettingsError::InvalidValue),
                VALUE_ERROR
            );
            if !invalid_value.is_empty() {
                assert!(!command_error(SecureSettingsError::InvalidValue).contains(&invalid_value));
            }
        }
    }

    #[test]
    fn only_application_windows_can_request_credentials() {
        assert!(ensure_allowed_window("main").is_ok());
        assert!(ensure_allowed_window(AI_WINDOW_LABEL).is_ok());
        assert!(ensure_allowed_window("untrusted").is_err());
    }

    #[test]
    fn blocking_helper_holds_the_lock_for_the_entire_operation() {
        let lock = Arc::new(SyncMutex::new(()));
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first_lock = Arc::clone(&lock);
        let first = thread::spawn(move || {
            run_with_lock(first_lock, || {
                first_started_tx.send(()).unwrap();
                release_first_rx.recv().unwrap();
                Ok(())
            })
        });
        first_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (second_started_tx, second_started_rx) = mpsc::channel();
        let second_lock = Arc::clone(&lock);
        let second = thread::spawn(move || {
            run_with_lock(second_lock, || {
                second_started_tx.send(()).unwrap();
                Ok(())
            })
        });

        assert!(
            second_started_rx
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        release_first_tx.send(()).unwrap();
        second_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        assert_eq!(first.join().unwrap(), Ok(()));
        assert_eq!(second.join().unwrap(), Ok(()));
    }
}
