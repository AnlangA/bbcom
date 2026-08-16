//! Long-running workspace operation tracking: the cancel-state machine and
//! the manager-side operation registry used by import/export.
//!
//! [`WorkspaceOperationControl`] is the atomic phase gate (Cancellable ->
//! CancelRequested / Committing -> Finished) that turns renderer cancel
//! requests into cooperative checkpoints inside the container copy loops.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use bbcom_contracts::{AppErrorCode, IpcError};
use bbcom_workspace::container::ContainerCheckpoint;

use super::{WorkspaceManager, validate_opaque_id};

#[cfg(test)]
use super::temporary_root;

const MAX_CONCURRENT_WORKSPACE_OPERATIONS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum WorkspaceOperationPhase {
    Cancellable = 0,
    CancelRequested = 1,
    Committing = 2,
    Finished = 3,
}

#[derive(Debug)]
pub(super) struct WorkspaceOperationControl {
    phase: AtomicU8,
}

impl WorkspaceOperationControl {
    const fn new() -> Self {
        Self {
            phase: AtomicU8::new(WorkspaceOperationPhase::Cancellable as u8),
        }
    }

    fn request_cancel(&self) -> bool {
        loop {
            match self.phase() {
                WorkspaceOperationPhase::Cancellable => {
                    if self
                        .phase
                        .compare_exchange(
                            WorkspaceOperationPhase::Cancellable as u8,
                            WorkspaceOperationPhase::CancelRequested as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return true;
                    }
                }
                WorkspaceOperationPhase::CancelRequested => return true,
                WorkspaceOperationPhase::Committing | WorkspaceOperationPhase::Finished => {
                    return false;
                }
            }
        }
    }

    pub(super) fn is_cancelled(&self, checkpoint: ContainerCheckpoint) -> bool {
        if matches!(
            checkpoint,
            ContainerCheckpoint::ImportBeforeCommit | ContainerCheckpoint::ExportBeforeCommit
        ) {
            loop {
                match self.phase() {
                    WorkspaceOperationPhase::Cancellable => {
                        if self
                            .phase
                            .compare_exchange(
                                WorkspaceOperationPhase::Cancellable as u8,
                                WorkspaceOperationPhase::Committing as u8,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            )
                            .is_ok()
                        {
                            return false;
                        }
                    }
                    WorkspaceOperationPhase::CancelRequested => return true,
                    WorkspaceOperationPhase::Committing | WorkspaceOperationPhase::Finished => {
                        return false;
                    }
                }
            }
        }

        self.phase() == WorkspaceOperationPhase::CancelRequested
    }

    fn finish(&self) {
        self.phase
            .store(WorkspaceOperationPhase::Finished as u8, Ordering::Release);
    }

    fn phase(&self) -> WorkspaceOperationPhase {
        match self.phase.load(Ordering::Acquire) {
            value if value == WorkspaceOperationPhase::Cancellable as u8 => {
                WorkspaceOperationPhase::Cancellable
            }
            value if value == WorkspaceOperationPhase::CancelRequested as u8 => {
                WorkspaceOperationPhase::CancelRequested
            }
            value if value == WorkspaceOperationPhase::Committing as u8 => {
                WorkspaceOperationPhase::Committing
            }
            _ => WorkspaceOperationPhase::Finished,
        }
    }
}

