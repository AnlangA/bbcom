//! Process-lifetime single owner for plugin runtime mutations.
//!
//! Tauri commands, workspace transitions and host-exit polling communicate
//! through this bounded mailbox. The adapter and lifecycle service never
//! escape the actor thread, so their internal synchronous APIs cannot be
//! raced by renderer commands or native supervisors.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;

use bbcom_contracts::{
    AppErrorCode, IpcError, PluginCommandResponse, PluginContributionDisposition,
};
use bbcom_plugin_manager::{OpaqueProjectPluginState, PluginSnapshot, WorkspacePluginBinding};

use crate::commands::plugin::{PluginCommand, PluginCommandService};

use super::bootstrap::PluginRuntimeLifecycle;
use super::command_adapter::NativePluginCommandAdapter;
use super::service::PluginServiceError;

const ACTOR_MAILBOX_CAPACITY: usize = 256;

pub trait PluginWorkspaceBindingPort: Send + Sync + 'static {
    fn set_expected_enabled(&self, plugin_id: &str, expected_enabled: bool) -> Result<(), ()>;
    fn uninstall_with_contribution_cleanup(
        &self,
        plugin_id: &str,
        disposition: PluginContributionDisposition,
        uninstall: &mut dyn FnMut() -> bool,
    ) -> Result<bool, ()>;
    fn recover_contribution_uninstall(
        &self,
        installed_plugin_ids: &BTreeSet<String>,
    ) -> Result<(), ()>;
}

enum PluginRuntimeMessage {
    Execute {
        command: PluginCommand,
        reply: SyncSender<Result<PluginCommandResponse, IpcError>>,
    },
    /// Push a protocol-v2 event/cancel/stream payload into a sidecar.
    DeliverEnvelope {
        plugin_id: String,
        payload: bbcom_plugin_contracts::generated_v2::envelope::Payload,
        reply: SyncSender<Result<(), PluginServiceError>>,
    },
    NotifyPortCatalogChanged {
        reply: SyncSender<Result<usize, PluginServiceError>>,
    },
    NotifyHostContextChanged {
        locale: Option<String>,
        theme: Option<bbcom_plugin_contracts::generated_v2::ColorScheme>,
        reply: SyncSender<Result<usize, PluginServiceError>>,
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
    fn deliver_envelope(
        &self,
        plugin_id: &str,
        payload: bbcom_plugin_contracts::generated_v2::envelope::Payload,
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

    fn notify_port_catalog_changed(&self) -> Result<usize, PluginServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::NotifyPortCatalogChanged { reply }) {
            return Err(PluginServiceError::StatePoisoned);
        }
        response
            .recv()
            .unwrap_or(Err(PluginServiceError::StatePoisoned))
    }

    fn notify_host_context_changed(
        &self,
        locale: Option<String>,
        theme: Option<bbcom_plugin_contracts::generated_v2::ColorScheme>,
    ) -> Result<usize, PluginServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        if !self.send(PluginRuntimeMessage::NotifyHostContextChanged {
            locale,
            theme,
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
            PluginRuntimeMessage::DeliverEnvelope {
                plugin_id,
                payload,
                reply,
            } => {
                let _ = reply.send(lifecycle.deliver_envelope(&plugin_id, payload));
            }
            PluginRuntimeMessage::NotifyPortCatalogChanged { reply } => {
                let _ = reply.send(lifecycle.notify_port_catalog_changed());
            }
            PluginRuntimeMessage::NotifyHostContextChanged {
                locale,
                theme,
                reply,
            } => {
                let _ = reply.send(lifecycle.notify_host_context_changed(locale, theme));
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
