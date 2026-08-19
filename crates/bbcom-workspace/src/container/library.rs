use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use bbcom_contracts::{MAX_WORKSPACE_DATABASE_BYTES, WorkspaceDocumentHeader};
use rusqlite::Connection;

use super::atomic::{
    PendingFile, atomic_replace, create_private_directory, create_private_file, private_temp_path,
    sync_directory,
};
use super::cancellation::check_cancelled;
use super::path::validate_bbcom_extension;
use super::{
    AgeScryptPassphraseStreams, CancellationCheck, ContainerCheckpoint, ManagedProjectFileName,
    NativeProjectDestination, NativeProjectSource, ProjectContainerError, ProjectContainerResult,
    WorkspaceUuid,
};
use crate::mutation::validate_workspace_limits;
use crate::schema::{READ_ONLY_FLAGS, configure_connection};
use crate::service::purge_undo_slot_from_copy;
use crate::{CreateWorkspaceRequest, WorkspaceError, WorkspaceService};

const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedProject {
    pub workspace_id: WorkspaceUuid,
    pub file_name: ManagedProjectFileName,
    pub header: WorkspaceDocumentHeader,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportedProject {
    pub workspace_id: WorkspaceUuid,
    pub bytes: u64,
}

/// Rust-owned managed project library. Its root is supplied by the native app
/// data resolver once; all subsequent managed operations accept only UUIDs or
/// validated internal file names.
#[derive(Debug)]
pub struct ProjectLibrary {
    root: PathBuf,
    commit_lock: Mutex<()>,
}

impl ProjectLibrary {
    pub fn open(root: impl AsRef<Path>) -> ProjectContainerResult<Self> {
        create_private_directory(root.as_ref())?;
        let root = fs::canonicalize(root.as_ref())?;
        Ok(Self {
            root,
            commit_lock: Mutex::new(()),
        })
    }

    pub fn create_project(
        &self,
        workspace_id: &WorkspaceUuid,
        name: impl Into<String>,
        created_at_ms: u64,
    ) -> ProjectContainerResult<WorkspaceService> {
        let _commit = self.lock_commits()?;
        let service = WorkspaceService::create(
            self.managed_path(workspace_id),
            CreateWorkspaceRequest {
                workspace_id: workspace_id.as_str().to_owned(),
                name: name.into(),
                created_at_ms,
            },
        )?;
        Ok(service)
    }

    pub fn open_project(
        &self,
        workspace_id: &WorkspaceUuid,
    ) -> ProjectContainerResult<WorkspaceService> {
        Ok(WorkspaceService::open(self.managed_path(workspace_id))?)
    }

    pub fn open_project_by_name(
        &self,
        file_name: &ManagedProjectFileName,
    ) -> ProjectContainerResult<WorkspaceService> {
        self.open_project(&file_name.workspace_id()?)
    }

    /// Remove one closed managed project and its SQLite sidecars. The caller
    /// owns active-project policy; this layer only accepts a validated UUID and
    /// serializes the destructive commit with create/import/export commits.
    pub fn delete_project(&self, workspace_id: &WorkspaceUuid) -> ProjectContainerResult<()> {
        let _commit = self.lock_commits()?;
        let path = self.managed_path(workspace_id);
        if !path.is_file() {
            return Err(ProjectContainerError::InvalidInput {
                field: "workspaceId",
            });
        }
        fs::remove_file(&path)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let _ = fs::remove_file(format!("{}{suffix}", path.display()));
        }
        // The primary file removal is authoritative. Directory sync is best
        // effort so a post-commit failure cannot invite a destructive retry.
        let _ = sync_directory(&self.root);
        Ok(())
    }

    #[must_use]
    pub fn contains(&self, workspace_id: &WorkspaceUuid) -> bool {
        self.managed_path(workspace_id).is_file()
    }

    /// Enumerate only canonical managed file names. Contents are validated by
    /// `open_project` before they can enter the renderer catalog.
    pub fn list_workspace_ids(&self) -> ProjectContainerResult<Vec<WorkspaceUuid>> {
        let mut workspace_ids = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(file_name) = ManagedProjectFileName::parse(&file_name) else {
                continue;
            };
            workspace_ids.push(file_name.workspace_id()?);
        }
        workspace_ids.sort();
        Ok(workspace_ids)
    }

    /// Copy, validate, and atomically commit a native-selected plaintext
    /// project. This method never changes any caller-owned "current project";
    /// callers may switch only after receiving `Ok`.
    pub fn import_plaintext(
        &self,
        source: &NativeProjectSource,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<ImportedProject> {
        let source_path = source.as_path();
        validate_bbcom_extension(source_path, "source")?;
        self.require_external_existing(source_path, "source")?;
        check_cancelled(cancellation, ContainerCheckpoint::ImportBeforeOpen)?;
        validate_file_size(source_path, "externalFileBytes")?;

        let staging_path = private_temp_path(&self.root, "import");
        let mut staging = PendingFile::new(staging_path);
        copy_bounded(source_path, staging.path(), cancellation)?;
        sync_directory(&self.root)?;

        check_cancelled(cancellation, ContainerCheckpoint::ImportBeforeValidation)?;
        let (workspace_id, header) = validate_staged_project(staging.path())?;
        let file_name = ManagedProjectFileName::for_workspace(&workspace_id);
        let destination = self.managed_path(&workspace_id);

        let _commit = self.lock_commits()?;
        check_cancelled(cancellation, ContainerCheckpoint::ImportBeforeCommit)?;
        if destination.exists() {
            return Err(ProjectContainerError::AlreadyExists);
        }
        fs::rename(staging.path(), &destination)?;
        staging.disarm();
        // Rename is authoritative. A post-commit directory sync is best effort
        // so an error can never be reported after the target has changed.
        let _ = sync_directory(&self.root);

        Ok(ImportedProject {
            workspace_id,
            file_name,
            header,
        })
    }

    /// Decrypt a standard age scrypt file to private managed staging, validate
    /// the complete SQLite document, then atomically commit it.
    pub fn import_encrypted(
        &self,
        source: &NativeProjectSource,
        passphrase: &AgeScryptPassphraseStreams,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<ImportedProject> {
        let source_path = source.as_path();
        self.require_external_existing(source_path, "source")?;
        check_cancelled(cancellation, ContainerCheckpoint::ImportBeforeOpen)?;
        validate_file_size(source_path, "encryptedFileBytes")?;

        let staging_path = private_temp_path(&self.root, "decrypt");
        let mut staging = PendingFile::new(staging_path);
        let mut source_file = File::open(source_path)?;
        let mut staging_file = create_private_file(staging.path())?;
        passphrase.decrypt(&mut source_file, &mut staging_file, cancellation)?;
        staging_file.sync_all()?;
        drop(staging_file);
        sync_directory(&self.root)?;

        check_cancelled(cancellation, ContainerCheckpoint::ImportBeforeValidation)?;
        let (workspace_id, header) = validate_staged_project(staging.path())?;
        let file_name = ManagedProjectFileName::for_workspace(&workspace_id);
        let destination = self.managed_path(&workspace_id);

        let _commit = self.lock_commits()?;
        check_cancelled(cancellation, ContainerCheckpoint::ImportBeforeCommit)?;
        if destination.exists() {
            return Err(ProjectContainerError::AlreadyExists);
        }
        fs::rename(staging.path(), &destination)?;
        staging.disarm();
        let _ = sync_directory(&self.root);

        Ok(ImportedProject {
            workspace_id,
            file_name,
            header,
        })
    }

    /// Generate a consistent SQLite snapshot in a private `.part` beside the
    /// native-selected target, sync it, then atomically replace the target.
    pub fn export_plaintext(
        &self,
        workspace_id: &WorkspaceUuid,
        destination: &NativeProjectDestination,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<ExportedProject> {
        let destination = destination.as_path();
        validate_bbcom_extension(destination, "destination")?;
        let parent = destination
            .parent()
            .ok_or(ProjectContainerError::InvalidInput {
                field: "destination",
            })?;
        self.require_external_destination(destination, parent)?;
        check_cancelled(cancellation, ContainerCheckpoint::ExportBeforeBackup)?;

        let source = WorkspaceService::open_read_only(self.managed_path(workspace_id))?;
        let part_path = private_temp_path(parent, "export");
        let mut part = PendingFile::new(part_path);
        source.backup_to(part.path())?;
        let bytes = validate_file_size(part.path(), "databaseBytes")?;
        let (verified_workspace_id, _) = validate_staged_project(part.path())?;
        if &verified_workspace_id != workspace_id {
            return Err(ProjectContainerError::InvalidInput {
                field: "workspaceId",
            });
        }
        sync_directory(parent)?;

        let _commit = self.lock_commits()?;
        check_cancelled(cancellation, ContainerCheckpoint::ExportBeforeCommit)?;
        atomic_replace(part.path(), destination)?;
        part.disarm();
        let _ = sync_directory(parent);

        Ok(ExportedProject {
            workspace_id: workspace_id.clone(),
            bytes,
        })
    }

    /// Back up SQLite to private managed staging first, then stream the
    /// snapshot through age scrypt into a private target-side `.part` and
    /// atomically replace the target only after both streams are complete.
    pub fn export_encrypted(
        &self,
        workspace_id: &WorkspaceUuid,
        destination: &NativeProjectDestination,
        passphrase: &AgeScryptPassphraseStreams,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<ExportedProject> {
        let destination = destination.as_path();
        let parent = destination
            .parent()
            .ok_or(ProjectContainerError::InvalidInput {
                field: "destination",
            })?;
        self.require_external_destination(destination, parent)?;
        check_cancelled(cancellation, ContainerCheckpoint::ExportBeforeBackup)?;

        let source = WorkspaceService::open_read_only(self.managed_path(workspace_id))?;
        let backup_path = private_temp_path(&self.root, "encrypt-source");
        let backup = PendingFile::new(backup_path);
        source.backup_to(backup.path())?;
        validate_file_size(backup.path(), "databaseBytes")?;

        let part_path = private_temp_path(parent, "encrypted-export");
        let mut part = PendingFile::new(part_path);
        let mut plaintext = File::open(backup.path())?;
        let mut ciphertext = create_private_file(part.path())?;
        passphrase.encrypt(&mut plaintext, &mut ciphertext, cancellation)?;
        ciphertext.sync_all()?;
        drop(ciphertext);
        let bytes = validate_file_size(part.path(), "encryptedFileBytes")?;
        let verified_workspace_id =
            self.verify_encrypted_staging(part.path(), passphrase, cancellation)?;
        if &verified_workspace_id != workspace_id {
            return Err(ProjectContainerError::InvalidInput {
                field: "workspaceId",
            });
        }
        sync_directory(parent)?;

        let _commit = self.lock_commits()?;
        check_cancelled(cancellation, ContainerCheckpoint::ExportBeforeCommit)?;
        atomic_replace(part.path(), destination)?;
        part.disarm();
        let _ = sync_directory(parent);

        Ok(ExportedProject {
            workspace_id: workspace_id.clone(),
            bytes,
        })
    }

    #[must_use]
    pub fn managed_file_name(workspace_id: &WorkspaceUuid) -> ManagedProjectFileName {
        ManagedProjectFileName::for_workspace(workspace_id)
    }

    fn managed_path(&self, workspace_id: &WorkspaceUuid) -> PathBuf {
        self.root
            .join(Self::managed_file_name(workspace_id).as_str())
    }

    fn require_external_existing(
        &self,
        path: &Path,
        field: &'static str,
    ) -> ProjectContainerResult<()> {
        let canonical = fs::canonicalize(path)?;
        if canonical.starts_with(&self.root) || !canonical.is_file() {
            return Err(ProjectContainerError::InvalidInput { field });
        }
        Ok(())
    }

    fn require_external_destination(
        &self,
        destination: &Path,
        parent: &Path,
    ) -> ProjectContainerResult<()> {
        let parent = fs::canonicalize(parent)?;
        if parent.starts_with(&self.root) {
            return Err(ProjectContainerError::InvalidInput {
                field: "destination",
            });
        }
        if destination.exists() {
            let canonical = fs::canonicalize(destination)?;
            if canonical.starts_with(&self.root) || canonical.is_dir() {
                return Err(ProjectContainerError::InvalidInput {
                    field: "destination",
                });
            }
        }
        Ok(())
    }

    /// Authenticate, decrypt and fully validate the just-written ciphertext
    /// before it can replace the user's existing destination. The readback
    /// plaintext lives only in the private managed directory and is removed by
    /// `PendingFile` on every path.
    fn verify_encrypted_staging(
        &self,
        encrypted_path: &Path,
        passphrase: &AgeScryptPassphraseStreams,
        cancellation: &(impl CancellationCheck + ?Sized),
    ) -> ProjectContainerResult<WorkspaceUuid> {
        let verification_path = private_temp_path(&self.root, "encrypted-readback");
        let verification = PendingFile::new(verification_path);
        let mut ciphertext = File::open(encrypted_path)?;
        let mut plaintext = create_private_file(verification.path())?;
        passphrase.decrypt(&mut ciphertext, &mut plaintext, cancellation)?;
        plaintext.sync_all()?;
        drop(plaintext);
        let (workspace_id, _) = validate_staged_project(verification.path())?;
        Ok(workspace_id)
    }

    fn lock_commits(&self) -> ProjectContainerResult<std::sync::MutexGuard<'_, ()>> {
        self.commit_lock.lock().map_err(|_| {
            ProjectContainerError::Io(std::io::Error::other("project commit lock poisoned"))
        })
    }
}

fn copy_bounded(
    source: &Path,
    destination: &Path,
    cancellation: &(impl CancellationCheck + ?Sized),
) -> ProjectContainerResult<u64> {
    let mut source = File::open(source)?;
    let mut destination = create_private_file(destination)?;
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    let mut copied = 0_u64;
    loop {
        check_cancelled(cancellation, ContainerCheckpoint::ImportCopy)?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or(ProjectContainerError::LimitExceeded {
                field: "externalFileBytes",
                limit: super::MAX_PROJECT_CONTAINER_BYTES,
                actual: u64::MAX,
            })?;
        ensure_container_size("externalFileBytes", copied)?;
        destination.write_all(&buffer[..count])?;
    }
    destination.sync_all()?;
    Ok(copied)
}

fn validate_staged_project(
    path: &Path,
) -> ProjectContainerResult<(WorkspaceUuid, WorkspaceDocumentHeader)> {
    validate_file_size(path, "databaseBytes")?;
    // Staging is always a private native-owned copy. Remove a transient undo
    // slot before it enters the managed library, including from an externally
    // crafted but otherwise valid container.
    purge_undo_slot_from_copy(path)?;
    let workspace = WorkspaceService::open_read_only(path)?;
    let integrity = workspace.integrity_check()?;
    if !integrity.ok {
        return Err(ProjectContainerError::Integrity);
    }
    let header = workspace.header()?;
    let workspace_id = WorkspaceUuid::parse(&header.workspace_id)?;
    if workspace_id.as_str() != header.workspace_id {
        return Err(ProjectContainerError::InvalidInput {
            field: "workspaceId",
        });
    }

    // WorkspaceService owns header and integrity validation. This second
    // read-only handle only runs the central aggregate limit validator, so the
    // container does not duplicate any schema or limit SQL.
    let connection =
        Connection::open_with_flags(path, READ_ONLY_FLAGS).map_err(WorkspaceError::from)?;
    configure_connection(&connection, false)?;
    validate_workspace_limits(&connection)?;
    Ok((workspace_id, header))
}

fn validate_file_size(path: &Path, field: &'static str) -> ProjectContainerResult<u64> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(ProjectContainerError::InvalidInput { field });
    }
    let bytes = metadata.len();
    ensure_container_size(field, bytes)?;
    Ok(bytes)
}

fn ensure_container_size(field: &'static str, actual: u64) -> ProjectContainerResult<()> {
    let limit = u64::try_from(MAX_WORKSPACE_DATABASE_BYTES)
        .expect("workspace database byte limit always fits u64");
    if actual > limit {
        Err(ProjectContainerError::LimitExceeded {
            field,
            limit,
            actual,
        })
    } else {
        Ok(())
    }
}
