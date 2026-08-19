use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bbcom_plugin_contracts::generated_v2 as wire;
use bbcom_plugin_contracts::generated_v2::{
    Capability, ErrorCode, ResourceBinding, request, response,
};
use bbcom_plugin_contracts::v2::{
    CALL_TIMEOUT_MS, LONG_TASK_TIMEOUT_MS, MAX_STREAM_CHUNK_BYTES, SERIAL_READ_TIMEOUT_MS,
};
use wasmtime::component::Resource;
use wasmtime::{ResourceLimiter, StoreLimits, StoreLimitsBuilder};

use crate::bindings::bbcom::plugin::host::{
    Host, HostReadGrant, HostSaveGrant, HostSerialLease, ReadGrant, SaveGrant, SerialLease,
};
use crate::bindings::bbcom::plugin::types as wit;
use crate::uplink::{CapabilityRpc, RpcFailure};

const SERIAL_READ_RPC_MARGIN_MS: u64 = 4_000;

fn serial_read_rpc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms) + SERIAL_READ_RPC_MARGIN_MS)
}

impl crate::bindings::bbcom::plugin::types::Host for StoreState {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeBinding {
    pub workspace_id: String,
    pub plugin_id: String,
    pub instance_id: String,
    pub generation: u64,
}

impl RuntimeBinding {
    fn validates(&self, binding: &ResourceBinding) -> bool {
        !binding.resource_id.is_empty()
            && binding.workspace_id == self.workspace_id
            && binding.plugin_id == self.plugin_id
            && binding.instance_id == self.instance_id
            && binding.generation == self.generation
    }
}

#[derive(Clone)]
struct LeaseState {
    binding: ResourceBinding,
    session_id: String,
    session_generation: u64,
}

#[derive(Clone)]
struct ReadGrantState {
    binding: ResourceBinding,
    display_name: String,
    size: u64,
}

#[derive(Clone)]
struct SaveGrantState {
    binding: ResourceBinding,
    display_name: String,
}

struct ActivityState {
    last_activity: Instant,
    active_host_calls: usize,
}

#[derive(Clone)]
pub(crate) struct ActivityTracker(Arc<Mutex<ActivityState>>);

impl ActivityTracker {
    #[must_use]
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(ActivityState {
            last_activity: Instant::now(),
            active_host_calls: 0,
        })))
    }

    pub fn touch(&self) {
        self.0
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .last_activity = Instant::now();
    }

    fn begin_host_call(&self) -> HostCallActivityGuard {
        let mut state = self.0.lock().unwrap_or_else(|value| value.into_inner());
        state.active_host_calls = state.active_host_calls.saturating_add(1);
        state.last_activity = Instant::now();
        HostCallActivityGuard(self.clone())
    }

    #[must_use]
    pub fn inactive_for(&self) -> Duration {
        let state = self.0.lock().unwrap_or_else(|value| value.into_inner());
        if state.active_host_calls > 0 {
            Duration::ZERO
        } else {
            state.last_activity.elapsed()
        }
    }
}

struct HostCallActivityGuard(ActivityTracker);
impl Drop for HostCallActivityGuard {
    fn drop(&mut self) {
        let mut state = self.0.0.lock().unwrap_or_else(|value| value.into_inner());
        state.active_host_calls = state.active_host_calls.saturating_sub(1);
        state.last_activity = Instant::now();
    }
}

pub(crate) struct StoreState {
    pub limits: TrackingLimits,
    permissions: BTreeSet<Capability>,
    binding: RuntimeBinding,
    rpc: Arc<CapabilityRpc>,
    activity: ActivityTracker,
    next_resource_rep: u32,
    leases: BTreeMap<u32, LeaseState>,
    read_grants: BTreeMap<u32, ReadGrantState>,
    save_grants: BTreeMap<u32, SaveGrantState>,
}

impl StoreState {
    pub fn new(
        limits: TrackingLimits,
        permissions: BTreeSet<Capability>,
        binding: RuntimeBinding,
        rpc: Arc<CapabilityRpc>,
        activity: ActivityTracker,
    ) -> Self {
        Self {
            limits,
            permissions,
            binding,
            rpc,
            activity,
            next_resource_rep: 1,
            leases: BTreeMap::new(),
            read_grants: BTreeMap::new(),
            save_grants: BTreeMap::new(),
        }
    }

    fn has(&self, capability: Capability) -> Result<(), wit::ContractError> {
        if self.permissions.contains(&capability) {
            Ok(())
        } else {
            Err(wit::ContractError::PermissionDenied)
        }
    }

    fn invoke(
        &self,
        capability: Capability,
        operation: request::Operation,
        timeout: Duration,
    ) -> Result<response::Result, wit::ContractError> {
        self.has(capability)?;
        self.activity.touch();
        let _host_call = self.activity.begin_host_call();
        let result = self.rpc.call(operation, timeout).map_err(map_rpc_error)?;
        self.activity.touch();
        Ok(result)
    }

    fn invoke_normal(
        &self,
        capability: Capability,
        operation: request::Operation,
    ) -> Result<response::Result, wit::ContractError> {
        self.invoke(
            capability,
            operation,
            Duration::from_millis(CALL_TIMEOUT_MS.into()),
        )
    }

    fn invoke_user_interaction(
        &self,
        capability: Capability,
        operation: request::Operation,
    ) -> Result<response::Result, wit::ContractError> {
        self.invoke(
            capability,
            operation,
            Duration::from_millis(LONG_TASK_TIMEOUT_MS),
        )
    }

    fn next_rep(&mut self) -> Result<u32, wit::ContractError> {
        let rep = self.next_resource_rep;
        self.next_resource_rep = self
            .next_resource_rep
            .checked_add(1)
            .filter(|value| *value != 0)
            .ok_or(wit::ContractError::LimitExceeded)?;
        Ok(rep)
    }

