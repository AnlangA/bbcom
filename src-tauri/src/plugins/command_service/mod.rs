//! Application-owned command state for the native plugin surface.
//!
//! This module contains no Tauri command and exposes no path, handle, secret,
//! serial writer, repository verifier, or host internals. A future command
//! adapter may map these native values to reviewed DTOs after wiring the
//! explicit upstream ports below.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use bbcom_plugin_broker::{
    AuditSink, AuthorizationBroker, AuthorizationGeneration, AuthorizationReview,
    AuthorizationState, AuthorizationStore, BrokerAction, BrokerError, DeclarativePanel,
    DeclarativePanelBroker, ExtraConfirmationReason, HostedPanel, NoActionReason, PanelEvent,
    PanelEventAction, ProposalContext, ProposalDecision, ProposalResolution, ReviewCapability,
    SerialProposalBroker, SerialProposalRequest, SerialProposalView,
};
use bbcom_plugin_contracts::{AuthorizationKey, Permission};
use bbcom_plugin_manager::{
    ArtifactRevocationStore, AuthorizationTarget, Clock, HostLauncher, InstallationPort,
    ManualPackageRequest, PluginAuthorizationStore, PluginSnapshot, PluginStatus,
};

use super::service::{PluginService, PluginServiceError};

const MAX_OPERATIONS: usize = 1_024;
const MAX_PENDING_REVIEWS: usize = 1;
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
    SetEnabled,
    AuthorizationDecision,
    ProposalDecision,
    PanelEvent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginUpstreamFailure {
    AuthorizationContextUnavailable,
    ProposalContextUnavailable,
    SerialExecutionUnavailable,
    PanelDeliveryUnavailable,
}

impl PluginUpstreamFailure {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::AuthorizationContextUnavailable => "PLUGIN_AUTHORIZATION_CONTEXT_UNAVAILABLE",
            Self::ProposalContextUnavailable => "PLUGIN_PROPOSAL_CONTEXT_UNAVAILABLE",
            Self::SerialExecutionUnavailable => "PLUGIN_SERIAL_EXECUTION_UNAVAILABLE",
            Self::PanelDeliveryUnavailable => "PLUGIN_PANEL_DELIVERY_UNAVAILABLE",
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::AuthorizationContextUnavailable => "plugin.error.authorizationContextUnavailable",
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
pub struct AuthorizationReviewSnapshot {
    pub review_id: String,
    pub plugin_id: String,
    pub artifact_version: String,
    pub implicit: BTreeSet<Permission>,
    pub requires_persistent_approval: BTreeSet<Permission>,
    pub requires_per_request_approval: BTreeSet<Permission>,
    pub unavailable: BTreeSet<ReviewCapability>,
    pub extra_confirmation: bool,
    pub extra_confirmation_reasons: BTreeSet<ExtraConfirmationReason>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewedAuthorizationReceipt {
    pub artifact_version: String,
    pub reviewed_permissions: BTreeSet<Permission>,
    pub revision: u64,
    pub decision_generation: AuthorizationGeneration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginCommandSnapshot {
    pub revision: u64,
    pub plugins: Vec<PluginSnapshot>,
    pub operations: Vec<PluginOperationSnapshot>,
    pub authorization_reviews: Vec<AuthorizationReviewSnapshot>,
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
    AuthorizationReviewNotFound,
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
            Self::AuthorizationReviewNotFound => "PLUGIN_AUTHORIZATION_REVIEW_NOT_FOUND",
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
    fn new(code: PluginCommandErrorCode) -> Self {
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
    fn authorization_target(
        &self,
        plugin_id: &str,
    ) -> Result<AuthorizationTarget, PluginOperationFailure>;
    fn complete_authorization(
        &self,
        target: &AuthorizationTarget,
        approved: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
    fn install_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
    fn set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure>;
}

impl<T: PluginLifecyclePort> PluginLifecyclePort for Arc<T> {
    fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
        self.as_ref().snapshots()
    }

    fn authorization_target(
        &self,
        plugin_id: &str,
    ) -> Result<AuthorizationTarget, PluginOperationFailure> {
        self.as_ref().authorization_target(plugin_id)
    }

    fn complete_authorization(
        &self,
        target: &AuthorizationTarget,
        approved: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        self.as_ref().complete_authorization(target, approved)
    }

    fn install_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        self.as_ref().install_manual(request)
    }

    fn set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        self.as_ref().set_enabled(plugin_id, enabled)
    }
}

impl<I, H, A, R, C> PluginLifecyclePort for PluginService<I, H, A, R, C>
where
    I: InstallationPort,
    H: HostLauncher,
    A: PluginAuthorizationStore,
    R: ArtifactRevocationStore,
    C: Clock,
{
    fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
        PluginService::snapshots(self).map_err(lifecycle_failure)
    }

    fn authorization_target(
        &self,
        plugin_id: &str,
    ) -> Result<AuthorizationTarget, PluginOperationFailure> {
        PluginService::authorization_target(self, plugin_id).map_err(lifecycle_failure)
    }

