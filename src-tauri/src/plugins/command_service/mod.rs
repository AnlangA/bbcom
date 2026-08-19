//! Application-owned command state for the native plugin surface.
//!
//! This module contains no Tauri command and exposes no path, handle, secret,
//! serial writer, repository verifier, or host internals. A future command
//! adapter may map these native values to reviewed DTOs after wiring the
//! explicit upstream ports below.

use std::collections::BTreeMap;
use std::sync::Arc;

use bbcom_contracts::PluginContributionDisposition;
use bbcom_plugin_manager::{
    Clock, HostLauncher, InstallationPort, ManualPackageRequest, PluginSnapshot,
};

use super::service::{PluginService, PluginServiceError};

const MAX_ACTIVE_OPERATIONS: usize = 128;
const MAX_COMPLETED_OPERATIONS: usize = 256;
const COMPLETED_OPERATION_RETENTION_MS: u64 = 15 * 60 * 1_000;
const MAX_REQUEST_ID_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginOperationStatus {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[cfg(test)]
mod operation_retention_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Lifecycle;

    impl PluginLifecyclePort for Lifecycle {
        fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
            Ok(Vec::new())
        }

        fn workspace_id(&self) -> Result<Option<String>, PluginOperationFailure> {
            Ok(Some("11111111-1111-1111-1111-111111111111".to_owned()))
        }

        fn install_manual(
            &self,
            _request: &ManualPackageRequest,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            Err(failure())
        }

        fn install_local(
            &self,
            _package_root: &std::path::Path,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            Err(failure())
        }

        fn uninstall(&self, _plugin_id: &str) -> Result<PluginSnapshot, PluginOperationFailure> {
            Err(failure())
        }

        fn set_enabled(
            &self,
            _plugin_id: &str,
            _enabled: bool,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            Err(failure())
        }
    }

    fn failure() -> PluginOperationFailure {
        PluginOperationFailure {
            code: "TEST_FAILURE",
            message_key: "plugin.error.test",
        }
    }

    #[test]
    fn terminal_operation_registry_and_request_correlations_stay_bounded() {
        let mut service = PluginCommandService::new(Arc::new(Lifecycle)).unwrap();
        for index in 0..5_000_u64 {
            let queued = service
                .queue_set_enabled(
                    service.snapshot().revision,
                    format!("request-{index}"),
                    "dev.bbcom.fixture".to_owned(),
                    true,
                )
                .unwrap();
            let terminal = service.execute(&queued.operation_id, index + 1).unwrap();
            assert!(terminal.status.is_terminal());
        }
        let snapshot = service.snapshot();
        assert_eq!(snapshot.operations.len(), MAX_COMPLETED_OPERATIONS);
        assert_eq!(service.requests.len(), MAX_COMPLETED_OPERATIONS);
    }

    struct RejectCleanup(Arc<AtomicBool>);

    impl PluginContributionCleanupPort for RejectCleanup {
        fn uninstall_with_contribution_cleanup(
            &self,
            _plugin_id: &str,
            disposition: PluginContributionDisposition,
            _uninstall: &mut dyn FnMut() -> Result<PluginSnapshot, PluginOperationFailure>,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            assert_eq!(disposition, PluginContributionDisposition::ConvertToUser);
            assert!(
                self.0.load(Ordering::SeqCst),
                "plugin runtime must be stopped before contribution cleanup"
            );
            Err(PluginOperationFailure {
                code: "PLUGIN_CONTRIBUTION_CLEANUP_FAILED",
                message_key: "plugin.error.contributionCleanupFailed",
            })
        }
    }

    struct PanicOnUninstall {
        disabled: Arc<AtomicBool>,
        uninstall_called: Arc<AtomicBool>,
    }

    impl PluginLifecyclePort for PanicOnUninstall {
        fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
            Ok(Vec::new())
        }

        fn install_manual(
            &self,
            _request: &ManualPackageRequest,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            unreachable!()
        }

        fn install_local(
            &self,
            _package_root: &std::path::Path,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            unreachable!()
        }

        fn uninstall(&self, _plugin_id: &str) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.uninstall_called.store(true, Ordering::SeqCst);
            unreachable!("lifecycle uninstall must not run after cleanup failure")
        }

        fn set_enabled(
            &self,
            _plugin_id: &str,
            enabled: bool,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            assert!(!enabled);
            self.disabled.store(true, Ordering::SeqCst);
            Ok(disabled_snapshot())
        }
    }

    fn disabled_snapshot() -> PluginSnapshot {
        let artifact = bbcom_plugin_manager::PluginArtifact::new(
            "dev.bbcom.fixture",
            "1.0.0",
            "00".repeat(32),
            "11".repeat(32),
            bbcom_plugin_manager::PluginArtifactSource {
                source_id: "local".to_owned(),
                kind: bbcom_plugin_manager::PluginSourceKind::LocalPackage,
            },
            [],
        )
        .unwrap();
        PluginSnapshot {
            artifact,
            expected_enabled: false,
            status: bbcom_plugin_manager::PluginStatus::Disabled(
                bbcom_plugin_manager::DisableReason::User,
            ),
            pending_version: None,
            running_instance_id: None,
            generation: 1,
            crashes_in_window: 0,
            last_error: None,
        }
    }

    #[test]
    fn contribution_cleanup_failure_prevents_irreversible_uninstall() {
        let disabled = Arc::new(AtomicBool::new(false));
        let uninstall_called = Arc::new(AtomicBool::new(false));
        let lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync> = Arc::new(PanicOnUninstall {
            disabled: Arc::clone(&disabled),
            uninstall_called: Arc::clone(&uninstall_called),
        });
        let cleanup: Arc<dyn PluginContributionCleanupPort> =
            Arc::new(RejectCleanup(Arc::clone(&disabled)));
        let mut service =
            PluginCommandService::new_with_contribution_cleanup(lifecycle, cleanup).unwrap();
        let queued = service
            .queue_uninstall(
                service.snapshot().revision,
                "uninstall-request".to_owned(),
                "dev.bbcom.fixture".to_owned(),
                PluginContributionDisposition::ConvertToUser,
            )
            .unwrap();
        let terminal = service.execute(&queued.operation_id, 1).unwrap();
        assert_eq!(terminal.status, PluginOperationStatus::Failed);
        assert_eq!(
            terminal.failure.unwrap().code,
            "PLUGIN_CONTRIBUTION_CLEANUP_FAILED"
        );
        assert!(!uninstall_called.load(Ordering::SeqCst));
    }

    struct FailingArtifactRemoval {
        disabled: Arc<AtomicBool>,
    }

    impl PluginLifecyclePort for FailingArtifactRemoval {
        fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
            Ok(Vec::new())
        }

        fn install_manual(
            &self,
            _request: &ManualPackageRequest,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            unreachable!()
        }

        fn install_local(
            &self,
            _package_root: &std::path::Path,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            unreachable!()
        }

        fn uninstall(&self, _plugin_id: &str) -> Result<PluginSnapshot, PluginOperationFailure> {
            Err(PluginOperationFailure {
                code: "PLUGIN_INSTALLATION_PREPARE_FAILED",
                message_key: "plugin.error.installationPrepareFailed",
            })
        }

        fn set_enabled(
            &self,
            _plugin_id: &str,
            enabled: bool,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            assert!(!enabled);
            self.disabled.store(true, Ordering::SeqCst);
            Ok(disabled_snapshot())
        }
    }

    struct RecordingRollbackCleanup {
        cleaned: Arc<AtomicBool>,
        restored: Arc<AtomicBool>,
    }

    impl PluginContributionCleanupPort for RecordingRollbackCleanup {
        fn uninstall_with_contribution_cleanup(
            &self,
            _plugin_id: &str,
            _disposition: PluginContributionDisposition,
            uninstall: &mut dyn FnMut() -> Result<PluginSnapshot, PluginOperationFailure>,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.cleaned.store(true, Ordering::SeqCst);
            match uninstall() {
                Ok(snapshot) => Ok(snapshot),
                Err(failure) => {
                    self.cleaned.store(false, Ordering::SeqCst);
                    self.restored.store(true, Ordering::SeqCst);
                    Err(failure)
                }
            }
        }
    }

    #[test]
    fn artifact_uninstall_failure_is_reported_only_after_contributions_restore() {
        let disabled = Arc::new(AtomicBool::new(false));
        let cleaned = Arc::new(AtomicBool::new(false));
        let restored = Arc::new(AtomicBool::new(false));
        let lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync> =
            Arc::new(FailingArtifactRemoval {
                disabled: Arc::clone(&disabled),
            });
        let cleanup: Arc<dyn PluginContributionCleanupPort> = Arc::new(RecordingRollbackCleanup {
            cleaned: Arc::clone(&cleaned),
            restored: Arc::clone(&restored),
        });
        let mut service =
            PluginCommandService::new_with_contribution_cleanup(lifecycle, cleanup).unwrap();
        let queued = service
            .queue_uninstall(
                service.snapshot().revision,
                "failed-artifact-uninstall".to_owned(),
                "dev.bbcom.fixture".to_owned(),
                PluginContributionDisposition::ConvertToUser,
            )
            .unwrap();
        let terminal = service.execute(&queued.operation_id, 1).unwrap();
        assert_eq!(terminal.status, PluginOperationStatus::Failed);
        assert_eq!(
            terminal.failure.unwrap().code,
            "PLUGIN_INSTALLATION_PREPARE_FAILED"
        );
        assert!(disabled.load(Ordering::SeqCst));
        assert!(restored.load(Ordering::SeqCst));
        assert!(!cleaned.load(Ordering::SeqCst));
    }
}

