use std::io;

use thiserror::Error;

use super::ContainerCheckpoint;
use crate::WorkspaceError;

pub type ProjectContainerResult<T> = std::result::Result<T, ProjectContainerError>;

/// Stable container-level failures. Physical paths and third-party error text
/// are deliberately absent from every display message.
#[derive(Debug, Error)]
pub enum ProjectContainerError {
    #[error("invalid project container field: {field}")]
    InvalidInput { field: &'static str },
    #[error("project container limit exceeded for {field}: {actual} > {limit}")]
    LimitExceeded {
        field: &'static str,
        limit: u64,
        actual: u64,
    },
    #[error("project container operation was cancelled")]
    Cancelled { checkpoint: ContainerCheckpoint },
    #[error("managed project already exists")]
    AlreadyExists,
    #[error("project container integrity validation failed")]
    Integrity,
    #[error("age scrypt stream operation failed")]
    AgeStream,
    #[error("age scrypt stream I/O failed")]
    AgeIo(#[source] io::Error),
    #[error("workspace validation failed")]
    Workspace(#[source] WorkspaceError),
    #[error("project container I/O failed")]
    Io(#[source] io::Error),
}

impl From<WorkspaceError> for ProjectContainerError {
    fn from(error: WorkspaceError) -> Self {
        match error {
            WorkspaceError::AlreadyExists => Self::AlreadyExists,
            other => Self::Workspace(other),
        }
    }
}

impl From<io::Error> for ProjectContainerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
