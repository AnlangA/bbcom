//! Lossless adapter from the reviewed IPC plugin commands to the native core.
//!
//! The adapter owns no repository, trust decision, path, serial port or host.
//! One mutex serializes correlation maps, catalog reads and core transitions.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use bbcom_contracts::{
    AppErrorCode, InstalledPluginView, IpcError, PluginAuthorizationReview, PluginCatalogItem,
    PluginCenterData, PluginCommandResponse, PluginDeclarativePanel, PluginFailure,
    PluginFailureCode, PluginLifecycleStatus, PluginPanelField, PluginPanelFieldKind,
    PluginPermission, PluginPermissionDecisionState, PluginRiskCombination, PluginSerialProposal,
    PluginStatusReason, PluginUnavailableCapability,
};
use bbcom_plugin_broker::{
    AuthorizationState, ExtraConfirmationReason, PanelControlKind, PanelEvent, ProposalDecision,
    ReviewCapability,
};
use bbcom_plugin_contracts::Permission;
use bbcom_plugin_manager::{Clock, ManualPackageRequest, PluginSnapshot, PluginStatus};

use crate::commands::plugin::{PluginCommand, PluginCommandService as IpcPluginCommandService};

use super::command_service::{
    AuthorizationBrokerPort, AuthorizationReviewSnapshot, PanelBrokerPort, PluginCommandError,
    PluginCommandErrorCode, PluginCommandService, PluginCommandSnapshot, PluginCommandUpstreamPort,
    PluginLifecyclePort, PluginOperationFailure, PluginOperationSnapshot, PluginOperationStatus,
    ProposalBrokerPort,
};

