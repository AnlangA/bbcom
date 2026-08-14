use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use bbcom_contracts::MAX_WORKSPACE_DATABASE_BYTES;
use bbcom_workspace::container::{
    AGE_CRATE_VERSION_REQUIRED, AGE_SCRYPT_ENVELOPE, AgeScryptPassphraseStreams, CancellationCheck,
    ContainerCheckpoint, ManagedProjectFileName, NativeProjectDestination, NativeProjectSource,
    NeverCancel, ProjectContainerError, ProjectLibrary, WorkspaceUuid,
};
use bbcom_workspace::{CreateWorkspaceRequest, WORKSPACE_SCHEMA_VERSION, WorkspaceService};
use rusqlite::Connection;
use tempfile::TempDir;

const WORKSPACE_ID: &str = "8e7b84cf-35f4-45cd-baf0-55d94ebf0213";
const SECOND_WORKSPACE_ID: &str = "65981dbf-942d-4cc8-a351-22060936e92d";

fn id(value: &str) -> WorkspaceUuid {
    WorkspaceUuid::parse(value).unwrap()
}

fn source_project(parent: &Path, workspace_id: &str, name: &str) -> PathBuf {
    let path = parent.join(format!("{name}.bbcom"));
    let service = WorkspaceService::create(
        &path,
        CreateWorkspaceRequest {
            workspace_id: workspace_id.to_owned(),
            name: name.to_owned(),
            created_at_ms: 1,
        },
    )
    .unwrap();
    drop(service);
    path
}

fn library(temp: &TempDir) -> ProjectLibrary {
    ProjectLibrary::open(temp.path().join("managed")).unwrap()
}

fn staging_files(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with(".bbcom-") && value.ends_with(".part"))
        })
        .collect()
}

#[test]
fn managed_identifiers_are_canonical_and_cannot_traverse() {
    let workspace_id = id(WORKSPACE_ID);
    assert_eq!(workspace_id.as_str(), WORKSPACE_ID);
    assert_eq!(workspace_id.to_string(), WORKSPACE_ID);
    assert!(WorkspaceUuid::parse("../../outside").is_err());
    assert!(WorkspaceUuid::parse("8E7B84CF-35F4-45CD-BAF0-55D94EBF0213").is_err());
    assert!(WorkspaceUuid::parse("00000000-0000-0000-0000-000000000000").is_err());

    let file_name = ManagedProjectFileName::for_workspace(&workspace_id);
    assert_eq!(file_name.as_str(), format!("{WORKSPACE_ID}.bbcom"));
    assert_eq!(file_name.workspace_id().unwrap(), workspace_id);
    assert_eq!(
        ManagedProjectFileName::parse(file_name.as_str()).unwrap(),
        file_name
    );
    for invalid in [
        "../8e7b84cf-35f4-45cd-baf0-55d94ebf0213.bbcom",
        "8e7b84cf-35f4-45cd-baf0-55d94ebf0213.db",
        "/tmp/project.bbcom",
    ] {
        assert!(ManagedProjectFileName::parse(invalid).is_err());
    }
}

#[cfg(unix)]
#[test]
fn import_copies_to_private_staging_and_commits_only_after_validation() {
    use std::os::unix::fs::PermissionsExt;

    struct StagingPermissions<'a> {
        root: &'a Path,
    }
    impl CancellationCheck for StagingPermissions<'_> {
        fn is_cancelled(&self, checkpoint: ContainerCheckpoint) -> bool {
            if checkpoint == ContainerCheckpoint::ImportBeforeValidation {
                let staging = staging_files(self.root);
                assert_eq!(staging.len(), 1);
                assert_eq!(
                    fs::metadata(&staging[0]).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            false
        }
    }

    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let source = source_project(&external, WORKSPACE_ID, "source");
    let managed_root = temp.path().join("managed");
    let library = ProjectLibrary::open(&managed_root).unwrap();

    let imported = library
        .import_plaintext(
            &NativeProjectSource::from_native_path(source),
            &StagingPermissions {
                root: &managed_root,
            },
        )
        .unwrap();
    assert_eq!(imported.workspace_id, id(WORKSPACE_ID));
    assert_eq!(imported.header.name, "source");
    assert!(library.contains(&id(WORKSPACE_ID)));
    assert!(staging_files(&managed_root).is_empty());
    assert_eq!(
        library
            .open_project(&id(WORKSPACE_ID))
            .unwrap()
            .header()
            .unwrap(),
        imported.header
    );
}

