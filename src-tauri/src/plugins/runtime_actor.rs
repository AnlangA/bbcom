//! Process-lifetime single owner for plugin runtime mutations.
//!
//! Tauri commands, workspace transitions and host-exit polling communicate
//! through this bounded mailbox. The adapter and lifecycle service never
//! escape the actor thread, so their internal synchronous APIs cannot be
//! raced by renderer commands or native supervisors.

use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;

use bbcom_contracts::{AppErrorCode, IpcError, PluginCommandResponse};
use bbcom_plugin_manager::{OpaqueProjectPluginState, PluginSnapshot, WorkspacePluginBinding};

use crate::commands::plugin::{PluginCommand, PluginCommandService};

use super::bootstrap::PluginRuntimeLifecycle;
use super::command_adapter::NativePluginCommandAdapter;
use super::service::PluginServiceError;

const ACTOR_MAILBOX_CAPACITY: usize = 256;

pub trait PluginWorkspaceBindingPort: Send + Sync + 'static {
    fn set_expected_enabled(&self, plugin_id: &str, expected_enabled: bool) -> Result<(), ()>;
}

enum PluginRuntimeMessage {
    Execute {
        command: PluginCommand,
        reply: SyncSender<Result<PluginCommandResponse, IpcError>>,
    },
    /// Trusted host ingress: a sidecar serial-write proposal awaiting user
    /// confirmation. Fire-and-forget from the host reader thread.
    RegisterProposal {
        event: bbcom_plugin_contracts::generated::SerialProposalEvent,
    },
    /// Push an unsolicited envelope (session-query data) into a sidecar.
    DeliverEnvelope {
        plugin_id: String,
        payload: bbcom_plugin_contracts::generated::envelope::Payload,
        reply: SyncSender<Result<(), PluginServiceError>>,
    },
    PollHostExits {
        reply: SyncSender<Vec<Result<PluginSnapshot, PluginServiceError>>>,
    },
    OpenWorkspace {
        workspace_id: String,
        bindings: Vec<WorkspacePluginBinding>,
        states: Vec<OpaqueProjectPluginState>,
        reply: SyncSender<Result<(), PluginServiceError>>,
    },
    CloseWorkspace {
        reply: SyncSender<Result<(), PluginServiceError>>,
    },
}

/// Cloneable proxy; all mutable plugin state remains on the actor thread.
#[derive(Clone)]
pub struct PluginRuntimeActorHandle {
    sender: SyncSender<PluginRuntimeMessage>,
}

impl PluginRuntimeActorHandle {
    /// Forward a sidecar serial-write proposal into the command service.
    /// Fire-and-forget: registration failures resolve the parked guest call
    /// via the sidecar's own TTL, so no reply channel is needed.
    pub fn register_proposal(&self, event: bbcom_plugin_contracts::generated::SerialProposalEvent) {
        let _ = self.send(PluginRuntimeMessage::RegisterProposal { event });
    }

    pub fn spawn(
        adapter: NativePluginCommandAdapter,
        lifecycle: Arc<dyn PluginRuntimeLifecycle>,
        workspace_bindings: Arc<dyn PluginWorkspaceBindingPort>,
    ) -> Result<Self, std::io::Error> {
        let (sender, receiver) = mpsc::sync_channel(ACTOR_MAILBOX_CAPACITY);
        thread::Builder::new()
            .name("bbcom-plugin-runtime".to_owned())
            .spawn(move || actor_loop(receiver, adapter, lifecycle, workspace_bindings))?;
        Ok(Self { sender })
    }

    fn send(&self, message: PluginRuntimeMessage) -> bool {
        self.sender.try_send(message).is_ok()
    }

    fn unavailable(operation: &'static str) -> IpcError {
        IpcError::new(
            AppErrorCode::Busy,
            "error.plugin_service_unavailable",
            true,
            operation,
        )
    }
}

impl PluginCommandService for PluginRuntimeActorHandle {
    fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::Execute { command, reply }) {
            return Err(Self::unavailable("plugin_command"));
        }
        response
            .recv()
            .map_err(|_| Self::unavailable("plugin_command"))?
    }
}

