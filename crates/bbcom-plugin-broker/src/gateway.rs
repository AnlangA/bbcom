use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bbcom_plugin_contracts::generated_v2::{
    self as wire, Cancel, Capability, Envelope, ErrorCode, Event, ResourceBinding, Response,
    Stream, envelope, request, response,
};
use bbcom_plugin_contracts::v2::{
    MAX_PENDING_HOST_REQUESTS, MAX_PROTOCOL_MINOR, MessageIdTracker, PROTOCOL_MAJOR,
    validate_envelope, validate_surface_patch, validate_surface_snapshot,
};

use crate::stream::{StreamEvent, StreamMultiplexer};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayContext {
    pub workspace_id: String,
    pub plugin_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub granted_capabilities: BTreeSet<Capability>,
}

impl GatewayContext {
    #[must_use]
    pub fn binds(&self, binding: &ResourceBinding) -> bool {
        !binding.resource_id.is_empty()
            && binding.workspace_id == self.workspace_id
            && binding.plugin_id == self.plugin_id
            && binding.instance_id == self.instance_id
            && binding.generation == self.generation
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayFailure {
    pub code: ErrorCode,
    pub message_key: String,
    pub retryable: bool,
    pub detail: Option<String>,
}

/// Opaque state loaded by native before a runtime is allowed to start. The
/// storage scope is native-generated (active or prepared artifact slot) and
/// is never supplied by the guest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBootstrapState {
    pub plugin_storage: Vec<u8>,
    pub project_state: Option<Vec<u8>>,
    /// Guest-owned portable-state schema. `None` is used only when there is no
    /// project state.
    pub project_state_schema_version: Option<u32>,
    pub storage_scope: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskTerminal {
    Completed,
    Failed(ErrorCode),
    Cancelled,
    UnknownOutcome,
}

impl GatewayFailure {
    #[must_use]
    pub fn new(code: ErrorCode, message_key: impl Into<String>) -> Self {
        Self {
            code,
            message_key: message_key.into(),
            retryable: false,
            detail: None,
        }
    }

    #[must_use]
    pub fn permission_denied() -> Self {
        Self::new(ErrorCode::PermissionDenied, "plugin.error.permissionDenied")
    }

    #[must_use]
    pub fn protocol() -> Self {
        Self::new(ErrorCode::ProtocolError, "plugin.error.protocolInvalid")
    }

    #[must_use]
    pub fn limit() -> Self {
        Self::new(ErrorCode::LimitExceeded, "plugin.error.limitExceeded")
    }
}

impl From<GatewayFailure> for wire::Error {
    fn from(value: GatewayFailure) -> Self {
        Self {
            code: value.code as i32,
            message_key: value.message_key,
            retryable: value.retryable,
            detail: value.detail,
        }
    }
}

/// Native integration point for protocol-v2 plugin authority.
///
/// Implementations live in the application layer and remain the only owners of
/// serial runtimes, workspace mutations, native dialogs, and plugin windows.
/// The broker validates capability and resource binding before invoking it.
pub trait PluginCapabilityGateway: Send + Sync + 'static {
    fn register_runtime(
        &self,
        _context: &GatewayContext,
        _state: RuntimeBootstrapState,
    ) -> Result<(), GatewayFailure> {
        Err(GatewayFailure::permission_denied())
    }

    /// Stages guest-migrated portable state inside the runtime. The native
    /// implementation must not mutate the active workspace until the whole
    /// `initialize` transaction has succeeded.
    fn stage_migrated_project_state(
        &self,
        _context: &GatewayContext,
        _schema_version: u32,
        _state: Vec<u8>,
    ) -> Result<(), GatewayFailure> {
        Err(GatewayFailure::permission_denied())
    }

    /// Completes initialization only after the native projection has verified
    /// that the model returned by the guest exactly matches the surfaces and
    /// commands registered through host imports during `initialize`.
    ///
    /// This prevents the response model from becoming an unauthoritative,
    /// silently discarded second declaration channel.
    fn finalize_initial_model(
        &self,
        _context: &GatewayContext,
        _model: &wire::PluginModel,
    ) -> Result<(), GatewayFailure> {
        Err(GatewayFailure::protocol())
    }

    fn invoke(
        &self,
        context: &GatewayContext,
        message_id: u64,
        operation: request::Operation,
    ) -> Result<response::Result, GatewayFailure>;

    fn cancel(
        &self,
        context: &GatewayContext,
        target_message_id: u64,
    ) -> Result<(), GatewayFailure>;

    /// Reclaims a successful result that completed after its request was
    /// cancelled. The result is never exposed to the guest and therefore any
    /// newly-created opaque resource must be revoked here.
    fn discard_cancelled_result(
        &self,
        _context: &GatewayContext,
        _operation: &request::Operation,
        _result: &response::Result,
    ) {
    }

    fn revoke_runtime(&self, context: &GatewayContext);

    fn complete_task(&self, _context: &GatewayContext, _task_id: &str, _terminal: TaskTerminal) {}

    fn stream(&self, _context: &GatewayContext, _event: StreamEvent) -> Result<(), GatewayFailure> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResourceKind {
    SerialLease,
    ReadGrant,
    SaveGrant,
}

#[derive(Default)]
struct SessionState {
    inbound_ids: MessageIdTracker,
    pending: BTreeSet<u64>,
    cancelled: BTreeSet<u64>,
    resources: BTreeMap<String, ResourceKind>,
    streams: StreamMultiplexer,
}

#[derive(Clone, Debug)]
pub struct PendingGatewayRequest {
    message_id: u64,
    operation: request::Operation,
}

pub enum GatewayDispatch {
    Immediate(Option<Envelope>),
    Request(PendingGatewayRequest),
}

pub struct GatewaySession<G: PluginCapabilityGateway + ?Sized> {
    context: GatewayContext,
    gateway: Arc<G>,
    state: Mutex<SessionState>,
    next_outbound_id: AtomicU64,
    revoked: AtomicBool,
}

impl<G: PluginCapabilityGateway + ?Sized> GatewaySession<G> {
    #[must_use]
    pub fn new(context: GatewayContext, gateway: Arc<G>) -> Self {
        Self {
            context,
            gateway,
            state: Mutex::new(SessionState::default()),
            next_outbound_id: AtomicU64::new(1),
            revoked: AtomicBool::new(false),
        }
    }

    #[must_use]
    pub const fn context(&self) -> &GatewayContext {
        &self.context
    }

    pub fn stage_migrated_project_state(
        &self,
        schema_version: u32,
        state: Vec<u8>,
    ) -> Result<(), GatewayFailure> {
        self.gateway
            .stage_migrated_project_state(&self.context, schema_version, state)
    }

    pub fn complete_task(&self, task_id: &str, terminal: TaskTerminal) {
        self.gateway.complete_task(&self.context, task_id, terminal);
    }

    pub fn finalize_initial_model(&self, model: &wire::PluginModel) -> Result<(), GatewayFailure> {
        self.gateway.finalize_initial_model(&self.context, model)
    }

    /// Reserves the next host->sidecar ID for handshake or guest-export
    /// requests. All writers for a runtime must allocate through this method.
    pub fn next_outbound_message_id(&self) -> Result<u64, GatewayFailure> {
        self.next_message_id()
    }

    /// Creates an independently ordered host event using the same sequence as
    /// request replies. Native code must not manufacture envelope IDs itself.
    pub fn event_envelope(&self, event: wire::event::Item) -> Result<Envelope, GatewayFailure> {
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: self.next_message_id()?,
            reply_to: None,
            payload: Some(envelope::Payload::Event(Event { item: Some(event) })),
        })
    }