#[test]
fn import_cancellation_at_every_checkpoint_leaves_no_target_or_staging() {
    for checkpoint in [
        ContainerCheckpoint::ImportBeforeOpen,
        ContainerCheckpoint::ImportCopy,
        ContainerCheckpoint::ImportBeforeValidation,
        ContainerCheckpoint::ImportBeforeCommit,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        let source = source_project(&external, WORKSPACE_ID, "source");
        let managed_root = temp.path().join("managed");
        let library = ProjectLibrary::open(&managed_root).unwrap();

        let error = library
            .import_plaintext(&NativeProjectSource::from_native_path(source), &|seen| {
                seen == checkpoint
            })
            .unwrap_err();
        assert!(matches!(
            error,
            ProjectContainerError::Cancelled { checkpoint: actual } if actual == checkpoint
        ));
        assert!(!library.contains(&id(WORKSPACE_ID)));
        assert!(staging_files(&managed_root).is_empty());
    }
}

#[test]
fn import_rejects_future_schema_integrity_failure_and_oversize_without_commit() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let managed_root = temp.path().join("managed");
    let library = ProjectLibrary::open(&managed_root).unwrap();

    let future = source_project(&external, WORKSPACE_ID, "future");
    let connection = Connection::open(&future).unwrap();
    connection
        .pragma_update(None, "user_version", WORKSPACE_SCHEMA_VERSION + 1)
        .unwrap();
    drop(connection);
    assert!(matches!(
        library
            .import_plaintext(&NativeProjectSource::from_native_path(future), &NeverCancel)
            .unwrap_err(),
        ProjectContainerError::Workspace(_)
    ));

    let corrupt = external.join("corrupt.bbcom");
    fs::write(&corrupt, b"not a sqlite project").unwrap();
    assert!(matches!(
        library
            .import_plaintext(
                &NativeProjectSource::from_native_path(corrupt),
                &NeverCancel
            )
            .unwrap_err(),
        ProjectContainerError::Workspace(_)
    ));

    let oversized = external.join("oversized.bbcom");
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&oversized)
        .unwrap();
    file.set_len(MAX_WORKSPACE_DATABASE_BYTES as u64 + 1)
        .unwrap();
    drop(file);
    assert!(matches!(
        library
            .import_plaintext(
                &NativeProjectSource::from_native_path(oversized),
                &NeverCancel
            )
            .unwrap_err(),
        ProjectContainerError::LimitExceeded {
            field: "externalFileBytes",
            ..
        }
    ));

    assert!(!library.contains(&id(WORKSPACE_ID)));
    assert!(staging_files(&managed_root).is_empty());
}

#[test]
fn duplicate_import_preserves_the_existing_managed_project() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let first = source_project(&external, WORKSPACE_ID, "first");
    let second = source_project(&external, WORKSPACE_ID, "second");
    let managed_root = temp.path().join("managed");
    let library = ProjectLibrary::open(&managed_root).unwrap();

    library
        .import_plaintext(&NativeProjectSource::from_native_path(first), &NeverCancel)
        .unwrap();
    assert!(matches!(
        library
            .import_plaintext(&NativeProjectSource::from_native_path(second), &NeverCancel)
            .unwrap_err(),
        ProjectContainerError::AlreadyExists
    ));
    assert_eq!(
        library
            .open_project(&id(WORKSPACE_ID))
            .unwrap()
            .header()
            .unwrap()
            .name,
        "first"
    );
    assert!(staging_files(&managed_root).is_empty());
}

#[test]
fn plaintext_export_replaces_existing_target_with_a_valid_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let library = library(&temp);
    let workspace_id = id(WORKSPACE_ID);
    drop(library.create_project(&workspace_id, "Managed", 1).unwrap());
    let destination = external.join("export.bbcom");
    fs::write(&destination, b"old target").unwrap();

    let exported = library
        .export_plaintext(
            &workspace_id,
            &NativeProjectDestination::from_native_path(&destination),
            &NeverCancel,
        )
        .unwrap();
    assert!(exported.bytes > 0);
    let snapshot = WorkspaceService::open_read_only(&destination).unwrap();
    assert_eq!(snapshot.header().unwrap().name, "Managed");
    assert!(snapshot.integrity_check().unwrap().ok);
    assert!(staging_files(&external).is_empty());
}