    pub fn revoke_all(&mut self) {
        for lease in std::mem::take(&mut self.leases).into_values() {
            let _ = self.rpc.call(
                request::Operation::ReleaseSerialLease(wire::ReleaseSerialLeaseRequest {
                    lease: Some(lease.binding),
                }),
                Duration::from_millis(CALL_TIMEOUT_MS.into()),
            );
        }
        for grant in std::mem::take(&mut self.read_grants).into_values() {
            let _ = self.rpc.call(
                request::Operation::CloseReadGrant(wire::CloseReadGrantRequest {
                    grant: Some(grant.binding),
                }),
                Duration::from_millis(CALL_TIMEOUT_MS.into()),
            );
        }
        for grant in std::mem::take(&mut self.save_grants).into_values() {
            let _ = self.rpc.call(
                request::Operation::CancelSaveGrant(wire::CancelSaveGrantRequest {
                    grant: Some(grant.binding),
                }),
                Duration::from_millis(CALL_TIMEOUT_MS.into()),
            );
        }
    }
}

fn map_rpc_error(error: RpcFailure) -> wit::ContractError {
    match error {
        RpcFailure::Remote(error) => map_error_code(ErrorCode::try_from(error.code).ok()),
        RpcFailure::Timeout => wit::ContractError::Timeout,
        RpcFailure::Cancelled => wit::ContractError::Cancelled,
        RpcFailure::Limit => wit::ContractError::LimitExceeded,
        RpcFailure::Protocol => wit::ContractError::ProtocolError,
        RpcFailure::Transport => wit::ContractError::IoError,
    }
}

fn map_error_code(code: Option<ErrorCode>) -> wit::ContractError {
    match code {
        Some(ErrorCode::InvalidInput) => wit::ContractError::InvalidInput,
        Some(ErrorCode::PermissionDenied) => wit::ContractError::PermissionDenied,
        Some(ErrorCode::Unavailable) => wit::ContractError::Unavailable,
        Some(ErrorCode::Busy) => wit::ContractError::Busy,
        Some(ErrorCode::NotFound) => wit::ContractError::NotFound,
        Some(ErrorCode::StaleHandle) => wit::ContractError::StaleHandle,
        Some(ErrorCode::Disconnected) => wit::ContractError::Disconnected,
        Some(ErrorCode::Timeout) => wit::ContractError::Timeout,
        Some(ErrorCode::Cancelled) => wit::ContractError::Cancelled,
        Some(ErrorCode::LimitExceeded) => wit::ContractError::LimitExceeded,
        Some(ErrorCode::PartialWrite) => wit::ContractError::PartialWrite,
        Some(ErrorCode::UnknownOutcome) => wit::ContractError::UnknownOutcome,
        Some(ErrorCode::ProtocolError | ErrorCode::Unspecified) | None => {
            wit::ContractError::ProtocolError
        }
        Some(ErrorCode::IoError) => wit::ContractError::IoError,
    }
}

fn ack(result: response::Result) -> Result<(), wit::ContractError> {
    use response::Result as R;
    if matches!(
        result,
        R::PublishSurfaceSnapshot(_)
            | R::PublishSurfacePatch(_)
            | R::RegisterSurface(_)
            | R::UnregisterSurface(_)
            | R::RegisterCommand(_)
            | R::UnregisterCommand(_)
            | R::ReportProgress(_)
            | R::Heartbeat(_)
            | R::DisconnectSession(_)
            | R::DeleteSession(_)
            | R::ReleaseSerialLease(_)
            | R::ClearSerialBuffers(_)
            | R::SetOutputLines(_)
            | R::DeleteQuickCommand(_)
            | R::DeleteMacro(_)
            | R::CloseReadGrant(_)
            | R::CommitSaveGrant(_)
            | R::CancelSaveGrant(_)
            | R::StorageSet(_)
            | R::StorageDelete(_)
            | R::ProjectStateSet(_)
    ) {
        Ok(())
    } else {
        Err(wit::ContractError::ProtocolError)
    }
}