    pub fn cancel_envelope(
        &self,
        target_message_id: u64,
        reason: impl Into<String>,
    ) -> Result<Envelope, GatewayFailure> {
        if target_message_id == 0 {
            return Err(GatewayFailure::protocol());
        }
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: self.next_message_id()?,
            reply_to: None,
            payload: Some(envelope::Payload::Cancel(Cancel {
                target_message_id,
                reason: reason.into(),
            })),
        })
    }

    pub fn stream_envelope(&self, stream: Stream) -> Result<Envelope, GatewayFailure> {
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: self.next_message_id()?,
            reply_to: None,
            payload: Some(envelope::Payload::Stream(stream)),
        })
    }

    /// Admits one sidecar envelope without executing a potentially blocking
    /// capability request. Native transports use this on their sole stdout
    /// reader and execute [`GatewayDispatch::Request`] on a bounded worker so
    /// later cancellation frames remain observable.
    pub fn begin(&self, envelope: Envelope) -> Result<GatewayDispatch, GatewayFailure> {
        if self.revoked.load(Ordering::Acquire) {
            return Err(GatewayFailure::new(
                ErrorCode::StaleHandle,
                "plugin.error.staleHandle",
            ));
        }
        validate_envelope(&envelope).map_err(|_| GatewayFailure::protocol())?;
        {
            let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
            state
                .inbound_ids
                .observe(envelope.message_id)
                .map_err(|_| GatewayFailure::protocol())?;
        }

        match envelope.payload {
            Some(envelope::Payload::Request(request)) => {
                let operation = request.operation.ok_or_else(GatewayFailure::protocol)?;
                self.begin_request(envelope.message_id, operation)
            }
            Some(envelope::Payload::Cancel(cancel)) => {
                let accepted = {
                    let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
                    if state.pending.contains(&cancel.target_message_id) {
                        state.cancelled.insert(cancel.target_message_id);
                        true
                    } else {
                        false
                    }
                };
                if accepted {
                    self.gateway
                        .cancel(&self.context, cancel.target_message_id)?;
                }
                Ok(GatewayDispatch::Immediate(None))
            }
            Some(envelope::Payload::Stream(stream)) => {
                let event = {
                    self.state
                        .lock()
                        .unwrap_or_else(|value| value.into_inner())
                        .streams
                        .accept(stream)?
                };
                let stream_id = event.stream_id();
                if let Err(error) = self.gateway.stream(&self.context, event) {
                    self.state
                        .lock()
                        .unwrap_or_else(|value| value.into_inner())
                        .streams
                        .abort(stream_id);
                    return Err(error);
                }
                Ok(GatewayDispatch::Immediate(None))
            }
            _ => Err(GatewayFailure::protocol()),
        }
    }

    /// Synchronous convenience entry used by focused broker tests and
    /// embedders without a dedicated reader loop.
    pub fn handle(&self, envelope: Envelope) -> Result<Option<Envelope>, GatewayFailure> {
        match self.begin(envelope)? {
            GatewayDispatch::Immediate(reply) => Ok(reply),
            GatewayDispatch::Request(request) => self.finish(request),
        }
    }

    fn begin_request(
        &self,
        message_id: u64,
        operation: request::Operation,
    ) -> Result<GatewayDispatch, GatewayFailure> {
        if let Err(error) = validate_operation(&operation) {
            return self
                .error_reply(message_id, error)
                .map(|reply| GatewayDispatch::Immediate(Some(reply)));
        }
        let capability = required_capability(&operation).ok_or_else(GatewayFailure::protocol)?;
        if !self.context.granted_capabilities.contains(&capability) {
            return self
                .error_reply(message_id, GatewayFailure::permission_denied())
                .map(|reply| GatewayDispatch::Immediate(Some(reply)));
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
            if state.pending.len() >= MAX_PENDING_HOST_REQUESTS as usize {
                return self
                    .error_reply(message_id, GatewayFailure::limit())
                    .map(|reply| GatewayDispatch::Immediate(Some(reply)));
            }
            if let Err(error) =
                validate_request_resources(&self.context, &state.resources, &operation)
            {
                return self
                    .error_reply(message_id, error)
                    .map(|reply| GatewayDispatch::Immediate(Some(reply)));
            }
            if !state.pending.insert(message_id) {
                return Err(GatewayFailure::protocol());
            }
        }

        Ok(GatewayDispatch::Request(PendingGatewayRequest {
            message_id,
            operation,
        }))
    }

    pub fn finish(
        &self,
        request: PendingGatewayRequest,
    ) -> Result<Option<Envelope>, GatewayFailure> {
        {
            let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
            if state.cancelled.remove(&request.message_id) {
                state.pending.remove(&request.message_id);
                return Ok(None);
            }
            if !state.pending.contains(&request.message_id) {
                return Err(GatewayFailure::protocol());
            }
        }
        let result =
            self.gateway
                .invoke(&self.context, request.message_id, request.operation.clone());
        let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
        if !state.pending.remove(&request.message_id) {
            return Err(GatewayFailure::protocol());
        }
        if state.cancelled.remove(&request.message_id) {
            drop(state);
            if let Ok(result) = &result {
                self.gateway
                    .discard_cancelled_result(&self.context, &request.operation, result);
            }
            return Ok(None);
        }
        match result {
            Ok(result) => {
                validate_response_shape(&request.operation, &result)?;
                update_resources(
                    &self.context,
                    &mut state.resources,
                    &request.operation,
                    &result,
                )?;
                self.response_reply(request.message_id, result).map(Some)
            }
            Err(error) => self.error_reply(request.message_id, error).map(Some),
        }
    }

    /// Rolls back admission when the native worker could not be created.
    pub fn abort(
        &self,
        request: PendingGatewayRequest,
        failure: GatewayFailure,
    ) -> Result<Option<Envelope>, GatewayFailure> {
        let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
        if !state.pending.remove(&request.message_id) {
            return Ok(None);
        }
        state.cancelled.remove(&request.message_id);
        drop(state);
        self.error_reply(request.message_id, failure).map(Some)
    }

    /// Immediately revokes all runtime authority even when request workers
    /// still hold references to this session (for example a native dialog).
    /// Late worker results remain cancellation-suppressed and are reclaimed by
    /// `discard_cancelled_result`.
    pub fn revoke(&self) {
        if self.revoked.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending = {
            let mut state = self.state.lock().unwrap_or_else(|value| value.into_inner());
            let pending = state.pending.iter().copied().collect::<Vec<_>>();
            state.cancelled.extend(pending.iter().copied());
            state.streams.abort_all();
            pending
        };
        for message_id in pending {
            let _ = self.gateway.cancel(&self.context, message_id);
        }
        self.gateway.revoke_runtime(&self.context);
    }

    fn response_reply(
        &self,
        reply_to: u64,
        result: response::Result,
    ) -> Result<Envelope, GatewayFailure> {
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: self.next_message_id()?,
            reply_to: Some(reply_to),
            payload: Some(envelope::Payload::Response(Response {
                result: Some(result),
            })),
        })
    }

    fn error_reply(
        &self,
        reply_to: u64,
        error: GatewayFailure,
    ) -> Result<Envelope, GatewayFailure> {
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: self.next_message_id()?,
            reply_to: Some(reply_to),
            payload: Some(envelope::Payload::Error(error.into())),
        })
    }

    fn next_message_id(&self) -> Result<u64, GatewayFailure> {
        self.next_outbound_id
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1).filter(|next| *next != 0)
            })
            .map_err(|_| GatewayFailure::protocol())
    }
}

