use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bbcom_plugin_contracts::generated_v2 as wire;
use bbcom_plugin_contracts::generated_v2::{
    Capability, Envelope, ErrorCode, Request, Response, envelope, request, response,
};
use bbcom_plugin_contracts::parse_v2_capability;
use bbcom_plugin_contracts::v2::{MAX_PROTOCOL_MINOR, PROTOCOL_MAJOR};

use crate::launch_context::PluginLaunchContext;
use crate::bindings::bbcom::plugin::types as wit;
use crate::handshake::{HandshakeExpectation, HandshakeMachine};
use crate::transport::{
    EnvelopeDispatcher, FramePump, FrameWriter, InputOperationControl, PumpEvent,
};
use crate::uplink::{CapabilityRpc, CapabilityRpcDispatcher, MessageIdSequence};
use crate::{
    HostError, PluginEngineFactory, PluginRuntime, Result, RuntimeInterruptHandle,
    PluginPackage,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidecarExit {
    ShutdownRequested,
    PeerClosed,
}

/// Test/embedder seam for the guest exports.
pub trait PluginExecutor {
    fn initialize_v2(&mut self, _context: wit::HostContext) -> Result<wit::PluginModel> {
        Err(HostError::UnsupportedMethod)
    }
    fn handle_event_v2(&mut self, _event: wit::PluginEvent) -> Result<wit::EventResult> {
        Err(HostError::UnsupportedMethod)
    }
    fn run_command_v2(
        &mut self,
        _invocation: wit::CommandInvocation,
    ) -> Result<wit::CommandResult> {
        Err(HostError::UnsupportedMethod)
    }
    fn migrate_state_v2(
        &mut self,
        _previous_api: &str,
        _state: &[u8],
    ) -> Result<wit::MigratedState> {
        Err(HostError::UnsupportedMethod)
    }
    fn shutdown(&mut self) -> Result<()> {
        Ok(())
    }
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
    fn initialize_v2(&mut self, context: wit::HostContext) -> Result<wit::PluginModel> {
        PluginRuntime::initialize_v2(self, context)
    }
    fn handle_event_v2(&mut self, event: wit::PluginEvent) -> Result<wit::EventResult> {
        PluginRuntime::handle_event(self, event)
    }
    fn run_command_v2(&mut self, invocation: wit::CommandInvocation) -> Result<wit::CommandResult> {
        PluginRuntime::run_command(self, invocation)
    }
    fn migrate_state_v2(&mut self, previous_api: &str, state: &[u8]) -> Result<wit::MigratedState> {
        PluginRuntime::migrate_state(self, previous_api, state)
    }
    fn shutdown(&mut self) -> Result<()> {
        PluginRuntime::shutdown(self)
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
    operation: Mutex<Option<ActiveOperation>>,
}
struct ActiveOperation {
    message_id: u64,
    cancelled: bool,
    interrupt: Option<Arc<dyn PluginInterrupt>>,
}

impl ActiveOperations {
    fn attach(
        &self,
        message_id: u64,
        interrupt: Option<Arc<dyn PluginInterrupt>>,
    ) -> ActiveGuard<'_> {
        let interrupt_now = {
            let mut operation = self.operation.lock().unwrap_or_else(|v| v.into_inner());
            if let Some(active) = operation
                .as_mut()
                .filter(|active| active.message_id == message_id)
            {
                active.interrupt = interrupt;
                active.cancelled.then(|| active.interrupt.clone()).flatten()
            } else {
                None
            }
        };
        if let Some(interrupt) = interrupt_now {
            interrupt.interrupt();
        }
        ActiveGuard {
            operations: self,
            message_id,
        }
    }
}

impl InputOperationControl for ActiveOperations {
    fn register(&self, message_id: u64) -> bool {
        let mut operation = self.operation.lock().unwrap_or_else(|v| v.into_inner());
        if operation.is_some() {
            return false;
        }
        *operation = Some(ActiveOperation {
            message_id,
            cancelled: false,
            interrupt: None,
        });
        true
    }
    fn cancel(&self, target_message_id: u64) -> bool {
        let interrupt = {
            let mut operation = self.operation.lock().unwrap_or_else(|v| v.into_inner());
            let Some(active) = operation
                .as_mut()
                .filter(|active| active.message_id == target_message_id && !active.cancelled)
            else {
                return false;
            };
            active.cancelled = true;
            active.interrupt.clone()
        };
        if let Some(interrupt) = interrupt {
            interrupt.interrupt();
        }
        true
    }
}

struct ActiveGuard<'a> {
    operations: &'a ActiveOperations,
    message_id: u64,
}
impl ActiveGuard<'_> {
    fn finish(self) -> bool {
        self.operations
            .operation
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .take()
            .filter(|active| active.message_id == self.message_id)
            .is_some_and(|active| active.cancelled)
    }
}
impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        let mut operation = self
            .operations
            .operation
            .lock()
            .unwrap_or_else(|v| v.into_inner());
        if operation
            .as_ref()
            .is_some_and(|active| active.message_id == self.message_id)
        {
            operation.take();
        }
    }
}

