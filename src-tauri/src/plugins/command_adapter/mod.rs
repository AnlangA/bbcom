//! Lossless adapter from the reviewed IPC plugin commands to the native core.
//!
//! The adapter owns no repository, trust decision, path, serial port or host.
//! One mutex serializes correlation maps, catalog reads and core transitions.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use bbcom_contracts::{
    AppErrorCode, InstalledPluginView, IpcError, PluginCapabilityV2, PluginCatalogItem,
    PluginCenterData, PluginCommandResponse, PluginContributionDisposition, PluginFailure,
    PluginFailureCode, PluginLifecycleStatus, PluginStatusReason, RuntimeInstanceKey,
};
use bbcom_plugin_manager::{
    Clock, ManualPackageRequest, PluginSnapshot, PluginStatus, SystemClock,
};

use crate::commands::plugin::{PluginCommand, PluginCommandService as IpcPluginCommandService};

use super::command_service::{
    PluginCommandError, PluginCommandErrorCode, PluginCommandService, PluginCommandSnapshot,
    PluginOperationFailure, PluginOperationSnapshot, PluginOperationStatus,
};

const OPERATION: &str = "plugin_command_adapter";
// Keep adapter-side replay state bounded by the core operation registry bound.
const MAX_ACTIVE_ADAPTER_CORRELATIONS: usize = 128;
const MAX_COMPLETED_ADAPTER_CORRELATIONS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogPluginRecord {
    pub catalog_id: String,
    pub plugin_id: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub publisher_name: String,
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
    InconsistentIdentity,
}

/// Mandatory native source for data the lifecycle/broker core does not own.
///
/// No default implementation is provided.
pub trait CatalogViewPort: Send + 'static {
    fn catalog(&mut self) -> Result<Vec<CatalogPluginRecord>, CatalogViewFailure>;
    fn plugin_display(
        &mut self,
        plugin_id: &str,
    ) -> Result<PluginDisplayRecord, CatalogViewFailure>;
}