fn validate_operation(operation: &request::Operation) -> Result<(), GatewayFailure> {
    use request::Operation as Op;
    match operation {
        Op::PublishSurfaceSnapshot(value) => validate_surface_snapshot(
            value
                .snapshot
                .as_ref()
                .ok_or_else(GatewayFailure::protocol)?,
        )
        .map_err(|_| GatewayFailure::protocol()),
        Op::PublishSurfacePatch(value) => {
            validate_surface_patch(value.patch.as_ref().ok_or_else(GatewayFailure::protocol)?)
                .map_err(|_| GatewayFailure::protocol())
        }
        Op::SerialRead(value)
            if value.max_bytes as usize > bbcom_plugin_contracts::v2::MAX_STREAM_CHUNK_BYTES
                || value.timeout_ms > bbcom_plugin_contracts::v2::SERIAL_READ_TIMEOUT_MS =>
        {
            Err(GatewayFailure::limit())
        }
        Op::SerialWrite(value)
            if value.payload.len() > bbcom_plugin_contracts::v2::MAX_STREAM_CHUNK_BYTES =>
        {
            Err(GatewayFailure::limit())
        }
        Op::ReadGrantChunk(value)
            if value.max_bytes as usize > bbcom_plugin_contracts::v2::MAX_STREAM_CHUNK_BYTES =>
        {
            Err(GatewayFailure::limit())
        }
        Op::WriteSaveGrant(value)
            if value.payload.len() > bbcom_plugin_contracts::v2::MAX_STREAM_CHUNK_BYTES =>
        {
            Err(GatewayFailure::limit())
        }
        _ => Ok(()),
    }
}

