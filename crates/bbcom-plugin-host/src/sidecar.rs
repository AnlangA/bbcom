use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bbcom_plugin_contracts::generated::{
    CancelRequest, CompleteShutdownResponse, Envelope, Error as ProtocolError,
    GetStateChunkRequest, GetStateChunkResponse, InitializeRequest, InitializeResponse,
    InvokeRequest, InvokeResponse, OpaqueStateKind, PutStateChunkRequest, PutStateChunkResponse,
    ShutdownResponse, StateSnapshotDescriptor, envelope,
};
use bbcom_plugin_contracts::{
    HANDSHAKE_TIMEOUT_MS, MAX_PLUGIN_PERSISTED_STATE_BYTES, MAX_PLUGIN_STATE_CHUNK_BYTES,
    PLUGIN_STATE_SCHEMA_VERSION, PROTOCOL_MAJOR, PROTOCOL_MINOR, Permission, parse_permission,
};

use crate::handshake::{HandshakeExpectation, HandshakeMachine};
use crate::policy::{HostPlatform, ProcessLimitPolicy};
use crate::transport::{FramePump, FrameWriter, InputOperationControl, PumpEvent};
use crate::uplink::Uplink;
use crate::{
    CallKind, HostError, PluginEngineFactory, PluginRuntime, Result, RuntimeInterruptHandle,
    TrustedPluginArtifact,
};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidecarExit {
    ShutdownRequested,
    PeerClosed,
}

pub trait PluginExecutor {
    fn initialize_with_kind(&mut self, kind: CallKind) -> Result<()>;
    fn shutdown(&mut self) -> Result<()>;
    fn handle_panel_event(&mut self, event: crate::bindings::PanelEvent) -> Result<()>;
    fn take_published_panel(&mut self) -> Option<crate::bindings::DeclarativePanel>;
    fn restore_persisted_state(
        &mut self,
        plugin_storage: &[u8],
        project_state: Option<Vec<u8>>,
    ) -> Result<()>;
    fn persisted_state(&self) -> (Vec<u8>, Option<Vec<u8>>);

    fn interrupt_handle(&self) -> Option<Arc<dyn PluginInterrupt>> {
        None
    }

    fn prepare_interruptible_call(&self) {}
}

pub trait PluginInterrupt: Send + Sync + 'static {
    fn interrupt(&self);
}

impl PluginInterrupt for RuntimeInterruptHandle {
    fn interrupt(&self) {
        RuntimeInterruptHandle::interrupt(self);
    }
}

impl PluginExecutor for PluginRuntime {
    fn initialize_with_kind(&mut self, kind: CallKind) -> Result<()> {
        PluginRuntime::initialize_with_kind(self, kind)
    }

    fn shutdown(&mut self) -> Result<()> {
        PluginRuntime::shutdown(self)
    }

    fn handle_panel_event(&mut self, event: crate::bindings::PanelEvent) -> Result<()> {
        PluginRuntime::handle_panel_event(self, event)
    }

    fn take_published_panel(&mut self) -> Option<crate::bindings::DeclarativePanel> {
        PluginRuntime::take_published_panel(self)
    }

    fn restore_persisted_state(
        &mut self,
        plugin_storage: &[u8],
        project_state: Option<Vec<u8>>,
    ) -> Result<()> {
        PluginRuntime::restore_persisted_state(self, plugin_storage, project_state)
    }

    fn persisted_state(&self) -> (Vec<u8>, Option<Vec<u8>>) {
        PluginRuntime::persisted_state(self)
    }

    fn interrupt_handle(&self) -> Option<Arc<dyn PluginInterrupt>> {
        Some(Arc::new(PluginRuntime::interrupt_handle(self)))
    }

    fn prepare_interruptible_call(&self) {
        PluginRuntime::prepare_interruptible_call(self);
    }
}

#[derive(Default)]
struct ActiveOperations {
    entries: Mutex<BTreeMap<u64, ActiveOperation>>,
}