impl PluginOperationStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginOperationKind {
    Install,
    Uninstall,
    SetEnabled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginOperationFailure {
    pub code: &'static str,
    pub message_key: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginOperationSnapshot {
    pub operation_id: String,
    pub client_request_id: String,
    pub kind: PluginOperationKind,
    pub status: PluginOperationStatus,
    pub failure: Option<PluginOperationFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginCommandSnapshot {
    pub revision: u64,
    pub workspace_id: Option<String>,
    pub plugins: Vec<PluginSnapshot>,
    pub operations: Vec<PluginOperationSnapshot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginCommandErrorCode {
    RevisionConflict,
    RequestConflict,
    RegistryLimit,
    OperationNotFound,
    OperationNotCancellable,
    LifecycleUnavailable,
}

impl PluginCommandErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RevisionConflict => "PLUGIN_COMMAND_REVISION_CONFLICT",
            Self::RequestConflict => "PLUGIN_COMMAND_REQUEST_CONFLICT",
            Self::RegistryLimit => "PLUGIN_COMMAND_REGISTRY_LIMIT",
            Self::OperationNotFound => "PLUGIN_OPERATION_NOT_FOUND",
            Self::OperationNotCancellable => "PLUGIN_OPERATION_NOT_CANCELLABLE",
            Self::LifecycleUnavailable => "PLUGIN_LIFECYCLE_UNAVAILABLE",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginCommandError {
    pub code: PluginCommandErrorCode,
    pub failure: Option<PluginOperationFailure>,
}

impl PluginCommandError {
    pub fn new(code: PluginCommandErrorCode) -> Self {
        Self {
            code,
            failure: None,
        }
    }

    fn with_failure(code: PluginCommandErrorCode, failure: PluginOperationFailure) -> Self {
        Self {
            code,
            failure: Some(failure),
        }
    }
}

pub trait PluginLifecyclePort {
    fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure>;
    fn workspace_id(&self) -> Result<Option<String>, PluginOperationFailure> {
        Ok(None)
    }
    fn install_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
    fn update_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        self.install_manual(request)
    }
    fn install_local(
        &self,
        package_root: &std::path::Path,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
    fn uninstall(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginOperationFailure>;
    fn set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
}

/// Native workspace/package transaction coordinator executed after command
/// correlation and runtime shutdown. Implementations stage contribution
/// cleanup, invoke the supplied irreversible package action exactly once, and
/// commit or restore workspace rows before returning.
pub trait PluginContributionCleanupPort: Send + Sync + 'static {
    fn uninstall_with_contribution_cleanup(
        &self,
        plugin_id: &str,
        disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> Result<PluginSnapshot, PluginOperationFailure>,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
}

struct NoopPluginContributionCleanup;

impl PluginContributionCleanupPort for NoopPluginContributionCleanup {
    fn uninstall_with_contribution_cleanup(
        &self,
        _plugin_id: &str,
        _disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> Result<PluginSnapshot, PluginOperationFailure>,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        uninstall()
    }
}

impl<I, H, C> PluginLifecyclePort for PluginService<I, H, C>
where
    I: InstallationPort,
    H: HostLauncher,
    C: Clock,
{
    fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
        PluginService::snapshots(self).map_err(lifecycle_failure)
    }

    fn workspace_id(&self) -> Result<Option<String>, PluginOperationFailure> {
        PluginService::workspace_id(self).map_err(lifecycle_failure)
    }

    fn install_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        PluginService::install_manual(self, request).map_err(lifecycle_failure)
    }

    fn update_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        PluginService::update_manual(self, request).map_err(lifecycle_failure)
    }

    fn set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        if enabled {
            PluginService::enable(self, plugin_id).map_err(lifecycle_failure)
        } else {
            PluginService::disable(self, plugin_id).map_err(lifecycle_failure)
        }
    }

    fn install_local(
        &self,
        package_root: &std::path::Path,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        PluginService::install_local(self, package_root).map_err(lifecycle_failure)
    }

    fn uninstall(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginOperationFailure> {
        PluginService::uninstall(self, plugin_id).map_err(lifecycle_failure)
    }
}

fn lifecycle_failure(error: PluginServiceError) -> PluginOperationFailure {
    match error {
        PluginServiceError::Manager(error) => PluginOperationFailure {
            code: error.code_str(),
            message_key: error.message_key(),
        },
        PluginServiceError::HostMonitorUnavailable => PluginOperationFailure {
            code: "PLUGIN_HOST_MONITOR_UNAVAILABLE",
            message_key: "plugin.error.hostMonitorUnavailable",
        },
        PluginServiceError::StatePoisoned => PluginOperationFailure {
            code: "PLUGIN_LIFECYCLE_UNAVAILABLE",
            message_key: "plugin.error.lifecycleUnavailable",
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum QueuedAction {
    Install(ManualPackageRequest),
    InstallLocal {
        package_root: std::path::PathBuf,
    },
    Uninstall {
        plugin_id: String,
        contribution_disposition: PluginContributionDisposition,
    },
    SetEnabled {
        plugin_id: String,
        enabled: bool,
    },
}

impl QueuedAction {
    const fn kind(&self) -> PluginOperationKind {
        match self {
            Self::Install(_) | Self::InstallLocal { .. } => PluginOperationKind::Install,
            Self::Uninstall { .. } => PluginOperationKind::Uninstall,
            Self::SetEnabled { .. } => PluginOperationKind::SetEnabled,
        }
    }
}

#[derive(Clone)]
struct OperationRecord {
    snapshot: PluginOperationSnapshot,
    action: QueuedAction,
    terminal_at_ms: Option<u64>,
}

/// Application-owned plugin command core. Lifecycle mutations remain behind a
/// single reviewed native port; protocol-v2 capability traffic is handled by
/// the separate capability gateway and never enters this command queue.
pub struct PluginCommandService {
    lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync>,
    contribution_cleanup: Arc<dyn PluginContributionCleanupPort>,
    revision: u64,
    workspace_id: Option<String>,
    next_operation_id: u64,
    operations: BTreeMap<String, OperationRecord>,
    requests: BTreeMap<String, String>,
    plugin_snapshots: BTreeMap<String, PluginSnapshot>,
}

impl PluginCommandService {
    pub fn new(
        lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync>,
    ) -> Result<Self, PluginCommandError> {
        Self::new_with_contribution_cleanup(lifecycle, Arc::new(NoopPluginContributionCleanup))
    }

    pub fn new_with_contribution_cleanup(
        lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync>,
        contribution_cleanup: Arc<dyn PluginContributionCleanupPort>,
    ) -> Result<Self, PluginCommandError> {
        let initial = lifecycle.snapshots().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        let plugin_snapshots = collect_plugin_snapshots(initial)?;
        let workspace_id = lifecycle.workspace_id().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        Ok(Self {
            lifecycle,
            contribution_cleanup,
            revision: 1,
            workspace_id,
            next_operation_id: 1,
            operations: BTreeMap::new(),
            requests: BTreeMap::new(),
            plugin_snapshots,
        })
    }

    #[must_use]
    pub fn snapshot(&self) -> PluginCommandSnapshot {
        PluginCommandSnapshot {
            revision: self.revision,
            workspace_id: self.workspace_id.clone(),
            plugins: self.plugin_snapshots.values().cloned().collect(),
            operations: self
                .operations
                .values()
                .map(|record| record.snapshot.clone())
                .collect(),
        }
    }

    /// Native hook after host-exit polling or any lifecycle mutation performed
    /// outside this command service. A renderer snapshot is therefore never
    /// changed behind an unchanged application revision.
    pub fn refresh_lifecycle(&mut self) -> Result<u64, PluginCommandError> {
        let next = self.lifecycle.snapshots().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        let next = collect_plugin_snapshots(next)?;
        let workspace_id = self.lifecycle.workspace_id().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        if next != self.plugin_snapshots || workspace_id != self.workspace_id {
            self.ensure_revision_capacity(1)?;
            self.plugin_snapshots = next;
            self.workspace_id = workspace_id;
            self.bump_revision()?;
        }
        Ok(self.revision)
    }

    pub fn queue_install_local(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        package_root: std::path::PathBuf,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.queue(
            expected_revision,
            client_request_id,
            QueuedAction::InstallLocal { package_root },
        )
    }

    pub fn queue_uninstall(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        plugin_id: String,
        contribution_disposition: PluginContributionDisposition,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.queue(
            expected_revision,
            client_request_id,
            QueuedAction::Uninstall {
                plugin_id,
                contribution_disposition,
            },
        )
    }

    pub fn queue_install(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        request: ManualPackageRequest,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.queue(
            expected_revision,
            client_request_id,
            QueuedAction::Install(request),
        )
    }

    pub fn queue_set_enabled(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.queue(
            expected_revision,
            client_request_id,
            QueuedAction::SetEnabled { plugin_id, enabled },
        )
    }

    pub fn execute_next(
        &mut self,
        now_ms: u64,
    ) -> Result<Option<PluginOperationSnapshot>, PluginCommandError> {
        let next = self
            .operations
            .iter()
            .find(|(_, record)| record.snapshot.status == PluginOperationStatus::Queued)
            .map(|(operation_id, _)| operation_id.clone());
        next.map(|operation_id| self.execute(&operation_id, now_ms))
            .transpose()
    }

    pub fn execute(
        &mut self,
        operation_id: &str,
        now_ms: u64,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.prune_terminal_operations(now_ms);
        if let Some(record) = self.operations.get(operation_id) {
            if record.snapshot.status.is_terminal() {
                return Ok(record.snapshot.clone());
            }
        } else {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::OperationNotFound,
            ));
        }
        self.ensure_revision_capacity(2)?;
        let action = {
            let record = self.operations.get_mut(operation_id).ok_or_else(|| {
                PluginCommandError::new(PluginCommandErrorCode::OperationNotFound)
            })?;
            if record.snapshot.status != PluginOperationStatus::Queued {
                return Err(PluginCommandError::new(
                    PluginCommandErrorCode::OperationNotCancellable,
                ));
            }
            record.snapshot.status = PluginOperationStatus::Running;
            record.action.clone()
        };
        self.bump_revision()?;
        let result = self.execute_action(action);
        let record = self
            .operations
            .get_mut(operation_id)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::OperationNotFound))?;
        match result {
            Ok(()) => {
                record.snapshot.status = PluginOperationStatus::Completed;
                record.snapshot.failure = None;
            }
            Err(failure) => {
                record.snapshot.status = PluginOperationStatus::Failed;
                record.snapshot.failure = Some(failure);
            }
        }
        let snapshot = record.snapshot.clone();
        self.bump_revision()?;
        if let Some(record) = self.operations.get_mut(operation_id) {
            record.terminal_at_ms = Some(now_ms);
        }
        self.prune_terminal_operations(now_ms);
        Ok(snapshot)
    }

    pub fn cancel(
        &mut self,
        expected_revision: u64,
        operation_id: &str,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        if let Some(record) = self.operations.get(operation_id) {
            if record.snapshot.status.is_terminal() {
                return Ok(record.snapshot.clone());
            }
        } else {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::OperationNotFound,
            ));
        }
        self.expect_revision(expected_revision)?;
        self.ensure_revision_capacity(1)?;
        let record = self
            .operations
            .get_mut(operation_id)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::OperationNotFound))?;
        if record.snapshot.status != PluginOperationStatus::Queued {
            // Current real lifecycle and broker APIs are synchronous. Reporting
            // `cancelling` for a running call would be false; fail closed until
            // an upstream interrupt/cancel API exists.
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::OperationNotCancellable,
            ));
        }
        record.snapshot.status = PluginOperationStatus::Cancelled;
        record.terminal_at_ms = Some(0);
        let snapshot = record.snapshot.clone();
        self.bump_revision()?;
        self.prune_terminal_capacity();
        Ok(snapshot)
    }

    fn queue(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        action: QueuedAction,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        validate_request_id(&client_request_id)?;
        if let Some(operation_id) = self.requests.get(&client_request_id) {
            let existing = self.operations.get(operation_id).ok_or_else(|| {
                PluginCommandError::new(PluginCommandErrorCode::OperationNotFound)
            })?;
            return if existing.action == action {
                Ok(existing.snapshot.clone())
            } else {
                Err(PluginCommandError::new(
                    PluginCommandErrorCode::RequestConflict,
                ))
            };
        }
        self.expect_revision(expected_revision)?;
        self.ensure_revision_capacity(1)?;
        self.prune_terminal_capacity();
        if self
            .operations
            .values()
            .filter(|record| !record.snapshot.status.is_terminal())
            .count()
            >= MAX_ACTIVE_OPERATIONS
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        let operation_id = format!("plugin-op-{:016x}", self.next_operation_id);
        self.next_operation_id = self
            .next_operation_id
            .checked_add(1)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::RegistryLimit))?;
        let snapshot = PluginOperationSnapshot {
            operation_id: operation_id.clone(),
            client_request_id: client_request_id.clone(),
            kind: action.kind(),
            status: PluginOperationStatus::Queued,
            failure: None,
        };
        self.operations.insert(
            operation_id.clone(),
            OperationRecord {
                snapshot: snapshot.clone(),
                action,
                terminal_at_ms: None,
            },
        );
        self.requests.insert(client_request_id, operation_id);
        self.bump_revision()?;
        Ok(snapshot)
    }

    fn execute_action(&mut self, action: QueuedAction) -> Result<(), PluginOperationFailure> {
        match action {
            QueuedAction::Install(request) => {
                let snapshot = if self.plugin_snapshots.contains_key(&request.plugin_id) {
                    self.lifecycle.update_manual(&request)?
                } else {
                    self.lifecycle.install_manual(&request)?
                };
                self.upsert_plugin_snapshot(snapshot);
                Ok(())
            }
            QueuedAction::InstallLocal { package_root } => {
                let snapshot = self.lifecycle.install_local(&package_root)?;
                self.upsert_plugin_snapshot(snapshot);
                Ok(())
            }
            QueuedAction::Uninstall {
                plugin_id,
                contribution_disposition,
            } => {
                // Stop the guest before touching workspace contributions.  It
                // must not be able to recreate an owned row in the interval
                // between the cleanup transaction and package removal.
                let disabled = self.lifecycle.set_enabled(&plugin_id, false)?;
                self.upsert_plugin_snapshot(disabled);
                let lifecycle = Arc::clone(&self.lifecycle);
                let uninstall_plugin_id = plugin_id.clone();
                let mut uninstall = move || lifecycle.uninstall(&uninstall_plugin_id);
                self.contribution_cleanup
                    .uninstall_with_contribution_cleanup(
                        &plugin_id,
                        contribution_disposition,
                        &mut uninstall,
                    )?;
                self.plugin_snapshots.remove(&plugin_id);
                Ok(())
            }
            QueuedAction::SetEnabled { plugin_id, enabled } => {
                let snapshot = self.lifecycle.set_enabled(&plugin_id, enabled)?;
                self.upsert_plugin_snapshot(snapshot);
                Ok(())
            }
        }
    }

    fn expect_revision(&self, expected: u64) -> Result<(), PluginCommandError> {
        if expected == self.revision {
            Ok(())
        } else {
            Err(PluginCommandError::new(
                PluginCommandErrorCode::RevisionConflict,
            ))
        }
    }

    fn upsert_plugin_snapshot(&mut self, snapshot: PluginSnapshot) {
        self.plugin_snapshots
            .insert(snapshot.artifact.plugin_id.clone(), snapshot);
    }

    fn bump_revision(&mut self) -> Result<(), PluginCommandError> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::RegistryLimit))?;
        Ok(())
    }

    fn ensure_revision_capacity(&self, increments: u64) -> Result<(), PluginCommandError> {
        self.revision
            .checked_add(increments)
            .map(|_| ())
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::RegistryLimit))
    }

    fn prune_terminal_operations(&mut self, now_ms: u64) {
        let expired: Vec<_> = self
            .operations
            .iter()
            .filter_map(|(operation_id, record)| {
                let terminal_at = record.terminal_at_ms?;
                (terminal_at > 0
                    && now_ms.saturating_sub(terminal_at) > COMPLETED_OPERATION_RETENTION_MS)
                    .then(|| operation_id.clone())
            })
            .collect();
        for operation_id in expired {
            self.remove_operation(&operation_id);
        }
        self.prune_terminal_capacity();
    }

    fn prune_terminal_capacity(&mut self) {
        let excess = self
            .operations
            .values()
            .filter(|record| record.snapshot.status.is_terminal())
            .count()
            .saturating_sub(MAX_COMPLETED_OPERATIONS);
        let removals: Vec<_> = self
            .operations
            .iter()
            .filter(|(_, record)| record.snapshot.status.is_terminal())
            .take(excess)
            .map(|(operation_id, _)| operation_id.clone())
            .collect();
        for operation_id in removals {
            self.remove_operation(&operation_id);
        }
    }

    fn remove_operation(&mut self, operation_id: &str) {
        let Some(record) = self.operations.remove(operation_id) else {
            return;
        };
        if self
            .requests
            .get(&record.snapshot.client_request_id)
            .map(String::as_str)
            == Some(operation_id)
        {
            self.requests.remove(&record.snapshot.client_request_id);
        }
    }
}

fn collect_plugin_snapshots(
    snapshots: Vec<PluginSnapshot>,
) -> Result<BTreeMap<String, PluginSnapshot>, PluginCommandError> {
    let mut collected = BTreeMap::new();
    for snapshot in snapshots {
        let plugin_id = snapshot.artifact.plugin_id.clone();
        if collected.insert(plugin_id, snapshot).is_some() {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::LifecycleUnavailable,
            ));
        }
    }
    Ok(collected)
}

fn validate_request_id(value: &str) -> Result<(), PluginCommandError> {
    if value.is_empty()
        || value.len() > MAX_REQUEST_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        Err(PluginCommandError::new(
            PluginCommandErrorCode::RequestConflict,
        ))
    } else {
        Ok(())
    }
}
