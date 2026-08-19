//! OS-keyring credential storage and the process-owned fallback slot.
//!
//! This module owns the on-device security contract: the allowlisted key
//! identity, the OS keyring backend, the zeroizing session-memory fallback
//! used only when the keyring is unavailable, and the typed non-secret error
//! every store failure collapses into. Secret values never leave this module
//! except through the reviewed accessors it exposes.

use std::sync::{Arc, Mutex as SyncMutex};

use keyring::v1::{Entry, Error as KeyringError};
use zeroize::Zeroizing;

use crate::models::ipc_error::{AppErrorCode, IpcError};

// The credential identity is part of the v0.5 on-device security contract.
// Keep the canonical key distinct from the legacy JSON field so a migration
// never changes the lookup name of an existing plaintext store.
const CREDENTIAL_SERVICE: &str = "com.bbcom.app";
pub(super) const AI_API_KEY: &str = "zhipu-api-key";
const MAX_SECRET_BYTES: usize = 4 * 1024;

/// Process-owned API-key state. A key is either in the OS keyring or, only
/// when the keyring is unavailable, in this zeroizing process-memory slot.
/// It is never returned to a webview after v0.5.
#[derive(Clone)]
pub struct SecureSettingsState {
    pub(super) operation_lock: Arc<SyncMutex<()>>,
    pub(super) session_ai_key: Arc<SyncMutex<Option<Zeroizing<String>>>>,
}

impl Default for SecureSettingsState {
    fn default() -> Self {
        Self {
            operation_lock: Arc::new(SyncMutex::new(())),
            session_ai_key: Arc::new(SyncMutex::new(None)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SecureSettingsError {
    AccessDenied,
    InvalidValue,
    StorageUnavailable,
}

pub(super) trait CredentialStore {
    fn load(&self, key: &str) -> Result<Option<String>, SecureSettingsError>;
    fn save(&self, key: &str, value: &str) -> Result<(), SecureSettingsError>;
    fn clear(&self, key: &str) -> Result<(), SecureSettingsError>;
}

pub(super) struct OsCredentialStore;

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

pub(super) fn ensure_allowed_key(key: &str) -> Result<(), SecureSettingsError> {
    if key == AI_API_KEY {
        Ok(())
    } else {
        Err(SecureSettingsError::AccessDenied)
    }
}

pub(super) fn validate_secret_value(value: &str) -> Result<(), SecureSettingsError> {
    if value.is_empty() || value.len() > MAX_SECRET_BYTES {
        Err(SecureSettingsError::InvalidValue)
    } else {
        Ok(())
    }
}

pub(super) fn load_from<S: CredentialStore>(
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

pub(super) fn save_to<S: CredentialStore>(
    store: &S,
    key: &str,
    value: &str,
) -> Result<(), SecureSettingsError> {
    ensure_allowed_key(key)?;
    validate_secret_value(value)?;
    store.save(key, value)
}

#[cfg(test)]
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

pub(super) fn clear_from<S: CredentialStore>(
    store: &S,
    key: &str,
) -> Result<(), SecureSettingsError> {
    ensure_allowed_key(key)?;
    store.clear(key)
}

pub(super) fn key_error(error: SecureSettingsError, operation: &'static str) -> IpcError {
    match error {
        SecureSettingsError::AccessDenied => IpcError::security_denied(operation),
        SecureSettingsError::InvalidValue => IpcError::invalid_input(operation, "value"),
        SecureSettingsError::StorageUnavailable => IpcError::new(
            AppErrorCode::IoPermissionDenied,
            "error.keyring_unavailable",
            true,
            operation,
        ),
    }
}

pub(super) fn session_key_present(state: &SecureSettingsState) -> Result<bool, IpcError> {
    state
        .session_ai_key
        .lock()
        .map(|key| key.is_some())
        .map_err(|_| {
            IpcError::new(
                AppErrorCode::IoPermissionDenied,
                "error.keyring_unavailable",
                true,
                "get_ai_key_status",
            )
        })
}

pub(super) fn set_session_key(
    state: &SecureSettingsState,
    value: Option<Zeroizing<String>>,
) -> Result<(), IpcError> {
    let mut key = state.session_ai_key.lock().map_err(|_| {
        IpcError::new(
            AppErrorCode::IoPermissionDenied,
            "error.keyring_unavailable",
            true,
            "set_ai_api_key",
        )
    })?;
    *key = value;
    Ok(())
}

pub(super) fn current_session_key(
    state: &SecureSettingsState,
) -> Result<Option<Zeroizing<String>>, IpcError> {
    state
        .session_ai_key
        .lock()
        .map(|key| key.as_ref().map(|value| Zeroizing::new(value.to_string())))
        .map_err(|_| {
            IpcError::new(
                AppErrorCode::IoPermissionDenied,
                "error.keyring_unavailable",
                true,
                "run_ai_request",
            )
        })
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct MemoryCredentialStore {
    pub(super) value: SyncMutex<Option<String>>,
    pub(super) operations: SyncMutex<Vec<&'static str>>,
    pub(super) fail: bool,
}

#[cfg(test)]
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

#[cfg(test)]
pub(super) struct ReadbackMismatchStore;

#[cfg(test)]
impl CredentialStore for ReadbackMismatchStore {
    fn load(&self, _key: &str) -> Result<Option<String>, SecureSettingsError> {
        Ok(Some("different-after-save".to_string()))
    }

    fn save(&self, _key: &str, _value: &str) -> Result<(), SecureSettingsError> {
        Ok(())
    }

    fn clear(&self, _key: &str) -> Result<(), SecureSettingsError> {
        Ok(())
    }
}

#[cfg(test)]
pub(super) struct StaleCredentialStore;

#[cfg(test)]
impl CredentialStore for StaleCredentialStore {
    fn load(&self, _key: &str) -> Result<Option<String>, SecureSettingsError> {
        Ok(Some("stale-os-key".to_string()))
    }

    fn save(&self, _key: &str, _value: &str) -> Result<(), SecureSettingsError> {
        Err(SecureSettingsError::StorageUnavailable)
    }

    fn clear(&self, _key: &str) -> Result<(), SecureSettingsError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlisted_secret_round_trips_without_debugging_its_value() {
        // Entry construction verifies the production keyring identity without
        // reading a real credential, which can block on OS authorization UI.
        assert!(OsCredentialStore::entry(AI_API_KEY).is_ok());
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
        assert_eq!(
            key_error(error, "set_ai_api_key").code,
            AppErrorCode::IoPermissionDenied
        );
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
        assert_eq!(
            key_error(error, "set_ai_api_key").code,
            AppErrorCode::InvalidInput
        );
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
                key_error(SecureSettingsError::InvalidValue, "set_ai_api_key").code,
                AppErrorCode::InvalidInput
            );
        }
    }
}