struct ActiveOperation {
    cancellation_requested: bool,
    interrupt: Option<Arc<dyn PluginInterrupt>>,
}

impl ActiveOperations {
    fn begin(
        &self,
        request_id: u64,
        interrupt: Option<Arc<dyn PluginInterrupt>>,
    ) -> ActiveOperationGuard<'_> {
        let interrupt_now = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let operation = entries.entry(request_id).or_insert(ActiveOperation {
                cancellation_requested: false,
                interrupt: None,
            });
            operation.interrupt = interrupt;
            operation
                .cancellation_requested
                .then(|| operation.interrupt.clone())
                .flatten()
        };
        if let Some(interrupt) = interrupt_now {
            interrupt.interrupt();
        }
        ActiveOperationGuard {
            operations: self,
            request_id,
            finished: false,
        }
    }

    fn discard(&self, request_id: u64) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&request_id);
    }
}

impl InputOperationControl for ActiveOperations {
    fn register(&self, request_id: u64) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(request_id)
            .or_insert(ActiveOperation {
                cancellation_requested: false,
                interrupt: None,
            });
    }

    fn cancel(&self, target_request_id: u64) -> bool {
        let interrupt = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(operation) = entries.get_mut(&target_request_id) else {
                return false;
            };
            if operation.cancellation_requested {
                return false;
            }
            operation.cancellation_requested = true;
            operation.interrupt.clone()
        };
        if let Some(interrupt) = interrupt {
            interrupt.interrupt();
        }
        true
    }
}

struct ActiveOperationGuard<'a> {
    operations: &'a ActiveOperations,
    request_id: u64,
    finished: bool,
}

impl ActiveOperationGuard<'_> {
    fn finish(mut self) -> bool {
        self.finished = true;
        self.operations
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.request_id)
            .is_some_and(|operation| operation.cancellation_requested)
    }
}

impl Drop for ActiveOperationGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.operations.discard(self.request_id);
        }
    }
}

#[derive(Default)]
struct UploadedState {
    plugin_storage: Option<StateUpload>,
    project_state: Option<StateUpload>,
}

#[derive(Default)]
struct StateUpload {
    total_bytes: usize,
    bytes: Vec<u8>,
    complete: bool,
}

struct PublishedState {
    revision: u64,
    plugin_storage: Vec<u8>,
    project_state: Option<Vec<u8>>,
}

pub struct Sidecar<E = PluginRuntime> {
    runtime: E,
    operations: Arc<ActiveOperations>,
    handshake: HandshakeMachine,
    uploaded: UploadedState,
    published: Option<PublishedState>,
    next_revision: u64,
    initialized: bool,
    shutdown_prepared: bool,
}

#[derive(serde::Deserialize)]
struct PanelEventBody {
    #[serde(rename = "fieldId")]
    field_id: String,
    value: String,
}

fn panel_json(panel: &crate::bindings::DeclarativePanel) -> Vec<u8> {
    use serde_json::json;
    json!({
        "title": panel.title,
        "fields": panel.fields.iter().map(|field| json!({
            "id": field.id,
            "label": field.label,
            "kind": format!("{:?}", field.kind).to_lowercase(),
            "value": field.value,
            "options": field.options,
            "disabled": field.disabled,
        })).collect::<Vec<_>>(),
    })
    .to_string()
    .into_bytes()
}

impl<E: PluginExecutor> Sidecar<E> {
    #[must_use]
    pub fn new(runtime: E, expectation: HandshakeExpectation) -> Self {
        Self {
            runtime,
            operations: Arc::new(ActiveOperations::default()),
            handshake: HandshakeMachine::new(expectation),
            uploaded: UploadedState::default(),
            published: None,
            next_revision: 1,
            initialized: false,
            shutdown_prepared: false,
        }
    }

    pub fn run<R, W>(&mut self, reader: R, writer: W) -> Result<SidecarExit>
    where
        R: Read + Send + 'static,
        W: Write,
    {
        self.run_with_dispatcher(reader, writer, None)
    }