    fn complete_authorization(
        &self,
        target: &AuthorizationTarget,
        approved: bool,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        PluginService::complete_authorization(self, target, approved).map_err(lifecycle_failure)
    }

    fn install_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginOperationFailure> {
        PluginService::install_manual(self, request).map_err(lifecycle_failure)
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

pub trait AuthorizationBrokerPort {
    fn review(
        &self,
        key: AuthorizationKey,
        requested: &[Permission],
        network_requested: bool,
    ) -> Result<AuthorizationReview, BrokerError>;

    fn record_decisions(
        &self,
        review: &AuthorizationReview,
        decisions: &[(Permission, AuthorizationState)],
        extra_confirmation_acknowledged: bool,
        target: &AuthorizationTarget,
        reviewed_permissions: BTreeSet<Permission>,
        revision: u64,
    ) -> Result<ReviewedAuthorizationReceipt, BrokerError>;
}

impl<'a, S, A> AuthorizationBrokerPort for AuthorizationBroker<'a, S, A>
where
    S: AuthorizationStore,
    A: AuditSink,
{
    fn review(
        &self,
        key: AuthorizationKey,
        requested: &[Permission],
        network_requested: bool,
    ) -> Result<AuthorizationReview, BrokerError> {
        AuthorizationBroker::review(self, key, requested, network_requested)
    }

    fn record_decisions(
        &self,
        review: &AuthorizationReview,
        decisions: &[(Permission, AuthorizationState)],
        extra_confirmation_acknowledged: bool,
        target: &AuthorizationTarget,
        reviewed_permissions: BTreeSet<Permission>,
        revision: u64,
    ) -> Result<ReviewedAuthorizationReceipt, BrokerError> {
        let decision_generation = AuthorizationBroker::record_decisions(
            self,
            review,
            decisions,
            extra_confirmation_acknowledged,
        )?;
        Ok(ReviewedAuthorizationReceipt {
            artifact_version: target.artifact.version.clone(),
            reviewed_permissions,
            revision,
            decision_generation,
        })
    }
}

pub trait ProposalBrokerPort {
    fn create(
        &mut self,
        key: &AuthorizationKey,
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
        key: &AuthorizationKey,
        declared: &BTreeSet<Permission>,
        request: SerialProposalRequest,
        now_ms: u64,
    ) -> Result<SerialProposalView, BrokerError> {
        SerialProposalBroker::create(self, key, declared, request, now_ms)
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
    fn publish(
        &self,
        key: &AuthorizationKey,
        panel: DeclarativePanel,
    ) -> Result<HostedPanel, BrokerError>;

    fn event(
        &self,
        hosted: &HostedPanel,
        event: PanelEvent,
    ) -> Result<PanelEventAction, BrokerError>;
}

impl<'a, A: AuditSink> PanelBrokerPort for DeclarativePanelBroker<'a, A> {
    fn publish(
        &self,
        key: &AuthorizationKey,
        panel: DeclarativePanel,
    ) -> Result<HostedPanel, BrokerError> {
        DeclarativePanelBroker::publish(self, key, panel)
    }

    fn event(
        &self,
        hosted: &HostedPanel,
        event: PanelEvent,
    ) -> Result<PanelEventAction, BrokerError> {
        DeclarativePanelBroker::event(self, hosted, event)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationSubject {
    pub workspace_id: String,
    pub network_requested: bool,
}

/// Missing native integrations are explicit and fail closed.
///
/// Implementations obtain authorization identity and current proposal context
/// from application-owned state. `execute_serial_action` is the only place an
/// approved broker action may reach the serial subsystem. `deliver_panel_event`
/// is the only place a validated event may reach a host. No permissive default
/// implementation exists.
pub trait PluginCommandUpstreamPort {
    fn authorization_subject(
        &mut self,
        plugin_id: &str,
    ) -> Result<AuthorizationSubject, PluginUpstreamFailure>;

    fn current_proposal_context(
        &mut self,
        proposal: &SerialProposalView,
    ) -> Result<ProposalContext, PluginUpstreamFailure>;

    fn execute_serial_action(&mut self, action: BrokerAction) -> Result<(), PluginUpstreamFailure>;

    fn deliver_panel_event(
        &mut self,
        action: PanelEventAction,
    ) -> Result<(), PluginUpstreamFailure>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum QueuedAction {
    Install(ManualPackageRequest),
    SetEnabled {
        plugin_id: String,
        enabled: bool,
    },
    AuthorizationDecision {
        review_id: String,
        decisions: Vec<(Permission, AuthorizationState)>,
        per_request_acknowledged: BTreeSet<Permission>,
        extra_confirmation_acknowledged: bool,
    },
    DismissAuthorization {
        review_id: String,
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
            Self::Install(_) => PluginOperationKind::Install,
            Self::SetEnabled { .. } => PluginOperationKind::SetEnabled,
            Self::AuthorizationDecision { .. } | Self::DismissAuthorization { .. } => {
                PluginOperationKind::AuthorizationDecision
            }
            Self::ProposalDecision { .. } => PluginOperationKind::ProposalDecision,
            Self::PanelEvent { .. } => PluginOperationKind::PanelEvent,
        }
    }
}

#[derive(Clone)]
struct OperationRecord {
    snapshot: PluginOperationSnapshot,
    action: QueuedAction,
}

struct PendingReview {
    snapshot: AuthorizationReviewSnapshot,
    review: AuthorizationReview,
    target: AuthorizationTarget,
}

pub struct PluginCommandService<L, U, AB, PB, DB> {
    lifecycle: L,
    upstream: U,
    authorization: AB,
    proposals: PB,
    panels: DB,
    revision: u64,
    next_operation_id: u64,
    next_review_id: u64,
    operations: BTreeMap<String, OperationRecord>,
    requests: BTreeMap<String, String>,
    reviews: BTreeMap<String, PendingReview>,
    deferred_review_plugins: BTreeSet<String>,
    proposal_views: BTreeMap<String, SerialProposalView>,
    hosted_panels: BTreeMap<String, HostedPanel>,
    plugin_snapshots: BTreeMap<String, PluginSnapshot>,
}

impl<L, U, AB, PB, DB> PluginCommandService<L, U, AB, PB, DB>
where
    L: PluginLifecyclePort,
    U: PluginCommandUpstreamPort,
    AB: AuthorizationBrokerPort,
    PB: ProposalBrokerPort,
    DB: PanelBrokerPort,
{
    pub fn new(
        lifecycle: L,
        upstream: U,
        authorization: AB,
        proposals: PB,
        panels: DB,
    ) -> Result<Self, PluginCommandError> {
        let initial = lifecycle.snapshots().map_err(|failure| {
            PluginCommandError::with_failure(PluginCommandErrorCode::LifecycleUnavailable, failure)
        })?;
        let plugin_snapshots = collect_plugin_snapshots(initial)?;
        let mut service = Self {
            lifecycle,
            upstream,
            authorization,
            proposals,
            panels,
            revision: 1,
            next_operation_id: 1,
            next_review_id: 1,
            operations: BTreeMap::new(),
            requests: BTreeMap::new(),
            reviews: BTreeMap::new(),
            deferred_review_plugins: BTreeSet::new(),
            proposal_views: BTreeMap::new(),
            hosted_panels: BTreeMap::new(),
            plugin_snapshots,
        };
        service.ensure_next_authorization_review()?;
        Ok(service)
    }

    #[must_use]
    pub fn snapshot(&self) -> PluginCommandSnapshot {
        PluginCommandSnapshot {
            revision: self.revision,
            plugins: self.plugin_snapshots.values().cloned().collect(),
            operations: self
                .operations
                .values()
                .map(|record| record.snapshot.clone())
                .collect(),
            authorization_reviews: self
                .reviews
                .values()
                .map(|review| review.snapshot.clone())
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
        if next != self.plugin_snapshots {
            self.ensure_revision_capacity(1)?;
            self.plugin_snapshots = next;
            self.deferred_review_plugins
                .retain(|plugin_id| self.plugin_snapshots.contains_key(plugin_id));
            self.bump_revision()?;
        }
        let stale_reviews = self
            .reviews
            .iter()
            .filter_map(|(review_id, pending)| {
                match self
                    .lifecycle
                    .authorization_target(&pending.snapshot.plugin_id)
                {
                    Ok(current) if current == pending.target => None,
                    _ => Some(review_id.clone()),
                }
            })
            .collect::<Vec<_>>();
        if !stale_reviews.is_empty() {
            // Removing the stale target and immediately materializing its
            // replacement can each advance the renderer-visible revision.
            self.ensure_revision_capacity(2)?;
            for review_id in stale_reviews {
                self.reviews.remove(&review_id);
            }
            self.bump_revision()?;
        }
        // Retry review materialization even when lifecycle state is unchanged.
        // A transient trusted-upstream failure must not strand an already
        // committed install or upgrade without a review forever.
        self.ensure_next_authorization_review()?;
        Ok(self.revision)
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

    pub fn begin_authorization_review(
        &mut self,
        expected_revision: u64,
        plugin_id: &str,
    ) -> Result<AuthorizationReviewSnapshot, PluginCommandError> {
        self.expect_revision(expected_revision)?;
        if let Some(existing) = self
            .reviews
            .values()
            .find(|review| review.snapshot.plugin_id == plugin_id)
        {
            return Ok(existing.snapshot.clone());
        }
        if !self.reviews.is_empty() {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        self.deferred_review_plugins.remove(plugin_id);
        self.create_authorization_review(plugin_id)
    }

    fn create_authorization_review(
        &mut self,
        plugin_id: &str,
    ) -> Result<AuthorizationReviewSnapshot, PluginCommandError> {
        self.ensure_revision_capacity(1)?;
        if self.reviews.len() >= MAX_PENDING_REVIEWS {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        let target = self
            .lifecycle
            .authorization_target(plugin_id)
            .map_err(|failure| {
                PluginCommandError::with_failure(
                    PluginCommandErrorCode::LifecycleUnavailable,
                    failure,
                )
            })?;
        let subject = self
            .upstream
            .authorization_subject(plugin_id)
            .map_err(|error| {
                PluginCommandError::with_failure(
                    PluginCommandErrorCode::UpstreamUnavailable,
                    PluginOperationFailure::upstream(error),
                )
            })?;
        let expected_key = target
            .artifact
            .authorization_key(&subject.workspace_id)
            .map_err(|_| PluginCommandError::new(PluginCommandErrorCode::UpstreamUnavailable))?;
        let review = self
            .authorization
            .review(
                expected_key,
                &target
                    .artifact
                    .requested_permissions
                    .iter()
                    .copied()
                    .collect::<Vec<_>>(),
                subject.network_requested,
            )
            .map_err(|error| {
                PluginCommandError::with_failure(
                    PluginCommandErrorCode::BrokerRejected,
                    PluginOperationFailure::broker(error),
                )
            })?;
        let review_id = format!("plugin-review-{:016x}", self.next_review_id);
        self.next_review_id = self
            .next_review_id
            .checked_add(1)
            .ok_or_else(|| PluginCommandError::new(PluginCommandErrorCode::RegistryLimit))?;
        let snapshot = AuthorizationReviewSnapshot {
            review_id: review_id.clone(),
            plugin_id: review.key().plugin_id.clone(),
            artifact_version: target.artifact.version.clone(),
            implicit: review.implicit().clone(),
            requires_persistent_approval: review.requires_persistent_approval().clone(),
            requires_per_request_approval: review.requires_per_request_approval().clone(),
            unavailable: review.unavailable().clone(),
            extra_confirmation: review.extra_confirmation(),
            extra_confirmation_reasons: review.extra_confirmation_reasons().clone(),
        };
        self.reviews.insert(
            review_id,
            PendingReview {
                snapshot: snapshot.clone(),
                review,
                target,
            },
        );
        self.bump_revision()?;
        Ok(snapshot)
    }

    fn ensure_next_authorization_review(&mut self) -> Result<(), PluginCommandError> {
        if !self.reviews.is_empty() {
            return Ok(());
        }
        let next = self
            .plugin_snapshots
            .values()
            .find(|snapshot| {
                matches!(snapshot.status, PluginStatus::ApprovalRequired(_))
                    && !self
                        .deferred_review_plugins
                        .contains(&snapshot.artifact.plugin_id)
            })
            .map(|snapshot| snapshot.artifact.plugin_id.clone());
        if let Some(plugin_id) = next {
            self.create_authorization_review(&plugin_id)?;
        }
        Ok(())
    }

    pub fn queue_authorization_decisions(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        review_id: String,
        decisions: Vec<(Permission, AuthorizationState)>,
        per_request_acknowledged: BTreeSet<Permission>,
        extra_confirmation_acknowledged: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        let action = QueuedAction::AuthorizationDecision {
            review_id: review_id.clone(),
            decisions,
            per_request_acknowledged,
            extra_confirmation_acknowledged,
        };
        if !self.requests.contains_key(&client_request_id) && !self.reviews.contains_key(&review_id)
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::AuthorizationReviewNotFound,
            ));
        }
        self.queue(expected_revision, client_request_id, action)
    }

    pub fn queue_dismiss_authorization(
        &mut self,
        expected_revision: u64,
        client_request_id: String,
        review_id: String,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        let action = QueuedAction::DismissAuthorization {
            review_id: review_id.clone(),
        };
        if !self.requests.contains_key(&client_request_id) && !self.reviews.contains_key(&review_id)
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::AuthorizationReviewNotFound,
            ));
        }
        self.queue(expected_revision, client_request_id, action)
    }

    /// Trusted host ingress. `key` and `declared` come from the native running
    /// instance, never from a renderer request.
    pub fn register_proposal(
        &mut self,
        key: &AuthorizationKey,
        declared: &BTreeSet<Permission>,
        request: SerialProposalRequest,
        now_ms: u64,
    ) -> Result<SerialProposalView, PluginCommandError> {
        if self.proposal_views.len() >= MAX_PENDING_PROPOSALS {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        self.ensure_revision_capacity(1)?;
        let view = self
            .proposals
            .create(key, declared, request, now_ms)
            .map_err(|error| {
                PluginCommandError::with_failure(
                    PluginCommandErrorCode::BrokerRejected,
                    PluginOperationFailure::broker(error),
                )
            })?;
        self.proposal_views
            .insert(view.proposal_id.clone(), view.clone());
        self.bump_revision()?;
        Ok(view)
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
        key: &AuthorizationKey,
        panel: DeclarativePanel,
    ) -> Result<HostedPanel, PluginCommandError> {
        if !self.hosted_panels.contains_key(&key.plugin_id)
            && self.hosted_panels.len() >= MAX_PENDING_PANELS
        {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::RegistryLimit,
            ));
        }
        self.ensure_revision_capacity(1)?;
        let hosted = self.panels.publish(key, panel).map_err(|error| {
            PluginCommandError::with_failure(
                PluginCommandErrorCode::BrokerRejected,
                PluginOperationFailure::broker(error),
            )
        })?;
        self.hosted_panels
            .insert(hosted.plugin_id().to_owned(), hosted.clone());
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
        if let Some(record) = self.operations.get(operation_id) {
            if record.snapshot.status.is_terminal() {
                return Ok(record.snapshot.clone());
            }
        } else {
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::OperationNotFound,
            ));
        }
        // An action can create the next authorization review, which owns one
        // additional observable revision between running and terminal.
        self.ensure_revision_capacity(3)?;
        let action = {
            let record = self
                .operations
                .get_mut(operation_id)
                .expect("operation existence checked above");
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
            .expect("operation existence checked above");
        if record.snapshot.status != PluginOperationStatus::Queued {
            // Current real lifecycle and broker APIs are synchronous. Reporting
            // `cancelling` for a running call would be false; fail closed until
            // an upstream interrupt/cancel API exists.
            return Err(PluginCommandError::new(
                PluginCommandErrorCode::OperationNotCancellable,
            ));
        }
        record.snapshot.status = PluginOperationStatus::Cancelled;
        let snapshot = record.snapshot.clone();
        self.bump_revision()?;
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
        if self.operations.len() >= MAX_OPERATIONS {
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
                let snapshot = self.lifecycle.install_manual(&request)?;
                let plugin_id = snapshot.artifact.plugin_id.clone();
                self.upsert_plugin_snapshot(snapshot);
                self.deferred_review_plugins.remove(&plugin_id);
                let _ = self.ensure_next_authorization_review();
                Ok(())
            }
            QueuedAction::SetEnabled { plugin_id, enabled } => {
                if enabled {
                    self.deferred_review_plugins.remove(&plugin_id);
                }
                match self.lifecycle.set_enabled(&plugin_id, enabled) {
                    Ok(snapshot) => {
                        self.upsert_plugin_snapshot(snapshot);
                        let _ = self.ensure_next_authorization_review();
                        Ok(())
                    }
                    Err(failure) => {
                        if enabled && failure.code.contains("AUTHORIZATION") {
                            let _ = self.ensure_next_authorization_review();
                        }
                        Err(failure)
                    }
                }
            }
            QueuedAction::AuthorizationDecision {
                review_id,
                decisions,
                per_request_acknowledged,
                extra_confirmation_acknowledged,
            } => {
                let review = self.reviews.get(&review_id).ok_or(PluginOperationFailure {
                    code: "PLUGIN_AUTHORIZATION_REVIEW_NOT_FOUND",
                    message_key: "plugin.error.authorizationReviewNotFound",
                })?;
                let target = review.target.clone();
                let reviewed_permissions = decisions
                    .iter()
                    .filter_map(|(permission, state)| {
                        (*state == AuthorizationState::Granted).then_some(*permission)
                    })
                    .chain(per_request_acknowledged.iter().copied())
                    .chain(review.snapshot.implicit.iter().copied())
                    .collect();
                if per_request_acknowledged != review.snapshot.requires_per_request_approval {
                    return Err(PluginOperationFailure {
                        code: "PLUGIN_AUTHORIZATION_REVIEW_MISMATCH",
                        message_key: "plugin.error.authorizationReviewMismatch",
                    });
                }
                let receipt = self
                    .authorization
                    .record_decisions(
                        &review.review,
                        &decisions,
                        extra_confirmation_acknowledged,
                        &target,
                        reviewed_permissions,
                        self.revision,
                    )
                    .map_err(PluginOperationFailure::broker)?;
                let fully_approved = review.snapshot.unavailable.is_empty()
                    && target
                        .artifact
                        .requested_permissions
                        .is_subset(&receipt.reviewed_permissions);
                let completed_snapshot = self
                    .lifecycle
                    .complete_authorization(&target, fully_approved)?;
                self.upsert_plugin_snapshot(completed_snapshot);
                if let Some(completed) = self.reviews.remove(&review_id) {
                    self.deferred_review_plugins
                        .insert(completed.snapshot.plugin_id);
                }
                let _ = self.ensure_next_authorization_review();
                Ok(())
            }
            QueuedAction::DismissAuthorization { review_id } => {
                let target = self
                    .reviews
                    .get(&review_id)
                    .ok_or(PluginOperationFailure {
                        code: "PLUGIN_AUTHORIZATION_REVIEW_NOT_FOUND",
                        message_key: "plugin.error.authorizationReviewNotFound",
                    })?
                    .target
                    .clone();
                let snapshot = self.lifecycle.complete_authorization(&target, false)?;
                self.upsert_plugin_snapshot(snapshot);
                let dismissed = self
                    .reviews
                    .remove(&review_id)
                    .ok_or(PluginOperationFailure {
                        code: "PLUGIN_AUTHORIZATION_REVIEW_NOT_FOUND",
                        message_key: "plugin.error.authorizationReviewNotFound",
                    })?;
                self.deferred_review_plugins
                    .insert(dismissed.snapshot.plugin_id);
                let _ = self.ensure_next_authorization_review();
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
                match resolution {
                    ProposalResolution::Action(action) => self
                        .upstream
                        .execute_serial_action(action)
                        .map_err(PluginOperationFailure::upstream),
                    ProposalResolution::NoAction(
                        NoActionReason::Rejected
                        | NoActionReason::Expired
                        | NoActionReason::ContextChanged,
                    ) => Ok(()),
                    ProposalResolution::NoAction(NoActionReason::UnknownOrConsumed) => {
                        Err(PluginOperationFailure {
                            code: "PLUGIN_PROPOSAL_NOT_FOUND",
                            message_key: "plugin.error.proposalNotFound",
                        })
                    }
                }
            }
            QueuedAction::PanelEvent { plugin_id, event } => {
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
                self.upstream
                    .deliver_panel_event(action)
                    .map_err(PluginOperationFailure::upstream)
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

#[cfg(test)]
mod tests {
    use super::*;
    use bbcom_plugin_broker::{
        AuditEvent, AuthorizationStoreError, NoopAuditSink, PanelControlKind, PanelField,
    };
    use bbcom_plugin_manager::{ApprovalReason, PluginArtifact, PluginStatus};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Lifecycle {
        snapshots: Vec<PluginSnapshot>,
        target: Option<AuthorizationTarget>,
        completion_decisions: Arc<Mutex<Vec<bool>>>,
        fail: bool,
        fail_complete: bool,
    }

    impl PluginLifecyclePort for Lifecycle {
        fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginOperationFailure> {
            Ok(self.snapshots.clone())
        }

        fn authorization_target(
            &self,
            plugin_id: &str,
        ) -> Result<AuthorizationTarget, PluginOperationFailure> {
            self.target
                .clone()
                .filter(|target| target.artifact.plugin_id == plugin_id)
                .or_else(|| {
                    self.snapshots
                        .iter()
                        .find(|snapshot| snapshot.artifact.plugin_id == plugin_id)
                        .map(|snapshot| snapshot.artifact.clone())
                        .or_else(|| (plugin_id == "dev.bbcom.fixture").then(|| snapshot().artifact))
                        .map(|artifact| AuthorizationTarget {
                            artifact,
                            preparation_token: None,
                        })
                })
                .ok_or(PluginOperationFailure {
                    code: "PLUGIN_ARTIFACT_NOT_INSTALLED",
                    message_key: "plugin.error.artifactNotInstalled",
                })
        }

        fn complete_authorization(
            &self,
            target: &AuthorizationTarget,
            approved: bool,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            self.completion_decisions.lock().unwrap().push(approved);
            if self.fail_complete {
                return Err(PluginOperationFailure {
                    code: "PLUGIN_AUTHORIZATION_COMPLETION_FAILED",
                    message_key: "plugin.error.authorizationCompletionFailed",
                });
            }
            self.snapshots
                .iter()
                .find(|snapshot| snapshot.artifact.plugin_id == target.artifact.plugin_id)
                .cloned()
                .or_else(|| (target.artifact.plugin_id == "dev.bbcom.fixture").then(snapshot))
                .ok_or(PluginOperationFailure {
                    code: "PLUGIN_ARTIFACT_NOT_INSTALLED",
                    message_key: "plugin.error.artifactNotInstalled",
                })
        }

        fn install_manual(
            &self,
            _request: &ManualPackageRequest,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            if self.fail {
                Err(PluginOperationFailure {
                    code: "PLUGIN_INSTALL_PREPARE_FAILED",
                    message_key: "plugin.error.installPrepareFailed",
                })
            } else {
                Ok(snapshot())
            }
        }

        fn set_enabled(
            &self,
            _plugin_id: &str,
            _enabled: bool,
        ) -> Result<PluginSnapshot, PluginOperationFailure> {
            Ok(snapshot())
        }
    }

    struct Store;

    impl AuthorizationStore for Store {
        fn state(
            &self,
            _key: &AuthorizationKey,
            _permission: Permission,
        ) -> Result<AuthorizationState, AuthorizationStoreError> {
            Ok(AuthorizationState::Missing)
        }

        fn replace_states(
            &self,
            _key: &AuthorizationKey,
            _decisions: &[(Permission, AuthorizationState)],
        ) -> Result<AuthorizationGeneration, AuthorizationStoreError> {
            Ok(AuthorizationGeneration::from_bytes([1; 32]))
        }
    }

    #[derive(Default)]
    struct Upstream {
        serial_actions: usize,
        panel_actions: usize,
        fail_serial: bool,
    }

    impl PluginCommandUpstreamPort for Upstream {
        fn authorization_subject(
            &mut self,
            plugin_id: &str,
        ) -> Result<AuthorizationSubject, PluginUpstreamFailure> {
            Ok(AuthorizationSubject {
                workspace_id: key(plugin_id).workspace_id,
                network_requested: false,
            })
        }

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
            _action: BrokerAction,
        ) -> Result<(), PluginUpstreamFailure> {
            if self.fail_serial {
                Err(PluginUpstreamFailure::SerialExecutionUnavailable)
            } else {
                self.serial_actions += 1;
                Ok(())
            }
        }

        fn deliver_panel_event(
            &mut self,
            _action: PanelEventAction,
        ) -> Result<(), PluginUpstreamFailure> {
            self.panel_actions += 1;
            Ok(())
        }
    }

    struct Audit(Mutex<Vec<AuditEvent>>);

    impl AuditSink for Audit {
        fn record(&self, event: AuditEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn key(plugin_id: &str) -> AuthorizationKey {
        AuthorizationKey {
            plugin_id: plugin_id.to_owned(),
            publisher_identity: format!("publisher:sha256-{}", "a".repeat(64)),
            plugin_major: 1,
            workspace_id: "11111111-1111-1111-1111-111111111111".to_owned(),
        }
    }

    fn snapshot() -> PluginSnapshot {
        PluginSnapshot {
            artifact: PluginArtifact::new(
                "dev.bbcom.fixture",
                "1.0.0",
                format!("publisher:sha256-{}", "a".repeat(64)),
                [Permission::SerialWriteProposal],
            )
            .unwrap(),
            status: PluginStatus::Stopped,
            pending_version: None,
            running_instance_id: None,
            crashes_in_window: 0,
            last_error: None,
        }
    }

    fn panel() -> DeclarativePanel {
        DeclarativePanel {
            title: "Fixture".to_owned(),
            fields: vec![PanelField {
                id: "run".to_owned(),
                label: "Run".to_owned(),
                kind: PanelControlKind::Button,
                value: String::new(),
                options: Vec::new(),
                disabled: false,
            }],
        }
    }

    #[test]
    fn queued_lifecycle_work_is_idempotent_cancelable_and_revision_guarded() {
        let audit = NoopAuditSink;
        let store = Store;
        let mut service = PluginCommandService::new(
            Lifecycle::default(),
            Upstream::default(),
            AuthorizationBroker::new(&store, &audit),
            SerialProposalBroker::new(&audit),
            DeclarativePanelBroker::new(&audit),
        )
        .unwrap();
        let request =
            ManualPackageRequest::new("official", "dev.bbcom.fixture", "1.0.0").expect("request");
        let queued = service
            .queue_install(1, "request-1".to_owned(), request.clone())
            .unwrap();
        assert_eq!(queued.status, PluginOperationStatus::Queued);
        assert_eq!(
            service
                .queue_install(1, "request-1".to_owned(), request)
                .unwrap(),
            queued
        );
        let cancelled = service.cancel(2, &queued.operation_id).unwrap();
        assert_eq!(cancelled.status, PluginOperationStatus::Cancelled);
        assert_eq!(service.execute(&queued.operation_id, 1).unwrap(), cancelled);
    }

    #[test]
    fn brokered_proposal_is_consumed_once_and_serial_failure_is_terminal() {
        let audit = Audit(Mutex::new(Vec::new()));
        let store = Store;
        let mut service = PluginCommandService::new(
            Lifecycle::default(),
            Upstream {
                fail_serial: true,
                ..Upstream::default()
            },
            AuthorizationBroker::new(&store, &audit),
            SerialProposalBroker::new(&audit),
            DeclarativePanelBroker::new(&audit),
        )
        .unwrap();
        let view = service
            .register_proposal(
                &key("dev.bbcom.fixture"),
                &BTreeSet::from([Permission::SerialWriteProposal]),
                SerialProposalRequest {
                    operation_id: "operation-1".to_owned(),
                    session_id: "session-1".to_owned(),
                    payload: vec![1, 2],
                    display_label: "Send".to_owned(),
                },
                1,
            )
            .unwrap();
        let queued = service
            .queue_proposal_decision(
                2,
                "request-proposal".to_owned(),
                view.proposal_id,
                ProposalDecision::Approve,
            )
            .unwrap();
        let terminal = service.execute(&queued.operation_id, 2).unwrap();
        assert_eq!(terminal.status, PluginOperationStatus::Failed);
        assert_eq!(
            terminal.failure.unwrap().code,
            "PLUGIN_SERIAL_EXECUTION_UNAVAILABLE"
        );
        assert!(service.snapshot().proposals.is_empty());
    }

    #[test]
    fn authorization_and_panel_only_use_broker_validated_native_context() {
        let audit = NoopAuditSink;
        let store = Store;
        let mut service = PluginCommandService::new(
            Lifecycle::default(),
            Upstream::default(),
            AuthorizationBroker::new(&store, &audit),
            SerialProposalBroker::new(&audit),
            DeclarativePanelBroker::new(&audit),
        )
        .unwrap();
        let review = service
            .begin_authorization_review(1, "dev.bbcom.fixture")
            .unwrap();
        assert!(
            review
                .requires_per_request_approval
                .contains(&Permission::SerialWriteProposal)
        );
        let hosted = service
            .publish_panel(&key("dev.bbcom.fixture"), panel())
            .unwrap();
        let queued = service
            .queue_panel_event(
                3,
                "panel-event-1".to_owned(),
                hosted.plugin_id().to_owned(),
                PanelEvent {
                    field_id: "run".to_owned(),
                    value: String::new(),
                },
            )
            .unwrap();
        assert_eq!(
            service.execute(&queued.operation_id, 1).unwrap().status,
            PluginOperationStatus::Completed
        );
    }

    #[test]
    fn grouped_authorization_review_is_automatically_created_and_completed() {
        let audit = NoopAuditSink;
        let store = Store;
        let mut approval = snapshot();
        approval.artifact = PluginArtifact::new(
            "dev.bbcom.fixture",
            "1.0.0",
            format!("publisher:sha256-{}", "a".repeat(64)),
            [Permission::SessionMetadataRead],
        )
        .unwrap();
        approval.status = PluginStatus::ApprovalRequired(ApprovalReason::InitialInstall);
        let mut service = PluginCommandService::new(
            Lifecycle {
                snapshots: vec![approval],
                ..Lifecycle::default()
            },
            Upstream::default(),
            AuthorizationBroker::new(&store, &audit),
            SerialProposalBroker::new(&audit),
            DeclarativePanelBroker::new(&audit),
        )
        .unwrap();

        let snapshot = service.snapshot();
        assert_eq!(snapshot.revision, 2);
        let review = snapshot.authorization_reviews.first().unwrap();
        assert_eq!(review.plugin_id, "dev.bbcom.fixture");
        assert_eq!(
            review.requires_persistent_approval,
            BTreeSet::from([Permission::SessionMetadataRead])
        );

        let queued = service
            .queue_authorization_decisions(
                snapshot.revision,
                "grouped-authorization-1".to_owned(),
                review.review_id.clone(),
                vec![(Permission::SessionMetadataRead, AuthorizationState::Granted)],
                BTreeSet::new(),
                false,
            )
            .unwrap();
        let completed = service.execute(&queued.operation_id, 1).unwrap();
        assert_eq!(completed.status, PluginOperationStatus::Completed);
        assert!(service.snapshot().authorization_reviews.is_empty());
    }

    #[test]
    fn dismiss_keeps_the_review_when_pending_target_discard_fails() {
        let audit = NoopAuditSink;
        let store = Store;
        let mut approval = snapshot();
        approval.artifact = PluginArtifact::new(
            "dev.bbcom.fixture",
            "1.0.0",
            format!("publisher:sha256-{}", "a".repeat(64)),
            [Permission::SessionMetadataRead],
        )
        .unwrap();
        approval.status = PluginStatus::ApprovalRequired(ApprovalReason::ArtifactChanged);
        approval.pending_version = Some("1.1.0".to_owned());
        let target = AuthorizationTarget {
            artifact: PluginArtifact::new(
                "dev.bbcom.fixture",
                "1.1.0",
                format!("publisher:sha256-{}", "a".repeat(64)),
                [Permission::SessionMetadataRead],
            )
            .unwrap(),
            preparation_token: Some(
                bbcom_plugin_manager::PreparationToken::new("pending-v1.1.0").unwrap(),
            ),
        };
        let completion_decisions = Arc::new(Mutex::new(Vec::new()));
        let mut service = PluginCommandService::new(
            Lifecycle {
                snapshots: vec![approval],
                target: Some(target),
                completion_decisions: Arc::clone(&completion_decisions),
                fail_complete: true,
                ..Lifecycle::default()
            },
            Upstream::default(),
            AuthorizationBroker::new(&store, &audit),
            SerialProposalBroker::new(&audit),
            DeclarativePanelBroker::new(&audit),
        )
        .unwrap();
        let initial = service.snapshot();
        let review_id = initial.authorization_reviews[0].review_id.clone();
        let queued = service
            .queue_dismiss_authorization(
                initial.revision,
                "dismiss-pending-upgrade".to_owned(),
                review_id,
            )
            .unwrap();

        let failed = service.execute(&queued.operation_id, 1).unwrap();
        assert_eq!(failed.status, PluginOperationStatus::Failed);
        assert_eq!(*completion_decisions.lock().unwrap(), vec![false]);
        assert_eq!(service.snapshot().authorization_reviews.len(), 1);
    }
}