#[test]
fn export_failure_and_all_cancellation_points_preserve_old_target() {
    for checkpoint in [
        ContainerCheckpoint::ExportBeforeBackup,
        ContainerCheckpoint::ExportBeforeCommit,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        let library = library(&temp);
        let workspace_id = id(WORKSPACE_ID);
        drop(library.create_project(&workspace_id, "Managed", 1).unwrap());
        let destination = external.join("export.bbcom");
        fs::write(&destination, b"old target").unwrap();

        let error = library
            .export_plaintext(
                &workspace_id,
                &NativeProjectDestination::from_native_path(&destination),
                &|seen| seen == checkpoint,
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ProjectContainerError::Cancelled { checkpoint: actual } if actual == checkpoint
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"old target");
        assert!(staging_files(&external).is_empty());
    }

    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let library = library(&temp);
    let destination = external.join("export.bbcom");
    fs::write(&destination, b"old target").unwrap();
    assert!(
        library
            .export_plaintext(
                &id(SECOND_WORKSPACE_ID),
                &NativeProjectDestination::from_native_path(&destination),
                &NeverCancel,
            )
            .is_err()
    );
    assert_eq!(fs::read(&destination).unwrap(), b"old target");
    assert!(staging_files(&external).is_empty());
}

#[test]
fn managed_library_rejects_managed_paths_as_external_sources_or_destinations() {
    let temp = tempfile::tempdir().unwrap();
    let managed_root = temp.path().join("managed");
    let library = ProjectLibrary::open(&managed_root).unwrap();
    let workspace_id = id(WORKSPACE_ID);
    drop(library.create_project(&workspace_id, "Managed", 1).unwrap());
    let managed_path = managed_root.join(format!("{WORKSPACE_ID}.bbcom"));

    assert!(matches!(
        library
            .import_plaintext(
                &NativeProjectSource::from_native_path(&managed_path),
                &NeverCancel,
            )
            .unwrap_err(),
        ProjectContainerError::InvalidInput { field: "source" }
    ));
    assert!(matches!(
        library
            .export_plaintext(
                &workspace_id,
                &NativeProjectDestination::from_native_path(managed_root.join("copy.bbcom")),
                &NeverCancel,
            )
            .unwrap_err(),
        ProjectContainerError::InvalidInput {
            field: "destination"
        }
    ));
}

#[test]
fn encryption_contract_requires_standard_age_scrypt_without_a_custom_password_format() {
    assert_eq!(AGE_CRATE_VERSION_REQUIRED, "0.12.1");
    assert_eq!(AGE_SCRYPT_ENVELOPE.format, "age");
    assert_eq!(AGE_SCRYPT_ENVELOPE.recipient, "scrypt");
    assert_eq!(
        AGE_SCRYPT_ENVELOPE.maximum_ciphertext_bytes,
        512 * 1024 * 1024
    );
    assert_eq!(
        AGE_SCRYPT_ENVELOPE.maximum_plaintext_bytes,
        512 * 1024 * 1024
    );
}

#[test]
fn encrypted_export_and_import_round_trip_through_standard_age_scrypt() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let source_library = ProjectLibrary::open(temp.path().join("managed-source")).unwrap();
    let workspace_id = id(WORKSPACE_ID);
    drop(
        source_library
            .create_project(&workspace_id, "Encrypted", 1)
            .unwrap(),
    );
    let encrypted = external.join("project.bbcom.age");
    let passphrase =
        AgeScryptPassphraseStreams::new("correct horse battery staple".into()).unwrap();

    source_library
        .export_encrypted(
            &workspace_id,
            &NativeProjectDestination::from_native_path(&encrypted),
            &passphrase,
            &NeverCancel,
        )
        .unwrap();
    let decryptor = age::Decryptor::new(fs::File::open(&encrypted).unwrap()).unwrap();
    assert!(
        decryptor.is_scrypt(),
        "encrypted export must be a standard age scrypt file"
    );

    let destination_library =
        ProjectLibrary::open(temp.path().join("managed-destination")).unwrap();
    let imported = destination_library
        .import_encrypted(
            &NativeProjectSource::from_native_path(&encrypted),
            &passphrase,
            &NeverCancel,
        )
        .unwrap();
    assert_eq!(imported.workspace_id, workspace_id);
    assert_eq!(imported.header.name, "Encrypted");
    assert!(staging_files(&temp.path().join("managed-source")).is_empty());
    assert!(staging_files(&temp.path().join("managed-destination")).is_empty());
    assert!(staging_files(&external).is_empty());
}