    /// `run` with a pump-level push dispatcher for parked WIT host imports
    /// (serial proposal decisions, session query data).
    pub fn run_with_dispatcher<R, W>(
        &mut self,
        reader: R,
        writer: W,
        dispatcher: Option<Arc<dyn crate::transport::EnvelopeDispatcher>>,
    ) -> Result<SidecarExit>
    where
        R: Read + Send + 'static,
        W: Write,
    {
        let operation_control: Arc<dyn InputOperationControl> = self.operations.clone();
        let pump = FramePump::spawn(reader, operation_control, dispatcher)?;
        let mut writer = FrameWriter::new(writer);
        let first = match pump
            .receiver()
            .recv_timeout(Duration::from_millis(HANDSHAKE_TIMEOUT_MS))
        {
            Ok(PumpEvent::Envelope(envelope, _permit)) => envelope,
            Ok(PumpEvent::Cancel(_, _permit, _accepted)) => {
                return Err(HostError::InvalidHandshake);
            }
            Ok(PumpEvent::Eof) => return Err(HostError::InvalidHandshake),
            Ok(PumpEvent::Failed(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => return Err(HostError::HandshakeTimeout),
            Err(RecvTimeoutError::Disconnected) => return Err(HostError::Transport),
        };
        let response = self.handshake.accept(first, std::time::Instant::now())?;
        writer.write_envelope(&response)?;

        loop {
            match pump.receiver().recv() {
                Ok(PumpEvent::Envelope(envelope, _permit)) => {
                    if let Some(exit) = self.handle_envelope(envelope, &mut writer)? {
                        self.handshake.close();
                        return Ok(exit);
                    }
                }
                Ok(PumpEvent::Cancel(envelope, _permit, accepted)) => {
                    let request_id = envelope.request_id;
                    let Some(envelope::Payload::CancelRequest(request)) = envelope.payload else {
                        return Err(HostError::Transport);
                    };
                    self.handle_cancel(request_id, request, accepted, &mut writer)?;
                }
                Ok(PumpEvent::Eof) => {
                    self.runtime.shutdown()?;
                    self.handshake.close();
                    return Ok(SidecarExit::PeerClosed);
                }
                Ok(PumpEvent::Failed(error)) => return Err(error),
                Err(_) => return Err(HostError::Transport),
            }
        }
    }

    fn handle_envelope<W: Write>(
        &mut self,
        envelope: Envelope,
        writer: &mut FrameWriter<W>,
    ) -> Result<Option<SidecarExit>> {
        let request_id = envelope.request_id;
        match envelope.payload {
            Some(envelope::Payload::InvokeRequest(request)) => {
                self.handle_invoke(request_id, request, writer)
            }
            Some(envelope::Payload::CancelRequest(request)) => {
                self.handle_cancel(request_id, request, false, writer)?;
                Ok(None)
            }
            Some(envelope::Payload::PutStateChunkRequest(request)) => {
                self.handle_put_state(request_id, request, writer)?;
                Ok(None)
            }
            Some(envelope::Payload::InitializeRequest(request)) => {
                self.handle_initialize(request_id, request, writer)?;
                Ok(None)
            }
            Some(envelope::Payload::GetStateChunkRequest(request)) => {
                self.handle_get_state(request_id, request, writer)?;
                Ok(None)
            }
            Some(envelope::Payload::ShutdownRequest(_)) => {
                self.handle_shutdown(request_id, writer)?;
                Ok(None)
            }
            Some(envelope::Payload::CompleteShutdownRequest(request)) => {
                if !self.shutdown_prepared
                    || self.published.as_ref().map(|state| state.revision) != Some(request.revision)
                {
                    writer.write_envelope(&protocol_error(
                        request_id,
                        "PLUGIN_PROTOCOL_INVALID",
                        "plugin.error.protocolInvalid",
                    ))?;
                    return Ok(None);
                }
                writer.write_envelope(&Envelope {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    request_id,
                    payload: Some(envelope::Payload::CompleteShutdownResponse(
                        CompleteShutdownResponse {},
                    )),
                })?;
                Ok(Some(SidecarExit::ShutdownRequested))
            }
            _ => {
                writer.write_envelope(&protocol_error(
                    request_id,
                    "PLUGIN_PROTOCOL_INVALID",
                    "plugin.error.protocolInvalid",
                ))?;
                Ok(None)
            }
        }
    }

    fn handle_invoke<W: Write>(
        &mut self,
        request_id: u64,
        request: InvokeRequest,
        writer: &mut FrameWriter<W>,
    ) -> Result<Option<SidecarExit>> {
        self.operations.discard(request_id);
        if matches!(request.method.as_str(), "initialize" | "shutdown") {
            writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_VERSION_UNSUPPORTED",
                "plugin.error.protocolInvalid",
            ))?;
            return Ok(None);
        }
        if request.method == "panel-event" {
            return self.handle_panel_event_invoke(request_id, request, writer);
        }
        let error = HostError::UnsupportedMethod;
        writer.write_envelope(&protocol_error(
            request_id,
            error.code(),
            error.message_key(),
        ))?;
        Ok(None)
    }

