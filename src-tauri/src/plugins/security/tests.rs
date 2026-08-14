use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use bbcom_plugin_broker::{AuthorizationState, AuthorizationStore};
use bbcom_plugin_contracts::{AuthorizationKey, Permission};
use bbcom_plugin_manager::{ArtifactRevocationStore, PluginArtifact, PluginAuthorizationStore};

use super::store::{CredentialVault, NativePluginSecurityError, NativePluginSecurityStore};

#[derive(Default)]
struct MemoryVault(Mutex<BTreeMap<String, String>>);

impl CredentialVault for MemoryVault {
    fn load(&self, account: &str) -> Result<Option<String>, NativePluginSecurityError> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn save(&self, account: &str, value: &str) -> Result<(), NativePluginSecurityError> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    fn clear(&self, account: &str) -> Result<(), NativePluginSecurityError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

fn key() -> AuthorizationKey {
    AuthorizationKey {
        plugin_id: "dev.fixture".to_owned(),
        publisher_identity: format!("publisher:sha256-{}", "a1".repeat(32)),
        plugin_major: 1,
        workspace_id: "8e7b84cf-35f4-45cd-baf0-55d94ebf0213".to_owned(),
    }
}

fn store(root: &std::path::Path) -> NativePluginSecurityStore {
    NativePluginSecurityStore::open_with_vault(root, Arc::new(MemoryVault::default())).unwrap()
}

#[test]
fn grouped_authorization_decisions_are_exactly_scoped_and_per_request_grants_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    store
        .replace_states(
            &key(),
            &[(Permission::SessionCaptureRead, AuthorizationState::Granted)],
        )
        .unwrap();
    assert_eq!(
        store.state(&key(), Permission::SessionCaptureRead).unwrap(),
        AuthorizationState::Granted
    );
    let mut other_major = key();
    other_major.plugin_major = 2;
    assert_eq!(
        store
            .state(&other_major, Permission::SessionCaptureRead)
            .unwrap(),
        AuthorizationState::Missing
    );
    assert!(
        store
            .replace_states(
                &key(),
                &[(Permission::SerialWriteProposal, AuthorizationState::Granted,)],
            )
            .is_err()
    );
}

#[test]
fn permission_expansion_does_not_inherit_an_artifact_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let reviewed = BTreeSet::from([Permission::SessionMetadataRead]);
    let generation = store
        .replace_states(
            &key(),
            &[(Permission::SessionMetadataRead, AuthorizationState::Granted)],
        )
        .unwrap();
    store
        .record_reviewed_grant(&key(), "1.2.3", reviewed.clone(), 1, generation)
        .unwrap();
    assert_eq!(
        store
            .current_grant(&key(), "1.2.3")
            .unwrap()
            .unwrap()
            .reviewed_permissions,
        reviewed
    );
    assert!(store.current_grant(&key(), "1.2.4").unwrap().is_none());

    store
        .replace_states(
            &key(),
            &[(Permission::SessionMetadataRead, AuthorizationState::Granted)],
        )
        .unwrap();
    // A later decision transaction invalidates the old receipt even when the
    // effective choice is unchanged; generations cannot be rebound.
    assert!(store.current_grant(&key(), "1.2.3").unwrap().is_none());
}

#[test]
fn exact_artifact_revocation_round_trips() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(temp.path());
    let artifact = PluginArtifact::new(
        "dev.fixture",
        "1.2.3",
        format!("publisher:sha256-{}", "a1".repeat(32)),
        [Permission::UiPanel],
    )
    .unwrap();
    store.set_artifact_revoked(&artifact, true).unwrap();
    assert!(store.is_revoked(&artifact).unwrap());
    store.set_artifact_revoked(&artifact, false).unwrap();
    assert!(!store.is_revoked(&artifact).unwrap());
}