impl WorkspaceManager {
    pub(super) fn begin_operation(
        &self,
        operation_id: &str,
        operation: &'static str,
    ) -> Result<Arc<WorkspaceOperationControl>, IpcError> {
        validate_opaque_id(operation_id, "operationId", operation)?;
        let mut operations = self.operations.lock().map_err(|_| {
            IpcError::new(AppErrorCode::Busy, "error.busy", true, operation)
                .with_field("operationId")
        })?;
        if operations.contains_key(operation_id) {
            return Err(
                IpcError::new(AppErrorCode::Busy, "error.busy", true, operation)
                    .with_field("operationId"),
            );
        }
        if operations.len() >= MAX_CONCURRENT_WORKSPACE_OPERATIONS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field("operationId")
            .with_size(
                MAX_CONCURRENT_WORKSPACE_OPERATIONS,
                operations.len().saturating_add(1),
            ));
        }
        let cancellation = Arc::new(WorkspaceOperationControl::new());
        operations.insert(operation_id.to_owned(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub(super) fn finish_operation(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            if let Some(operation) = operations.get(operation_id) {
                operation.finish();
            }
            operations.remove(operation_id);
        }
    }

    pub(super) fn cancel_operation(
        &self,
        operation_id: &str,
        operation: &'static str,
    ) -> Result<bool, IpcError> {
        validate_opaque_id(operation_id, "operationId", operation)?;
        let cancellation = self
            .operations
            .lock()
            .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))?
            .get(operation_id)
            .cloned();
        Ok(cancellation.is_some_and(|operation| operation.request_cancel()))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn workspace_operation_cancellation_and_commit_barrier_are_atomic() {
        let root = temporary_root("operation-cancel");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let cancellation = manager
            .begin_operation("workspace-operation-1", "test")
            .expect("begin operation");
        assert_eq!(cancellation.phase(), WorkspaceOperationPhase::Cancellable);
        assert!(
            manager
                .cancel_operation("workspace-operation-1", "test")
                .expect("cancel operation")
        );
        assert!(
            manager
                .cancel_operation("workspace-operation-1", "test")
                .expect("repeat cancellation remains acknowledged")
        );
        assert!(cancellation.is_cancelled(ContainerCheckpoint::ImportBeforeCommit));
        assert_eq!(
            cancellation.phase(),
            WorkspaceOperationPhase::CancelRequested
        );
        manager.finish_operation("workspace-operation-1");
        assert_eq!(cancellation.phase(), WorkspaceOperationPhase::Finished);
        assert!(
            !manager
                .cancel_operation("workspace-operation-1", "test")
                .expect("finished operation is absent")
        );

        let committing = manager
            .begin_operation("workspace-operation-2", "test")
            .expect("begin committing operation");
        assert!(!committing.is_cancelled(ContainerCheckpoint::ExportBeforeCommit));
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Committing);
        assert!(
            !manager
                .cancel_operation("workspace-operation-2", "test")
                .expect("committing operation rejects late cancellation")
        );
        manager.finish_operation("workspace-operation-2");
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Finished);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_operation_registry_rejects_invalid_duplicate_and_excess_ids() {
        let root = temporary_root("operation-limits");
        let manager = WorkspaceManager::open(&root).expect("open manager");

        let invalid = manager.begin_operation("bad id", "test").unwrap_err();
        assert_eq!(invalid.code, AppErrorCode::InvalidInput);
        assert_eq!(invalid.field, Some("operationId"));

        manager
            .begin_operation("operation-0", "test")
            .expect("begin first operation");
        let duplicate = manager.begin_operation("operation-0", "test").unwrap_err();
        assert_eq!(duplicate.code, AppErrorCode::Busy);
        assert_eq!(duplicate.field, Some("operationId"));

        for index in 1..MAX_CONCURRENT_WORKSPACE_OPERATIONS {
            manager
                .begin_operation(&format!("operation-{index}"), "test")
                .expect("fill operation registry");
        }
        let limited = manager
            .begin_operation("operation-overflow", "test")
            .unwrap_err();
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!(limited.limit, Some(MAX_CONCURRENT_WORKSPACE_OPERATIONS));
        assert_eq!(
            limited.actual,
            Some(MAX_CONCURRENT_WORKSPACE_OPERATIONS + 1)
        );

        assert!(!manager.cancel_operation("missing", "test").unwrap());
        assert_eq!(
            manager
                .cancel_operation("bad id", "test")
                .unwrap_err()
                .field,
            Some("operationId")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn cancellation_is_observed_before_but_not_after_the_commit_barrier() {
        let control = WorkspaceOperationControl::new();
        assert!(!control.is_cancelled(ContainerCheckpoint::ImportCopy));
        assert!(control.request_cancel());
        assert!(control.is_cancelled(ContainerCheckpoint::ImportBeforeValidation));

        let committing = WorkspaceOperationControl::new();
        assert!(!committing.is_cancelled(ContainerCheckpoint::ImportBeforeCommit));
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Committing);
        assert!(!committing.request_cancel());
        assert!(!committing.is_cancelled(ContainerCheckpoint::ExportBeforeBackup));
        committing.finish();
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Finished);
    }
}