    /// Delivers a declarative-panel event to the plugin. The request body is
    /// JSON `{"fieldId": string, "value": string}`; the response body is the
    /// plugin's returned panel serialized as JSON
    /// `{"title": string, "fields": [{"id", "label", "kind", "value",
    /// "options", "disabled"}]}`.
    fn handle_panel_event_invoke<W: Write>(
        &mut self,
        request_id: u64,
        request: InvokeRequest,
        writer: &mut FrameWriter<W>,
    ) -> Result<Option<SidecarExit>> {
        if !self.initialized || self.shutdown_prepared {
            self.operations.discard(request_id);
            writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ))?;
            return Ok(None);
        }
        let event: PanelEventBody = match serde_json::from_slice(&request.body) {
            Ok(event) => event,
            Err(_) => {
                self.operations.discard(request_id);
                writer.write_envelope(&protocol_error(
                    request_id,
                    "PLUGIN_PROTOCOL_INVALID",
                    "plugin.error.protocolInvalid",
                ))?;
                return Ok(None);
            }
        };
        let event = crate::bindings::PanelEvent {
            field_id: event.field_id,
            value: event.value,
        };
        self.runtime.prepare_interruptible_call();
        let active = self
            .operations
            .begin(request_id, self.runtime.interrupt_handle());
        let result = self.runtime.handle_panel_event(event);
        let cancelled = active.finish();
        if cancelled {
            writer.write_envelope(&cancelled_error(request_id))?;
            return Ok(None);
        }
        let panel = match result {
            Ok(()) => self.runtime.take_published_panel(),
            Err(error) => {
                writer.write_envelope(&protocol_error(
                    request_id,
                    error.code(),
                    error.message_key(),
                ))?;
                return Ok(None);
            }
        };
        let body = panel
            .map(|panel| panel_json(&panel))
            .unwrap_or_else(|| serde_json::Value::Null.to_string().into_bytes());
        writer.write_envelope(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(envelope::Payload::InvokeResponse(InvokeResponse { body })),
        })?;
        Ok(None)
    }

    fn handle_put_state<W: Write>(
        &mut self,
        request_id: u64,
        request: PutStateChunkRequest,
        writer: &mut FrameWriter<W>,
    ) -> Result<()> {
        if self.initialized
            || request.state_schema_version != PLUGIN_STATE_SCHEMA_VERSION
            || request.payload.len() > MAX_PLUGIN_STATE_CHUNK_BYTES
            || request.total_bytes as usize > MAX_PLUGIN_PERSISTED_STATE_BYTES
        {
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ));
        }
        let kind = OpaqueStateKind::try_from(request.kind).ok();
        let other_bytes = match kind {
            Some(OpaqueStateKind::PluginStorage) => self
                .uploaded
                .project_state
                .as_ref()
                .map_or(0, |state| state.total_bytes),
            Some(OpaqueStateKind::ProjectState) => self
                .uploaded
                .plugin_storage
                .as_ref()
                .map_or(0, |state| state.total_bytes),
            _ => {
                return writer.write_envelope(&protocol_error(
                    request_id,
                    "PLUGIN_PROTOCOL_INVALID",
                    "plugin.error.protocolInvalid",
                ));
            }
        };
        let total_bytes = request.total_bytes as usize;
        if total_bytes.saturating_add(other_bytes) > MAX_PLUGIN_PERSISTED_STATE_BYTES {
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_STATE_LIMIT",
                "plugin.error.packageLimit",
            ));
        }
        let upload = match kind {
            Some(OpaqueStateKind::PluginStorage) => &mut self.uploaded.plugin_storage,
            Some(OpaqueStateKind::ProjectState) => &mut self.uploaded.project_state,
            _ => unreachable!("state kind was validated"),
        };
        let state = upload.get_or_insert_with(|| StateUpload {
            total_bytes,
            bytes: Vec::with_capacity(total_bytes.min(MAX_PLUGIN_STATE_CHUNK_BYTES)),
            complete: false,
        });
        if state.complete
            || state.total_bytes != total_bytes
            || request.offset as usize != state.bytes.len()
            || state.bytes.len().saturating_add(request.payload.len()) > total_bytes
            || request.final_chunk
                != (state.bytes.len().saturating_add(request.payload.len()) == total_bytes)
        {
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ));
        }
        state.bytes.extend_from_slice(&request.payload);
        state.complete = request.final_chunk;
        let accepted_bytes = state.bytes.len() as u64;
        writer.write_envelope(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(envelope::Payload::PutStateChunkResponse(
                PutStateChunkResponse {
                    kind: request.kind,
                    accepted_bytes,
                },
            )),
        })
    }

    fn handle_initialize<W: Write>(
        &mut self,
        request_id: u64,
        request: InitializeRequest,
        writer: &mut FrameWriter<W>,
    ) -> Result<()> {
        let storage_ready = self
            .uploaded
            .plugin_storage
            .as_ref()
            .is_some_and(|state| state.complete);
        let project_ready = self
            .uploaded
            .project_state
            .as_ref()
            .is_some_and(|state| state.complete);
        if self.initialized
            || request.state_schema_version != PLUGIN_STATE_SCHEMA_VERSION
            || request.has_plugin_storage != storage_ready
            || request.has_project_state != project_ready
            || !storage_ready
        {
            self.operations.discard(request_id);
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ));
        }
        let storage = self
            .uploaded
            .plugin_storage
            .take()
            .expect("validated upload")
            .bytes;
        let project = self.uploaded.project_state.take().map(|state| state.bytes);
        if let Err(error) = self.runtime.restore_persisted_state(&storage, project) {
            self.operations.discard(request_id);
            return writer.write_envelope(&protocol_error(
                request_id,
                error.code(),
                error.message_key(),
            ));
        }
        self.runtime.prepare_interruptible_call();
        let active = self
            .operations
            .begin(request_id, self.runtime.interrupt_handle());
        let result = self.runtime.initialize_with_kind(CallKind::Normal);
        let cancelled = active.finish();
        if cancelled {
            return writer.write_envelope(&cancelled_error(request_id));
        }
        if let Err(error) = result {
            return writer.write_envelope(&protocol_error(
                request_id,
                error.code(),
                error.message_key(),
            ));
        }
        self.initialized = true;
        let panel_json = self
            .runtime
            .take_published_panel()
            .map(|panel| panel_json(&panel))
            .unwrap_or_default();
        let descriptor = self.publish_runtime_state()?;
        writer.write_envelope(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(envelope::Payload::InitializeResponse(InitializeResponse {
                state: Some(descriptor),
                panel_json,
            })),
        })
    }

    fn handle_shutdown<W: Write>(
        &mut self,
        request_id: u64,
        writer: &mut FrameWriter<W>,
    ) -> Result<()> {
        if !self.initialized || self.shutdown_prepared {
            self.operations.discard(request_id);
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ));
        }
        self.runtime.prepare_interruptible_call();
        let active = self
            .operations
            .begin(request_id, self.runtime.interrupt_handle());
        let result = self.runtime.shutdown();
        let cancelled = active.finish();
        if cancelled {
            return writer.write_envelope(&cancelled_error(request_id));
        }
        if let Err(error) = result {
            return writer.write_envelope(&protocol_error(
                request_id,
                error.code(),
                error.message_key(),
            ));
        }
        self.shutdown_prepared = true;
        let descriptor = self.publish_runtime_state()?;
        writer.write_envelope(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(envelope::Payload::ShutdownResponse(ShutdownResponse {
                state: Some(descriptor),
            })),
        })
    }

    fn publish_runtime_state(&mut self) -> Result<StateSnapshotDescriptor> {
        let (plugin_storage, project_state) = self.runtime.persisted_state();
        let combined = plugin_storage
            .len()
            .saturating_add(project_state.as_ref().map_or(0, Vec::len));
        if combined > MAX_PLUGIN_PERSISTED_STATE_BYTES {
            return Err(HostError::PluginRejected);
        }
        let revision = self.next_revision;
        self.next_revision = self
            .next_revision
            .checked_add(1)
            .ok_or(HostError::Transport)?;
        let descriptor = StateSnapshotDescriptor {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            revision,
            plugin_storage_bytes: plugin_storage.len() as u64,
            has_project_state: project_state.is_some(),
            project_state_bytes: project_state.as_ref().map_or(0, Vec::len) as u64,
        };
        self.published = Some(PublishedState {
            revision,
            plugin_storage,
            project_state,
        });
        Ok(descriptor)
    }

    fn handle_get_state<W: Write>(
        &mut self,
        request_id: u64,
        request: GetStateChunkRequest,
        writer: &mut FrameWriter<W>,
    ) -> Result<()> {
        let Some(state) = self.published.as_ref().filter(|state| {
            state.revision == request.revision
                && request.state_schema_version == PLUGIN_STATE_SCHEMA_VERSION
                && request.max_bytes > 0
                && request.max_bytes as usize <= MAX_PLUGIN_STATE_CHUNK_BYTES
        }) else {
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ));
        };
        let kind = OpaqueStateKind::try_from(request.kind).ok();
        let bytes = match kind {
            Some(OpaqueStateKind::PluginStorage) => &state.plugin_storage,
            Some(OpaqueStateKind::ProjectState) => match state.project_state.as_ref() {
                Some(bytes) => bytes,
                None => {
                    return writer.write_envelope(&protocol_error(
                        request_id,
                        "PLUGIN_PROTOCOL_INVALID",
                        "plugin.error.protocolInvalid",
                    ));
                }
            },
            _ => {
                return writer.write_envelope(&protocol_error(
                    request_id,
                    "PLUGIN_PROTOCOL_INVALID",
                    "plugin.error.protocolInvalid",
                ));
            }
        };
        let offset = request.offset as usize;
        if offset > bytes.len() {
            return writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_PROTOCOL_INVALID",
                "plugin.error.protocolInvalid",
            ));
        }
        let end = offset
            .saturating_add(request.max_bytes as usize)
            .min(bytes.len());
        writer.write_envelope(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(envelope::Payload::GetStateChunkResponse(
                GetStateChunkResponse {
                    state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                    revision: state.revision,
                    kind: request.kind,
                    offset: request.offset,
                    total_bytes: bytes.len() as u64,
                    payload: bytes[offset..end].to_vec(),
                },
            )),
        })
    }

    fn handle_cancel<W: Write>(
        &mut self,
        request_id: u64,
        request: CancelRequest,
        accepted: bool,
        writer: &mut FrameWriter<W>,
    ) -> Result<()> {
        let _ = request.target_request_id;
        if accepted {
            writer.write_envelope(&cancelled_error(request_id))
        } else {
            writer.write_envelope(&protocol_error(
                request_id,
                "PLUGIN_OPERATION_NOT_FOUND",
                "plugin.error.operationNotFound",
            ))
        }
    }
}

