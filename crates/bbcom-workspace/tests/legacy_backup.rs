use std::fs;

use bbcom_contracts::{LegacyBackupContent, LegacyBackupFormat, LegacyBackupSourceVersion};
use bbcom_workspace::container::{
    AgeScryptPassphraseStreams, ContainerCheckpoint, LegacyBackupFile, NeverCancel,
    ProjectContainerError, verify_encrypted_legacy_backup, write_encrypted_legacy_backup,
};

fn content(created_at_ms: u64, label: &str) -> LegacyBackupContent {
    LegacyBackupContent {
        format: LegacyBackupFormat::V1,
        source_version: LegacyBackupSourceVersion::V0_7_3,
        created_at_ms,
        snapshot: serde_json::json!({
            "sessions": [{ "id": "session-1", "label": label, "bytes": [1, 2, 3] }]
        }),
        settings: serde_json::json!({ "app": { "theme": "dark" } }),
        presets: serde_json::json!({ "presets": [{ "name": "9600-8-N-1" }] }),
    }
}

#[test]
fn encrypted_legacy_backup_is_atomic_strict_and_verified_from_the_final_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("bbcom-0.7.3-backup.age");
    let file = LegacyBackupFile::from_native_path(&path);
    let passphrase =
        AgeScryptPassphraseStreams::new("correct horse battery staple".to_owned()).unwrap();
    let first = content(1_700_000_000_000, "first");
    let second = content(1_700_000_000_001, "second");

    let bytes = write_encrypted_legacy_backup(&file, &first, &passphrase, &NeverCancel).unwrap();
    assert!(bytes > 0);
    assert!(verify_encrypted_legacy_backup(&file, &first, &passphrase, &NeverCancel).unwrap());

    // Replacing the final artifact with another valid backup proves that the
    // verifier reopens disk instead of trusting the begin-operation buffer.
    write_encrypted_legacy_backup(&file, &second, &passphrase, &NeverCancel).unwrap();
    assert!(!verify_encrypted_legacy_backup(&file, &first, &passphrase, &NeverCancel).unwrap());
    assert!(verify_encrypted_legacy_backup(&file, &second, &passphrase, &NeverCancel).unwrap());

    let before_cancel = fs::read(&path).unwrap();
    let cancelled = write_encrypted_legacy_backup(&file, &first, &passphrase, &|checkpoint| {
        checkpoint == ContainerCheckpoint::LegacyBackupBeforeCommit
    })
    .unwrap_err();
    assert!(matches!(
        cancelled,
        ProjectContainerError::Cancelled {
            checkpoint: ContainerCheckpoint::LegacyBackupBeforeCommit
        }
    ));
    assert_eq!(fs::read(&path).unwrap(), before_cancel);
    assert!(verify_encrypted_legacy_backup(&file, &second, &passphrase, &NeverCancel).unwrap());

    let mut unsafe_content = first;
    unsafe_content.settings = serde_json::json!({ "apiKey": "must-not-enter-backup" });
    assert!(matches!(
        write_encrypted_legacy_backup(&file, &unsafe_content, &passphrase, &NeverCancel),
        Err(ProjectContainerError::InvalidInput {
            field: "content.settings"
        })
    ));
    assert_eq!(fs::read(&path).unwrap(), before_cancel);
}
