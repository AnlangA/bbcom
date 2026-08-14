use bbcom_contracts::{AppErrorCode, IpcError};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("invalid workspace field: {field}")]
    InvalidInput { field: &'static str },
    #[error("workspace limit exceeded for {field}: {actual} > {limit}")]
    LimitExceeded {
        field: &'static str,
        limit: usize,
        actual: usize,
    },
    #[error("workspace does not exist")]
    NotFound,
    #[error("workspace target already exists")]
    AlreadyExists,
    #[error("workspace is read-only")]
    ReadOnly,
    #[error("workspace revision conflict: expected {expected}, found {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("workspace is corrupt: {reason}")]
    Corrupt { reason: &'static str },
    #[error("workspace schema {found} is newer than supported schema {supported}")]
    FutureSchema { found: i32, supported: i32 },
    #[error("workspace batch id was reused with different content")]
    BatchIdReuse,
    #[error("workspace database is busy")]
    Busy,
    #[error("workspace I/O failed")]
    Io(#[from] std::io::Error),
    #[error("workspace database operation failed")]
    Database(rusqlite::Error),
    #[error("workspace payload serialization failed")]
    Serialization(#[from] serde_json::Error),
}

impl WorkspaceError {
    #[must_use]
    pub fn to_ipc_error(&self, operation: &'static str) -> IpcError {
        match self {
            Self::InvalidInput { field } => IpcError::invalid_input(operation, field),
            Self::LimitExceeded {
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
            .with_size(*limit, *actual),
            Self::ReadOnly => IpcError::new(
                AppErrorCode::WorkspaceReadOnly,
                "error.workspace_read_only",
                false,
                operation,
            ),
            Self::RevisionConflict { .. } => IpcError::new(
                AppErrorCode::RevisionConflict,
                "error.revision_conflict",
                false,
                operation,
            ),
            Self::Corrupt { .. } | Self::FutureSchema { .. } => IpcError::new(
                AppErrorCode::WorkspaceCorrupt,
                "error.workspace_corrupt",
                false,
                operation,
            ),
            Self::Busy => IpcError::new(AppErrorCode::Busy, "error.busy", true, operation),
            Self::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                IpcError::new(
                    AppErrorCode::IoPermissionDenied,
                    "error.io_permission_denied",
                    false,
                    operation,
                )
            }
            Self::Io(error) if error.kind() == std::io::ErrorKind::StorageFull => IpcError::new(
                AppErrorCode::IoDiskFull,
                "error.io_disk_full",
                true,
                operation,
            ),
            Self::NotFound | Self::AlreadyExists | Self::BatchIdReuse | Self::Serialization(_) => {
                IpcError::invalid_input(operation, self.stable_field())
            }
            Self::Io(_) | Self::Database(_) => IpcError::new(
                AppErrorCode::WorkspaceCorrupt,
                "error.workspace_corrupt",
                true,
                operation,
            ),
        }
    }

    const fn stable_field(&self) -> &'static str {
        match self {
            Self::NotFound => "workspaceId",
            Self::AlreadyExists => "destination",
            Self::BatchIdReuse => "clientBatchId",
            Self::Serialization(_) => "payload",
            _ => "workspace",
        }
    }
}

pub(crate) fn map_database_error(error: rusqlite::Error) -> WorkspaceError {
    let rusqlite::Error::SqliteFailure(failure, _) = &error else {
        return WorkspaceError::Database(error);
    };
    match failure.code {
        rusqlite::ErrorCode::ReadOnly => WorkspaceError::ReadOnly,
        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
            WorkspaceError::Busy
        }
        rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
            WorkspaceError::Corrupt { reason: "sqlite" }
        }
        _ => WorkspaceError::Database(error),
    }
}

impl From<rusqlite::Error> for WorkspaceError {
    fn from(error: rusqlite::Error) -> Self {
        map_database_error(error)
    }
}