impl Host for StoreState {
    fn publish_surface_snapshot(
        &mut self,
        snapshot: wit::SurfaceSnapshot,
    ) -> Result<(), wit::ContractError> {
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::PublishSurfaceSnapshot(wire::PublishSurfaceSnapshotRequest {
                snapshot: Some(surface_snapshot(snapshot)),
            }),
        )?;
        ack(result)
    }

    fn publish_surface_patch(
        &mut self,
        patch: wit::SurfacePatch,
    ) -> Result<(), wit::ContractError> {
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::PublishSurfacePatch(wire::PublishSurfacePatchRequest {
                patch: Some(surface_patch(patch)),
            }),
        )?;
        ack(result)
    }

    fn register_surface(&mut self, surface: wit::PluginSurface) -> Result<(), wit::ContractError> {
        let capability = if surface.location == wit::SurfaceLocation::DetachedWindow {
            Capability::UiDetachedWindow
        } else {
            Capability::UiWorkspace
        };
        let result = self.invoke_normal(
            capability,
            request::Operation::RegisterSurface(wire::RegisterSurfaceRequest {
                surface: Some(plugin_surface(surface)),
            }),
        )?;
        ack(result)
    }

    fn unregister_surface(&mut self, surface_id: String) -> Result<(), wit::ContractError> {
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::UnregisterSurface(wire::UnregisterSurfaceRequest { surface_id }),
        )?;
        ack(result)
    }

    fn register_command(
        &mut self,
        command: wit::CommandContribution,
    ) -> Result<(), wit::ContractError> {
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::RegisterCommand(wire::RegisterCommandRequest {
                command: Some(command_contribution(command)),
            }),
        )?;
        ack(result)
    }

    fn unregister_command(&mut self, command_id: String) -> Result<(), wit::ContractError> {
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::UnregisterCommand(wire::UnregisterCommandRequest { command_id }),
        )?;
        ack(result)
    }

    fn report_task_progress(
        &mut self,
        progress: wit::TaskProgress,
    ) -> Result<(), wit::ContractError> {
        let event = wire::TaskStateEvent {
            task_id: progress.task_id,
            state: wire::TaskState::Running as i32,
            completed: Some(progress.completed),
            total: progress.total,
            message: progress.message,
        };
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::ReportProgress(wire::ReportProgressRequest {
                progress: Some(event),
            }),
        )?;
        ack(result)
    }

    fn heartbeat(&mut self, task_id: String) -> Result<(), wit::ContractError> {
        let result = self.invoke_normal(
            Capability::UiWorkspace,
            request::Operation::Heartbeat(wire::HeartbeatRequest { task_id }),
        )?;
        ack(result)
    }

    fn serial_ports(&mut self) -> Result<Vec<wit::SerialPort>, wit::ContractError> {
        match self.invoke_normal(
            Capability::SerialPortsRead,
            request::Operation::ListPorts(wire::ListPortsRequest {}),
        )? {
            response::Result::ListPorts(value) => {
                value.ports.into_iter().map(serial_port_from_wire).collect()
            }
            _ => Err(wit::ContractError::ProtocolError),
        }
    }

    fn serial_sessions(&mut self) -> Result<Vec<wit::SerialSession>, wit::ContractError> {
        match self.invoke_normal(
            Capability::SerialSessionsManage,
            request::Operation::ListSessions(wire::ListSessionsRequest {}),
        )? {
            response::Result::ListSessions(value) => value
                .sessions
                .into_iter()
                .map(serial_session_from_wire)
                .collect(),
            _ => Err(wit::ContractError::ProtocolError),
        }
    }

    fn create_serial_session(
        &mut self,
        value: wit::CreateSession,
    ) -> Result<wit::SerialSession, wit::ContractError> {
        let request = wire::CreateSessionRequest {
            local_id: value.local_id,
            name: value.name,
            lifetime: match value.lifetime {
                wit::SessionLifetime::Persistent => wire::SessionLifetime::Persistent as i32,
                wit::SessionLifetime::Runtime => wire::SessionLifetime::Runtime as i32,
            },
            port_id: value.port_id,
            config: Some(serial_config_to_wire(value.config)),
        };
        session_result(self.invoke_normal(
            Capability::SerialSessionsManage,
            request::Operation::CreateSession(request),
        )?)
    }

    fn update_serial_session(
        &mut self,
        session: wit::SerialSession,
    ) -> Result<wit::SerialSession, wit::ContractError> {
        let request = wire::UpdateSessionRequest {
            session: Some(serial_session_to_wire(session)),
        };
        session_result(self.invoke_normal(
            Capability::SerialSessionsManage,
            request::Operation::UpdateSession(request),
        )?)
    }

    fn connect_serial_session(
        &mut self,
        session_id: String,
    ) -> Result<wit::SerialSession, wit::ContractError> {
        session_result(self.invoke_normal(
            Capability::SerialSessionsManage,
            request::Operation::ConnectSession(wire::ConnectSessionRequest { session_id }),
        )?)
    }

    fn disconnect_serial_session(&mut self, session_id: String) -> Result<(), wit::ContractError> {
        ack(self.invoke_normal(
            Capability::SerialSessionsManage,
            request::Operation::DisconnectSession(wire::DisconnectSessionRequest { session_id }),
        )?)
    }

    fn delete_serial_session(&mut self, session_id: String) -> Result<(), wit::ContractError> {
        ack(self.invoke_normal(
            Capability::SerialSessionsManage,
            request::Operation::DeleteSession(wire::DeleteSessionRequest { session_id }),
        )?)
    }

    fn acquire_serial_lease(
        &mut self,
        session_id: String,
        options: wit::SerialLeaseOptions,
    ) -> Result<Resource<SerialLease>, wit::ContractError> {
        let result = self.invoke_normal(
            Capability::SerialIo,
            request::Operation::AcquireSerialLease(wire::AcquireSerialLeaseRequest {
                session_id: session_id.clone(),
                options: Some(wire::SerialLeaseOptions {
                    pause_automation: options.pause_automation,
                    rx_buffer_bytes: options.rx_buffer_bytes,
                }),
            }),
        )?;
        let response::Result::AcquireSerialLease(value) = result else {
            return Err(wit::ContractError::ProtocolError);
        };
        let binding = value.lease.ok_or(wit::ContractError::ProtocolError)?;
        if !self.binding.validates(&binding) {
            return Err(wit::ContractError::StaleHandle);
        }
        let rep = self.next_rep()?;
        self.leases.insert(
            rep,
            LeaseState {
                binding,
                session_id,
                session_generation: value.session_generation,
            },
        );
        Ok(Resource::new_own(rep))
    }

    fn capture_read(
        &mut self,
        session_id: String,
        from_sequence: u64,
        max_frames: u32,
        max_bytes: u32,
    ) -> Result<wit::CapturePage, wit::ContractError> {
        let result = self.invoke_normal(
            Capability::SessionCaptureRead,
            request::Operation::CaptureRead(wire::CaptureReadRequest {
                session_id,
                from_sequence,
                max_frames,
                max_bytes,
            }),
        )?;
        let response::Result::CaptureRead(value) = result else {
            return Err(wit::ContractError::ProtocolError);
        };
        Ok(wit::CapturePage {
            frames: value
                .frames
                .into_iter()
                .map(|frame| {
                    Ok(wit::CaptureFrame {
                        sequence: frame.sequence,
                        timestamp_ms: frame.timestamp_ms,
                        direction: match wire::FrameDirection::try_from(frame.direction).ok() {
                            Some(wire::FrameDirection::Rx) => wit::FrameDirection::Rx,
                            Some(wire::FrameDirection::Tx) => wit::FrameDirection::Tx,
                            _ => return Err(wit::ContractError::ProtocolError),
                        },
                        payload: frame.payload,
                    })
                })
                .collect::<Result<_, _>>()?,
            next_sequence: value.next_sequence,
        })
    }

    fn upsert_quick_command(
        &mut self,
        command: wit::QuickCommand,
    ) -> Result<String, wit::ContractError> {
        let request = wire::UpsertQuickCommandRequest {
            command: Some(wire::QuickCommand {
                local_id: command.local_id,
                title: command.title,
                session_id: command.session_id,
                payload: command.payload,
                append_newline: command.append_newline,
            }),
        };
        contribution_result(self.invoke_normal(
            Capability::SessionCommandsReadWrite,
            request::Operation::UpsertQuickCommand(request),
        )?)
    }

    fn delete_quick_command(
        &mut self,
        session_id: String,
        local_id: String,
    ) -> Result<(), wit::ContractError> {
        ack(self.invoke_normal(
            Capability::SessionCommandsReadWrite,
            request::Operation::DeleteQuickCommand(wire::DeleteQuickCommandRequest {
                local_id,
                session_id,
            }),
        )?)
    }

    fn upsert_macro(
        &mut self,
        value: wit::MacroContribution,
    ) -> Result<String, wit::ContractError> {
        let macro_ = wire::MacroContribution {
            local_id: value.local_id,
            title: value.title,
            session_id: value.session_id,
            steps: value
                .steps
                .into_iter()
                .map(|step| wire::MacroStep {
                    delay_ms: step.delay_ms,
                    payload: step.payload,
                })
                .collect(),
        };
        contribution_result(self.invoke_normal(
            Capability::SessionCommandsReadWrite,
            request::Operation::UpsertMacro(wire::UpsertMacroRequest {
                r#macro: Some(macro_),
            }),
        )?)
    }

    fn delete_macro(
        &mut self,
        session_id: String,
        local_id: String,
    ) -> Result<(), wit::ContractError> {
        ack(self.invoke_normal(
            Capability::SessionCommandsReadWrite,
            request::Operation::DeleteMacro(wire::DeleteMacroRequest {
                local_id,
                session_id,
            }),
        )?)
    }

    fn open_read_grant(
        &mut self,
        accept: Vec<String>,
    ) -> Result<Option<Resource<ReadGrant>>, wit::ContractError> {
        let result = self.invoke_user_interaction(
            Capability::FileOpenRead,
            request::Operation::OpenReadGrant(wire::OpenReadGrantRequest {
                accepted_extensions: accept,
            }),
        )?;
        let response::Result::OpenReadGrant(value) = result else {
            return Err(wit::ContractError::ProtocolError);
        };
        let Some(info) = value.grant else {
            return Ok(None);
        };
        let binding = info.grant.ok_or(wit::ContractError::ProtocolError)?;
        if !self.binding.validates(&binding) {
            return Err(wit::ContractError::StaleHandle);
        }
        let size = info.size.ok_or(wit::ContractError::ProtocolError)?;
        let rep = self.next_rep()?;
        self.read_grants.insert(
            rep,
            ReadGrantState {
                binding,
                display_name: info.display_name,
                size,
            },
        );
        Ok(Some(Resource::new_own(rep)))
    }

    fn create_save_grant(
        &mut self,
        suggested_name: String,
    ) -> Result<Option<Resource<SaveGrant>>, wit::ContractError> {
        let result = self.invoke_user_interaction(
            Capability::FileSaveWrite,
            request::Operation::CreateSaveGrant(wire::CreateSaveGrantRequest { suggested_name }),
        )?;
        let response::Result::CreateSaveGrant(value) = result else {
            return Err(wit::ContractError::ProtocolError);
        };
        let Some(info) = value.grant else {
            return Ok(None);
        };
        let binding = info.grant.ok_or(wit::ContractError::ProtocolError)?;
        if !self.binding.validates(&binding) {
            return Err(wit::ContractError::StaleHandle);
        }
        let rep = self.next_rep()?;
        self.save_grants.insert(
            rep,
            SaveGrantState {
                binding,
                display_name: info.display_name,
            },
        );
        Ok(Some(Resource::new_own(rep)))
    }

    fn storage_get(&mut self, key: String) -> Result<Option<Vec<u8>>, wit::ContractError> {
        match self.invoke_normal(
            Capability::PluginStorage,
            request::Operation::StorageGet(wire::StorageGetRequest { key }),
        )? {
            response::Result::StorageGet(value) => Ok(value.value),
            _ => Err(wit::ContractError::ProtocolError),
        }
    }

    fn storage_set(&mut self, key: String, value: Vec<u8>) -> Result<(), wit::ContractError> {
        ack(self.invoke_normal(
            Capability::PluginStorage,
            request::Operation::StorageSet(wire::StorageSetRequest { key, value }),
        )?)
    }

    fn storage_delete(&mut self, key: String) -> Result<(), wit::ContractError> {
        ack(self.invoke_normal(
            Capability::PluginStorage,
            request::Operation::StorageDelete(wire::StorageDeleteRequest { key }),
        )?)
    }

    fn project_state_get(&mut self) -> Result<Option<wit::ProjectState>, wit::ContractError> {
        match self.invoke_normal(
            Capability::ProjectStateReadWrite,
            request::Operation::ProjectStateGet(wire::ProjectStateGetRequest {}),
        )? {
            response::Result::ProjectStateGet(value) => project_state_from_wire(value),
            _ => Err(wit::ContractError::ProtocolError),
        }
    }

    fn project_state_set(&mut self, state: wit::ProjectState) -> Result<(), wit::ContractError> {
        if state.schema_version == 0 {
            return Err(wit::ContractError::InvalidInput);
        }
        ack(self.invoke_normal(
            Capability::ProjectStateReadWrite,
            request::Operation::ProjectStateSet(wire::ProjectStateSetRequest {
                schema_version: state.schema_version,
                value: state.value,
            }),
        )?)
    }
}