pub trait PluginCommandCorePort: Send + 'static {
    fn snapshot(&self) -> PluginCommandSnapshot;
    fn queue_install(
        &mut self,
        revision: u64,
        request_id: String,
        request: ManualPackageRequest,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_install_local(
        &mut self,
        revision: u64,
        request_id: String,
        package_root: std::path::PathBuf,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_uninstall(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        contribution_disposition: PluginContributionDisposition,
    ) -> Result<PluginOperationSnapshot, PluginCommandError>;
    fn queue_set_enabled(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        enabled: bool,
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

impl PluginCommandCorePort for PluginCommandService {
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

    fn queue_install_local(
        &mut self,
        revision: u64,
        request_id: String,
        package_root: std::path::PathBuf,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_install_local(self, revision, request_id, package_root)
    }

    fn queue_uninstall(
        &mut self,
        revision: u64,
        request_id: String,
        plugin_id: String,
        contribution_disposition: PluginContributionDisposition,
    ) -> Result<PluginOperationSnapshot, PluginCommandError> {
        PluginCommandService::queue_uninstall(
            self,
            revision,
            request_id,
            plugin_id,
            contribution_disposition,
        )
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
    InstallLocal {
        package_root: String,
    },
    Uninstall {
        plugin_id: String,
        contribution_disposition: PluginContributionDisposition,
    },
    SetEnabled {
        plugin_id: String,
        enabled: bool,
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
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AdapterCorrelationRecord {
    external_operation_id: String,
    fingerprint: AdapterRequestFingerprint,
    resolution: AdapterCorrelationResolution,
}

struct AdapterState {
    core: Box<dyn PluginCommandCorePort>,
    catalog: Box<dyn CatalogViewPort>,
    correlations: BTreeMap<String, AdapterCorrelationRecord>,
    completed_correlations: VecDeque<String>,
}

/// Native IPC adapter over the single production command core. The core and
/// catalog view are dyn ports: production wiring and the in-module tests share
/// this one non-generic implementation instead of monomorphizing per port.
pub struct NativePluginCommandAdapter {
    state: Mutex<AdapterState>,
    clock: SystemClock,
}

impl NativePluginCommandAdapter {
    #[must_use]
    pub fn new(
        core: Box<dyn PluginCommandCorePort>,
        catalog: Box<dyn CatalogViewPort>,
        clock: SystemClock,
    ) -> Self {
        Self {
            state: Mutex::new(AdapterState {
                core,
                catalog,
                correlations: BTreeMap::new(),
                completed_correlations: VecDeque::new(),
            }),
            clock,
        }
    }

    fn execute_locked(
        &self,
        state: &mut AdapterState,
        command: PluginCommand,
    ) -> Result<PluginCommandResponse, IpcError> {
        match command {
            PluginCommand::Snapshot(request) => {
                let snapshot = state.core.snapshot();
                ensure_snapshot_revision(request.revision, snapshot.revision, &request.request_id)?;
                completed(
                    &mut *state.catalog,
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
            PluginCommand::InstallLocal {
                request,
                package_root,
            } => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::InstallLocal {
                        package_root: package_root.to_string_lossy().into_owned(),
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
                    .queue_install_local(request.revision, request.request_id.clone(), package_root)
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
            PluginCommand::Uninstall(request) => {
                let fingerprint = AdapterRequestFingerprint {
                    revision: request.revision,
                    payload: AdapterPayloadFingerprint::Uninstall {
                        plugin_id: request.plugin_id.clone(),
                        contribution_disposition: request.contribution_disposition,
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
                    .queue_uninstall(
                        request.revision,
                        request.request_id.clone(),
                        request.plugin_id.clone(),
                        request.contribution_disposition,
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
                finish_registered_operation(
                    state,
                    request.request_id,
                    request.operation_id,
                    terminal,
                    None,
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

impl IpcPluginCommandService for NativePluginCommandAdapter {
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
        PluginCommand::InstallLocal { request, .. } => &request.request_id,
        PluginCommand::Uninstall(request) => &request.request_id,
        PluginCommand::SetEnabled(request) => &request.request_id,
        PluginCommand::CancelOperation(request) => &request.request_id,
    }
}

fn correlate_new(
    state: &AdapterState,
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
    let snapshot = state.core.snapshot();
    ensure_exact_revision(fingerprint.revision, snapshot.revision, request_id)?;
    Ok(None)
}

fn correlate_cancel(
    state: &AdapterState,
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

fn ensure_correlation_capacity(state: &AdapterState, request_id: &str) -> Result<(), IpcError> {
    let active = state
        .correlations
        .values()
        .filter(|record| match &record.resolution {
            AdapterCorrelationResolution::CoreOperation {
                terminal_response, ..
            } => terminal_response.is_none(),
        })
        .count();
    if active < MAX_ACTIVE_ADAPTER_CORRELATIONS
        && state.correlations.len()
            < MAX_ACTIVE_ADAPTER_CORRELATIONS + MAX_COMPLETED_ADAPTER_CORRELATIONS
    {
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
            MAX_ACTIVE_ADAPTER_CORRELATIONS + MAX_COMPLETED_ADAPTER_CORRELATIONS,
            state.correlations.len().saturating_add(1),
        ))
    }
}

fn register_operation(
    state: &mut AdapterState,
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

fn register_core_operation(
    state: &mut AdapterState,
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

fn core_operation_for_external(
    state: &AdapterState,
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
        }
    })
}

fn cache_terminal_response(
    state: &mut AdapterState,
    request_id: &str,
    external_operation_id: &str,
    response: &PluginCommandResponse,
) -> Result<(), IpcError> {
    let newly_terminal = {
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
                let newly_terminal = terminal_response.is_none();
                *terminal_response = Some(response.clone());
                newly_terminal
            }
        }
    };
    if newly_terminal {
        state
            .completed_correlations
            .push_back(request_id.to_owned());
        while state.completed_correlations.len() > MAX_COMPLETED_ADAPTER_CORRELATIONS {
            if let Some(expired) = state.completed_correlations.pop_front() {
                state.correlations.remove(&expired);
            }
        }
    }
    Ok(())
}

fn execute_registered_operation(
    state: &mut AdapterState,
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

fn finish_registered_operation(
    state: &mut AdapterState,
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

fn replay_resolution(
    state: &mut AdapterState,
    request_id: String,
    external_operation_id: String,
    resolution: AdapterCorrelationResolution,
    now_ms: u64,
    forced_failure: Option<PluginFailureCode>,
) -> Result<PluginCommandResponse, IpcError> {
    match resolution {
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

fn replay_cancel_resolution(
    state: &mut AdapterState,
    request_id: String,
    external_operation_id: String,
    revision: u64,
    resolution: AdapterCorrelationResolution,
) -> Result<PluginCommandResponse, IpcError> {
    match resolution {
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

fn terminal_response(
    state: &mut AdapterState,
    request_id: String,
    external_operation_id: String,
    operation: PluginOperationSnapshot,
    forced_failure: Option<PluginFailureCode>,
) -> Result<PluginCommandResponse, IpcError> {
    let snapshot = state.core.snapshot();
    let data = center_data(&mut *state.catalog, snapshot)
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

fn completed(
    catalog: &mut dyn CatalogViewPort,
    request_id: String,
    operation_id: String,
    snapshot: PluginCommandSnapshot,
) -> Result<PluginCommandResponse, IpcError> {
    let data =
        center_data(catalog, snapshot).map_err(|error| attach_request(error, &request_id))?;
    Ok(PluginCommandResponse::Completed {
        request_id,
        operation_id,
        revision: data.revision,
        data,
    })
}

fn center_data(
    catalog_port: &mut dyn CatalogViewPort,
    snapshot: PluginCommandSnapshot,
) -> Result<PluginCenterData, IpcError> {
    let workspace_id = snapshot.workspace_id.as_deref();
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
            installed_version: installed_versions.get(&record.plugin_id).cloned(),
        });
    }
    let installed = snapshot
        .plugins
        .iter()
        .map(|plugin| installed_view(catalog_port, workspace_id, plugin))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PluginCenterData {
        revision: snapshot.revision,
        catalog,
        installed,
        sources: Vec::new(),
        surfaces: None,
        tasks: None,
        command_contributions: None,
    })
}

fn installed_view(
    catalog: &mut dyn CatalogViewPort,
    workspace_id: Option<&str>,
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
        enabled: plugin.expected_enabled,
        pending_version: plugin.pending_version.clone(),
        requested_capabilities: plugin
            .artifact
            .requested_capabilities
            .iter()
            .copied()
            .map(capability_view)
            .collect::<Result<Vec<_>, _>>()?,
        effective_capabilities: if plugin.running_instance_id.is_some() {
            plugin
                .artifact
                .requested_capabilities
                .iter()
                .copied()
                .map(capability_view)
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        },
        runtime: runtime_key(
            workspace_id,
            std::slice::from_ref(plugin),
            &plugin.artifact.plugin_id,
        ),
    })
}

fn runtime_key(
    workspace_id: Option<&str>,
    plugins: &[PluginSnapshot],
    plugin_id: &str,
) -> Option<RuntimeInstanceKey> {
    let workspace_id = workspace_id?;
    let plugin = plugins
        .iter()
        .find(|plugin| plugin.artifact.plugin_id == plugin_id)?;
    let instance_id = plugin.running_instance_id?;
    Some(RuntimeInstanceKey {
        workspace_id: workspace_id.to_owned(),
        plugin_id: plugin_id.to_owned(),
        instance_id,
        generation: plugin.generation,
    })
}

fn lifecycle_status(status: PluginStatus) -> (PluginLifecycleStatus, Option<PluginStatusReason>) {
    match status {
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

fn capability_view(
    capability: bbcom_plugin_contracts::generated_v2::Capability,
) -> Result<PluginCapabilityV2, IpcError> {
    use bbcom_plugin_contracts::generated_v2::Capability;
    Ok(match capability {
        Capability::UiWorkspace => PluginCapabilityV2::UiWorkspace,
        Capability::UiDetachedWindow => PluginCapabilityV2::UiDetachedWindow,
        Capability::SerialPortsRead => PluginCapabilityV2::SerialPortsRead,
        Capability::SerialSessionsManage => PluginCapabilityV2::SerialSessionsManage,
        Capability::SerialIo => PluginCapabilityV2::SerialIo,
        Capability::SerialControlLines => PluginCapabilityV2::SerialControlLines,
        Capability::SessionCaptureRead => PluginCapabilityV2::SessionCaptureRead,
        Capability::SessionCommandsReadWrite => PluginCapabilityV2::SessionCommandsReadWrite,
        Capability::FileOpenRead => PluginCapabilityV2::FileOpenRead,
        Capability::FileSaveWrite => PluginCapabilityV2::FileSaveWrite,
        Capability::PluginStorage => PluginCapabilityV2::PluginStorage,
        Capability::ProjectStateReadWrite => PluginCapabilityV2::ProjectStateReadWrite,
        Capability::Unspecified => {
            return Err(catalog_error(
                CatalogViewFailure::InconsistentIdentity,
                "snapshot",
            ));
        }
    })
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
    // Exact-match table: substring matching mislabeled failures (e.g. an
    // INSTALLER_* repository error landing in HostFailed because its message
    // contained "HOST"). Unknown codes degrade to Unavailable.
    match failure.code {
        "PLUGIN_INSTALL_PREPARE_FAILED"
        | "PLUGIN_INSTALL_COMMIT_FAILED"
        | "PLUGIN_INSTALL_DISCARD_FAILED"
        | "PLUGIN_UPDATE_TARGET_INVALID"
        | "PLUGIN_ALREADY_INSTALLED"
        | "PLUGIN_ARTIFACT_INVALID" => PluginFailureCode::InstallationFailed,
        "PLUGIN_WORKSPACE_NOT_OPEN" => PluginFailureCode::WorkspaceMissing,
        "PLUGIN_HOST_START_FAILED"
        | "PLUGIN_HOST_INITIALIZATION_FAILED"
        | "PLUGIN_HOST_STOP_FAILED"
        | "PLUGIN_HOST_IDENTITY_INVALID"
        | "PLUGIN_HOST_CRASHED"
        | "PLUGIN_HOST_MEMORY_LIMIT"
        | "PLUGIN_HOST_EXECUTION_TIMEOUT"
        | "PLUGIN_HOST_PROTOCOL_FAILED" => PluginFailureCode::HostFailed,
        "PLUGIN_SERIAL_EXECUTION_UNAVAILABLE" => PluginFailureCode::Unavailable,
        _ => PluginFailureCode::Unavailable,
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