const OPERATION: &str = "plugin_command_adapter";
// Keep adapter-side replay state bounded by the core operation registry bound.
const MAX_ADAPTER_CORRELATIONS: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublisherVerification {
    Unverified,
    VerifiedByNativeTrustStore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogPluginRecord {
    pub catalog_id: String,
    pub plugin_id: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub publisher_name: String,
    pub publisher_verification: PublisherVerification,
    pub install_request: ManualPackageRequest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginDisplayRecord {
    pub plugin_id: String,
    pub display_name: String,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogViewFailure {
    Unavailable,
    MissingCatalogItem,
    MissingPluginDisplay,
    MissingSessionDisplay,
    InconsistentIdentity,
}

/// Mandatory native source for data the lifecycle/broker core does not own.
///
/// `VerifiedByNativeTrustStore` may be returned only after the repository trust
/// store verified publisher identity. HTTPS, package SHA-256, manifest text or
/// a publisher-shaped string are insufficient. No default implementation is
/// provided.
pub trait CatalogViewPort: Send + 'static {
    fn catalog(&mut self) -> Result<Vec<CatalogPluginRecord>, CatalogViewFailure>;
    fn plugin_display(
        &mut self,
        plugin_id: &str,
    ) -> Result<PluginDisplayRecord, CatalogViewFailure>;
    fn session_label(&mut self, session_id: &str) -> Result<String, CatalogViewFailure>;
}

pub trait PluginCommandCorePort: Send + 'static {
    fn snapshot(&self) -> PluginCommandSnapshot;
    fn queue_install(
        &mut self,
        revision: u64,
        request_id: String,
        request: ManualPackageRequest,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_set_enabled(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_authorization_decisions(
        &mut self,
        revision: u64,
        request_id: String,
        review_id: String,
        decisions: Vec<(Permission, AuthorizationState)>,
        per_request_acknowledged: BTreeSet<Permission>,
        extra_confirmation_acknowledged: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_dismiss_authorization(
        &mut self,
        revision: u64,
        request_id: String,
        review_id: String,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_proposal_decision(
        &mut self,
        revision: u64,
        request_id: String,
        proposal_id: String,
        decision: ProposalDecision,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_panel_event(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        event: PanelEvent,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn execute_operation(
        &mut self,
        operation_id: &str,
        now_ms: u64,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn cancel_operation(
        &mut self,
        revision: u64,
        operation_id: &str,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
}

impl<L, U, AB, PB, DB> PluginCommandCorePort for PluginCommandService<L, U, AB, PB, DB>
where
    L: PluginLifecyclePort + Send + 'static,
    U: PluginCommandUpstreamPort + Send + 'static,
    AB: AuthorizationBrokerPort + Send + 'static,
    PB: ProposalBrokerPort + Send + 'static,
    DB: PanelBrokerPort + Send + 'static,
{
    fn snapshot(&self) -> PluginCommandSnapshot {
        PluginCommandService::snapshot(self)
    }

    fn queue_install(
        &mut self,
        revision: u64,
        request_id: String,
        request: ManualPackageRequest,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_install(self, revision, request_id, request)
    }

    fn queue_set_enabled(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_set_enabled(self, revision, request_id, plugin_id, enabled)
    }

    fn queue_authorization_decisions(
        &mut self,
        revision: u64,
        request_id: String,
        review_id: String,
        decisions: Vec<(Permission, AuthorizationState)>,
        per_request_acknowledged: BTreeSet<Permission>,
        extra_confirmation_acknowledged: bool,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_authorization_decisions(
            self,
            revision,
            request_id,
            review_id,
            decisions,
            per_request_acknowledged,
            extra_confirmation_acknowledged,
        )
    }

    fn queue_dismiss_authorization(
        &mut self,
        revision: u64,
        request_id: String,
        review_id: String,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_dismiss_authorization(self, revision, request_id, review_id)
    }

    fn queue_proposal_decision(
        &mut self,
        revision: u64,
        request_id: String,
        proposal_id: String,
        decision: ProposalDecision,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_proposal_decision(
            self,
            revision,
            request_id,
            proposal_id,
            decision,
        )
    }

    fn queue_panel_event(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        event: PanelEvent,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_panel_event(self, revision, request_id, plugin_id, event)
    }

    fn execute_operation(
        &mut self,
        operation_id: &str,
        now_ms: u64,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::execute(self, operation_id, now_ms)
    }

    fn cancel_operation(
        &mut self,
        revision: u64,
        operation_id: &str,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::cancel(self, revision, operation_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AdapterRequestFingerprint {
    revision: u64,
    payload: AdapterPayloadFingerprint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AdapterPayloadFingerprint {
    Install {
        catalog_id: String,
    },
    SetEnabled {
        plugin_id: String,
        enabled: bool,
    },
    SubmitAuthorization {
        review_id: String,
        decisions: Vec<(Permission, bool)>,
        per_request_acknowledged: Vec<Permission>,
        extra_confirmation_acknowledged: bool,
    },
    DismissAuthorization {
        review_id: String,
    },
    ResolveSerialProposal {
        proposal_id: String,
        approve: bool,
    },
    EmitPanelEvent {
        plugin_id: String,
        field_id: String,
        value: String,
    },
    CancelOperation,
}

impl AdapterRequestFingerprint {
    const fn is_cancel(&self) -> bool {
        matches!(&self.payload, AdapterPayloadFingerprint::CancelOperation)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AdapterCorrelationResolution {
    CoreOperation {
        operation_id: String,
        terminal_response: Option<PluginCommandResponse>,
    },
    StableTerminal(PluginCommandResponse),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AdapterCorrelationRecord {
    external_operation_id: String,
    fingerprint: AdapterRequestFingerprint,
    resolution: AdapterCorrelationResolution,
}

struct AdapterState<K, V> {
    core: K,
    catalog: V,
    correlations: BTreeMap<String, AdapterCorrelationRecord>,
    enabled_overrides: BTreeMap<String, bool>,
}

pub struct NativePluginCommandAdapter<K, V, C> {
    state: Mutex<AdapterState<K, V>>,
    clock: C,
}

impl<K, V, C> NativePluginCommandAdapter<K, V, C>
where
    K: PluginCommandCorePort,
    V: CatalogViewPort,
    C: Clock + Send + Sync + 'static,
{
    #[must_use]
    pub fn new(core: K, catalog: V, clock: C) -> Self {
        Self {
            state: Mutex::new(AdapterState {
                core,
                catalog,
                correlations: BTreeMap::new(),
                enabled_overrides: BTreeMap::new(),
            }),
            clock,
        }
    }

    fn execute_locked(
        &self,
        state: &mut AdapterState<K, V>,
        command: PluginCommand,
    ) -> Result<PluginCommandResponse, IpcError> {
        match command {
            PluginCommand::Snapshot(request) => {
                let snapshot = state.core.snapshot();
                ensure_snapshot_revision(request.revision, snapshot.revision, &request.request_id)?;
                completed(
                    &mut state.catalog,
                    &state.enabled_overrides,
                    request.request_id,
                    request.operation_id,
                    snapshot,
                )
            }
            PluginCommand::Install(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::Install {
                        catalog_id: request.catalog_id.clone(),
                    },
                };
                if let Some(resolution) = correlate_new(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        resolution,
                        self.clock.now_millis(),
                        None,
                    );
                }
                let record = state
                    .catalog
                    .catalog()
                    .map_err(|error| catalog_error(error, &request.request_id))?
                    .into_iter()
                    .find(|record| record.catalog_id == request.catalog_id)
                    .ok_or_else(|| {
                        catalog_error(CatalogViewFailure::MissingCatalogItem, &request.request_id)
                    })?;
                validate_install_record(&record)
                    .map_err(|error| catalog_error(error, &request.request_id))?;
                let queued = state
                    .core
                    .queue_install(
                        request.revision,
                        request.request_id.clone(),
                        record.install_request,
                    )
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    &queued,
                )?;
                execute_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    queued.operation_id,
                    self.clock.now_millis(),
                    None,
                )
            }
            PluginCommand::SetEnabled(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::SetEnabled {
                        plugin_id: request.plugin_id.clone(),
                        enabled: request.enabled,
                    },
                };
                if let Some(resolution) = correlate_new(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        resolution,
                        self.clock.now_millis(),
                        None,
                    );
                }
                let queued = state
                    .core
                    .queue_set_enabled(
                        request.revision,
                        request.request_id.clone(),
                        request.plugin_id.clone(),
                        request.enabled,
                    )
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    &queued,
                )?;
                let terminal = state
                    .core
                    .execute_operation(&queued.operation_id, self.clock.now_millis())
                    .map_err(|error| core_error(error, &request.request_id))?;
                if terminal.status == PluginOperationStatus::Completed {
                    state
                        .enabled_overrides
                        .insert(request.plugin_id, request.enabled);
                }
                finish_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    terminal,
                    None,
                )
            }
            PluginCommand::SubmitAuthorization(request) => {
                let mut fingerprint_decisions = request
                    .decisions
                    .iter()
                    .map(|decision| {
                        (
                            permission_from_ipc(decision.permission),
                            matches!(decision.state, PluginPermissionDecisionState::Granted),
                        )
                    })
                    .collect::<Vec<_>>();
                fingerprint_decisions.sort_unstable();
                let mut fingerprint_acknowledged = request
                    .per_request_capabilities_acknowledged
                    .iter()
                    .copied()
                    .map(permission_from_ipc)
                    .collect::<Vec<_>>();
                fingerprint_acknowledged.sort_unstable();
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::SubmitAuthorization {
                        review_id: request.review_id.clone(),
                        decisions: fingerprint_decisions,
                        per_request_acknowledged: fingerprint_acknowledged,
                        extra_confirmation_acknowledged: request.extra_confirmation_acknowledged,
                    },
                };
                if let Some(resolution) = correlate_new(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        resolution,
                        self.clock.now_millis(),
                        Some(PluginFailureCode::AuthorizationFailed),
                    );
                }
                let snapshot = state.core.snapshot();
                let acknowledged: BTreeSet<_> = request
                    .per_request_capabilities_acknowledged
                    .iter()
                    .copied()
                    .map(permission_from_ipc)
                    .collect();
                let decisions = request
                    .decisions
                    .iter()
                    .map(|decision| {
                        (
                            permission_from_ipc(decision.permission),
                            match decision.state {
                                PluginPermissionDecisionState::Granted => {
                                    AuthorizationState::Granted
                                }
                                PluginPermissionDecisionState::Denied => AuthorizationState::Denied,
                            },
                        )
                    })
                    .collect::<Vec<_>>();
                let submitted = decisions
                    .iter()
                    .map(|(permission, _)| *permission)
                    .collect::<BTreeSet<_>>();
                let review = snapshot
                    .authorization_reviews
                    .iter()
                    .find(|review| review.review_id == request.review_id)
                    .ok_or_else(|| permission_denied(&request.request_id))?;
                if acknowledged != review.requires_per_request_approval
                    || submitted.len() != decisions.len()
                    || submitted != review.requires_persistent_approval
                {
                    return failed_without_mutation(
                        state,
                        request.request_id,
                        request.operation_id,
                        fingerprint,
                        PluginFailureCode::AuthorizationFailed,
                    );
                }
                let queued = state
                    .core
                    .queue_authorization_decisions(
                        request.revision,
                        request.request_id.clone(),
                        request.review_id,
                        decisions,
                        acknowledged,
                        request.extra_confirmation_acknowledged,
                    )
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    &queued,
                )?;
                execute_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    queued.operation_id,
                    self.clock.now_millis(),
                    Some(PluginFailureCode::AuthorizationFailed),
                )
            }
            PluginCommand::DismissAuthorization(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::DismissAuthorization {
                        review_id: request.review_id.clone(),
                    },
                };
                if let Some(resolution) = correlate_new(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        resolution,
                        self.clock.now_millis(),
                        Some(PluginFailureCode::AuthorizationFailed),
                    );
                }
                let queued = state
                    .core
                    .queue_dismiss_authorization(
                        request.revision,
                        request.request_id.clone(),
                        request.review_id,
                    )
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    &queued,
                )?;
                execute_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    queued.operation_id,
                    self.clock.now_millis(),
                    Some(PluginFailureCode::AuthorizationFailed),
                )
            }
            PluginCommand::ResolveSerialProposal(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::ResolveSerialProposal {
                        proposal_id: request.proposal_id.clone(),
                        approve: matches!(
                            request.decision,
                            bbcom_contracts::PluginSerialProposalDecision::Approve
                        ),
                    },
                };
                if let Some(resolution) = correlate_new(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        resolution,
                        self.clock.now_millis(),
                        None,
                    );
                }
                let queued = state
                    .core
                    .queue_proposal_decision(
                        request.revision,
                        request.request_id.clone(),
                        request.proposal_id,
                        match request.decision {
                            bbcom_contracts::PluginSerialProposalDecision::Approve => {
                                ProposalDecision::Approve
                            }
                            bbcom_contracts::PluginSerialProposalDecision::Reject => {
                                ProposalDecision::Reject
                            }
                        },
                    )
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    &queued,
                )?;
                execute_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    queued.operation_id,
                    self.clock.now_millis(),
                    None,
                )
            }
            PluginCommand::EmitPanelEvent(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::EmitPanelEvent {
                        plugin_id: request.event.plugin_id.clone(),
                        field_id: request.event.field_id.clone(),
                        value: request.event.value.clone(),
                    },
                };
                if let Some(resolution) = correlate_new(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        resolution,
                        self.clock.now_millis(),
                        Some(PluginFailureCode::PanelEventRejected),
                    );
                }
                let queued = state
                    .core
                    .queue_panel_event(
                        request.revision,
                        request.request_id.clone(),
                        request.event.plugin_id.clone(),
                        PanelEvent {
                            field_id: request.event.field_id,
                            value: request.event.value,
                        },
                    )
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    &queued,
                )?;
                execute_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    queued.operation_id,
                    self.clock.now_millis(),
                    Some(PluginFailureCode::PanelEventRejected),
                )
            }
            PluginCommand::CancelOperation(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::CancelOperation,
                };
                if let Some(resolution) = correlate_cancel(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    &fingerprint,
                )? {
                    return replay_cancel_resolution(
                        state,
                        request.request_id,
                        request.operation_id,
                        request.revision,
                        resolution,
                    );
                }
                let core_operation = core_operation_for_external(state, &request.operation_id)
                    .ok_or_else(|| permission_denied(&request.request_id))?;
                let terminal = state
                    .core
                    .cancel_operation(request.revision, &core_operation)
                    .map_err(|error| core_error(error, &request.request_id))?;
                register_core_operation(
                    state,
                    &request.request_id,
                    &request.operation_id,
                    fingerprint,
                    core_operation,
                )?;
                finish_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    terminal,
                    Some(PluginFailureCode::CancelFailed),
                )
            }
        }
    }
}