impl HostSerialLease for StoreState {
    fn session_id(&mut self, resource: Resource<SerialLease>) -> String {
        self.leases
            .get(&resource.rep())
            .map(|value| value.session_id.clone())
            .unwrap_or_default()
    }
    fn generation(&mut self, resource: Resource<SerialLease>) -> u64 {
        self.leases
            .get(&resource.rep())
            .map_or(0, |value| value.session_generation)
    }

    fn read(
        &mut self,
        resource: Resource<SerialLease>,
        max_bytes: u32,
        timeout_ms: u32,
    ) -> Result<wit::SerialReadResult, wit::ContractError> {
        if max_bytes as usize > MAX_STREAM_CHUNK_BYTES || timeout_ms > SERIAL_READ_TIMEOUT_MS {
            return Err(wit::ContractError::LimitExceeded);
        }
        let binding = self.lease_binding(resource.rep())?;
        let result = self.invoke(
            Capability::SerialIo,
            request::Operation::SerialRead(wire::SerialReadRequest {
                lease: Some(binding),
                max_bytes,
                timeout_ms,
            }),
            serial_read_rpc_timeout(timeout_ms),
        )?;
        match result {
            response::Result::SerialRead(value) => Ok(wit::SerialReadResult {
                payload: value.payload,
                timed_out: value.timed_out,
                disconnected: value.disconnected,
            }),
            _ => Err(wit::ContractError::ProtocolError),
        }
    }