pub struct Sidecar<E = PluginRuntime> {
    runtime: E,
    operations: Arc<ActiveOperations>,
    handshake: HandshakeMachine,
    ids: Arc<MessageIdSequence>,
    initialized: bool,
    closed: bool,
}

impl<E: PluginExecutor> Sidecar<E> {
    #[must_use]
    pub fn new(runtime: E, expectation: HandshakeExpectation) -> Self {
        Self::with_message_ids(runtime, expectation, MessageIdSequence::new())
    }
    #[must_use]
    pub fn with_message_ids(
        runtime: E,
        expectation: HandshakeExpectation,
        ids: Arc<MessageIdSequence>,
    ) -> Self {
        Self {
            runtime,
            operations: Arc::new(ActiveOperations::default()),
            handshake: HandshakeMachine::new(expectation),
            ids,
            initialized: false,
            closed: false,
        }
    }

    pub fn run<R: Read + Send + 'static, W: Write>(
        &mut self,
        reader: R,
        writer: W,
    ) -> Result<SidecarExit> {
        self.run_with_dispatcher(reader, writer, None)
    }
    pub fn run_with_dispatcher<R: Read + Send + 'static, W: Write>(
        &mut self,
        reader: R,
        writer: W,
        dispatcher: Option<Arc<dyn EnvelopeDispatcher>>,
    ) -> Result<SidecarExit> {
        let mut writer = FrameWriter::new(writer);
        let pump = FramePump::spawn(
            reader,
            Arc::clone(&self.operations) as Arc<dyn InputOperationControl>,
            dispatcher,
        )?;
        loop {
            match pump.receiver().recv().map_err(|_| HostError::Transport)? {
                PumpEvent::Envelope(envelope, _permit) => {
                    if !self.handshake.is_established() {
                        let reply =
                            self.handshake
                                .accept(envelope, Instant::now(), self.ids.next()?)?;
                        writer.write_envelope(&reply)?;
                        continue;
                    }
                    if let Some(exit) = self.dispatch(envelope, &mut writer)? {
                        return Ok(exit);
                    }
                }
                PumpEvent::Busy(envelope, _permit) => writer.write_envelope(&error_reply(
                    self.ids.next()?,
                    envelope.message_id,
                    ErrorCode::Busy,
                    "plugin.error.busy",
                ))?,
                PumpEvent::Cancel(envelope, _permit, accepted) => {
                    let code = if accepted {
                        ErrorCode::Cancelled
                    } else {
                        ErrorCode::NotFound
                    };
                    let key = if accepted {
                        "plugin.error.cancelled"
                    } else {
                        "plugin.error.operationNotFound"
                    };
                    writer.write_envelope(&error_reply(
                        self.ids.next()?,
                        envelope.message_id,
                        code,
                        key,
                    ))?;
                }
                PumpEvent::Eof => {
                    self.best_effort_shutdown();
                    return Ok(SidecarExit::PeerClosed);
                }
                PumpEvent::Failed(error) => return Err(error),
            }
        }
    }

    fn dispatch<W: Write>(
        &mut self,
        envelope: Envelope,
        writer: &mut FrameWriter<W>,
    ) -> Result<Option<SidecarExit>> {
        let message_id = envelope.message_id;
        let Some(envelope::Payload::Request(Request {
            operation: Some(operation),
        })) = envelope.payload
        else {
            writer.write_envelope(&error_reply(
                self.ids.next()?,
                message_id,
                ErrorCode::ProtocolError,
                "plugin.error.protocolInvalid",
            ))?;
            return Ok(None);
        };
        self.runtime.prepare_interruptible_call();
        let guard = self
            .operations
            .attach(message_id, self.runtime.interrupt_handle());
        let (result, exit) = match operation {
            request::Operation::Initialize(value) if !self.initialized => {
                let context =
                    value
                        .context
                        .ok_or(HostError::InvalidHandshake)
                        .and_then(|value| {
                            self.validate_context(&value)
                                .and_then(|()| host_context(value))
                        })?;
                match self.runtime.initialize_v2(context) {
                    Ok(model) => {
                        self.initialized = true;
                        (
                            Ok(response::Result::Initialize(wire::InitializeResponse {
                                model: Some(plugin_model(model)),
                            })),
                            false,
                        )
                    }
                    Err(error) => (Err(error), false),
                }
            }
            request::Operation::Initialize(_) => (Err(HostError::InvalidHandshake), false),
            request::Operation::HandleEvent(value) if self.initialized => {
                let result = value
                    .event
                    .ok_or(HostError::InvalidHandshake)
                    .and_then(plugin_event)
                    .and_then(|event| self.runtime.handle_event_v2(event))
                    .map(|value| {
                        response::Result::HandleEvent(wire::HandleEventResponse {
                            accepted: value.accepted,
                        })
                    });
                (result, false)
            }
            request::Operation::RunCommand(value) if self.initialized => {
                let result = value
                    .invocation
                    .ok_or(HostError::InvalidHandshake)
                    .map(command_invocation)
                    .and_then(|value| self.runtime.run_command_v2(value))
                    .map(|value| {
                        response::Result::RunCommand(wire::RunCommandResponse {
                            message: value.message,
                        })
                    });
                (result, false)
            }
            request::Operation::MigrateState(value) if !self.initialized => {
                let result = self
                    .runtime
                    .migrate_state_v2(&value.previous_api, &value.state)
                    .map(|value| {
                        response::Result::MigrateState(wire::MigrateStateResponse {
                            state_schema_version: value.schema_version,
                            state: value.state,
                        })
                    });
                (result, false)
            }
            request::Operation::Shutdown(_) => (
                self.runtime
                    .shutdown()
                    .map(|()| response::Result::Shutdown(wire::OperationAck {})),
                true,
            ),
            request::Operation::HandleEvent(_)
            | request::Operation::RunCommand(_)
            | request::Operation::MigrateState(_) => (Err(HostError::InvalidHandshake), false),
            _ => (Err(HostError::UnsupportedMethod), false),
        };
        let cancelled = guard.finish();
        let reply = if cancelled {
            error_reply(
                self.ids.next()?,
                message_id,
                ErrorCode::Cancelled,
                "plugin.error.cancelled",
            )
        } else {
            match result {
                Ok(result) => response_reply(self.ids.next()?, message_id, result),
                Err(error) => host_error_reply(self.ids.next()?, message_id, &error),
            }
        };
        writer.write_envelope(&reply)?;
        if exit && !cancelled {
            self.closed = true;
            self.handshake.close();
            Ok(Some(SidecarExit::ShutdownRequested))
        } else {
            Ok(None)
        }
    }

    fn validate_context(&self, context: &wire::HostContext) -> Result<()> {
        let expected = self.handshake.expectation();
        let mut capabilities = BTreeSet::new();
        for capability in &context.granted_capabilities {
            let capability =
                Capability::try_from(*capability).map_err(|_| HostError::InvalidHandshake)?;
            if capability == Capability::Unspecified || !capabilities.insert(capability) {
                return Err(HostError::InvalidHandshake);
            }
        }
        if context.workspace_id != expected.workspace_id
            || context.plugin_id != expected.plugin_id
            || context.instance_id != expected.instance_id
            || context.generation != expected.generation
            || capabilities != expected.granted_capabilities
            || context.limits.as_ref() != Some(&expected.limits)
        {
            return Err(HostError::InvalidHandshake);
        }
        Ok(())
    }

    fn best_effort_shutdown(&mut self) {
        if !self.closed {
            let _ = self.runtime.shutdown();
            self.closed = true;
            self.handshake.close();
        }
    }
}