fn cancelled_error(request_id: u64) -> Envelope {
    protocol_error(request_id, "PLUGIN_CANCELLED", "plugin.error.cancelled")
}

fn protocol_error(request_id: u64, code: &str, message_key: &str) -> Envelope {
    Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        request_id,
        payload: Some(envelope::Payload::Error(ProtocolError {
            code: code.to_owned(),
            message_key: message_key.to_owned(),
            retryable: false,
        })),
    }
}

pub fn run_from_environment() -> Result<SidecarExit> {
    let launch = LaunchArguments::parse(std::env::args().skip(1))?;
    launch.process_policy.validate()?;
    let manifest_path = launch.package_root.join("plugin.toml");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|_| HostError::ArtifactRead)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err(HostError::InvalidArtifact);
    }
    let manifest_text = fs::read_to_string(&manifest_path).map_err(|_| HostError::ArtifactRead)?;
    let artifact = TrustedPluginArtifact::load(&launch.package_root, &manifest_text)?;
    let requested: BTreeSet<_> = artifact.manifest.permissions()?.into_iter().collect();
    if launch
        .granted
        .iter()
        .any(|permission| !permission.is_implicit() && !requested.contains(permission))
    {
        return Err(HostError::InvalidHandshake);
    }
    let mut granted = launch.granted;
    granted.insert(Permission::UiPanel);
    granted.insert(Permission::PluginStorage);
    let expectation = HandshakeExpectation::new(
        artifact.manifest.id.clone(),
        artifact.manifest.version.clone(),
        granted.iter().copied(),
    );
    let factory = PluginEngineFactory::new()?;
    // One shared stdout handle: the main loop and the WIT-host uplink write
    // through the same mutex so envelope frames never interleave.
    let shared_stdout: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(Box::new(std::io::stdout())));
    let uplink = Uplink::new(
        artifact.manifest.id.clone(),
        Box::new(SharedWrite(Arc::clone(&shared_stdout))),
    );
    let runtime = factory.load_with_uplink(&artifact, granted, Some(Arc::clone(&uplink)))?;
    let mut sidecar = Sidecar::new(runtime, expectation);
    let dispatcher = crate::uplink::UplinkDispatcher(uplink);
    sidecar.run_with_dispatcher(
        std::io::stdin(),
        SharedWrite(shared_stdout),
        Some(Arc::new(dispatcher)),
    )
}