    fn write(
        &mut self,
        resource: Resource<SerialLease>,
        payload: Vec<u8>,
    ) -> Result<wit::SerialWriteResult, wit::ContractError> {
        if payload.len() > MAX_STREAM_CHUNK_BYTES {
            return Err(wit::ContractError::LimitExceeded);
        }
        let binding = self.lease_binding(resource.rep())?;
        let result = self.invoke_normal(
            Capability::SerialIo,
            request::Operation::SerialWrite(wire::SerialWriteRequest {
                lease: Some(binding),
                payload,
            }),
        )?;
        let response::Result::SerialWrite(value) = result else {
            return Err(wit::ContractError::ProtocolError);
        };
        let outcome = match wire::WriteOutcome::try_from(value.outcome).ok() {
            Some(wire::WriteOutcome::Completed) => wit::WriteOutcome::Completed,
            Some(wire::WriteOutcome::PartialWrite) => wit::WriteOutcome::PartialWrite,
            Some(wire::WriteOutcome::UnknownOutcome) => wit::WriteOutcome::UnknownOutcome,
            _ => return Err(wit::ContractError::ProtocolError),
        };
        Ok(wit::SerialWriteResult {
            requested: value.requested,
            sent: value.sent,
            outcome,
        })
    }

    fn clear_buffers(&mut self, resource: Resource<SerialLease>) -> Result<(), wit::ContractError> {
        let binding = self.lease_binding(resource.rep())?;
        ack(self.invoke_normal(
            Capability::SerialIo,
            request::Operation::ClearSerialBuffers(wire::ClearSerialBuffersRequest {
                lease: Some(binding),
            }),
        )?)
    }
    fn pending(
        &mut self,
        resource: Resource<SerialLease>,
    ) -> Result<wit::PendingBytes, wit::ContractError> {
        let binding = self.lease_binding(resource.rep())?;
        match self.invoke_normal(
            Capability::SerialIo,
            request::Operation::PendingSerialBytes(wire::PendingSerialBytesRequest {
                lease: Some(binding),
            }),
        )? {
            response::Result::PendingSerialBytes(value) => Ok(wit::PendingBytes {
                rx: value.rx,
                tx: value.tx,
            }),
            _ => Err(wit::ContractError::ProtocolError),
        }
    }
    fn set_output_lines(
        &mut self,
        resource: Resource<SerialLease>,
        lines: wit::OutputLines,
    ) -> Result<(), wit::ContractError> {
        let binding = self.lease_binding(resource.rep())?;
        ack(self.invoke_normal(
            Capability::SerialControlLines,
            request::Operation::SetOutputLines(wire::SetOutputLinesRequest {
                lease: Some(binding),
                lines: Some(wire::OutputLines {
                    dtr: lines.dtr,
                    rts: lines.rts,
                    break_active: lines.break_active,
                }),
            }),
        )?)
    }
    fn input_lines(
        &mut self,
        resource: Resource<SerialLease>,
    ) -> Result<wit::InputLines, wit::ContractError> {
        let binding = self.lease_binding(resource.rep())?;
        match self.invoke_normal(
            Capability::SerialControlLines,
            request::Operation::ReadInputLines(wire::ReadInputLinesRequest {
                lease: Some(binding),
            }),
        )? {
            response::Result::ReadInputLines(value) => {
                let value = value.lines.ok_or(wit::ContractError::ProtocolError)?;
                Ok(wit::InputLines {
                    cts: value.cts,
                    dsr: value.dsr,
                    ri: value.ri,
                    cd: value.cd,
                })
            }
            _ => Err(wit::ContractError::ProtocolError),
        }
    }
    fn release(&mut self, resource: Resource<SerialLease>) -> Result<(), wit::ContractError> {
        self.release_lease(resource.rep())
    }
    fn drop(&mut self, resource: Resource<SerialLease>) -> wasmtime::Result<()> {
        let _ = self.release_lease(resource.rep());
        Ok(())
    }
}