impl<K, V, C> IpcPluginCommandService for NativePluginCommandAdapter<K, V, C>
where
    K: PluginCommandCorePort,
    V: CatalogViewPort,
    C: Clock + Send + Sync + 'static,
{
    fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
        let request_id = command_request_id(&command).to_owned();
        let mut state = self.state.lock().map_err(|_| {
            IpcError::new(
                AppErrorCode::Busy,
                "error.plugin_service_unavailable",
                true,
                OPERATION,
            )
            .with_request_id(&request_id)
        })?;
        self.execute_locked(&mut state, command)
            .map_err(|error| attach_request(error, &request_id))
    }
}

fn command_request_id(command: &PluginCommand) -> &str {
    match command {
        PluginCommand::Snapshot(request) => &request.request_id,
        PluginCommand::Install(request) => &request.request_id,
        PluginCommand::SetEnabled(request) => &request.request_id,
        PluginCommand::SubmitAuthorization(request) => &request.request_id,
        PluginCommand::DismissAuthorization(request) => &request.request_id,
        PluginCommand::ResolveSerialProposal(request) => &request.request_id,
        PluginCommand::EmitPanelEvent(request) => &request.request_id,
        PluginCommand::CancelOperation(request) => &request.request_id,
    }
}

fn correlate_new<K: PluginCommandCorePort, V>(
    state: &AdapterState<K, V>,
    request_id: &str,
    external_operation_id: &str,
    fingerprint: &AdapterRequestFingerprint,
) -> Result<Option<AdapterCorrelationResolution>, IpcError> {
    debug_assert!(!fingerprint.is_cancel());
    if let Some(existing) = state.correlations.get(request_id) {
        if existing.external_operation_id == external_operation_id
            && existing.fingerprint == *fingerprint
        {
            return Ok(Some(existing.resolution.clone()));
        }
        return Err(operation_conflict(request_id));
    }
    if state.correlations.values().any(|record| {
        !record.fingerprint.is_cancel() && record.external_operation_id == external_operation_id
    }) {
        return Err(operation_conflict(request_id));
    }
    ensure_correlation_capacity(state, request_id)?;
    let snapshot = state.core_snapshot();
    ensure_exact_revision(fingerprint.revision, snapshot.revision, request_id)?;
    Ok(None)
}

fn correlate_cancel<K: PluginCommandCorePort, V>(
    state: &AdapterState<K, V>,
    request_id: &str,
    external_operation_id: &str,
    fingerprint: &AdapterRequestFingerprint,
) -> Result<Option<AdapterCorrelationResolution>, IpcError> {
    debug_assert!(fingerprint.is_cancel());
    if let Some(existing) = state.correlations.get(request_id) {
        if existing.external_operation_id == external_operation_id
            && existing.fingerprint == *fingerprint
        {
            return Ok(Some(existing.resolution.clone()));
        }
        return Err(operation_conflict(request_id));
    }
    ensure_correlation_capacity(state, request_id)?;
    Ok(None)
}

fn ensure_correlation_capacity<K, V>(
    state: &AdapterState<K, V>,
    request_id: &str,
) -> Result<(), IpcError> {
    if state.correlations.len() < MAX_ADAPTER_CORRELATIONS {
        Ok(())
    } else {
        Err(IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            OPERATION,
        )
        .with_request_id(request_id)
        .with_size(
            MAX_ADAPTER_CORRELATIONS,
            state.correlations.len().saturating_add(1),
        ))
    }
}

trait SnapshotAccess {
    fn core_snapshot(&self) -> PluginCommandSnapshot;
}

impl<K: PluginCommandCorePort, V> SnapshotAccess for AdapterState<K, V> {
    fn core_snapshot(&self) -> PluginCommandSnapshot {
        self.core.snapshot()
    }
}

fn register_operation<K, V>(
    state: &mut AdapterState<K, V>,
    request_id: &str,
    external_operation_id: &str,
    fingerprint: AdapterRequestFingerprint,
    operation: &PluginOperationSnapshot,
) -> Result<(), IpcError> {
    register_core_operation(
        state,
        request_id,
        external_operation_id,
        fingerprint,
        operation.operation_id.clone(),
    )
}

fn register_core_operation<K, V>(
    state: &mut AdapterState<K, V>,
    request_id: &str,
    external_operation_id: &str,
    fingerprint: AdapterRequestFingerprint,
    core_operation_id: String,
) -> Result<(), IpcError> {
    if state.correlations.contains_key(request_id) {
        return Err(operation_conflict(request_id));
    }
    ensure_correlation_capacity(state, request_id)?;
    state.correlations.insert(
        request_id.to_owned(),
        AdapterCorrelationRecord {
            external_operation_id: external_operation_id.to_owned(),
            fingerprint,
            resolution: AdapterCorrelationResolution::CoreOperation {
                operation_id: core_operation_id,
                terminal_response: None,
            },
        },
    );
    Ok(())
}

fn register_stable_terminal<K, V>(
    state: &mut AdapterState<K, V>,
    request_id: &str,
    external_operation_id: &str,
    fingerprint: AdapterRequestFingerprint,
    response: PluginCommandResponse,
) -> Result<(), IpcError> {
    if state.correlations.contains_key(request_id) {
        return Err(operation_conflict(request_id));
    }
    ensure_correlation_capacity(state, request_id)?;
    state.correlations.insert(
        request_id.to_owned(),
        AdapterCorrelationRecord {
            external_operation_id: external_operation_id.to_owned(),
            fingerprint,
            resolution: AdapterCorrelationResolution::StableTerminal(response),
        },
    );
    Ok(())
}

fn core_operation_for_external<K, V>(
    state: &AdapterState<K, V>,
    external_operation_id: &str,
) -> Option<String> {
    state.correlations.values().find_map(|record| {
        if record.fingerprint.is_cancel() || record.external_operation_id != external_operation_id {
            return None;
        }
        match &record.resolution {
            AdapterCorrelationResolution::CoreOperation { operation_id, .. } => {
                Some(operation_id.clone())
            }
            AdapterCorrelationResolution::StableTerminal(_) => None,
        }
    })
}

