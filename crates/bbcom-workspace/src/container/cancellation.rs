use super::{ProjectContainerError, ProjectContainerResult};

/// Named points at which a container operation may still stop without
/// committing a managed project or replacing an export target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerCheckpoint {
    ImportBeforeOpen,
    ImportCopy,
    ImportBeforeValidation,
    ImportBeforeCommit,
    ExportBeforeBackup,
    ExportBeforeCommit,
    LegacyBackupBeforeCommit,
    EncryptStream,
    DecryptStream,
}

/// Cancellation is polled only at the documented checkpoints. Once the
/// atomic rename starts, the operation is committed and no longer cancellable.
pub trait CancellationCheck {
    fn is_cancelled(&self, checkpoint: ContainerCheckpoint) -> bool;
}

impl<F> CancellationCheck for F
where
    F: Fn(ContainerCheckpoint) -> bool,
{
    fn is_cancelled(&self, checkpoint: ContainerCheckpoint) -> bool {
        self(checkpoint)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NeverCancel;

impl CancellationCheck for NeverCancel {
    fn is_cancelled(&self, _checkpoint: ContainerCheckpoint) -> bool {
        false
    }
}

pub(crate) fn check_cancelled(
    cancellation: &(impl CancellationCheck + ?Sized),
    checkpoint: ContainerCheckpoint,
) -> ProjectContainerResult<()> {
    if cancellation.is_cancelled(checkpoint) {
        Err(ProjectContainerError::Cancelled { checkpoint })
    } else {
        Ok(())
    }
}