impl StoreState {
    fn lease_binding(&self, rep: u32) -> Result<ResourceBinding, wit::ContractError> {
        self.leases
            .get(&rep)
            .map(|value| value.binding.clone())
            .ok_or(wit::ContractError::StaleHandle)
    }
    fn release_lease(&mut self, rep: u32) -> Result<(), wit::ContractError> {
        let binding = self.lease_binding(rep)?;
        let result = self.invoke_normal(
            Capability::SerialIo,
            request::Operation::ReleaseSerialLease(wire::ReleaseSerialLeaseRequest {
                lease: Some(binding),
            }),
        )?;
        ack(result)?;
        self.leases.remove(&rep);
        Ok(())
    }
}

impl HostReadGrant for StoreState {
    fn info(&mut self, resource: Resource<ReadGrant>) -> wit::ReadGrantInfo {
        self.read_grants
            .get(&resource.rep())
            .map(|value| wit::ReadGrantInfo {
                display_name: value.display_name.clone(),
                size: value.size,
            })
            .unwrap_or(wit::ReadGrantInfo {
                display_name: String::new(),
                size: 0,
            })
    }
    fn read_at(
        &mut self,
        resource: Resource<ReadGrant>,
        offset: u64,
        max_bytes: u32,
    ) -> Result<Vec<u8>, wit::ContractError> {
        if max_bytes as usize > MAX_STREAM_CHUNK_BYTES {
            return Err(wit::ContractError::LimitExceeded);
        }
        let binding = self
            .read_grants
            .get(&resource.rep())
            .map(|value| value.binding.clone())
            .ok_or(wit::ContractError::StaleHandle)?;
        match self.invoke_normal(
            Capability::FileOpenRead,
            request::Operation::ReadGrantChunk(wire::ReadGrantChunkRequest {
                grant: Some(binding),
                offset,
                max_bytes,
            }),
        )? {
            response::Result::ReadGrantChunk(value)
                if value.offset == offset && value.payload.len() <= max_bytes as usize =>
            {
                Ok(value.payload)
            }
            _ => Err(wit::ContractError::ProtocolError),
        }
    }
    fn close(&mut self, resource: Resource<ReadGrant>) {
        let _ = self.close_read(resource.rep());
    }
    fn drop(&mut self, resource: Resource<ReadGrant>) -> wasmtime::Result<()> {
        let _ = self.close_read(resource.rep());
        Ok(())
    }
}

impl StoreState {
    fn close_read(&mut self, rep: u32) -> Result<(), wit::ContractError> {
        let binding = self
            .read_grants
            .get(&rep)
            .map(|value| value.binding.clone())
            .ok_or(wit::ContractError::StaleHandle)?;
        let result = self.invoke_normal(
            Capability::FileOpenRead,
            request::Operation::CloseReadGrant(wire::CloseReadGrantRequest {
                grant: Some(binding),
            }),
        )?;
        ack(result)?;
        self.read_grants.remove(&rep);
        Ok(())
    }
}

impl HostSaveGrant for StoreState {
    fn info(&mut self, resource: Resource<SaveGrant>) -> wit::SaveGrantInfo {
        self.save_grants
            .get(&resource.rep())
            .map(|value| wit::SaveGrantInfo {
                display_name: value.display_name.clone(),
            })
            .unwrap_or(wit::SaveGrantInfo {
                display_name: String::new(),
            })
    }
    fn write(
        &mut self,
        resource: Resource<SaveGrant>,
        payload: Vec<u8>,
    ) -> Result<u64, wit::ContractError> {
        if payload.len() > MAX_STREAM_CHUNK_BYTES {
            return Err(wit::ContractError::LimitExceeded);
        }
        let binding = self
            .save_grants
            .get(&resource.rep())
            .map(|value| value.binding.clone())
            .ok_or(wit::ContractError::StaleHandle)?;
        match self.invoke_normal(
            Capability::FileSaveWrite,
            request::Operation::WriteSaveGrant(wire::WriteSaveGrantRequest {
                grant: Some(binding),
                payload,
            }),
        )? {
            response::Result::WriteSaveGrant(value) => Ok(value.accepted_bytes),
            _ => Err(wit::ContractError::ProtocolError),
        }
    }
    fn commit(&mut self, resource: Resource<SaveGrant>) -> Result<(), wit::ContractError> {
        let rep = resource.rep();
        let binding = self
            .save_grants
            .get(&rep)
            .map(|value| value.binding.clone())
            .ok_or(wit::ContractError::StaleHandle)?;
        let result = self.invoke_normal(
            Capability::FileSaveWrite,
            request::Operation::CommitSaveGrant(wire::CommitSaveGrantRequest {
                grant: Some(binding),
            }),
        )?;
        ack(result)?;
        self.save_grants.remove(&rep);
        Ok(())
    }
    fn cancel(&mut self, resource: Resource<SaveGrant>) {
        let _ = self.cancel_save(resource.rep());
    }
    fn drop(&mut self, resource: Resource<SaveGrant>) -> wasmtime::Result<()> {
        let _ = self.cancel_save(resource.rep());
        Ok(())
    }
}

impl StoreState {
    fn cancel_save(&mut self, rep: u32) -> Result<(), wit::ContractError> {
        let binding = self
            .save_grants
            .get(&rep)
            .map(|value| value.binding.clone())
            .ok_or(wit::ContractError::StaleHandle)?;
        let result = self.invoke_normal(
            Capability::FileSaveWrite,
            request::Operation::CancelSaveGrant(wire::CancelSaveGrantRequest {
                grant: Some(binding),
            }),
        )?;
        ack(result)?;
        self.save_grants.remove(&rep);
        Ok(())
    }
}

fn plugin_surface(value: wit::PluginSurface) -> wire::PluginSurface {
    wire::PluginSurface {
        surface_id: value.surface_id,
        title: value.title,
        location: match value.location {
            wit::SurfaceLocation::Workspace => wire::SurfaceLocation::Workspace as i32,
            wit::SurfaceLocation::DetachedWindow => wire::SurfaceLocation::DetachedWindow as i32,
        },
    }
}
fn command_contribution(value: wit::CommandContribution) -> wire::CommandContribution {
    wire::CommandContribution {
        command_id: value.command_id,
        title: value.title,
        description: value.description,
        long_running: value.long_running,
        confirmation: value.confirmation,
    }
}