fn cache_terminal_response<K, V>(
    state: &mut AdapterState<K, V>,
    request_id: &str,
    external_operation_id: &str,
    response: &PluginCommandResponse,
) -> Result<(), IpcError> {
    let record = state
        .correlations
        .get_mut(request_id)
        .ok_or_else(|| operation_conflict(request_id))?;
    if record.external_operation_id != external_operation_id {
        return Err(operation_conflict(request_id));
    }
    match &mut record.resolution {
        AdapterCorrelationResolution::CoreOperation {
            terminal_response, ..
        } => {
            if let Some(existing) = terminal_response.as_ref()
                && existing != response
            {
                return Err(operation_conflict(request_id));
            }
            *terminal_response = Some(response.clone());
            Ok(())
        }
        AdapterCorrelationResolution::StableTerminal(existing) if existing == response => Ok(()),
        AdapterCorrelationResolution::StableTerminal(_) => Err(operation_conflict(request_id)),
    }
}

fn execute_registered_operation<K: PluginCommandCorePort, V: CatalogViewPort>(
    state: &mut AdapterState<K, V>,
    request_id: String,
    external_operation_id: String,
    core_operation_id: String,
    now_ms: u64,
    forced_failure: Option<PluginFailureCode>,
) -> Result<PluginCommandResponse, IpcError> {
    let terminal = state
        .core
        .execute_operation(&core_operation_id, now_ms)
        .map_err(|error| core_error(error, &request_id))?;
    finish_registered_operation(
        state,
        request_id,
        external_operation_id,
        terminal,
        forced_failure,
    )
}

fn finish_registered_operation<K: PluginCommandCorePort, V: CatalogViewPort>(
    state: &mut AdapterState<K, V>,
    request_id: String,
    external_operation_id: String,
    terminal: PluginOperationSnapshot,
    forced_failure: Option<PluginFailureCode>,
) -> Result<PluginCommandResponse, IpcError> {
    let response = terminal_response(
        state,
        request_id.clone(),
        external_operation_id.clone(),
        terminal,
        forced_failure,
    )?;
    cache_terminal_response(state, &request_id, &external_operation_id, &response)?;
    Ok(response)
}

fn replay_resolution<K: PluginCommandCorePort, V: CatalogViewPort>(
    state: &mut AdapterState<K, V>,
    request_id: String,
    external_operation_id: String,
    resolution: AdapterCorrelationResolution,
    now_ms: u64,
    forced_failure: Option<PluginFailureCode>,
) -> Result<PluginCommandResponse, IpcError> {
    match resolution {
        AdapterCorrelationResolution::StableTerminal(response) => Ok(response),
        AdapterCorrelationResolution::CoreOperation {
            operation_id,
            terminal_response,
        } => {
            let terminal = state
                .core
                .execute_operation(&operation_id, now_ms)
                .map_err(|error| core_error(error, &request_id))?;
            if let Some(response) = terminal_response {
                if response_matches_operation(&response, &terminal) {
                    Ok(response)
                } else {
                    Err(operation_conflict(&request_id))
                }
            } else {
                finish_registered_operation(
                    state,
                    request_id,
                    external_operation_id,
                    terminal,
                    forced_failure,
                )
            }
        }
    }
}

fn replay_cancel_resolution<K: PluginCommandCorePort, V: CatalogViewPort>(
    state: &mut AdapterState<K, V>,
    request_id: String,
    external_operation_id: String,
    revision: u64,
    resolution: AdapterCorrelationResolution,
) -> Result<PluginCommandResponse, IpcError> {
    match resolution {
        AdapterCorrelationResolution::StableTerminal(_) => Err(operation_conflict(&request_id)),
        AdapterCorrelationResolution::CoreOperation {
            operation_id,
            terminal_response,
        } => {
            let terminal = state
                .core
                .cancel_operation(revision, &operation_id)
                .map_err(|error| core_error(error, &request_id))?;
            if let Some(response) = terminal_response {
                if response_matches_operation(&response, &terminal) {
                    Ok(response)
                } else {
                    Err(operation_conflict(&request_id))
                }
            } else {
                finish_registered_operation(
                    state,
                    request_id,
                    external_operation_id,
                    terminal,
                    Some(PluginFailureCode::CancelFailed),
                )
            }
        }
    }
}

fn response_matches_operation(
    response: &PluginCommandResponse,
    operation: &PluginOperationSnapshot,
) -> bool {
    matches!(
        (response, operation.status),
        (
            PluginCommandResponse::Completed { .. },
            PluginOperationStatus::Completed
        ) | (
            PluginCommandResponse::Cancelled { .. },
            PluginOperationStatus::Cancelled
        ) | (
            PluginCommandResponse::Failed { .. },
            PluginOperationStatus::Failed | PluginOperationStatus::Interrupted
        )
    )
}

fn terminal_response<K: PluginCommandCorePort, V: CatalogViewPort>(
    state: &mut AdapterState<K, V>,
    request_id: String,
    external_operation_id: String,
    operation: PluginOperationSnapshot,
    forced_failure: Option<PluginFailureCode>,
) -> Result<PluginCommandResponse, IpcError> {
    let snapshot = state.core.snapshot();
    let data = center_data(&mut state.catalog, &state.enabled_overrides, snapshot)
        .map_err(|error| attach_request(error, &request_id))?;
    match operation.status {
        PluginOperationStatus::Completed => Ok(PluginCommandResponse::Completed {
            request_id,
            operation_id: external_operation_id,
            revision: data.revision,
            data,
        }),
        PluginOperationStatus::Cancelled => Ok(PluginCommandResponse::Cancelled {
            request_id,
            operation_id: external_operation_id,
            revision: data.revision,
            data: Some(data),
        }),
        PluginOperationStatus::Failed | PluginOperationStatus::Interrupted => {
            Ok(PluginCommandResponse::Failed {
                request_id,
                operation_id: external_operation_id,
                revision: data.revision,
                failure: PluginFailure {
                    code: forced_failure
                        .unwrap_or_else(|| failure_code(operation.failure.as_ref())),
                },
                data: Some(data),
            })
        }
        PluginOperationStatus::Queued
        | PluginOperationStatus::Running
        | PluginOperationStatus::Cancelling => Err(IpcError::new(
            AppErrorCode::Busy,
            "error.plugin_operation_not_terminal",
            true,
            OPERATION,
        )
        .with_request_id(request_id)),
    }
}

fn failed_without_mutation<K: PluginCommandCorePort, V: CatalogViewPort>(
    state: &mut AdapterState<K, V>,
    request_id: String,
    operation_id: String,
    fingerprint: AdapterRequestFingerprint,
    code: PluginFailureCode,
) -> Result<PluginCommandResponse, IpcError> {
    let snapshot = state.core.snapshot();
    let data = center_data(&mut state.catalog, &state.enabled_overrides, snapshot)
        .map_err(|error| attach_request(error, &request_id))?;
    let response = PluginCommandResponse::Failed {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        revision: data.revision,
        failure: PluginFailure { code },
        data: Some(data),
    };
    register_stable_terminal(
        state,
        &request_id,
        &operation_id,
        fingerprint,
        response.clone(),
    )?;
    Ok(response)
}