impl<E> Drop for Sidecar<E> {
    fn drop(&mut self) {
        if let Some(interrupt) = self
            .operations
            .operation
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .take()
            .and_then(|active| active.interrupt)
        {
            interrupt.interrupt();
        }
    }
}

fn response_reply(message_id: u64, reply_to: u64, result: response::Result) -> Envelope {
    Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: MAX_PROTOCOL_MINOR,
        message_id,
        reply_to: Some(reply_to),
        payload: Some(envelope::Payload::Response(Response {
            result: Some(result),
        })),
    }
}
fn error_reply(message_id: u64, reply_to: u64, code: ErrorCode, message_key: &str) -> Envelope {
    Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: MAX_PROTOCOL_MINOR,
        message_id,
        reply_to: Some(reply_to),
        payload: Some(envelope::Payload::Error(wire::Error {
            code: code as i32,
            message_key: message_key.to_owned(),
            retryable: false,
            detail: None,
        })),
    }
}
fn host_error_reply(message_id: u64, reply_to: u64, error: &HostError) -> Envelope {
    let (code, key) = match error {
        HostError::Execution(value) if value.kind == crate::ExecutionFailureKind::Timeout => {
            (ErrorCode::Timeout, "plugin.error.timeout")
        }
        HostError::Execution(value) if value.kind == crate::ExecutionFailureKind::Cancelled => {
            (ErrorCode::Cancelled, "plugin.error.cancelled")
        }
        HostError::Execution(value) if value.kind == crate::ExecutionFailureKind::Trap => {
            (ErrorCode::ProtocolError, "plugin.error.trap")
        }
        HostError::Execution(value) if value.kind == crate::ExecutionFailureKind::FuelExhausted => {
            (ErrorCode::LimitExceeded, "plugin.error.fuelExhausted")
        }
        HostError::Execution(value) if value.kind == crate::ExecutionFailureKind::MemoryLimit => {
            (ErrorCode::LimitExceeded, "plugin.error.memoryLimit")
        }
        HostError::UnsupportedMethod => {
            (ErrorCode::Unavailable, "plugin.error.operationUnavailable")
        }
        HostError::PluginRejected => (ErrorCode::InvalidInput, "plugin.error.requestRejected"),
        _ => (ErrorCode::ProtocolError, "plugin.error.protocolInvalid"),
    };
    error_reply(message_id, reply_to, code, key)
}