impl PluginRuntimeLifecycle for PluginRuntimeActorHandle {
    fn register_serial_proposal(
        &self,
        event: bbcom_plugin_contracts::generated::SerialProposalEvent,
    ) {
        PluginRuntimeActorHandle::register_proposal(self, event);
    }

    fn deliver_envelope(
        &self,
        plugin_id: &str,
        payload: bbcom_plugin_contracts::generated::envelope::Payload,
    ) -> Result<(), PluginServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::DeliverEnvelope {
            plugin_id: plugin_id.to_owned(),
            payload,
            reply,
        }) {
            return Err(PluginServiceError::StatePoisoned);
        }
        response
            .recv()
            .unwrap_or(Err(PluginServiceError::StatePoisoned))
    }

    fn poll_host_exits(&self) -> Vec<Result<PluginSnapshot, PluginServiceError>> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::PollHostExits { reply }) {
            return vec![Err(PluginServiceError::StatePoisoned)];
        }
        response
            .recv()
            .unwrap_or_else(|_| vec![Err(PluginServiceError::StatePoisoned)])
    }

    fn open_workspace(
        &self,
        workspace_id: String,
        bindings: Vec<WorkspacePluginBinding>,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<(), PluginServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::OpenWorkspace {
            workspace_id,
            bindings,
            states,
            reply,
        }) {
            return Err(PluginServiceError::StatePoisoned);
        }
        response
            .recv()
            .unwrap_or(Err(PluginServiceError::StatePoisoned))
    }

    fn close_project(&self) -> Result<(), PluginServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::CloseWorkspace { reply }) {
            return Err(PluginServiceError::StatePoisoned);
        }
        response
            .recv()
            .unwrap_or(Err(PluginServiceError::StatePoisoned))
    }
}

fn actor_loop(
    receiver: Receiver<PluginRuntimeMessage>,
    adapter: NativePluginCommandAdapter,
    lifecycle: Arc<dyn PluginRuntimeLifecycle>,
    workspace_bindings: Arc<dyn PluginWorkspaceBindingPort>,
) {
    while let Ok(message) = receiver.recv() {
        match message {
            PluginRuntimeMessage::Execute { command, reply } => {
                let binding_update = match &command {
                    PluginCommand::SetEnabled(request) => {
                        Some((request.plugin_id.clone(), request.enabled))
                    }
                    PluginCommand::Uninstall(request) => Some((request.plugin_id.clone(), false)),
                    _ => None,
                };
                let result = adapter.execute(command);
                let result = match (result, binding_update) {
                    (Ok(response), Some((plugin_id, expected_enabled))) => {
                        // The adapter already executed successfully; a failed
                        // binding bookkeeping write must not rewrite the
                        // response into an error (the plugin IS enabled or
                        // uninstalled). Log and let the next snapshot
                        // reconcile the persisted expectation.
                        if let Err(()) =
                            workspace_bindings.set_expected_enabled(&plugin_id, expected_enabled)
                        {
                            tracing::warn!(
                                "failed to persist expected_enabled={expected_enabled} \
                                 for plugin {plugin_id}; snapshot will reconcile"
                            );
                        }
                        Ok(response)
                    }
                    (result, _) => result,
                };
                let _ = reply.send(result);
            }
            PluginRuntimeMessage::RegisterProposal { event } => {
                adapter.register_serial_proposal(&event);
            }
            PluginRuntimeMessage::DeliverEnvelope {
                plugin_id,
                payload,
                reply,
            } => {
                let _ = reply.send(lifecycle.deliver_envelope(&plugin_id, payload));
            }
            PluginRuntimeMessage::PollHostExits { reply } => {
                let _ = reply.send(lifecycle.poll_host_exits());
            }
            PluginRuntimeMessage::OpenWorkspace {
                workspace_id,
                bindings,
                states,
                reply,
            } => {
                let _ = reply.send(lifecycle.open_workspace(workspace_id, bindings, states));
            }
            PluginRuntimeMessage::CloseWorkspace { reply } => {
                let _ = reply.send(lifecycle.close_project());
            }
        }
    }
}