fn completed<V: CatalogViewPort>(
    catalog: &mut V,
    enabled_overrides: &BTreeMap<String, bool>,
    request_id: String,
    operation_id: String,
    snapshot: PluginCommandSnapshot,
) -> Result<PluginCommandResponse, IpcError> {
    let data = center_data(catalog, enabled_overrides, snapshot)
        .map_err(|error| attach_request(error, &request_id))?;
    Ok(PluginCommandResponse::Completed {
        request_id,
        operation_id,
        revision: data.revision,
        data,
    })
}

fn center_data<V: CatalogViewPort>(
    catalog_port: &mut V,
    enabled_overrides: &BTreeMap<String, bool>,
    snapshot: PluginCommandSnapshot,
) -> Result<PluginCenterData, IpcError> {
    let mut catalog_records = catalog_port
        .catalog()
        .map_err(|error| catalog_error(error, "snapshot"))?;
    let installed_versions: BTreeMap<_, _> = snapshot
        .plugins
        .iter()
        .map(|plugin| {
            (
                plugin.artifact.plugin_id.clone(),
                plugin.artifact.version.clone(),
            )
        })
        .collect();
    let mut catalog = Vec::with_capacity(catalog_records.len());
    for record in catalog_records.drain(..) {
        validate_install_record(&record).map_err(|error| catalog_error(error, "snapshot"))?;
        catalog.push(PluginCatalogItem {
            catalog_id: record.catalog_id,
            plugin_id: record.plugin_id.clone(),
            display_name: record.display_name,
            description: record.description,
            version: record.version,
            publisher_name: record.publisher_name,
            publisher_verified: matches!(
                record.publisher_verification,
                PublisherVerification::VerifiedByNativeTrustStore
            ),
            installed_version: installed_versions.get(&record.plugin_id).cloned(),
        });
    }
    let installed = snapshot
        .plugins
        .iter()
        .map(|plugin| installed_view(catalog_port, enabled_overrides, plugin))
        .collect::<Result<Vec<_>, _>>()?;
    let authorization_review = match snapshot.authorization_reviews.as_slice() {
        [] => None,
        [review] => Some(authorization_view(catalog_port, &snapshot.plugins, review)?),
        _ => return Err(permission_denied("snapshot")),
    };
    let serial_proposals = snapshot
        .proposals
        .iter()
        .map(|proposal| {
            let display = catalog_port
                .plugin_display(&proposal.plugin_id)
                .map_err(|error| catalog_error(error, "snapshot"))?;
            if display.plugin_id != proposal.plugin_id {
                return Err(catalog_error(
                    CatalogViewFailure::InconsistentIdentity,
                    "snapshot",
                ));
            }
            Ok(PluginSerialProposal {
                proposal_id: proposal.proposal_id.clone(),
                plugin_id: proposal.plugin_id.clone(),
                plugin_name: display.display_name,
                session_label: catalog_port
                    .session_label(&proposal.session_id)
                    .map_err(|error| catalog_error(error, "snapshot"))?,
                display_label: proposal.display_label.clone(),
                byte_count: proposal.byte_count,
                hex_preview: proposal.hex_preview.clone(),
                expires_at_ms: proposal.expires_at_ms,
            })
        })
        .collect::<Result<Vec<_>, IpcError>>()?;
    let panels = snapshot.panels.iter().map(panel_view).collect();
    Ok(PluginCenterData {
        revision: snapshot.revision,
        catalog,
        installed,
        authorization_review,
        serial_proposals,
        panels,
    })
}

fn installed_view<V: CatalogViewPort>(
    catalog: &mut V,
    enabled_overrides: &BTreeMap<String, bool>,
    plugin: &PluginSnapshot,
) -> Result<InstalledPluginView, IpcError> {
    let display = catalog
        .plugin_display(&plugin.artifact.plugin_id)
        .map_err(|error| catalog_error(error, "snapshot"))?;
    if display.plugin_id != plugin.artifact.plugin_id {
        return Err(catalog_error(
            CatalogViewFailure::InconsistentIdentity,
            "snapshot",
        ));
    }
    let (status, status_reason) = lifecycle_status(plugin.status);
    Ok(InstalledPluginView {
        plugin_id: plugin.artifact.plugin_id.clone(),
        display_name: display.display_name,
        version: plugin.artifact.version.clone(),
        status,
        status_reason,
        enabled: enabled_overrides
            .get(&plugin.artifact.plugin_id)
            .copied()
            .unwrap_or(display.enabled),
        pending_version: plugin.pending_version.clone(),
        requested_permissions: plugin
            .artifact
            .requested_permissions
            .iter()
            .copied()
            .map(permission_to_ipc)
            .collect(),
    })
}

fn authorization_view<V: CatalogViewPort>(
    catalog: &mut V,
    plugins: &[PluginSnapshot],
    review: &AuthorizationReviewSnapshot,
) -> Result<PluginAuthorizationReview, IpcError> {
    if !plugins
        .iter()
        .any(|plugin| plugin.artifact.plugin_id == review.plugin_id)
    {
        return Err(permission_denied("snapshot"));
    }
    let display = catalog
        .plugin_display(&review.plugin_id)
        .map_err(|error| catalog_error(error, "snapshot"))?;
    if display.plugin_id != review.plugin_id {
        return Err(catalog_error(
            CatalogViewFailure::InconsistentIdentity,
            "snapshot",
        ));
    }
    Ok(PluginAuthorizationReview {
        review_id: review.review_id.clone(),
        plugin_id: review.plugin_id.clone(),
        display_name: display.display_name,
        version: review.artifact_version.clone(),
        persistent_permissions: review
            .requires_persistent_approval
            .iter()
            .copied()
            .map(permission_to_ipc)
            .collect(),
        per_request_permissions: review
            .requires_per_request_approval
            .iter()
            .copied()
            .map(permission_to_ipc)
            .collect(),
        unavailable_capabilities: review
            .unavailable
            .iter()
            .copied()
            .map(|capability| match capability {
                ReviewCapability::Permission(permission) => permission_to_unavailable(permission),
                ReviewCapability::Network => PluginUnavailableCapability::Network,
            })
            .collect(),
        extra_confirmation_reasons: review
            .extra_confirmation_reasons
            .iter()
            .copied()
            .map(|reason| match reason {
                ExtraConfirmationReason::CaptureWithNetwork => {
                    PluginRiskCombination::CaptureWithNetwork
                }
                ExtraConfirmationReason::ConversationWithNetwork => {
                    PluginRiskCombination::ConversationWithNetwork
                }
                ExtraConfirmationReason::CaptureWithExternalSink => {
                    PluginRiskCombination::CaptureWithExternalSink
                }
                ExtraConfirmationReason::ConversationWithExternalSink => {
                    PluginRiskCombination::ConversationWithExternalSink
                }
                ExtraConfirmationReason::SerialControlAndWriteProposal => {
                    PluginRiskCombination::SerialControlAndWriteProposal
                }
            })
            .collect(),
    })
}

fn panel_view(panel: &bbcom_plugin_broker::HostedPanel) -> PluginDeclarativePanel {
    PluginDeclarativePanel {
        plugin_id: panel.plugin_id().to_owned(),
        title: panel.panel().title.clone(),
        fields: panel
            .panel()
            .fields
            .iter()
            .map(|field| PluginPanelField {
                id: field.id.clone(),
                label: field.label.clone(),
                kind: match field.kind {
                    PanelControlKind::Text => PluginPanelFieldKind::Text,
                    PanelControlKind::Number => PluginPanelFieldKind::Number,
                    PanelControlKind::Toggle => PluginPanelFieldKind::Toggle,
                    PanelControlKind::Select => PluginPanelFieldKind::Select,
                    PanelControlKind::Button => PluginPanelFieldKind::Button,
                },
                value: field.value.clone(),
                options: field.options.clone(),
                disabled: field.disabled,
            })
            .collect(),
    }
}