fn host_context(value: wire::HostContext) -> Result<wit::HostContext> {
    let theme = match wire::ColorScheme::try_from(value.theme).ok() {
        Some(wire::ColorScheme::Light) => wit::ColorScheme::Light,
        Some(wire::ColorScheme::Dark) => wit::ColorScheme::Dark,
        Some(wire::ColorScheme::System) => wit::ColorScheme::System,
        _ => return Err(HostError::InvalidHandshake),
    };
    let capabilities = value
        .granted_capabilities
        .into_iter()
        .map(|value| match Capability::try_from(value).ok() {
            Some(Capability::UiWorkspace) => Ok(wit::Capability::UiWorkspace),
            Some(Capability::UiDetachedWindow) => Ok(wit::Capability::UiDetachedWindow),
            Some(Capability::SerialPortsRead) => Ok(wit::Capability::SerialPortsRead),
            Some(Capability::SerialSessionsManage) => Ok(wit::Capability::SerialSessionsManage),
            Some(Capability::SerialIo) => Ok(wit::Capability::SerialIo),
            Some(Capability::SerialControlLines) => Ok(wit::Capability::SerialControlLines),
            Some(Capability::SessionCaptureRead) => Ok(wit::Capability::SessionCaptureRead),
            Some(Capability::SessionCommandsReadWrite) => {
                Ok(wit::Capability::SessionCommandsReadWrite)
            }
            Some(Capability::FileOpenRead) => Ok(wit::Capability::FileOpenRead),
            Some(Capability::FileSaveWrite) => Ok(wit::Capability::FileSaveWrite),
            Some(Capability::PluginStorage) => Ok(wit::Capability::PluginStorage),
            Some(Capability::ProjectStateReadWrite) => Ok(wit::Capability::ProjectStateReadWrite),
            _ => Err(HostError::InvalidHandshake),
        })
        .collect::<Result<Vec<_>>>()?;
    let limits = value.limits.ok_or(HostError::InvalidHandshake)?;
    Ok(wit::HostContext {
        workspace_id: value.workspace_id,
        plugin_id: value.plugin_id,
        instance_id: value.instance_id,
        generation: value.generation,
        locale: value.locale,
        theme,
        granted_capabilities: capabilities,
        limits: wit::ResourceLimits {
            max_frame_bytes: limits.max_frame_bytes,
            max_queue_bytes: limits.max_queue_bytes,
            max_stream_chunk_bytes: limits.max_stream_chunk_bytes,
            max_concurrent_streams: limits.max_concurrent_streams,
            max_pending_host_requests: limits.max_pending_host_requests,
            wasm_memory_limit_bytes: limits.wasm_memory_limit_bytes,
            host_process_memory_limit_bytes: limits.host_process_memory_limit_bytes,
            call_timeout_ms: limits.call_timeout_ms,
            serial_read_timeout_ms: limits.serial_read_timeout_ms,
            long_task_timeout_ms: limits.long_task_timeout_ms,
            activity_timeout_ms: limits.activity_timeout_ms,
            max_ui_document_bytes: limits.max_ui_document_bytes,
            max_ui_nodes: limits.max_ui_nodes,
        },
        sessions: value
            .sessions
            .into_iter()
            .map(|session| wit::SessionSummary {
                session_id: session.session_id,
                name: session.name,
                connected: session.connected,
                rx_bytes: session.rx_bytes,
                tx_bytes: session.tx_bytes,
                generation: session.generation,
            })
            .collect(),
    })
}

