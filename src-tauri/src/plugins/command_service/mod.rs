//! Application-owned command state for the native plugin surface.
//!
//! This module contains no Tauri command and exposes no path, handle, secret,
//! serial writer, repository verifier, or host internals. A future command
//! adapter may map these native values to reviewed DTOs after wiring the
//! explicit upstream ports below.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use bbcom_contracts::RuntimeInstanceKey;
use bbcom_plugin_broker::{
    AuditSink, BrokerAction, BrokerError, DeclarativePanel, DeclarativePanelBroker, HostedPanel,
    NoActionReason, PanelControlKind, PanelEvent, PanelEventAction, PanelField, ProposalContext,
    ProposalDecision, ProposalResolution, SerialProposalBroker, SerialProposalRequest,
    SerialProposalView,
};
use bbcom_plugin_contracts::Permission;
use bbcom_plugin_contracts::generated::{ProposalOutcomeValue, ProposalResult, envelope};
use bbcom_plugin_manager::{
    Clock, HostLauncher, HostPanel, HostPanelFieldKind, HostPublishedPanel, InstallationPort,
    ManualPackageRequest, PluginSnapshot,
};

/// Terminal proposal outcome pushed to a sidecar parked on its guest call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostProposalOutcome {
    Approved,
    Rejected,
    Expired,
}

use super::service::{PluginService, PluginServiceError};