fn surface_snapshot(value: wit::SurfaceSnapshot) -> wire::SurfaceSnapshot {
    wire::SurfaceSnapshot {
        surface_id: value.surface_id,
        revision: value.revision,
        root_node_id: value.root_node_id,
        nodes: value.nodes.into_iter().map(ui_node).collect(),
    }
}
fn surface_patch(value: wit::SurfacePatch) -> wire::SurfacePatch {
    wire::SurfacePatch {
        surface_id: value.surface_id,
        base_revision: value.base_revision,
        next_revision: value.next_revision,
        operations: value
            .operations
            .into_iter()
            .map(|operation| wire::UiPatchOperation {
                operation: Some(match operation {
                    wit::UiPatchOperation::Upsert(value) => {
                        wire::ui_patch_operation::Operation::Upsert(ui_node(value))
                    }
                    wit::UiPatchOperation::Remove(value) => {
                        wire::ui_patch_operation::Operation::Remove(value)
                    }
                    wit::UiPatchOperation::SetRoot(value) => {
                        wire::ui_patch_operation::Operation::SetRoot(value)
                    }
                }),
            })
            .collect(),
    }
}

fn ui_node(value: wit::UiNode) -> wire::UiNode {
    use wire::ui_node::Kind as K;
    use wit::UiNodeKind as W;
    let kind = match value.kind {
        W::Column => K::Column(wire::EmptyNode {}),
        W::Row => K::Row(wire::EmptyNode {}),
        W::Group(v) => K::Group(wire::GroupNode { title: v.title }),
        W::Tabs(v) => K::Tabs(wire::TabsNode {
            selected_child_id: v.selected_child_id,
        }),
        W::Text(v) => K::Text(wire::TextNode { text: v.text }),
        W::Badge(v) => K::Badge(wire::BadgeNode {
            text: v.text,
            tone: v.tone,
        }),
        W::KeyValue(v) => K::KeyValue(wire::KeyValueNode {
            entries: v
                .entries
                .into_iter()
                .map(|e| wire::KeyValueEntry {
                    key: e.key,
                    value: e.value,
                })
                .collect(),
        }),
        W::Progress(v) => K::Progress(wire::ProgressNode {
            value: v.value,
            maximum: v.maximum,
            label: v.label,
        }),
        W::Log(v) => K::Log(wire::LogNode {
            text: v.text,
            language: v.language,
        }),
        W::Code(v) => K::Code(wire::LogNode {
            text: v.text,
            language: v.language,
        }),
        W::Table(v) => K::Table(wire::TableNode {
            columns: v.columns,
            rows: v
                .rows
                .into_iter()
                .map(|cells| wire::TableRow { cells })
                .collect(),
            page: v.page,
            page_size: v.page_size,
            total_rows: v.total_rows,
        }),
        W::Input(v) => K::Input(wire::InputNode {
            label: v.label,
            value: v.value,
            placeholder: v.placeholder,
            disabled: v.disabled,
        }),
        W::NumberInput(v) => K::NumberInput(wire::NumberInputNode {
            label: v.label,
            value: v.value,
            minimum: v.minimum,
            maximum: v.maximum,
            step: v.step,
            disabled: v.disabled,
        }),
        W::Select(v) => K::Select(wire::SelectNode {
            label: v.label,
            value: v.value,
            options: v
                .options
                .into_iter()
                .map(|o| wire::SelectOption {
                    value: o.value,
                    label: o.label,
                })
                .collect(),
            disabled: v.disabled,
        }),
        W::Toggle(v) => K::Toggle(wire::ToggleNode {
            label: v.label,
            checked: v.checked,
            disabled: v.disabled,
        }),
        W::Button(v) => K::Button(wire::ButtonNode {
            label: v.label,
            disabled: v.disabled,
            confirmation: v.confirmation,
        }),
        W::DangerousButton(v) => K::DangerousButton(wire::ButtonNode {
            label: v.label,
            disabled: v.disabled,
            confirmation: v.confirmation,
        }),
    };
    wire::UiNode {
        id: value.id,
        parent_id: value.parent_id,
        order: value.order,
        kind: Some(kind),
    }
}