fn lifecycle_status(status: PluginStatus) -> (PluginLifecycleStatus, Option<PluginStatusReason>) {
    match status {
        PluginStatus::ApprovalRequired(reason) => (
            PluginLifecycleStatus::ApprovalRequired,
            Some(match reason {
                bbcom_plugin_manager::ApprovalReason::InitialInstall => {
                    PluginStatusReason::InitialInstall
                }
                bbcom_plugin_manager::ApprovalReason::WorkspaceChanged => {
                    PluginStatusReason::WorkspaceChanged
                }
                bbcom_plugin_manager::ApprovalReason::PermissionExpansion => {
                    PluginStatusReason::PermissionExpansion
                }
                bbcom_plugin_manager::ApprovalReason::ArtifactChanged => {
                    PluginStatusReason::ArtifactChanged
                }
            }),
        ),
        PluginStatus::Disabled(reason) => (
            PluginLifecycleStatus::Disabled,
            Some(match reason {
                bbcom_plugin_manager::DisableReason::User => PluginStatusReason::User,
                bbcom_plugin_manager::DisableReason::CrashLoopRolledBack => {
                    PluginStatusReason::CrashLoopRolledBack
                }
                bbcom_plugin_manager::DisableReason::CrashLoopNoRollback => {
                    PluginStatusReason::CrashLoopNoRollback
                }
                bbcom_plugin_manager::DisableReason::RollbackFailed => {
                    PluginStatusReason::RollbackFailed
                }
                bbcom_plugin_manager::DisableReason::RollbackBlockedRevoked => {
                    PluginStatusReason::RollbackBlockedRevoked
                }
                bbcom_plugin_manager::DisableReason::ArtifactRevoked => {
                    PluginStatusReason::ArtifactRevoked
                }
            }),
        ),
        PluginStatus::Stopped => (PluginLifecycleStatus::Stopped, None),
        PluginStatus::Starting => (PluginLifecycleStatus::Starting, None),
        PluginStatus::Running => (PluginLifecycleStatus::Running, None),
        PluginStatus::Updating => (PluginLifecycleStatus::Updating, None),
        PluginStatus::RollingBack => (PluginLifecycleStatus::RollingBack, None),
        PluginStatus::Failed => (PluginLifecycleStatus::Failed, None),
    }
}

fn permission_to_ipc(permission: Permission) -> PluginPermission {
    match permission {
        Permission::UiPanel => PluginPermission::UiPanel,
        Permission::PluginStorage => PluginPermission::PluginStorage,
        Permission::SessionMetadataRead => PluginPermission::SessionMetadataRead,
        Permission::SessionCaptureRead => PluginPermission::SessionCaptureRead,
        Permission::ProjectSettingsReadWrite => PluginPermission::ProjectSettingsReadWrite,
        Permission::SerialPortsRead => PluginPermission::SerialPortsRead,
        Permission::SerialControl => PluginPermission::SerialControl,
        Permission::SerialWriteProposal => PluginPermission::SerialWriteProposal,
        Permission::AiConversationRead => PluginPermission::AiConversationRead,
        Permission::AiRequest => PluginPermission::AiRequest,
        Permission::FileOpenSave => PluginPermission::FileOpenSave,
        Permission::Clipboard => PluginPermission::Clipboard,
        Permission::Notification => PluginPermission::Notification,
    }
}

fn permission_from_ipc(permission: PluginPermission) -> Permission {
    match permission {
        PluginPermission::UiPanel => Permission::UiPanel,
        PluginPermission::PluginStorage => Permission::PluginStorage,
        PluginPermission::SessionMetadataRead => Permission::SessionMetadataRead,
        PluginPermission::SessionCaptureRead => Permission::SessionCaptureRead,
        PluginPermission::ProjectSettingsReadWrite => Permission::ProjectSettingsReadWrite,
        PluginPermission::SerialPortsRead => Permission::SerialPortsRead,
        PluginPermission::SerialControl => Permission::SerialControl,
        PluginPermission::SerialWriteProposal => Permission::SerialWriteProposal,
        PluginPermission::AiConversationRead => Permission::AiConversationRead,
        PluginPermission::AiRequest => Permission::AiRequest,
        PluginPermission::FileOpenSave => Permission::FileOpenSave,
        PluginPermission::Clipboard => Permission::Clipboard,
        PluginPermission::Notification => Permission::Notification,
    }
}

fn permission_to_unavailable(permission: Permission) -> PluginUnavailableCapability {
    match permission {
        Permission::UiPanel => PluginUnavailableCapability::UiPanel,
        Permission::PluginStorage => PluginUnavailableCapability::PluginStorage,
        Permission::SessionMetadataRead => PluginUnavailableCapability::SessionMetadataRead,
        Permission::SessionCaptureRead => PluginUnavailableCapability::SessionCaptureRead,
        Permission::ProjectSettingsReadWrite => {
            PluginUnavailableCapability::ProjectSettingsReadWrite
        }
        Permission::SerialPortsRead => PluginUnavailableCapability::SerialPortsRead,
        Permission::SerialControl => PluginUnavailableCapability::SerialControl,
        Permission::SerialWriteProposal => PluginUnavailableCapability::SerialWriteProposal,
        Permission::AiConversationRead => PluginUnavailableCapability::AiConversationRead,
        Permission::AiRequest => PluginUnavailableCapability::AiRequest,
        Permission::FileOpenSave => PluginUnavailableCapability::FileOpenSave,
        Permission::Clipboard => PluginUnavailableCapability::Clipboard,
        Permission::Notification => PluginUnavailableCapability::Notification,
    }
}

fn validate_install_record(record: &CatalogPluginRecord) -> Result<(), CatalogViewFailure> {
    if record.catalog_id.is_empty()
        || record.plugin_id != record.install_request.plugin_id
        || record.version != record.install_request.version
        || record.display_name.is_empty()
        || record.publisher_name.is_empty()
    {
        Err(CatalogViewFailure::InconsistentIdentity)
    } else {
        Ok(())
    }
}

fn ensure_snapshot_revision(requested: u64, actual: u64, request_id: &str) -> Result<(), IpcError> {
    if requested <= actual {
        Ok(())
    } else {
        Err(revision_conflict(request_id))
    }
}

fn ensure_exact_revision(requested: u64, actual: u64, request_id: &str) -> Result<(), IpcError> {
    if requested == actual {
        Ok(())
    } else {
        Err(revision_conflict(request_id))
    }
}

fn failure_code(failure: Option<&PluginOperationFailure>) -> PluginFailureCode {
    let Some(failure) = failure else {
        return PluginFailureCode::Unavailable;
    };
    if failure.code.contains("INSTALL") {
        PluginFailureCode::InstallationFailed
    } else if failure.code.contains("AUTHORIZATION") || failure.code.contains("PERMISSION") {
        PluginFailureCode::AuthorizationFailed
    } else if failure.code.contains("PANEL") {
        PluginFailureCode::PanelEventRejected
    } else if failure.code == "PLUGIN_SERIAL_EXECUTION_UNAVAILABLE" {
        PluginFailureCode::Unavailable
    } else if failure.code.contains("PROPOSAL") {
        PluginFailureCode::ProposalConsumed
    } else if failure.code.contains("HOST") {
        PluginFailureCode::HostFailed
    } else {
        PluginFailureCode::Unavailable
    }
}