const MAX_ACTIVE_OPERATIONS: usize = 128;
const MAX_COMPLETED_OPERATIONS: usize = 256;
const COMPLETED_OPERATION_RETENTION_MS: u64 = 15 * 60 * 1_000;
const MAX_PENDING_PANELS: usize = 128;
const MAX_PENDING_PROPOSALS: usize = 1_024;
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
    use bbcom_plugin_broker::NoopAuditSink;
    use bbcom_plugin_manager::{
        PluginArtifact, PluginArtifactSource, PluginSourceKind, PluginStatus,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    struct Upstream;

    impl PluginCommandUpstreamPort for Upstream {
        fn current_proposal_context(
            &mut self,
            _proposal: &SerialProposalView,
        ) -> Result<ProposalContext, PluginUpstreamFailure> {
            Err(PluginUpstreamFailure::ProposalContextUnavailable)
        }

        fn execute_serial_action(
            &mut self,
            _runtime: RuntimeInstanceKey,
            _action: BrokerAction,
        ) -> Result<(), PluginUpstreamFailure> {
            Err(PluginUpstreamFailure::SerialExecutionUnavailable)
        }

        fn deliver_panel_event(
            &mut self,
            _action: PanelEventAction,
        ) -> Result<(), PluginUpstreamFailure> {
            Err(PluginUpstreamFailure::PanelDeliveryUnavailable)
        }
    }

    fn failure() -> PluginOperationFailure {
        PluginOperationFailure {
            code: "TEST_FAILURE",
            message_key: "plugin.error.test",
        }
    }

    fn service() -> PluginCommandService {
        let audit: &'static NoopAuditSink = Box::leak(Box::new(NoopAuditSink));
        PluginCommandService::new(
            Arc::new(Lifecycle),
            Box::new(Upstream),
            Box::new(SerialProposalBroker::new(audit)),
            Box::new(DeclarativePanelBroker::new(audit)),
        )
        .unwrap()
    }

    #[test]
    fn five_thousand_terminal_operations_keep_registry_and_correlations_bounded() {
        let mut service = service();
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

        // Advancing beyond retention removes the old request correlations too.
        let queued = service
            .queue_set_enabled(
                snapshot.revision,
                "request-after-retention".to_owned(),
                "dev.bbcom.fixture".to_owned(),
                true,
            )
            .unwrap();
        service
            .execute(
                &queued.operation_id,
                COMPLETED_OPERATION_RETENTION_MS + 10_000,
            )
            .unwrap();
        assert!(service.snapshot().operations.len() <= MAX_COMPLETED_OPERATIONS);
    }

    struct RunningLifecycle(PluginSnapshot);

    impl PluginLifecyclePort for RunningLifecycle {
        fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
            Ok(vec![self.0.clone()])
        }
        fn workspace_id(&self) -> Result<Option<String>, PluginOperationFailure> {
            Ok(Some("11111111-1111-1111-1111-111111111111".to_owned()))
        }
        fn install_manual(
            &self,
            _: &ManualPackageRequest,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            Ok(self.0.clone())
        }
        fn install_local(
            &self,
            _: &std::path::Path,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            Ok(self.0.clone())
        }
        fn uninstall(&self, _: &str) -> Result<PluginSnapshot, PluginOperationFailure> {
            Ok(self.0.clone())
        }
        fn set_enabled(&self, _: &str, _: bool) -> Result<PluginSnapshot, PluginOperationFailure> {
            Ok(self.0.clone())
        }
    }

    struct CountingUpstream(Arc<AtomicUsize>);

    impl PluginCommandUpstreamPort for CountingUpstream {
        fn current_proposal_context(
            &mut self,
            proposal: &SerialProposalView,
        ) -> Result<ProposalContext, PluginUpstreamFailure> {
            Ok(ProposalContext {
                operation_id: proposal.operation_id.clone(),
                session_id: proposal.session_id.clone(),
            })
        }
        fn execute_serial_action(
            &mut self,
            _: RuntimeInstanceKey,
            _: BrokerAction,
        ) -> Result<(), PluginUpstreamFailure> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        fn deliver_panel_event(
            &mut self,
            _: PanelEventAction,
        ) -> Result<(), PluginUpstreamFailure> {
            Ok(())
        }
    }

    fn running_snapshot() -> PluginSnapshot {
        PluginSnapshot {
            artifact: PluginArtifact::new(
                "dev.bbcom.fixture",
                "1.0.0",
                "a".repeat(64),
                "b".repeat(64),
                PluginArtifactSource {
                    source_id: "local".to_owned(),
                    kind: PluginSourceKind::LocalPackage,
                },
                [Permission::SerialWriteProposal],
            )
            .unwrap(),
            expected_enabled: true,
            status: PluginStatus::Running,
            pending_version: None,
            running_instance_id: Some(7),
            generation: 3,
            crashes_in_window: 0,
            last_error: None,
        }
    }

    fn proposal(index: u8) -> SerialProposalRequest {
        SerialProposalRequest {
            operation_id: format!("operation-{index}"),
            session_id: "session-1".to_owned(),
            payload: vec![index],
            display_label: "send".to_owned(),
        }
    }

    fn proposal_service(counter: Arc<AtomicUsize>) -> PluginCommandService {
        let audit: &'static NoopAuditSink = Box::leak(Box::new(NoopAuditSink));
        PluginCommandService::new(
            Arc::new(RunningLifecycle(running_snapshot())),
            Box::new(CountingUpstream(counter)),
            Box::new(SerialProposalBroker::new(audit)),
            Box::new(DeclarativePanelBroker::new(audit)),
        )
        .unwrap()
    }

    #[test]
    fn first_write_decision_is_reused_only_within_the_runtime_generation() {
        let count = Arc::new(AtomicUsize::new(0));
        let mut service = proposal_service(Arc::clone(&count));
        let declared = BTreeSet::from([Permission::SerialWriteProposal]);
        let first = service
            .register_proposal("dev.bbcom.fixture", &declared, proposal(1), None, 1)
            .unwrap();
        assert_eq!(service.snapshot().proposals.len(), 1);
        let queued = service
            .queue_proposal_decision(
                service.snapshot().revision,
                "approve-first".to_owned(),
                first.proposal_id,
                ProposalDecision::Approve,
            )
            .unwrap();
        assert_eq!(
            service.execute(&queued.operation_id, 2).unwrap().status,
            PluginOperationStatus::Completed
        );
        assert_eq!(count.load(Ordering::Relaxed), 1);

        service
            .register_proposal("dev.bbcom.fixture", &declared, proposal(2), None, 3)
            .unwrap();
        assert!(service.snapshot().proposals.is_empty());
        assert_eq!(count.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn rejection_is_cached_and_suppresses_later_prompts_and_writes() {
        let count = Arc::new(AtomicUsize::new(0));
        let mut service = proposal_service(Arc::clone(&count));
        let declared = BTreeSet::from([Permission::SerialWriteProposal]);
        let first = service
            .register_proposal("dev.bbcom.fixture", &declared, proposal(1), None, 1)
            .unwrap();
        let queued = service
            .queue_proposal_decision(
                service.snapshot().revision,
                "reject-first".to_owned(),
                first.proposal_id,
                ProposalDecision::Reject,
            )
            .unwrap();
        service.execute(&queued.operation_id, 2).unwrap();
        service
            .register_proposal("dev.bbcom.fixture", &declared, proposal(2), None, 3)
            .unwrap();
        assert!(service.snapshot().proposals.is_empty());
        assert_eq!(count.load(Ordering::Relaxed), 0);
    }

    /// Lifecycle wrapper that records pushed envelopes so tests can assert
    /// parked sidecar calls receive their correlated outcome.
    struct RecordingLifecycle {
        inner: RunningLifecycle,
        delivered: std::sync::Mutex<Vec<(String, String, i32)>>,
    }

    impl PluginLifecyclePort for RecordingLifecycle {
        fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
            self.inner.snapshots()
        }
        fn workspace_id(&self) -> Result<Option<String>, PluginOperationFailure> {
            self.inner.workspace_id()
        }
        fn install_manual(
            &self,
            request: &ManualPackageRequest,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.inner.install_manual(request)
        }
        fn install_local(
            &self,
            package_root: &std::path::Path,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.inner.install_local(package_root)
        }
        fn uninstall(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.inner.uninstall(plugin_id)
        }
        fn set_enabled(
            &self,
            plugin_id: &str,
            enabled: bool,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.inner.set_enabled(plugin_id, enabled)
        }
        fn deliver_envelope(
            &self,
            plugin_id: &str,
            payload: envelope::Payload,
        ) -> Result<(), PluginOperationFailure> {
            if let envelope::Payload::ProposalResult(result) = payload {
                self.delivered
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((plugin_id.to_owned(), result.proposal_id, result.outcome));
            }
            Ok(())
        }
    }

    #[test]
    fn correlated_proposals_push_their_outcome_back_to_the_sidecar() {
        let count = Arc::new(AtomicUsize::new(0));
        let audit: &'static NoopAuditSink = Box::leak(Box::new(NoopAuditSink));
        let recording = Arc::new(RecordingLifecycle {
            inner: RunningLifecycle(running_snapshot()),
            delivered: std::sync::Mutex::new(Vec::new()),
        });
        let mut service = PluginCommandService::new(
            recording.clone(),
            Box::new(CountingUpstream(Arc::clone(&count))),
            Box::new(SerialProposalBroker::new(audit)),
            Box::new(DeclarativePanelBroker::new(audit)),
        )
        .unwrap();
        let declared = BTreeSet::from([Permission::SerialWriteProposal]);

        let approved = service
            .register_proposal(
                "dev.bbcom.fixture",
                &declared,
                proposal(1),
                Some("sidecar-proposal-1".to_owned()),
                1,
            )
            .unwrap();
        let queued = service
            .queue_proposal_decision(
                service.snapshot().revision,
                "approve".to_owned(),
                approved.proposal_id,
                ProposalDecision::Approve,
            )
            .unwrap();
        service.execute(&queued.operation_id, 2).unwrap();

        // A second proposal under the cached approval auto-resolves and
        // still pushes its correlated outcome without a renderer decision.
        service
            .register_proposal(
                "dev.bbcom.fixture",
                &declared,
                proposal(2),
                Some("sidecar-proposal-2".to_owned()),
                3,
            )
            .unwrap();

        // Rejection outcome uses a fresh service (the approve cache is
        // per-generation by design).
        let recording_reject = Arc::new(RecordingLifecycle {
            inner: RunningLifecycle(running_snapshot()),
            delivered: std::sync::Mutex::new(Vec::new()),
        });
        let mut reject_service = PluginCommandService::new(
            recording_reject.clone(),
            Box::new(CountingUpstream(Arc::clone(&count))),
            Box::new(SerialProposalBroker::new(audit)),
            Box::new(DeclarativePanelBroker::new(audit)),
        )
        .unwrap();
        let rejected = reject_service
            .register_proposal(
                "dev.bbcom.fixture",
                &declared,
                proposal(1),
                Some("sidecar-proposal-3".to_owned()),
                1,
            )
            .unwrap();
        let queued = reject_service
            .queue_proposal_decision(
                reject_service.snapshot().revision,
                "reject".to_owned(),
                rejected.proposal_id,
                ProposalDecision::Reject,
            )
            .unwrap();
        reject_service.execute(&queued.operation_id, 2).unwrap();
        assert_eq!(
            recording_reject
                .delivered
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
            vec![(
                "dev.bbcom.fixture".to_owned(),
                "sidecar-proposal-3".to_owned(),
                ProposalOutcomeValue::Rejected as i32
            )]
        );

        let delivered = recording
            .delivered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(
            delivered,
            vec![
                (
                    "dev.bbcom.fixture".to_owned(),
                    "sidecar-proposal-1".to_owned(),
                    ProposalOutcomeValue::Approved as i32
                ),
                (
                    "dev.bbcom.fixture".to_owned(),
                    "sidecar-proposal-2".to_owned(),
                    ProposalOutcomeValue::Approved as i32
                ),
            ]
        );
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
    ProposalDecision,
    PanelEvent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginUpstreamFailure {
    ProposalContextUnavailable,
    SerialExecutionUnavailable,
    PanelDeliveryUnavailable,
}

impl PluginUpstreamFailure {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProposalContextUnavailable => "PLUGIN_PROPOSAL_CONTEXT_UNAVAILABLE",
            Self::SerialExecutionUnavailable => "PLUGIN_SERIAL_EXECUTION_UNAVAILABLE",
            Self::PanelDeliveryUnavailable => "PLUGIN_PANEL_DELIVERY_UNAVAILABLE",
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::ProposalContextUnavailable => "plugin.error.proposalContextUnavailable",
            Self::SerialExecutionUnavailable => "plugin.error.serialExecutionUnavailable",
            Self::PanelDeliveryUnavailable => "plugin.error.panelDeliveryUnavailable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginOperationFailure {
    pub code: &'static str,
    pub message_key: &'static str,
}

impl PluginOperationFailure {
    fn broker(error: BrokerError) -> Self {
        Self {
            code: error.code().as_str(),
            message_key: error.message_key(),
        }
    }

    fn upstream(error: PluginUpstreamFailure) -> Self {
        Self {
            code: error.code(),
            message_key: error.message_key(),
        }
    }
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
    pub proposals: Vec<SerialProposalView>,
    pub panels: Vec<HostedPanel>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginCommandErrorCode {
    RevisionConflict,
    RequestConflict,
    RegistryLimit,
    OperationNotFound,
    OperationNotCancellable,
    ProposalNotFound,
    PanelNotFound,
    LifecycleUnavailable,
    BrokerRejected,
    UpstreamUnavailable,
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
            Self::ProposalNotFound => "PLUGIN_PROPOSAL_NOT_FOUND",
            Self::PanelNotFound => "PLUGIN_PANEL_NOT_FOUND",
            Self::LifecycleUnavailable => "PLUGIN_LIFECYCLE_UNAVAILABLE",
            Self::BrokerRejected => "PLUGIN_BROKER_REJECTED",
            Self::UpstreamUnavailable => "PLUGIN_UPSTREAM_UNAVAILABLE",
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
    fn take_published_panels(&self) -> Result<Vec<HostPublishedPanel>, PluginOperationFailure> {
        Ok(Vec::new())
    }
    /// Push an unsolicited envelope (proposal decision, session-query data)
    /// into the plugin's own sidecar process. Default: unavailable.
    fn deliver_envelope(
        &self,
        _plugin_id: &str,
        _payload: bbcom_plugin_contracts::generated::envelope::Payload,
    ) -> Result<(), PluginOperationFailure> {
        Err(PluginOperationFailure {
            code: "PLUGIN_HOST_DELIVERY_UNAVAILABLE",
            message_key: "plugin.error.hostDeliveryUnavailable",
        })
    }
    fn invoke_panel_event(
        &self,
        _plugin_id: &str,
        _field_id: &str,
        _value: &str,
    ) -> Result<Option<HostPanel>, PluginOperationFailure> {
        Err(PluginOperationFailure {
            code: "PLUGIN_PANEL_DELIVERY_UNAVAILABLE",
            message_key: "plugin.error.panelDeliveryUnavailable",
        })
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

    fn take_published_panels(&self) -> Result<Vec<HostPublishedPanel>, PluginOperationFailure> {
        PluginService::take_published_panels(self).map_err(lifecycle_failure)
    }

    fn invoke_panel_event(
        &self,
        plugin_id: &str,
        field_id: &str,
        value: &str,
    ) -> Result<Option<HostPanel>, PluginOperationFailure> {
        PluginService::invoke_panel_event(self, plugin_id, field_id, value)
            .map_err(lifecycle_failure)
    }

    fn deliver_envelope(
        &self,
        plugin_id: &str,
        payload: envelope::Payload,
    ) -> Result<(), PluginOperationFailure> {
        PluginService::deliver_envelope(self, plugin_id, payload).map_err(lifecycle_failure)
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

fn host_panel_to_broker(panel: HostPanel) -> DeclarativePanel {
    DeclarativePanel {
        title: panel.title,
        fields: panel
            .fields
            .into_iter()
            .map(|field| PanelField {
                id: field.id,
                label: field.label,
                kind: match field.kind {
                    HostPanelFieldKind::Text => PanelControlKind::Text,
                    HostPanelFieldKind::Number => PanelControlKind::Number,
                    HostPanelFieldKind::Toggle => PanelControlKind::Toggle,
                    HostPanelFieldKind::Select => PanelControlKind::Select,
                    HostPanelFieldKind::Button => PanelControlKind::Button,
                },
                value: field.value,
                options: field.options,
                disabled: field.disabled,
            })
            .collect(),
    }
}

pub trait ProposalBrokerPort {
    fn create(
        &mut self,
        plugin_id: &str,
        declared: &BTreeSet<Permission>,
        request: SerialProposalRequest,
        now_ms: u64,
    ) -> Result<SerialProposalView, BrokerError>;

    fn resolve(
        &mut self,
        proposal_id: &str,
        decision: ProposalDecision,
        current: &ProposalContext,
        now_ms: u64,
    ) -> ProposalResolution;
}

impl<'a, A: AuditSink> ProposalBrokerPort for SerialProposalBroker<'a, A> {
    fn create(
        &mut self,
        plugin_id: &str,
        declared: &BTreeSet<Permission>,
        request: SerialProposalRequest,
        now_ms: u64,
    ) -> Result<SerialProposalView, BrokerError> {
        SerialProposalBroker::create(self, plugin_id, declared, request, now_ms)
    }

    fn resolve(
        &mut self,
        proposal_id: &str,
        decision: ProposalDecision,
        current: &ProposalContext,
        now_ms: u64,
    ) -> ProposalResolution {
        SerialProposalBroker::resolve(self, proposal_id, decision, current, now_ms)
    }
}

pub trait PanelBrokerPort {
    fn publish(&self, plugin_id: &str, panel: DeclarativePanel)
    -> Result<HostedPanel, BrokerError>;

    fn event(
        &self,
        hosted: &HostedPanel,
        event: PanelEvent,
    ) -> Result<PanelEventAction, BrokerError>;
}

impl<'a, A: AuditSink> PanelBrokerPort for DeclarativePanelBroker<'a, A> {
    fn publish(
        &self,
        plugin_id: &str,
        panel: DeclarativePanel,
    ) -> Result<HostedPanel, BrokerError> {
        DeclarativePanelBroker::publish(self, plugin_id, panel)
    }

    fn event(
        &self,
        hosted: &HostedPanel,
        event: PanelEvent,
    ) -> Result<PanelEventAction, BrokerError> {
        DeclarativePanelBroker::event(self, hosted, event)
    }
}

/// Missing native integrations are explicit and fail closed.
///
/// Implementations obtain current proposal context from application-owned
/// state. `execute_serial_action` is the only place an
/// approved broker action may reach the serial subsystem. `deliver_panel_event`
/// is the only place a validated event may reach a host. No permissive default
/// implementation exists.
pub trait PluginCommandUpstreamPort {
    fn current_proposal_context(
        &mut self,
        proposal: &SerialProposalView,
    ) -> Result<ProposalContext, PluginUpstreamFailure>;

    fn execute_serial_action(
        &mut self,
        runtime: RuntimeInstanceKey,
        action: BrokerAction,
    ) -> Result<(), PluginUpstreamFailure>;

    fn deliver_panel_event(
        &mut self,
        action: PanelEventAction,
    ) -> Result<(), PluginUpstreamFailure>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum QueuedAction {
    Install(ManualPackageRequest),
    InstallLocal {
        package_root: std::path::PathBuf,
    },
    Uninstall {
        plugin_id: String,
    },
    SetEnabled {
        plugin_id: String,
        enabled: bool,
    },
    ProposalDecision {
        proposal_id: String,
        decision: ProposalDecision,
    },
    PanelEvent {
        plugin_id: String,
        event: PanelEvent,
    },
}

impl QueuedAction {
    const fn kind(&self) -> PluginOperationKind {
        match self {
            Self::Install(_) | Self::InstallLocal { .. } => PluginOperationKind::Install,
            Self::Uninstall { .. } => PluginOperationKind::Uninstall,
            Self::SetEnabled { .. } => PluginOperationKind::SetEnabled,
            Self::ProposalDecision { .. } => PluginOperationKind::ProposalDecision,
            Self::PanelEvent { .. } => PluginOperationKind::PanelEvent,
        }
    }
}

#[derive(Clone)]
struct OperationRecord {
    snapshot: PluginOperationSnapshot,
    action: QueuedAction,
    terminal_at_ms: Option<u64>,
}

/// Application-owned plugin command core. The five reviewed native ports are
/// dyn objects because production wiring has exactly one implementation of
/// each; the port traits remain the reviewed contract every implementation
/// (including test fakes) must satisfy before it is boxed or shared here.
pub struct PluginCommandService {
    lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync>,
    upstream: Box<dyn PluginCommandUpstreamPort + Send>,
    proposals: Box<dyn ProposalBrokerPort + Send>,
    panels: Box<dyn PanelBrokerPort + Send>,
    revision: u64,
    workspace_id: Option<String>,
    next_operation_id: u64,
    operations: BTreeMap<String, OperationRecord>,
    requests: BTreeMap<String, String>,
    proposal_views: BTreeMap<String, SerialProposalView>,
    proposal_generations: BTreeMap<String, u64>,
    /// Broker proposal id → sidecar correlation id for parked guest calls.
    proposal_correlations: BTreeMap<String, String>,
    hosted_panels: BTreeMap<String, HostedPanel>,
    panel_generations: BTreeMap<String, u64>,
    serial_write_decisions: BTreeMap<(String, u64), bool>,
    plugin_snapshots: BTreeMap<String, PluginSnapshot>,
}

impl PluginCommandService {
    pub fn new(
        lifecycle: Arc<dyn PluginLifecyclePort + Send + Sync>,
        upstream: Box<dyn PluginCommandUpstreamPort + Send>,
        proposals: Box<dyn ProposalBrokerPort + Send>,
        panels: Box<dyn PanelBrokerPort + Send>,
    ) -> Result<Self, PluginCommandError> {
        let initial = lifecycle.snapshots().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        let plugin_snapshots = collect_plugin_snapshots(initial)?;
        let workspace_id = lifecycle.workspace_id().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        let mut service = Self {
            lifecycle,
            upstream,
            proposals,
            panels,
            revision: 1,
            workspace_id,
            next_operation_id: 1,
            operations: BTreeMap::new(),
            requests: BTreeMap::new(),
            proposal_views: BTreeMap::new(),
            proposal_generations: BTreeMap::new(),
            proposal_correlations: BTreeMap::new(),
            hosted_panels: BTreeMap::new(),
            panel_generations: BTreeMap::new(),
            serial_write_decisions: BTreeMap::new(),
            plugin_snapshots,
        };
        if let Err(error) = service.ingest_published_panels() {
            if error.code == PluginCommandErrorCode::BrokerRejected {
                tracing::warn!(
                    "ignoring a broker-rejected plugin panel during command-service bootstrap"
                );
            } else {
                return Err(error);
            }
        }
        Ok(service)
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
            proposals: self.proposal_views.values().cloned().collect(),
            panels: self.hosted_panels.values().cloned().collect(),
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
            self.reconcile_runtime_instances();
            self.bump_revision()?;
        }
        self.ingest_published_panels()?;
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
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        self.queue(
            expected_revision,
            client_request_id,
            QueuedAction::Uninstall { plugin_id },
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

    /// Trusted host ingress. `plugin_id` and `declared` come from the native running
    /// instance, never from a renderer request. `correlation` is the sidecar's
    /// own proposal id: when present, terminal outcomes are pushed back so the
    /// parked guest `propose-serial-send` call can resolve.
    pub fn register_proposal(
        &mut self,
        plugin_id: &str,
        declared: &BTreeSet<Permission>,
        request: SerialProposalRequest,
        correlation: Option<String>,
        now_ms: u64,
    ) -> Result<SerialProposalView, PluginCommandError> {
        // Drop proposals whose broker TTL already elapsed: their parked
        // sidecar calls resolved themselves as cancelled, so registry slots
        // and correlation entries must not accumulate across re-propose
        // loops.
        let expired: Vec<String> = self
            .proposal_views
            .iter()
            .filter(|(_, view)| now_ms >= view.expires_at_ms)
            .map(|(proposal_id, _)| proposal_id.clone())
            .collect();
        for proposal_id in expired {
            self.proposal_views.remove(&proposal_id);
            self.proposal_generations.remove(&proposal_id);
            self.proposal_correlations.remove(&proposal_id);
        }
        if self.proposal_views.len() >= MAX_PENDING_PROPOSALS {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        self.ensure_revision_capacity(1)?;
        let generation = self.running_generation(plugin_id)?;
        let view = self
            .proposals
            .create(plugin_id, declared, request, now_ms)
            .map_err(|error| {
                PluginCommandError::with_failure(
                    PluginCommandErrorCode::BrokerRejected,
                    PluginOperationFailure::broker(error),
                )
            })?;
        if let Some(approved) = self
            .serial_write_decisions
            .get(&(plugin_id.to_owned(), generation))
            .copied()
        {
            // Cached per-generation decision: resolve immediately. The
            // correlation must be registered before resolution so the
            // outcome push below can find it.
            if let Some(correlation) = correlation {
                self.proposal_correlations
                    .insert(view.proposal_id.clone(), correlation);
            }
            let current = self
                .upstream
                .current_proposal_context(&view)
                .map_err(|error| {
                    PluginCommandError::with_failure(
                        PluginCommandErrorCode::UpstreamUnavailable,
                        PluginOperationFailure::upstream(error),
                    )
                })?;
            let resolution = self.proposals.resolve(
                &view.proposal_id,
                if approved {
                    ProposalDecision::Approve
                } else {
                    ProposalDecision::Reject
                },
                &current,
                now_ms,
            );
            match resolution {
                ProposalResolution::Action(action) => {
                    let runtime = self.running_instance_key(plugin_id)?;
                    self.upstream
                        .execute_serial_action(runtime, action)
                        .map_err(|error| {
                            PluginCommandError::with_failure(
                                PluginCommandErrorCode::UpstreamUnavailable,
                                PluginOperationFailure::upstream(error),
                            )
                        })?;
                    // Cache the approval only after the action executed:
                    // a failed execution must not seed an auto-approve for
                    // the rest of this instance's lifetime.
                    self.serial_write_decisions
                        .insert((plugin_id.to_owned(), generation), true);
                    self.deliver_proposal_outcome(
                        plugin_id,
                        &view.proposal_id,
                        HostProposalOutcome::Approved,
                    );
                }
                ProposalResolution::NoAction(NoActionReason::Rejected) => {
                    self.deliver_proposal_outcome(
                        plugin_id,
                        &view.proposal_id,
                        HostProposalOutcome::Rejected,
                    );
                }
                ProposalResolution::NoAction(NoActionReason::Expired) => {
                    self.deliver_proposal_outcome(
                        plugin_id,
                        &view.proposal_id,
                        HostProposalOutcome::Expired,
                    );
                }
                ProposalResolution::NoAction(
                    NoActionReason::ContextChanged | NoActionReason::UnknownOrConsumed,
                ) => {}
            }
            self.proposal_correlations.remove(&view.proposal_id);
        } else {
            if let Some(correlation) = correlation {
                self.proposal_correlations
                    .insert(view.proposal_id.clone(), correlation);
            }
            self.proposal_generations
                .insert(view.proposal_id.clone(), generation);
            self.proposal_views
                .insert(view.proposal_id.clone(), view.clone());
        }
        self.bump_revision()?;
        Ok(view)
    }

    /// Best-effort push of a terminal proposal outcome to the parked sidecar
    /// call. Delivery failure is logged only: the sidecar's own TTL bound
    /// resolves the call even when this push cannot be delivered.
    fn deliver_proposal_outcome(
        &self,
        plugin_id: &str,
        broker_proposal_id: &str,
        outcome: HostProposalOutcome,
    ) {
        let Some(correlation) = self.proposal_correlations.get(broker_proposal_id) else {
            return;
        };
        let payload = envelope::Payload::ProposalResult(ProposalResult {
            proposal_id: correlation.clone(),
            outcome: match outcome {
                HostProposalOutcome::Approved => ProposalOutcomeValue::Approved,
                HostProposalOutcome::Rejected => ProposalOutcomeValue::Rejected,
                HostProposalOutcome::Expired => ProposalOutcomeValue::Expired,
            } as i32,
        });
        if let Err(error) = self.lifecycle.deliver_envelope(plugin_id, payload) {
            tracing::warn!(
                "proposal outcome push failed for {plugin_id} ({broker_proposal_id}): {}",
                error.code
            );
        }
    }

    pub fn queue_proposal_decision(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        proposal_id: String,
        decision: ProposalDecision,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        let action = QueuedAction::ProposalDecision {
            proposal_id: proposal_id.clone(),
            decision,
        };
        if !self.requests.contains_key(&client_request_id)
            && !self.proposal_views.contains_key(&proposal_id)
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::ProposalNotFound,
            ));
        }
        self.queue(expected_revision, client_request_id, action)
    }

    /// Trusted host ingress. The broker validates the complete declarative
    /// panel before it becomes visible to command snapshots.
    pub fn publish_panel(
        &mut self,
        plugin_id: &str,
        panel: DeclarativePanel,
    ) -> Result<HostedPanel, PluginCommandError> {
        if !self.hosted_panels.contains_key(plugin_id)
            && self.hosted_panels.len() >= MAX_PENDING_PANELS
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        self.ensure_revision_capacity(1)?;
        let hosted = self.panels.publish(plugin_id, panel).map_err(|error| {
            PluginCommandError::with_failure(
                PluginCommandErrorCode::BrokerRejected,
                PluginOperationFailure::broker(error),
            )
        })?;
        self.hosted_panels
            .insert(hosted.plugin_id().to_owned(), hosted.clone());
        self.panel_generations
            .insert(plugin_id.to_owned(), self.running_generation(plugin_id)?);
        self.bump_revision()?;
        Ok(hosted)
    }

    pub fn queue_panel_event(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        plugin_id: String,
        event: PanelEvent,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        if !self.hosted_panels.contains_key(&plugin_id) {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::PanelNotFound,
            ));
        }
        if self.panel_generations.get(&plugin_id).copied()
            != Some(self.running_generation(&plugin_id)?)
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::PanelNotFound,
            ));
        }
        self.queue(
            expected_revision,
            client_request_id,
            QueuedAction::PanelEvent { plugin_id, event },
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
        let result = self.execute_action(action, now_ms);
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

    fn execute_action(
        &mut self,
        action: QueuedAction,
        now_ms: u64,
    ) -> Result<(), PluginOperationFailure> {
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
            QueuedAction::Uninstall { plugin_id } => {
                self.lifecycle.uninstall(&plugin_id)?;
                self.plugin_snapshots.remove(&plugin_id);
                self.hosted_panels.remove(&plugin_id);
                self.panel_generations.remove(&plugin_id);
                self.serial_write_decisions
                    .retain(|(candidate, _), _| candidate != &plugin_id);
                Ok(())
            }
            QueuedAction::SetEnabled { plugin_id, enabled } => {
                let snapshot = self.lifecycle.set_enabled(&plugin_id, enabled)?;
                self.upsert_plugin_snapshot(snapshot);
                Ok(())
            }
            QueuedAction::ProposalDecision {
                proposal_id,
                decision,
            } => {
                let view = self.proposal_views.get(&proposal_id).cloned().ok_or(
                    PluginOperationFailure {
                        code: "PLUGIN_PROPOSAL_NOT_FOUND",
                        message_key: "plugin.error.proposalNotFound",
                    },
                )?;
                let context = self
                    .upstream
                    .current_proposal_context(&view)
                    .map_err(PluginOperationFailure::upstream)?;
                let resolution = self
                    .proposals
                    .resolve(&proposal_id, decision, &context, now_ms);
                self.proposal_views.remove(&proposal_id);
                let generation = self.proposal_generations.remove(&proposal_id).ok_or(
                    PluginOperationFailure {
                        code: "PLUGIN_PROPOSAL_NOT_FOUND",
                        message_key: "plugin.error.proposalNotFound",
                    },
                )?;
                match resolution {
                    ProposalResolution::Action(action) => {
                        let runtime =
                            self.running_instance_key(&view.plugin_id)
                                .map_err(|error| {
                                    error.failure.unwrap_or(PluginOperationFailure {
                                        code: "PLUGIN_LIFECYCLE_UNAVAILABLE",
                                        message_key: "plugin.error.lifecycleUnavailable",
                                    })
                                })?;
                        self.upstream
                            .execute_serial_action(runtime, action)
                            .map_err(PluginOperationFailure::upstream)?;
                        // Cache the approval only after the action executed:
                        // a failed execution must not seed an auto-approve for
                        // the rest of this instance's lifetime.
                        self.serial_write_decisions
                            .insert((view.plugin_id.clone(), generation), true);
                        self.deliver_proposal_outcome(
                            &view.plugin_id,
                            &proposal_id,
                            HostProposalOutcome::Approved,
                        );
                        self.proposal_correlations.remove(&proposal_id);
                        Ok(())
                    }
                    ProposalResolution::NoAction(NoActionReason::Rejected) => {
                        self.serial_write_decisions
                            .insert((view.plugin_id.clone(), generation), false);
                        self.deliver_proposal_outcome(
                            &view.plugin_id,
                            &proposal_id,
                            HostProposalOutcome::Rejected,
                        );
                        self.proposal_correlations.remove(&proposal_id);
                        Ok(())
                    }
                    ProposalResolution::NoAction(
                        NoActionReason::Expired | NoActionReason::ContextChanged,
                    ) => {
                        self.deliver_proposal_outcome(
                            &view.plugin_id,
                            &proposal_id,
                            HostProposalOutcome::Expired,
                        );
                        self.proposal_correlations.remove(&proposal_id);
                        Ok(())
                    }
                    ProposalResolution::NoAction(NoActionReason::UnknownOrConsumed) => {
                        Err(PluginOperationFailure {
                            code: "PLUGIN_PROPOSAL_NOT_FOUND",
                            message_key: "plugin.error.proposalNotFound",
                        })
                    }
                }
            }
            QueuedAction::PanelEvent { plugin_id, event } => {
                let generation = self
                    .plugin_snapshots
                    .get(&plugin_id)
                    .filter(|snapshot| snapshot.running_instance_id.is_some())
                    .map(|snapshot| snapshot.generation)
                    .ok_or(PluginOperationFailure {
                        code: "PLUGIN_PANEL_NOT_FOUND",
                        message_key: "plugin.error.panelNotFound",
                    })?;
                let hosted = self
                    .hosted_panels
                    .get(&plugin_id)
                    .ok_or(PluginOperationFailure {
                        code: "PLUGIN_PANEL_NOT_FOUND",
                        message_key: "plugin.error.panelNotFound",
                    })?;
                let action = self
                    .panels
                    .event(hosted, event)
                    .map_err(PluginOperationFailure::broker)?;
                let returned = self.lifecycle.invoke_panel_event(
                    &action.plugin_id,
                    &action.event.field_id,
                    &action.event.value,
                )?;
                if let Some(panel) = returned {
                    let hosted = self
                        .panels
                        .publish(&plugin_id, host_panel_to_broker(panel))
                        .map_err(PluginOperationFailure::broker)?;
                    self.hosted_panels.insert(plugin_id.clone(), hosted);
                    self.panel_generations.insert(plugin_id.clone(), generation);
                }
                Ok(())
            }
        }
    }

    fn ingest_published_panels(&mut self) -> Result<(), PluginCommandError> {
        let panels = self.lifecycle.take_published_panels().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        if panels.is_empty() {
            return Ok(());
        }
        self.ensure_revision_capacity(1)?;
        let mut changed = false;
        for published in panels {
            let Some(snapshot) = self.plugin_snapshots.get(&published.plugin_id) else {
                continue;
            };
            if snapshot.running_instance_id != Some(published.instance_id) {
                continue;
            }
            let hosted = self
                .panels
                .publish(&published.plugin_id, host_panel_to_broker(published.panel))
                .map_err(|error| {
                    PluginCommandError::with_failure(
                        PluginCommandErrorCode::BrokerRejected,
                        PluginOperationFailure::broker(error),
                    )
                })?;
            self.hosted_panels
                .insert(published.plugin_id.clone(), hosted);
            self.panel_generations
                .insert(published.plugin_id, snapshot.generation);
            changed = true;
        }
        if changed {
            self.bump_revision()?;
        }
        Ok(())
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
        self.reconcile_runtime_instances();
    }

    fn running_generation(&self, plugin_id: &str) -> Result<u64, PluginCommandError> {
        self.plugin_snapshots
            .get(plugin_id)
            .filter(|snapshot| {
                snapshot.status == bbcom_plugin_manager::PluginStatus::Running
                    && snapshot.running_instance_id.is_some()
            })
            .map(|snapshot| snapshot.generation)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::LifecycleUnavailable))
    }

    fn running_instance_key(
        &self,
        plugin_id: &str,
    ) -> Result<RuntimeInstanceKey, PluginCommandError> {
        let workspace_id = self
            .workspace_id
            .clone()
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::LifecycleUnavailable))?;
        let snapshot = self
            .plugin_snapshots
            .get(plugin_id)
            .filter(|snapshot| snapshot.status == bbcom_plugin_manager::PluginStatus::Running)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::LifecycleUnavailable))?;
        let instance_id = snapshot
            .running_instance_id
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::LifecycleUnavailable))?;
        Ok(RuntimeInstanceKey {
            workspace_id,
            plugin_id: plugin_id.to_owned(),
            instance_id,
            generation: snapshot.generation,
        })
    }

    fn reconcile_runtime_instances(&mut self) {
        let current = self
            .plugin_snapshots
            .iter()
            .filter(|(_, snapshot)| {
                snapshot.status == bbcom_plugin_manager::PluginStatus::Running
                    && snapshot.running_instance_id.is_some()
            })
            .map(|(plugin_id, snapshot)| (plugin_id.clone(), snapshot.generation))
            .collect::<BTreeMap<_, _>>();
        self.serial_write_decisions
            .retain(|(plugin_id, generation), _| {
                current.get(plugin_id).copied() == Some(*generation)
            });
        self.panel_generations
            .retain(|plugin_id, generation| current.get(plugin_id).copied() == Some(*generation));
        self.hosted_panels
            .retain(|plugin_id, _| self.panel_generations.contains_key(plugin_id));
        self.proposal_generations.retain(|proposal_id, generation| {
            self.proposal_views
                .get(proposal_id)
                .and_then(|view| current.get(&view.plugin_id))
                .copied()
                == Some(*generation)
        });
        self.proposal_views
            .retain(|proposal_id, _| self.proposal_generations.contains_key(proposal_id));
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