fn plugin_model(value: wit::PluginModel) -> wire::PluginModel {
    wire::PluginModel {
        surfaces: value
            .surfaces
            .into_iter()
            .map(|surface| wire::PluginSurface {
                surface_id: surface.surface_id,
                title: surface.title,
                location: match surface.location {
                    wit::SurfaceLocation::Workspace => wire::SurfaceLocation::Workspace as i32,
                    wit::SurfaceLocation::DetachedWindow => {
                        wire::SurfaceLocation::DetachedWindow as i32
                    }
                },
            })
            .collect(),
        commands: value
            .commands
            .into_iter()
            .map(|command| wire::CommandContribution {
                command_id: command.command_id,
                title: command.title,
                description: command.description,
                long_running: command.long_running,
                confirmation: command.confirmation,
            })
            .collect(),
    }
}
fn command_invocation(value: wire::CommandInvocation) -> wit::CommandInvocation {
    wit::CommandInvocation {
        command_id: value.command_id,
        invocation_id: value.invocation_id,
        arguments: value.arguments,
    }
}
fn plugin_event(value: wire::PluginEvent) -> Result<wit::PluginEvent> {
    use wire::plugin_event::Item;
    Ok(match value.item.ok_or(HostError::InvalidHandshake)? {
        Item::Surface(value) => {
            let ui_value = match value.value.ok_or(HostError::InvalidHandshake)? {
                wire::surface_interaction::Value::Text(v) => wit::UiValue::Text(v),
                wire::surface_interaction::Value::Number(v) => wit::UiValue::Number(v),
                wire::surface_interaction::Value::Toggle(v) => wit::UiValue::Toggle(v),
                wire::surface_interaction::Value::Selection(v) => wit::UiValue::Selection(v),
                wire::surface_interaction::Value::Action(_) => wit::UiValue::Action,
            };
            wit::PluginEvent::Surface(wit::SurfaceInteraction {
                surface_id: value.surface_id,
                revision: value.revision,
                node_id: value.node_id,
                value: ui_value,
            })
        }
        Item::LocaleChanged(value) => wit::PluginEvent::LocaleChanged(value.locale),
        Item::ThemeChanged(value) => {
            wit::PluginEvent::ThemeChanged(match wire::ColorScheme::try_from(value.theme).ok() {
                Some(wire::ColorScheme::Light) => wit::ColorScheme::Light,
                Some(wire::ColorScheme::Dark) => wit::ColorScheme::Dark,
                Some(wire::ColorScheme::System) => wit::ColorScheme::System,
                _ => return Err(HostError::InvalidHandshake),
            })
        }
        Item::PortCatalogChanged(_) => wit::PluginEvent::PortCatalogChanged,
        Item::CancelTask(value) => wit::PluginEvent::CancelTask(value.task_id),
    })
}