fn serial_config_to_wire(value: wit::SerialConfig) -> wire::SerialConfig {
    wire::SerialConfig {
        baud_rate: value.baud_rate,
        data_bits: value.data_bits.into(),
        parity: match value.parity {
            wit::Parity::None => wire::Parity::None as i32,
            wit::Parity::Odd => wire::Parity::Odd as i32,
            wit::Parity::Even => wire::Parity::Even as i32,
        },
        stop_bits: match value.stop_bits {
            wit::StopBits::One => wire::StopBits::One as i32,
            wit::StopBits::Two => wire::StopBits::Two as i32,
        },
        flow_control: match value.flow_control {
            wit::FlowControl::None => wire::FlowControl::None as i32,
            wit::FlowControl::Software => wire::FlowControl::Software as i32,
            wit::FlowControl::Hardware => wire::FlowControl::Hardware as i32,
        },
    }
}
fn serial_config_from_wire(
    value: Option<wire::SerialConfig>,
) -> Result<wit::SerialConfig, wit::ContractError> {
    let value = value.ok_or(wit::ContractError::ProtocolError)?;
    Ok(wit::SerialConfig {
        baud_rate: value.baud_rate,
        data_bits: value
            .data_bits
            .try_into()
            .map_err(|_| wit::ContractError::ProtocolError)?,
        parity: match wire::Parity::try_from(value.parity).ok() {
            Some(wire::Parity::None) => wit::Parity::None,
            Some(wire::Parity::Odd) => wit::Parity::Odd,
            Some(wire::Parity::Even) => wit::Parity::Even,
            _ => return Err(wit::ContractError::ProtocolError),
        },
        stop_bits: match wire::StopBits::try_from(value.stop_bits).ok() {
            Some(wire::StopBits::One) => wit::StopBits::One,
            Some(wire::StopBits::Two) => wit::StopBits::Two,
            _ => return Err(wit::ContractError::ProtocolError),
        },
        flow_control: match wire::FlowControl::try_from(value.flow_control).ok() {
            Some(wire::FlowControl::None) => wit::FlowControl::None,
            Some(wire::FlowControl::Software) => wit::FlowControl::Software,
            Some(wire::FlowControl::Hardware) => wit::FlowControl::Hardware,
            _ => return Err(wit::ContractError::ProtocolError),
        },
    })
}
fn serial_session_to_wire(value: wit::SerialSession) -> wire::SerialSession {
    wire::SerialSession {
        session_id: value.session_id,
        name: value.name,
        port_id: value.port_id,
        config: Some(serial_config_to_wire(value.config)),
        connected: value.connected,
        generation: value.generation,
    }
}
fn serial_session_from_wire(
    value: wire::SerialSession,
) -> Result<wit::SerialSession, wit::ContractError> {
    Ok(wit::SerialSession {
        session_id: value.session_id,
        name: value.name,
        port_id: value.port_id,
        config: serial_config_from_wire(value.config)?,
        connected: value.connected,
        generation: value.generation,
    })
}
fn serial_port_from_wire(value: wire::SerialPort) -> Result<wit::SerialPort, wit::ContractError> {
    Ok(wit::SerialPort {
        port_id: value.port_id,
        display_name: value.display_name,
        usb_vendor_id: value
            .usb_vendor_id
            .map(|v| v.try_into().map_err(|_| wit::ContractError::ProtocolError))
            .transpose()?,
        usb_product_id: value
            .usb_product_id
            .map(|v| v.try_into().map_err(|_| wit::ContractError::ProtocolError))
            .transpose()?,
        serial_number: value.serial_number,
    })
}
fn session_result(result: response::Result) -> Result<wit::SerialSession, wit::ContractError> {
    let session = match result {
        response::Result::CreateSession(v)
        | response::Result::UpdateSession(v)
        | response::Result::ConnectSession(v) => v.session,
        _ => return Err(wit::ContractError::ProtocolError),
    }
    .ok_or(wit::ContractError::ProtocolError)?;
    serial_session_from_wire(session)
}
fn contribution_result(result: response::Result) -> Result<String, wit::ContractError> {
    match result {
        response::Result::UpsertQuickCommand(v) | response::Result::UpsertMacro(v) => {
            Ok(v.contribution_id)
        }
        _ => Err(wit::ContractError::ProtocolError),
    }
}

fn project_state_from_wire(
    value: wire::ProjectStateGetResponse,
) -> Result<Option<wit::ProjectState>, wit::ContractError> {
    match (value.schema_version, value.value) {
        (None, None) => Ok(None),
        (Some(schema_version), Some(value)) if schema_version != 0 => Ok(Some(wit::ProjectState {
            schema_version,
            value,
        })),
        _ => Err(wit::ContractError::ProtocolError),
    }
}

pub(crate) struct TrackingLimits {
    inner: StoreLimits,
    memory_limit_bytes: usize,
    memory_limit_hit: bool,
}
impl TrackingLimits {
    pub fn fixed(memory_limit_bytes: usize) -> Self {
        Self {
            inner: StoreLimitsBuilder::new()
                .memory_size(memory_limit_bytes)
                .table_elements(65_536)
                .instances(64)
                .tables(64)
                .memories(1)
                .trap_on_grow_failure(true)
                .build(),
            memory_limit_bytes,
            memory_limit_hit: false,
        }
    }
    pub const fn memory_limit_hit(&self) -> bool {
        self.memory_limit_hit
    }
    pub fn reset_memory_limit_hit(&mut self) {
        self.memory_limit_hit = false;
    }
}
impl ResourceLimiter for TrackingLimits {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.memory_limit_bytes {
            self.memory_limit_hit = true;
        }
        self.inner.memory_growing(current, desired, maximum)
    }
    fn memory_grow_failed(&mut self, error: wasmtime::Error) -> wasmtime::Result<()> {
        self.inner.memory_grow_failed(error)
    }
    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        self.inner.table_growing(current, desired, maximum)
    }
    fn table_grow_failed(&mut self, error: wasmtime::Error) -> wasmtime::Result<()> {
        self.inner.table_grow_failed(error)
    }
    fn instances(&self) -> usize {
        self.inner.instances()
    }
    fn tables(&self) -> usize {
        self.inner.tables()
    }
    fn memories(&self) -> usize {
        self.inner.memories()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_read_rpc_deadline_has_margin_over_renderer_wait() {
        assert_eq!(
            serial_read_rpc_timeout(SERIAL_READ_TIMEOUT_MS),
            Duration::from_secs(14)
        );
    }

    #[test]
    fn project_state_wire_conversion_preserves_arbitrary_nonzero_schema() {
        let state = project_state_from_wire(wire::ProjectStateGetResponse {
            schema_version: Some(73),
            value: Some(b"portable".to_vec()),
        })
        .unwrap()
        .unwrap();
        assert_eq!(state.schema_version, 73);
        assert_eq!(state.value, b"portable");
        for malformed in [
            wire::ProjectStateGetResponse {
                schema_version: Some(0),
                value: Some(Vec::new()),
            },
            wire::ProjectStateGetResponse {
                schema_version: Some(73),
                value: None,
            },
            wire::ProjectStateGetResponse {
                schema_version: None,
                value: Some(Vec::new()),
            },
        ] {
            assert!(matches!(
                project_state_from_wire(malformed),
                Err(wit::ContractError::ProtocolError)
            ));
        }
    }
}