fn core_error(error: PluginCommandError, request_id: &str) -> IpcError {
    let (code, message_key, retryable) = match error.code {
        PluginCommandErrorCode::RevisionConflict => (
            AppErrorCode::RevisionConflict,
            "error.revision_conflict",
            true,
        ),
        PluginCommandErrorCode::RegistryLimit => {
            (AppErrorCode::LimitExceeded, "error.limit_exceeded", false)
        }
        PluginCommandErrorCode::RequestConflict
        | PluginCommandErrorCode::OperationNotCancellable => {
            (AppErrorCode::Busy, "error.plugin_operation_conflict", false)
        }
        _ => (
            AppErrorCode::PluginPermissionDenied,
            "error.plugin_permission_denied",
            false,
        ),
    };
    IpcError::new(code, message_key, retryable, OPERATION).with_request_id(request_id)
}

fn catalog_error(error: CatalogViewFailure, request_id: &str) -> IpcError {
    let message_key = match error {
        CatalogViewFailure::Unavailable => "error.plugin_catalog_unavailable",
        CatalogViewFailure::MissingCatalogItem => "error.plugin_catalog_item_missing",
        CatalogViewFailure::MissingPluginDisplay => "error.plugin_display_missing",
        CatalogViewFailure::MissingSessionDisplay => "error.plugin_session_display_missing",
        CatalogViewFailure::InconsistentIdentity => "error.plugin_catalog_inconsistent",
    };
    IpcError::new(
        AppErrorCode::PluginPermissionDenied,
        message_key,
        false,
        OPERATION,
    )
    .with_request_id(request_id)
}

fn revision_conflict(request_id: &str) -> IpcError {
    IpcError::new(
        AppErrorCode::RevisionConflict,
        "error.revision_conflict",
        true,
        OPERATION,
    )
    .with_request_id(request_id)
}

fn operation_conflict(request_id: &str) -> IpcError {
    IpcError::new(
        AppErrorCode::Busy,
        "error.plugin_operation_conflict",
        false,
        OPERATION,
    )
    .with_request_id(request_id)
}

fn permission_denied(request_id: &str) -> IpcError {
    IpcError::new(
        AppErrorCode::PluginPermissionDenied,
        "error.plugin_permission_denied",
        false,
        OPERATION,
    )
    .with_request_id(request_id)
}