#[test]
fn wrong_passphrase_tampering_and_encrypted_cancellation_never_commit() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let source_library = ProjectLibrary::open(temp.path().join("managed-source")).unwrap();
    let workspace_id = id(WORKSPACE_ID);
    drop(
        source_library
            .create_project(&workspace_id, "Encrypted", 1)
            .unwrap(),
    );
    let encrypted = external.join("project.age");
    let passphrase = AgeScryptPassphraseStreams::new("correct".into()).unwrap();
    source_library
        .export_encrypted(
            &workspace_id,
            &NativeProjectDestination::from_native_path(&encrypted),
            &passphrase,
            &NeverCancel,
        )
        .unwrap();

    let managed_root = temp.path().join("managed-import");
    let destination_library = ProjectLibrary::open(&managed_root).unwrap();
    let wrong = AgeScryptPassphraseStreams::new("wrong".into()).unwrap();
    assert!(matches!(
        destination_library
            .import_encrypted(
                &NativeProjectSource::from_native_path(&encrypted),
                &wrong,
                &NeverCancel,
            )
            .unwrap_err(),
        ProjectContainerError::AgeStream
    ));
    assert!(!destination_library.contains(&workspace_id));
    assert!(staging_files(&managed_root).is_empty());

    let tampered = external.join("tampered.age");
    let mut bytes = fs::read(&encrypted).unwrap();
    let last = bytes.last_mut().unwrap();
    *last ^= 0x80;
    fs::write(&tampered, bytes).unwrap();
    assert!(
        destination_library
            .import_encrypted(
                &NativeProjectSource::from_native_path(&tampered),
                &passphrase,
                &NeverCancel,
            )
            .is_err()
    );
    assert!(!destination_library.contains(&workspace_id));
    assert!(staging_files(&managed_root).is_empty());

    let cancelled_target = external.join("cancelled.age");
    fs::write(&cancelled_target, b"old target").unwrap();
    let error = source_library
        .export_encrypted(
            &workspace_id,
            &NativeProjectDestination::from_native_path(&cancelled_target),
            &passphrase,
            &|checkpoint| checkpoint == ContainerCheckpoint::EncryptStream,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ProjectContainerError::Cancelled {
            checkpoint: ContainerCheckpoint::EncryptStream
        }
    ));
    assert_eq!(fs::read(&cancelled_target).unwrap(), b"old target");
    assert!(staging_files(&external).is_empty());
    assert!(staging_files(&temp.path().join("managed-source")).is_empty());

    let error = destination_library
        .import_encrypted(
            &NativeProjectSource::from_native_path(&encrypted),
            &passphrase,
            &|checkpoint| checkpoint == ContainerCheckpoint::DecryptStream,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ProjectContainerError::Cancelled {
            checkpoint: ContainerCheckpoint::DecryptStream
        }
    ));
    assert!(!destination_library.contains(&workspace_id));
    assert!(staging_files(&managed_root).is_empty());
}

#[test]
fn import_rejects_non_bbcom_extension_before_copying() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    let source = external.join("project.sqlite");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&source)
        .unwrap();
    file.write_all(b"ignored").unwrap();
    drop(file);
    let managed_root = temp.path().join("managed");
    let library = ProjectLibrary::open(&managed_root).unwrap();
    assert!(matches!(
        library
            .import_plaintext(&NativeProjectSource::from_native_path(source), &NeverCancel)
            .unwrap_err(),
        ProjectContainerError::InvalidInput { field: "source" }
    ));
    assert!(staging_files(&managed_root).is_empty());
}