impl<G: PluginCapabilityGateway + ?Sized> Drop for GatewaySession<G> {
    fn drop(&mut self) {
        self.revoke();
    }
}

fn required_capability(operation: &request::Operation) -> Option<Capability> {
    use request::Operation as Op;
    Some(match operation {
        Op::PublishSurfaceSnapshot(_)
        | Op::PublishSurfacePatch(_)
        | Op::RegisterCommand(_)
        | Op::UnregisterCommand(_)
        | Op::ReportProgress(_)
        | Op::Heartbeat(_) => Capability::UiWorkspace,
        Op::RegisterSurface(request)
            if request.surface.as_ref().is_some_and(|surface| {
                surface.location == wire::SurfaceLocation::DetachedWindow as i32
            }) =>
        {
            Capability::UiDetachedWindow
        }
        Op::RegisterSurface(_) | Op::UnregisterSurface(_) => Capability::UiWorkspace,
        Op::ListPorts(_) => Capability::SerialPortsRead,
        Op::ListSessions(_)
        | Op::CreateSession(_)
        | Op::UpdateSession(_)
        | Op::ConnectSession(_)
        | Op::DisconnectSession(_)
        | Op::DeleteSession(_) => Capability::SerialSessionsManage,
        Op::AcquireSerialLease(_)
        | Op::ReleaseSerialLease(_)
        | Op::SerialRead(_)
        | Op::SerialWrite(_)
        | Op::ClearSerialBuffers(_)
        | Op::PendingSerialBytes(_) => Capability::SerialIo,
        Op::SetOutputLines(_) | Op::ReadInputLines(_) => Capability::SerialControlLines,
        Op::CaptureRead(_) => Capability::SessionCaptureRead,
        Op::UpsertQuickCommand(_)
        | Op::DeleteQuickCommand(_)
        | Op::UpsertMacro(_)
        | Op::DeleteMacro(_) => Capability::SessionCommandsReadWrite,
        Op::OpenReadGrant(_) | Op::ReadGrantChunk(_) | Op::CloseReadGrant(_) => {
            Capability::FileOpenRead
        }
        Op::CreateSaveGrant(_)
        | Op::WriteSaveGrant(_)
        | Op::CommitSaveGrant(_)
        | Op::CancelSaveGrant(_) => Capability::FileSaveWrite,
        Op::StorageGet(_) | Op::StorageSet(_) | Op::StorageDelete(_) => Capability::PluginStorage,
        Op::ProjectStateGet(_) | Op::ProjectStateSet(_) => Capability::ProjectStateReadWrite,
        Op::Initialize(_)
        | Op::HandleEvent(_)
        | Op::RunCommand(_)
        | Op::MigrateState(_)
        | Op::Shutdown(_) => return None,
    })
}