pub fn run_from_environment() -> Result<SidecarExit> {
    let launch = LaunchArguments::parse(std::env::args().skip(1))?;
    let manifest_path = launch.package_root.join("plugin.toml");
    let manifest_text = fs::read_to_string(&manifest_path).map_err(|_| HostError::ArtifactRead)?;
    let artifact = PluginPackage::load(&launch.package_root, &manifest_text)?;
    let context = PluginLaunchContext {
        workspace_id: launch.workspace_id.clone(),
        instance_id: launch.instance_id.clone(),
        generation: launch.generation,
    };
    let ids = MessageIdSequence::new();
    let shared_stdout: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(Box::new(std::io::stdout())));
    let rpc = CapabilityRpc::new(
        Box::new(SharedWrite(Arc::clone(&shared_stdout))),
        Arc::clone(&ids),
    );
    let factory = PluginEngineFactory::new()?;
    let runtime = factory.load(
        &artifact,
        &context,
        launch.granted.iter().copied(),
        Arc::clone(&rpc),
    )?;
    let expectation = HandshakeExpectation::new(
        artifact.manifest.id.clone(),
        artifact.manifest.version.clone(),
        artifact.manifest.component.sha256.clone(),
        launch.workspace_id,
        launch.instance_id,
        launch.generation,
        launch.granted.iter().copied(),
    );
    let mut sidecar = Sidecar::with_message_ids(runtime, expectation, ids);
    sidecar.run_with_dispatcher(
        std::io::stdin(),
        SharedWrite(shared_stdout),
        Some(Arc::new(CapabilityRpcDispatcher(rpc))),
    )
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::transport::InputOperationControl;
    use bbcom_plugin_contracts::generated_v2::{
        CommandInvocation, HandleEventRequest, Handshake, HostContext, HostHello,
        InitializeRequest, PluginEvent, PluginIdentity, RunCommandRequest, envelope, handshake,
        plugin_event,
    };
    use bbcom_plugin_contracts::v2::{MIN_PROTOCOL_MINOR, WIT_PACKAGE, default_resource_limits};

    #[derive(Default)]
    struct FakeRuntime {
        calls: Vec<&'static str>,
    }

    impl PluginExecutor for FakeRuntime {
        fn initialize_v2(&mut self, _: wit::HostContext) -> Result<wit::PluginModel> {
            self.calls.push("initialize");
            Ok(wit::PluginModel {
                surfaces: Vec::new(),
                commands: Vec::new(),
            })
        }

        fn handle_event_v2(&mut self, _: wit::PluginEvent) -> Result<wit::EventResult> {
            self.calls.push("event");
            Ok(wit::EventResult { accepted: true })
        }

        fn run_command_v2(&mut self, _: wit::CommandInvocation) -> Result<wit::CommandResult> {
            self.calls.push("command");
            Ok(wit::CommandResult {
                message: "ok".to_owned(),
            })
        }

        fn migrate_state_v2(&mut self, _: &str, state: &[u8]) -> Result<wit::MigratedState> {
            self.calls.push("migrate");
            Ok(wit::MigratedState {
                schema_version: 2,
                state: state.to_vec(),
            })
        }

        fn shutdown(&mut self) -> Result<()> {
            self.calls.push("shutdown");
            Ok(())
        }
    }

    fn expectation() -> HandshakeExpectation {
        HandshakeExpectation::new(
            "dev.bbcom.fixture",
            "2.0.0",
            "a".repeat(64),
            "workspace-1",
            "1",
            1,
            [Capability::UiWorkspace],
        )
    }

    fn establish(sidecar: &mut Sidecar<FakeRuntime>) {
        let expected = expectation();
        sidecar
            .handshake
            .accept(
                Envelope {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: MAX_PROTOCOL_MINOR,
                    message_id: 1,
                    reply_to: None,
                    payload: Some(envelope::Payload::Handshake(Handshake {
                        hello: Some(handshake::Hello::Host(HostHello {
                            protocol_major: PROTOCOL_MAJOR,
                            min_minor: MIN_PROTOCOL_MINOR,
                            max_minor: MAX_PROTOCOL_MINOR,
                            wit_package: WIT_PACKAGE.to_owned(),
                            plugin: Some(PluginIdentity {
                                plugin_id: expected.plugin_id,
                                plugin_version: expected.plugin_version,
                                component_sha256: expected.component_sha256,
                            }),
                            granted_capabilities: vec![Capability::UiWorkspace as i32],
                            limits: Some(default_resource_limits()),
                            workspace_id: expected.workspace_id,
                            instance_id: expected.instance_id,
                            generation: expected.generation,
                        })),
                    })),
                },
                Instant::now(),
                1,
            )
            .unwrap();
    }

    fn request(message_id: u64, operation: request::Operation) -> Envelope {
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

    fn dispatch(sidecar: &mut Sidecar<FakeRuntime>, envelope: Envelope) -> Option<SidecarExit> {
        let mut bytes = Vec::new();
        let mut writer = FrameWriter::new(&mut bytes);
        sidecar.dispatch(envelope, &mut writer).unwrap()
    }

    fn initialize(message_id: u64) -> Envelope {
        request(
            message_id,
            request::Operation::Initialize(InitializeRequest {
                context: Some(HostContext {
                    workspace_id: "workspace-1".to_owned(),
                    plugin_id: "dev.bbcom.fixture".to_owned(),
                    instance_id: "1".to_owned(),
                    generation: 1,
                    locale: "en-US".to_owned(),
                    theme: wire::ColorScheme::System as i32,
                    granted_capabilities: vec![Capability::UiWorkspace as i32],
                    limits: Some(default_resource_limits()),
                    sessions: Vec::new(),
                }),
            }),
        )
    }

    #[test]
    fn migrate_precedes_single_initialize_then_events_and_commands_are_sequenced() {
        let mut sidecar = Sidecar::new(FakeRuntime::default(), expectation());
        establish(&mut sidecar);
        dispatch(
            &mut sidecar,
            request(
                2,
                request::Operation::MigrateState(wire::MigrateStateRequest {
                    previous_api: "bbcom:plugin@2.0.0".to_owned(),
                    state_schema_version: 1,
                    state: vec![7],
                }),
            ),
        );
        dispatch(&mut sidecar, initialize(3));
        // A second initialize is rejected before reaching the guest.
        dispatch(&mut sidecar, initialize(4));
        dispatch(
            &mut sidecar,
            request(
                5,
                request::Operation::HandleEvent(HandleEventRequest {
                    event: Some(PluginEvent {
                        item: Some(plugin_event::Item::PortCatalogChanged(
                            wire::PortCatalogChangedEvent {},
                        )),
                    }),
                }),
            ),
        );
        dispatch(
            &mut sidecar,
            request(
                6,
                request::Operation::RunCommand(RunCommandRequest {
                    invocation: Some(CommandInvocation {
                        command_id: "fixture.run".to_owned(),
                        invocation_id: "invocation-1".to_owned(),
                        arguments: Vec::new(),
                    }),
                }),
            ),
        );
        assert_eq!(
            sidecar.runtime.calls,
            ["migrate", "initialize", "event", "command"]
        );
    }

    #[test]
    fn shutdown_runs_once_and_closes_the_sidecar() {
        let mut sidecar = Sidecar::new(FakeRuntime::default(), expectation());
        establish(&mut sidecar);
        dispatch(&mut sidecar, initialize(2));
        assert_eq!(
            dispatch(
                &mut sidecar,
                request(3, request::Operation::Shutdown(wire::ShutdownRequest {})),
            ),
            Some(SidecarExit::ShutdownRequested)
        );
        assert_eq!(sidecar.runtime.calls, ["initialize", "shutdown"]);
        sidecar.best_effort_shutdown();
        assert_eq!(sidecar.runtime.calls, ["initialize", "shutdown"]);
    }

    struct InterruptFlag(AtomicBool);
    impl PluginInterrupt for InterruptFlag {
        fn interrupt(&self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn one_guest_task_is_admitted_and_cancel_interrupts_the_exact_task() {
        let operations = ActiveOperations::default();
        assert!(operations.register(10));
        assert!(!operations.register(11), "second guest task must be busy");
        let interrupted = Arc::new(InterruptFlag(AtomicBool::new(false)));
        let guard = operations.attach(10, Some(interrupted.clone()));
        assert!(!operations.cancel(11));
        assert!(operations.cancel(10));
        assert!(interrupted.0.load(Ordering::Acquire));
        assert!(guard.finish());
        assert!(operations.register(11), "cancelled task releases the slot");
    }
}

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
    granted: BTreeSet<Capability>,
    workspace_id: String,
    instance_id: String,
    generation: u64,
}
impl LaunchArguments {
    fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self> {
        let mut arguments = arguments.into_iter();
        let mut package_root = None;
        let mut granted = BTreeSet::new();
        let mut workspace_id = None;
        let mut instance_id = None;
        let mut generation = None;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--package-root" => package_root = arguments.next().map(PathBuf::from),
                "--grant" => {
                    if let Some(value) = arguments.next()
                        && let Ok(capability) = parse_v2_capability(&value)
                    {
                        granted.insert(capability);
                    }
                }
                "--workspace-id" => workspace_id = arguments.next(),
                "--instance-id" => instance_id = arguments.next(),
                "--generation" => generation = arguments.next().and_then(|v| v.parse().ok()),
                // Unknown arguments (including retired sandbox/attestation
                // flags) are ignored.
                _ => {}
            }
        }
        Ok(Self {
            package_root: package_root.ok_or(HostError::InvalidArtifact)?,
            granted,
            workspace_id: workspace_id.unwrap_or_default(),
            instance_id: instance_id.unwrap_or_default(),
            generation: generation.unwrap_or(1),
        })
    }
}