/// Serialized writer handle shared by the main envelope loop and the uplink.
pub(crate) struct SharedWrite(Arc<Mutex<Box<dyn Write + Send>>>);

impl Write for SharedWrite {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("shared stdout poisoned"))?
            .write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("shared stdout poisoned"))?
            .flush()
    }
}

struct LaunchArguments {
    package_root: PathBuf,
    process_policy: ProcessLimitPolicy,
    granted: BTreeSet<Permission>,
}

impl LaunchArguments {
    fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self> {
        let mut arguments = arguments.into_iter();
        let mut package_root = None;
        let mut platform = None;
        let mut memory_limit_bytes = None;
        let mut blocks_child_processes = false;
        let mut blocks_network = false;
        let mut restricts_filesystem = false;
        let mut granted = BTreeSet::new();
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--package-root" => package_root = arguments.next().map(PathBuf::from),
                "--platform" => {
                    platform = match arguments.next().as_deref() {
                        Some("windows") => Some(HostPlatform::Windows),
                        Some("macos") => Some(HostPlatform::MacOs),
                        Some("linux") => Some(HostPlatform::Linux),
                        _ => return Err(HostError::InvalidProcessLimit),
                    }
                }
                "--memory-limit-bytes" => {
                    memory_limit_bytes = arguments
                        .next()
                        .and_then(|value| value.parse::<usize>().ok())
                }
                "--sandbox-no-children" => blocks_child_processes = true,
                "--sandbox-no-network" => blocks_network = true,
                "--sandbox-private-fs" => restricts_filesystem = true,
                "--grant" => {
                    let value = arguments.next().ok_or(HostError::InvalidHandshake)?;
                    granted.insert(parse_permission(&value)?);
                }
                _ => return Err(HostError::InvalidProcessLimit),
            }
        }
        Ok(Self {
            package_root: package_root.ok_or(HostError::InvalidArtifact)?,
            process_policy: ProcessLimitPolicy {
                platform: platform.ok_or(HostError::InvalidProcessLimit)?,
                memory_limit_bytes: memory_limit_bytes.ok_or(HostError::InvalidProcessLimit)?,
                blocks_child_processes,
                blocks_network,
                restricts_filesystem,
            },
            granted,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_arguments(platform: &str) -> Vec<String> {
        vec![
            "--package-root".to_owned(),
            "/private/plugin".to_owned(),
            "--platform".to_owned(),
            platform.to_owned(),
            "--memory-limit-bytes".to_owned(),
            bbcom_plugin_contracts::HOST_PROCESS_MEMORY_LIMIT_BYTES.to_string(),
            "--sandbox-no-children".to_owned(),
            "--sandbox-no-network".to_owned(),
            "--sandbox-private-fs".to_owned(),
            "--grant".to_owned(),
            Permission::SessionMetadataRead.to_string(),
        ]
    }

    #[test]
    fn launch_arguments_parse_all_platforms_and_reject_malformed_attestations() {
        for (name, platform) in [
            ("windows", HostPlatform::Windows),
            ("macos", HostPlatform::MacOs),
            ("linux", HostPlatform::Linux),
        ] {
            let parsed = LaunchArguments::parse(valid_arguments(name)).unwrap();
            assert_eq!(parsed.package_root, PathBuf::from("/private/plugin"));
            assert_eq!(parsed.process_policy.platform, platform);
            assert_eq!(
                parsed.granted,
                [Permission::SessionMetadataRead].into_iter().collect()
            );
            parsed.process_policy.validate().unwrap();
        }

        assert!(matches!(
            LaunchArguments::parse(Vec::<String>::new()),
            Err(HostError::InvalidArtifact)
        ));
        assert!(matches!(
            LaunchArguments::parse(["--unknown".to_owned()]),
            Err(HostError::InvalidProcessLimit)
        ));
        assert!(matches!(
            LaunchArguments::parse([
                "--package-root".to_owned(),
                "/private/plugin".to_owned(),
                "--platform".to_owned(),
                "other".to_owned(),
            ]),
            Err(HostError::InvalidProcessLimit)
        ));
        assert!(matches!(
            LaunchArguments::parse([
                "--package-root".to_owned(),
                "/private/plugin".to_owned(),
                "--platform".to_owned(),
                "linux".to_owned(),
                "--memory-limit-bytes".to_owned(),
                "not-a-number".to_owned(),
            ]),
            Err(HostError::InvalidProcessLimit)
        ));
        assert!(matches!(
            LaunchArguments::parse([
                "--package-root".to_owned(),
                "/private/plugin".to_owned(),
                "--platform".to_owned(),
                "linux".to_owned(),
                "--memory-limit-bytes".to_owned(),
                "1".to_owned(),
                "--grant".to_owned(),
                "network.http".to_owned(),
            ]),
            Err(HostError::Contract(_))
        ));
    }

    #[test]
    fn protocol_errors_are_stable_and_non_retryable() {
        let envelope = protocol_error(41, "PLUGIN_DENIED", "plugin.error.denied");
        assert_eq!(envelope.request_id, 41);
        let Some(envelope::Payload::Error(error)) = envelope.payload else {
            panic!("expected error payload")
        };
        assert_eq!(error.code, "PLUGIN_DENIED");
        assert_eq!(error.message_key, "plugin.error.denied");
        assert!(!error.retryable);
    }
}