fn request_binding(operation: &request::Operation) -> Option<(&ResourceBinding, ResourceKind)> {
    use request::Operation as Op;
    match operation {
        Op::ReleaseSerialLease(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::SerialRead(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::SerialWrite(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::ClearSerialBuffers(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::PendingSerialBytes(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::SetOutputLines(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::ReadInputLines(value) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        Op::ReadGrantChunk(value) => value
            .grant
            .as_ref()
            .map(|value| (value, ResourceKind::ReadGrant)),
        Op::CloseReadGrant(value) => value
            .grant
            .as_ref()
            .map(|value| (value, ResourceKind::ReadGrant)),
        Op::WriteSaveGrant(value) => value
            .grant
            .as_ref()
            .map(|value| (value, ResourceKind::SaveGrant)),
        Op::CommitSaveGrant(value) => value
            .grant
            .as_ref()
            .map(|value| (value, ResourceKind::SaveGrant)),
        Op::CancelSaveGrant(value) => value
            .grant
            .as_ref()
            .map(|value| (value, ResourceKind::SaveGrant)),
        _ => None,
    }
}

fn validate_request_resources(
    context: &GatewayContext,
    resources: &BTreeMap<String, ResourceKind>,
    operation: &request::Operation,
) -> Result<(), GatewayFailure> {
    let Some((binding, expected)) = request_binding(operation) else {
        return Ok(());
    };
    if !context.binds(binding) || resources.get(&binding.resource_id) != Some(&expected) {
        return Err(GatewayFailure::new(
            ErrorCode::StaleHandle,
            "plugin.error.staleHandle",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex};
    use std::thread;

    use bbcom_plugin_contracts::generated_v2::{
        AcquireSerialLeaseRequest, AcquireSerialLeaseResponse, ErrorCode, ListPortsRequest,
        ListPortsResponse, Request, SerialLeaseOptions, SerialReadRequest, envelope, request,
        response,
    };

    use super::*;

    #[derive(Default)]
    struct RecordingGateway {
        invokes: AtomicUsize,
        revoked: AtomicBool,
    }

    #[derive(Default)]
    struct BlockingGateway {
        invoked: (Mutex<bool>, Condvar),
        release: (Mutex<bool>, Condvar),
        cancellations: AtomicUsize,
        discarded: AtomicUsize,
        discarded_results: Mutex<Vec<(request::Operation, response::Result)>>,
        returns_acquire: AtomicBool,
        revoked: AtomicUsize,
    }

    impl PluginCapabilityGateway for BlockingGateway {
        fn invoke(
            &self,
            context: &GatewayContext,
            _: u64,
            operation: request::Operation,
        ) -> Result<response::Result, GatewayFailure> {
            let returns_acquire = self.returns_acquire.load(Ordering::Relaxed);
            if (returns_acquire && !matches!(operation, request::Operation::AcquireSerialLease(_)))
                || (!returns_acquire && !matches!(operation, request::Operation::ListPorts(_)))
            {
                return Err(GatewayFailure::protocol());
            }
            *self.invoked.0.lock().unwrap() = true;
            self.invoked.1.notify_all();
            let mut released = self.release.0.lock().unwrap();
            while !*released {
                released = self.release.1.wait(released).unwrap();
            }
            if returns_acquire {
                Ok(response::Result::AcquireSerialLease(
                    AcquireSerialLeaseResponse {
                        lease: Some(ResourceBinding {
                            workspace_id: context.workspace_id.clone(),
                            plugin_id: context.plugin_id.clone(),
                            instance_id: context.instance_id.clone(),
                            generation: context.generation,
                            resource_id: "lease-late".to_owned(),
                        }),
                        session_generation: 9,
                    },
                ))
            } else {
                Ok(response::Result::ListPorts(ListPortsResponse {
                    ports: Vec::new(),
                }))
            }
        }

        fn cancel(&self, _: &GatewayContext, _: u64) -> Result<(), GatewayFailure> {
            self.cancellations.fetch_add(1, Ordering::Relaxed);
            *self.release.0.lock().unwrap() = true;
            self.release.1.notify_all();
            Ok(())
        }

        fn discard_cancelled_result(
            &self,
            _: &GatewayContext,
            operation: &request::Operation,
            result: &response::Result,
        ) {
            self.discarded.fetch_add(1, Ordering::Relaxed);
            self.discarded_results
                .lock()
                .unwrap()
                .push((operation.clone(), result.clone()));
        }

        fn revoke_runtime(&self, _: &GatewayContext) {
            self.revoked.fetch_add(1, Ordering::Relaxed);
        }
    }

    impl PluginCapabilityGateway for RecordingGateway {
        fn invoke(
            &self,
            context: &GatewayContext,
            _message_id: u64,
            operation: request::Operation,
        ) -> Result<response::Result, GatewayFailure> {
            self.invokes.fetch_add(1, Ordering::Relaxed);
            Ok(match operation {
                request::Operation::ListPorts(_) => {
                    response::Result::ListPorts(ListPortsResponse { ports: Vec::new() })
                }
                request::Operation::AcquireSerialLease(_) => {
                    response::Result::AcquireSerialLease(AcquireSerialLeaseResponse {
                        lease: Some(ResourceBinding {
                            resource_id: "lease-1".to_owned(),
                            workspace_id: context.workspace_id.clone(),
                            plugin_id: context.plugin_id.clone(),
                            instance_id: context.instance_id.clone(),
                            generation: context.generation,
                        }),
                        session_generation: 9,
                    })
                }
                _ => return Err(GatewayFailure::protocol()),
            })
        }

        fn cancel(
            &self,
            _context: &GatewayContext,
            _target_message_id: u64,
        ) -> Result<(), GatewayFailure> {
            Ok(())
        }

        fn revoke_runtime(&self, _context: &GatewayContext) {
            self.revoked.store(true, Ordering::Relaxed);
        }
    }

    fn context(capabilities: impl IntoIterator<Item = Capability>) -> GatewayContext {
        GatewayContext {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.fixture".to_owned(),
            instance_id: "instance-1".to_owned(),
            generation: 4,
            granted_capabilities: capabilities.into_iter().collect(),
        }
    }

    fn request_envelope(message_id: u64, operation: request::Operation) -> Envelope {
        Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id,
            reply_to: None,
            payload: Some(envelope::Payload::Request(Request {
                operation: Some(operation),
            })),
        }
    }

    #[test]
    fn capability_denial_is_a_typed_reply_and_duplicate_ids_are_rejected() {
        let gateway = Arc::new(RecordingGateway::default());
        let session = GatewaySession::new(context([]), Arc::clone(&gateway));
        let request = request_envelope(
            1,
            request::Operation::ListPorts(ListPortsRequest::default()),
        );
        let reply = session.handle(request.clone()).unwrap().unwrap();
        assert_eq!(reply.reply_to, Some(1));
        assert!(matches!(
            reply.payload,
            Some(envelope::Payload::Error(wire::Error { code, .. }))
                if code == ErrorCode::PermissionDenied as i32
        ));
        assert_eq!(gateway.invokes.load(Ordering::Relaxed), 0);
        assert_eq!(
            session.handle(request).unwrap_err().code,
            ErrorCode::ProtocolError
        );
    }

    #[test]
    fn resources_are_bound_to_the_exact_runtime_generation() {
        let gateway = Arc::new(RecordingGateway::default());
        let session = GatewaySession::new(context([Capability::SerialIo]), Arc::clone(&gateway));
        let acquire = request_envelope(
            1,
            request::Operation::AcquireSerialLease(AcquireSerialLeaseRequest {
                session_id: "session-1".to_owned(),
                options: Some(SerialLeaseOptions {
                    pause_automation: true,
                    rx_buffer_bytes: 4096,
                }),
            }),
        );
        assert!(matches!(
            session.handle(acquire).unwrap().unwrap().payload,
            Some(envelope::Payload::Response(_))
        ));

        let stale = request_envelope(
            2,
            request::Operation::SerialRead(SerialReadRequest {
                lease: Some(ResourceBinding {
                    resource_id: "lease-1".to_owned(),
                    workspace_id: "workspace-1".to_owned(),
                    plugin_id: "dev.bbcom.fixture".to_owned(),
                    instance_id: "instance-1".to_owned(),
                    generation: 5,
                }),
                max_bytes: 32,
                timeout_ms: 100,
            }),
        );
        let reply = session.handle(stale).unwrap().unwrap();
        assert!(matches!(
            reply.payload,
            Some(envelope::Payload::Error(wire::Error { code, .. }))
                if code == ErrorCode::StaleHandle as i32
        ));
        assert_eq!(gateway.invokes.load(Ordering::Relaxed), 1);

        drop(session);
        assert!(gateway.revoked.load(Ordering::Relaxed));
    }

    #[test]
    fn cancellation_is_admitted_while_invoke_blocks_and_suppresses_late_result() {
        let gateway = Arc::new(BlockingGateway::default());
        let session = Arc::new(GatewaySession::new(
            context([Capability::SerialPortsRead]),
            Arc::clone(&gateway),
        ));
        let GatewayDispatch::Request(request) = session
            .begin(request_envelope(
                1,
                request::Operation::ListPorts(ListPortsRequest::default()),
            ))
            .unwrap()
        else {
            panic!("request must be admitted for asynchronous execution");
        };
        let worker_session = Arc::clone(&session);
        let worker = thread::spawn(move || worker_session.finish(request));
        let mut invoked = gateway.invoked.0.lock().unwrap();
        while !*invoked {
            invoked = gateway.invoked.1.wait(invoked).unwrap();
        }
        drop(invoked);

        let cancellation = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: 2,
            reply_to: None,
            payload: Some(envelope::Payload::Cancel(Cancel {
                target_message_id: 1,
                reason: "test-cancel".to_owned(),
            })),
        };
        assert!(matches!(
            session.begin(cancellation).unwrap(),
            GatewayDispatch::Immediate(None)
        ));
        assert!(worker.join().unwrap().unwrap().is_none());
        assert_eq!(gateway.cancellations.load(Ordering::Relaxed), 1);
        assert_eq!(gateway.discarded.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cancelled_late_acquire_passes_the_exact_opaque_lease_to_discard() {
        let gateway = Arc::new(BlockingGateway::default());
        gateway.returns_acquire.store(true, Ordering::Relaxed);
        let session = Arc::new(GatewaySession::new(
            context([Capability::SerialIo]),
            Arc::clone(&gateway),
        ));
        let operation = request::Operation::AcquireSerialLease(AcquireSerialLeaseRequest {
            session_id: "session-1".to_owned(),
            options: Some(SerialLeaseOptions {
                pause_automation: true,
                rx_buffer_bytes: 4_096,
            }),
        });
        let GatewayDispatch::Request(request) = session
            .begin(request_envelope(1, operation.clone()))
            .unwrap()
        else {
            panic!("request must be admitted for asynchronous execution");
        };
        let worker_session = Arc::clone(&session);
        let worker = thread::spawn(move || worker_session.finish(request));
        let mut invoked = gateway.invoked.0.lock().unwrap();
        while !*invoked {
            invoked = gateway.invoked.1.wait(invoked).unwrap();
        }
        drop(invoked);

        assert!(matches!(
            session
                .begin(Envelope {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: MAX_PROTOCOL_MINOR,
                    message_id: 2,
                    reply_to: None,
                    payload: Some(envelope::Payload::Cancel(Cancel {
                        target_message_id: 1,
                        reason: "late-acquire".to_owned(),
                    })),
                })
                .unwrap(),
            GatewayDispatch::Immediate(None)
        ));
        assert!(worker.join().unwrap().unwrap().is_none());

        let discarded = gateway.discarded_results.lock().unwrap();
        assert_eq!(discarded.len(), 1);
        assert_eq!(discarded[0].0, operation);
        assert!(matches!(
            &discarded[0].1,
            response::Result::AcquireSerialLease(AcquireSerialLeaseResponse {
                lease: Some(ResourceBinding {
                    resource_id,
                    workspace_id,
                    plugin_id,
                    instance_id,
                    generation: 4,
                }),
                session_generation: 9,
            }) if resource_id == "lease-late"
                && workspace_id == "workspace-1"
                && plugin_id == "dev.bbcom.fixture"
                && instance_id == "instance-1"
        ));
    }

    #[test]
    fn explicit_revoke_cancels_workers_and_revokes_authority_before_last_arc_drops() {
        let gateway = Arc::new(BlockingGateway::default());
        let session = Arc::new(GatewaySession::new(
            context([Capability::SerialPortsRead]),
            Arc::clone(&gateway),
        ));
        let GatewayDispatch::Request(request) = session
            .begin(request_envelope(
                1,
                request::Operation::ListPorts(ListPortsRequest::default()),
            ))
            .unwrap()
        else {
            panic!("request must be admitted");
        };
        let worker_session = Arc::clone(&session);
        let worker = thread::spawn(move || worker_session.finish(request));
        let mut invoked = gateway.invoked.0.lock().unwrap();
        while !*invoked {
            invoked = gateway.invoked.1.wait(invoked).unwrap();
        }
        drop(invoked);

        session.revoke();
        assert_eq!(gateway.revoked.load(Ordering::Relaxed), 1);
        assert_eq!(gateway.cancellations.load(Ordering::Relaxed), 1);
        assert!(worker.join().unwrap().unwrap().is_none());
        session.revoke();
        assert_eq!(gateway.revoked.load(Ordering::Relaxed), 1);
    }
}

fn validate_response_shape(
    operation: &request::Operation,
    result: &response::Result,
) -> Result<(), GatewayFailure> {
    use request::Operation as Op;
    use response::Result as Res;
    let valid = matches!(
        (operation, result),
        (
            Op::PublishSurfaceSnapshot(_),
            Res::PublishSurfaceSnapshot(_)
        ) | (Op::PublishSurfacePatch(_), Res::PublishSurfacePatch(_))
            | (Op::RegisterSurface(_), Res::RegisterSurface(_))
            | (Op::UnregisterSurface(_), Res::UnregisterSurface(_))
            | (Op::RegisterCommand(_), Res::RegisterCommand(_))
            | (Op::UnregisterCommand(_), Res::UnregisterCommand(_))
            | (Op::ReportProgress(_), Res::ReportProgress(_))
            | (Op::Heartbeat(_), Res::Heartbeat(_))
            | (Op::ListPorts(_), Res::ListPorts(_))
            | (Op::ListSessions(_), Res::ListSessions(_))
            | (Op::CreateSession(_), Res::CreateSession(_))
            | (Op::UpdateSession(_), Res::UpdateSession(_))
            | (Op::ConnectSession(_), Res::ConnectSession(_))
            | (Op::DisconnectSession(_), Res::DisconnectSession(_))
            | (Op::DeleteSession(_), Res::DeleteSession(_))
            | (Op::AcquireSerialLease(_), Res::AcquireSerialLease(_))
            | (Op::ReleaseSerialLease(_), Res::ReleaseSerialLease(_))
            | (Op::SerialRead(_), Res::SerialRead(_))
            | (Op::SerialWrite(_), Res::SerialWrite(_))
            | (Op::ClearSerialBuffers(_), Res::ClearSerialBuffers(_))
            | (Op::PendingSerialBytes(_), Res::PendingSerialBytes(_))
            | (Op::SetOutputLines(_), Res::SetOutputLines(_))
            | (Op::ReadInputLines(_), Res::ReadInputLines(_))
            | (Op::CaptureRead(_), Res::CaptureRead(_))
            | (Op::UpsertQuickCommand(_), Res::UpsertQuickCommand(_))
            | (Op::DeleteQuickCommand(_), Res::DeleteQuickCommand(_))
            | (Op::UpsertMacro(_), Res::UpsertMacro(_))
            | (Op::DeleteMacro(_), Res::DeleteMacro(_))
            | (Op::OpenReadGrant(_), Res::OpenReadGrant(_))
            | (Op::ReadGrantChunk(_), Res::ReadGrantChunk(_))
            | (Op::CloseReadGrant(_), Res::CloseReadGrant(_))
            | (Op::CreateSaveGrant(_), Res::CreateSaveGrant(_))
            | (Op::WriteSaveGrant(_), Res::WriteSaveGrant(_))
            | (Op::CommitSaveGrant(_), Res::CommitSaveGrant(_))
            | (Op::CancelSaveGrant(_), Res::CancelSaveGrant(_))
            | (Op::StorageGet(_), Res::StorageGet(_))
            | (Op::StorageSet(_), Res::StorageSet(_))
            | (Op::StorageDelete(_), Res::StorageDelete(_))
            | (Op::ProjectStateGet(_), Res::ProjectStateGet(_))
            | (Op::ProjectStateSet(_), Res::ProjectStateSet(_))
    );
    valid.then_some(()).ok_or_else(GatewayFailure::protocol)
}

fn update_resources(
    context: &GatewayContext,
    resources: &mut BTreeMap<String, ResourceKind>,
    operation: &request::Operation,
    result: &response::Result,
) -> Result<(), GatewayFailure> {
    use request::Operation as Op;
    use response::Result as Res;
    let created = match (operation, result) {
        (Op::AcquireSerialLease(_), Res::AcquireSerialLease(value)) => value
            .lease
            .as_ref()
            .map(|value| (value, ResourceKind::SerialLease)),
        (Op::OpenReadGrant(_), Res::OpenReadGrant(value)) => value
            .grant
            .as_ref()
            .and_then(|value| value.grant.as_ref())
            .map(|value| (value, ResourceKind::ReadGrant)),
        (Op::CreateSaveGrant(_), Res::CreateSaveGrant(value)) => value
            .grant
            .as_ref()
            .and_then(|value| value.grant.as_ref())
            .map(|value| (value, ResourceKind::SaveGrant)),
        _ => None,
    };
    if let Some((binding, kind)) = created
        && (!context.binds(binding)
            || resources
                .insert(binding.resource_id.clone(), kind)
                .is_some())
    {
        return Err(GatewayFailure::protocol());
    }
    if matches!(
        operation,
        Op::ReleaseSerialLease(_)
            | Op::CloseReadGrant(_)
            | Op::CommitSaveGrant(_)
            | Op::CancelSaveGrant(_)
    ) && let Some((binding, _)) = request_binding(operation)
    {
        resources.remove(&binding.resource_id);
    }
    Ok(())
}