fn attach_request(error: IpcError, request_id: &str) -> IpcError {
    match error.request_id.as_deref() {
        Some(existing) if existing == request_id => error,
        Some(_) => operation_conflict(request_id),
        None => error.with_request_id(request_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use bbcom_contracts::{
        InstallPluginRequest, PluginPermissionDecision, PluginSnapshotRequest,
        SetPluginEnabledRequest, SubmitPluginAuthorizationRequest,
    };
    use bbcom_plugin_manager::{PluginArtifact, SystemClock};

    struct Core {
        snapshot: PluginCommandSnapshot,
        next: u64,
    }

    impl PluginCommandCorePort for Core {
        fn snapshot(&self) -> PluginCommandSnapshot {
            self.snapshot.clone()
        }

        fn queue_install(
            &mut self,
            revision: u64,
            request_id: String,
            _request: ManualPackageRequest,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.queue(revision, request_id)
        }

        fn queue_set_enabled(
            &mut self,
            revision: u64,
            request_id: String,
            _plugin_id: String,
            _enabled: bool,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.queue(revision, request_id)
        }

        fn queue_authorization_decisions(
            &mut self,
            revision: u64,
            request_id: String,
            _review_id: String,
            _decisions: Vec<(Permission, AuthorizationState)>,
            _per_request_acknowledged: BTreeSet<Permission>,
            _ack: bool,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.queue(revision, request_id)
        }

        fn queue_dismiss_authorization(
            &mut self,
            revision: u64,
            request_id: String,
            _review_id: String,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.queue(revision, request_id)
        }

        fn queue_proposal_decision(
            &mut self,
            revision: u64,
            request_id: String,
            _proposal_id: String,
            _decision: ProposalDecision,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.queue(revision, request_id)
        }

        fn queue_panel_event(
            &mut self,
            revision: u64,
            request_id: String,
            _plugin_id: String,
            _event: PanelEvent,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.queue(revision, request_id)
        }

        fn execute_operation(
            &mut self,
            operation_id: &str,
            _now_ms: u64,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            self.snapshot.revision += 1;
            Ok(PluginOperationSnapshot {
                operation_id: operation_id.to_owned(),
                client_request_id: "request".to_owned(),
                kind: super::super::command_service::PluginOperationKind::Install,
                status: PluginOperationStatus::Completed,
                failure: None,
            })
        }

        fn cancel_operation(
            &mut self,
            _revision: u64,
            operation_id: &str,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            Ok(PluginOperationSnapshot {
                operation_id: operation_id.to_owned(),
                client_request_id: "request".to_owned(),
                kind: super::super::command_service::PluginOperationKind::Install,
                status: PluginOperationStatus::Cancelled,
                failure: None,
            })
        }
    }

    impl Core {
        fn queue(
            &mut self,
            revision: u64,
            request_id: String,
        ) -> Result<PluginOperationSnapshot, PluginCommandError> {
            assert_eq!(revision, self.snapshot.revision);
            let id = format!("core-{}", self.next);
            self.next += 1;
            Ok(PluginOperationSnapshot {
                operation_id: id,
                client_request_id: request_id,
                kind: super::super::command_service::PluginOperationKind::Install,
                status: PluginOperationStatus::Queued,
                failure: None,
            })
        }
    }

    struct Catalog;

    impl CatalogViewPort for Catalog {
        fn catalog(&mut self) -> Result<Vec<CatalogPluginRecord>, CatalogViewFailure> {
            Ok(fixture_catalog())
        }

        fn plugin_display(
            &mut self,
            plugin_id: &str,
        ) -> Result<PluginDisplayRecord, CatalogViewFailure> {
            Ok(fixture_display(plugin_id))
        }

        fn session_label(&mut self, _session_id: &str) -> Result<String, CatalogViewFailure> {
            Ok("Session".to_owned())
        }
    }

    struct CountingCatalog {
        catalog_calls: Arc<AtomicUsize>,
    }

    impl CatalogViewPort for CountingCatalog {
        fn catalog(&mut self) -> Result<Vec<CatalogPluginRecord>, CatalogViewFailure> {
            self.catalog_calls.fetch_add(1, Ordering::SeqCst);
            Ok(fixture_catalog())
        }

        fn plugin_display(
            &mut self,
            plugin_id: &str,
        ) -> Result<PluginDisplayRecord, CatalogViewFailure> {
            Ok(fixture_display(plugin_id))
        }

        fn session_label(&mut self, _session_id: &str) -> Result<String, CatalogViewFailure> {
            Ok("Session".to_owned())
        }
    }

    fn fixture_catalog() -> Vec<CatalogPluginRecord> {
        vec![CatalogPluginRecord {
            catalog_id: "official:fixture".to_owned(),
            plugin_id: "dev.bbcom.fixture".to_owned(),
            display_name: "Fixture".to_owned(),
            description: String::new(),
            version: "1.0.0".to_owned(),
            publisher_name: "Fixture Publisher".to_owned(),
            publisher_verification: PublisherVerification::Unverified,
            install_request: ManualPackageRequest::new("official", "dev.bbcom.fixture", "1.0.0")
                .unwrap(),
        }]
    }

    fn fixture_display(plugin_id: &str) -> PluginDisplayRecord {
        PluginDisplayRecord {
            plugin_id: plugin_id.to_owned(),
            display_name: "Fixture".to_owned(),
            enabled: false,
        }
    }

    fn adapter() -> NativePluginCommandAdapter<Core, Catalog, SystemClock> {
        adapter_with_catalog(Catalog)
    }

    fn adapter_with_catalog<V: CatalogViewPort>(
        catalog: V,
    ) -> NativePluginCommandAdapter<Core, V, SystemClock> {
        NativePluginCommandAdapter::new(
            Core {
                snapshot: PluginCommandSnapshot {
                    revision: 1,
                    plugins: Vec::new(),
                    operations: Vec::new(),
                    authorization_reviews: Vec::new(),
                    proposals: Vec::new(),
                    panels: Vec::new(),
                },
                next: 1,
            },
            catalog,
            SystemClock,
        )
    }

    fn fixture_plugin(permissions: impl IntoIterator<Item = Permission>) -> PluginSnapshot {
        PluginSnapshot {
            artifact: PluginArtifact::new(
                "dev.bbcom.fixture",
                "1.0.0",
                format!("publisher:sha256-{}", "a".repeat(64)),
                permissions,
            )
            .unwrap(),
            status: PluginStatus::Stopped,
            pending_version: None,
            running_instance_id: None,
            crashes_in_window: 0,
            last_error: None,
        }
    }

    #[test]
    fn snapshot_and_install_preserve_external_correlation() {
        let adapter = adapter();
        let snapshot = adapter
            .execute(PluginCommand::Snapshot(PluginSnapshotRequest {
                request_id: "request-snapshot".to_owned(),
                revision: 0,
                operation_id: "snapshot-operation".to_owned(),
            }))
            .unwrap();
        assert_eq!(snapshot.request_id(), "request-snapshot");
        assert_eq!(snapshot.operation_id(), "snapshot-operation");

        let installed = adapter
            .execute(PluginCommand::Install(InstallPluginRequest {
                request_id: "request-install".to_owned(),
                revision: 1,
                operation_id: "external-operation".to_owned(),
                catalog_id: "official:fixture".to_owned(),
            }))
            .unwrap();
        assert_eq!(installed.request_id(), "request-install");
        assert_eq!(installed.operation_id(), "external-operation");
    }

    #[test]
    fn verified_publisher_is_never_inferred_and_stale_mutation_fails() {
        let adapter = adapter();
        let response = adapter
            .execute(PluginCommand::Snapshot(PluginSnapshotRequest {
                request_id: "request-snapshot".to_owned(),
                revision: 0,
                operation_id: "snapshot-operation".to_owned(),
            }))
            .unwrap();
        assert!(!response.data().unwrap().catalog[0].publisher_verified);
        let error = adapter
            .execute(PluginCommand::SetEnabled(SetPluginEnabledRequest {
                request_id: "request-enable".to_owned(),
                revision: 0,
                operation_id: "enable-operation".to_owned(),
                plugin_id: "dev.bbcom.fixture".to_owned(),
                enabled: true,
            }))
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::RevisionConflict);
        assert_eq!(error.request_id.as_deref(), Some("request-enable"));
    }

    #[test]
    fn install_exact_replay_reuses_core_operation_without_catalog_read() {
        let catalog_calls = Arc::new(AtomicUsize::new(0));
        let adapter = adapter_with_catalog(CountingCatalog {
            catalog_calls: Arc::clone(&catalog_calls),
        });
        let request = InstallPluginRequest {
            request_id: "request-install".to_owned(),
            revision: 1,
            operation_id: "external-operation".to_owned(),
            catalog_id: "official:fixture".to_owned(),
        };

        let first = adapter
            .execute(PluginCommand::Install(request.clone()))
            .unwrap();
        assert_eq!(catalog_calls.load(Ordering::SeqCst), 2);

        let replay = adapter
            .execute(PluginCommand::Install(request.clone()))
            .unwrap();
        assert_eq!(replay, first);
        assert_eq!(catalog_calls.load(Ordering::SeqCst), 2);
        assert_eq!(adapter.state.lock().unwrap().core.next, 2);

        let mut variant = request;
        variant.catalog_id = "official:replacement".to_owned();
        let error = adapter
            .execute(PluginCommand::Install(variant))
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::Busy);
        assert_eq!(error.message_key, "error.plugin_operation_conflict");
        assert_eq!(catalog_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn authorization_prevalidation_failure_is_canonical_and_stable() {
        let catalog_calls = Arc::new(AtomicUsize::new(0));
        let adapter = adapter_with_catalog(CountingCatalog {
            catalog_calls: Arc::clone(&catalog_calls),
        });
        {
            let mut state = adapter.state.lock().unwrap();
            state
                .core
                .snapshot
                .plugins
                .push(fixture_plugin([Permission::UiPanel, Permission::Clipboard]));
            state
                .core
                .snapshot
                .authorization_reviews
                .push(AuthorizationReviewSnapshot {
                    review_id: "review-1".to_owned(),
                    plugin_id: "dev.bbcom.fixture".to_owned(),
                    artifact_version: "1.0.0".to_owned(),
                    implicit: BTreeSet::new(),
                    requires_persistent_approval: BTreeSet::from([Permission::UiPanel]),
                    requires_per_request_approval: BTreeSet::new(),
                    unavailable: BTreeSet::new(),
                    extra_confirmation: false,
                    extra_confirmation_reasons: BTreeSet::new(),
                });
        }
        let request = SubmitPluginAuthorizationRequest {
            request_id: "request-authorization".to_owned(),
            revision: 1,
            operation_id: "authorization-operation".to_owned(),
            review_id: "review-1".to_owned(),
            decisions: vec![
                PluginPermissionDecision {
                    permission: PluginPermission::UiPanel,
                    state: PluginPermissionDecisionState::Granted,
                },
                PluginPermissionDecision {
                    permission: PluginPermission::Clipboard,
                    state: PluginPermissionDecisionState::Granted,
                },
            ],
            per_request_capabilities_acknowledged: Vec::new(),
            extra_confirmation_acknowledged: false,
        };

        let first = adapter
            .execute(PluginCommand::SubmitAuthorization(request.clone()))
            .unwrap();
        assert!(matches!(
            &first,
            PluginCommandResponse::Failed {
                failure: PluginFailure {
                    code: PluginFailureCode::AuthorizationFailed
                },
                ..
            }
        ));
        assert_eq!(catalog_calls.load(Ordering::SeqCst), 1);

        {
            let mut state = adapter.state.lock().unwrap();
            state.core.snapshot.authorization_reviews[0].requires_persistent_approval =
                BTreeSet::from([Permission::UiPanel, Permission::Clipboard]);
        }
        let mut reordered = request.clone();
        reordered.decisions.reverse();
        let replay = adapter
            .execute(PluginCommand::SubmitAuthorization(reordered))
            .unwrap();
        assert_eq!(replay, first);
        assert_eq!(catalog_calls.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.state.lock().unwrap().core.next, 1);

        let mut variant = request;
        variant.decisions[1].state = PluginPermissionDecisionState::Denied;
        let error = adapter
            .execute(PluginCommand::SubmitAuthorization(variant))
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::Busy);
        assert_eq!(error.message_key, "error.plugin_operation_conflict");
        assert_eq!(catalog_calls.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.state.lock().unwrap().core.next, 1);
    }
}
