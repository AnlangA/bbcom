//! Main-window actions for protocol-v2 plugin surfaces and tasks.
//!
//! This is an injection boundary only: renderer commands cannot reach a
//! sidecar, window, or task directly. Production
//! composition installs one application service after every dependency has
//! passed its release gate; until then every action fails closed.

use std::sync::{Arc, Mutex};

use bbcom_contracts::{
    CancelPluginTaskRequestV2, EmitPluginSurfaceEventRequestV2, IpcError, PluginCommandResponse,
    PluginSnapshotRequest, PluginSurfacePlacement, RunPluginCommandRequestV2,
    SetPluginSurfacePlacementRequestV2,
};
use bbcom_plugin_contracts::generated_v2 as wire;
use bbcom_plugin_contracts::generated_v2::{envelope, plugin_event, request};
use bbcom_plugin_manager::HostFailure;

use crate::commands::plugin::{PluginCommand, PluginCommandService as IpcPluginCommandService};

use super::{
    PluginDetachedProjectionPortV2, PluginRuntimeLifecycle, PluginRuntimeProjectionV2,
    SharedNativePluginStatePersistencePort,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginUiActionV2 {
    EmitSurfaceEvent(EmitPluginSurfaceEventRequestV2),
    CancelTask(CancelPluginTaskRequestV2),
    RunCommand(RunPluginCommandRequestV2),
    SetSurfacePlacement(SetPluginSurfacePlacementRequestV2),
}

impl PluginUiActionV2 {
    #[must_use]
    pub fn correlation(&self) -> (&str, u64, &str) {
        match self {
            Self::EmitSurfaceEvent(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::CancelTask(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::RunCommand(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::SetSurfacePlacement(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
        }
    }
}

pub trait PluginUiActionServiceV2: Send + Sync + 'static {
    fn execute(&self, action: PluginUiActionV2) -> Result<PluginCommandResponse, IpcError>;
}

pub struct UnavailablePluginUiActionServiceV2;

impl PluginUiActionServiceV2 for UnavailablePluginUiActionServiceV2 {
    fn execute(&self, _action: PluginUiActionV2) -> Result<PluginCommandResponse, IpcError> {
        Err(IpcError::security_denied("plugin_v2_ui_action"))
    }
}

trait PluginPrivateStateUninstallPortV2: Send + Sync + 'static {
    fn stage_plugin_removal(&self, plugin_id: &str) -> Result<(), HostFailure>;
    fn cancel_plugin_removal(&self, plugin_id: &str) -> Result<(), HostFailure>;
    fn remove_plugin(&self, plugin_id: &str) -> Result<(), HostFailure>;
}

impl PluginPrivateStateUninstallPortV2 for SharedNativePluginStatePersistencePort {
    fn stage_plugin_removal(&self, plugin_id: &str) -> Result<(), HostFailure> {
        Self::stage_plugin_removal(self, plugin_id)
    }

    fn cancel_plugin_removal(&self, plugin_id: &str) -> Result<(), HostFailure> {
        Self::cancel_plugin_removal(self, plugin_id)
    }

    fn remove_plugin(&self, plugin_id: &str) -> Result<(), HostFailure> {
        Self::remove_plugin(self, plugin_id)
    }
}

/// Adds native v2 projections to every plugin-center response while leaving
/// the serialized lifecycle actor as the sole owner of install/enable state.
pub struct ProjectingPluginCommandServiceV2 {
    inner: Arc<dyn IpcPluginCommandService>,
    projection: Arc<PluginRuntimeProjectionV2>,
    detached: Arc<dyn PluginDetachedProjectionPortV2>,
    private_state: Arc<dyn PluginPrivateStateUninstallPortV2>,
}

impl ProjectingPluginCommandServiceV2 {
    #[must_use]
    pub fn new(
        inner: Arc<dyn IpcPluginCommandService>,
        projection: Arc<PluginRuntimeProjectionV2>,
        detached: Arc<dyn PluginDetachedProjectionPortV2>,
        private_state: Arc<SharedNativePluginStatePersistencePort>,
    ) -> Self {
        Self::new_with_private_state_port(inner, projection, detached, private_state)
    }

    fn new_with_private_state_port(
        inner: Arc<dyn IpcPluginCommandService>,
        projection: Arc<PluginRuntimeProjectionV2>,
        detached: Arc<dyn PluginDetachedProjectionPortV2>,
        private_state: Arc<dyn PluginPrivateStateUninstallPortV2>,
    ) -> Self {
        Self {
            inner,
            projection,
            detached,
            private_state,
        }
    }

    fn project(&self, response: &mut PluginCommandResponse) -> Result<(), IpcError> {
        let projection = self.projection.snapshot();
        match response {
            PluginCommandResponse::Completed { data, .. }
            | PluginCommandResponse::Cancelled {
                data: Some(data), ..
            }
            | PluginCommandResponse::Failed {
                data: Some(data), ..
            } => {
                let center_revision = data.revision;
                data.surfaces = Some(projection.surfaces.clone());
                data.tasks = Some(projection.tasks.clone());
                data.command_contributions = Some(projection.command_contributions.clone());
                self.detached
                    .sync(center_revision, &projection)
                    .map_err(|_| IpcError::security_denied("plugin_v2_detached_projection"))?;
            }
            PluginCommandResponse::Cancelled { data: None, .. }
            | PluginCommandResponse::Failed { data: None, .. } => {}
        }
        Ok(())
    }

    fn compensate_reversible_uninstall(&self, plugin_id: &str) -> Result<(), IpcError> {
        if self.private_state.cancel_plugin_removal(plugin_id).is_ok() {
            Ok(())
        } else {
            Err(private_state_uninstall_error())
        }
    }
}

impl IpcPluginCommandService for ProjectingPluginCommandServiceV2 {
    fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
        let uninstall = match &command {
            PluginCommand::Uninstall(request) => Some(request.plugin_id.clone()),
            _ => None,
        };
        let Some(plugin_id) = uninstall else {
            let mut response = self.inner.execute(command)?;
            self.project(&mut response)?;
            return Ok(response);
        };

        if self.private_state.stage_plugin_removal(&plugin_id).is_err() {
            self.compensate_reversible_uninstall(&plugin_id)?;
            return Err(private_state_uninstall_error());
        }
        let result = self.inner.execute(command);
        match result {
            Ok(mut response) if matches!(response, PluginCommandResponse::Completed { .. }) => {
                // The package is now irreversibly absent. The tombstone was
                // committed before dispatch, so a cleanup failure or crash
                // cannot expose old bytes to a same-ID reinstall.
                self.private_state
                    .remove_plugin(&plugin_id)
                    .map_err(|_| private_state_uninstall_error())?;
                self.project(&mut response)?;
                Ok(response)
            }
            Ok(mut response) => {
                self.compensate_reversible_uninstall(&plugin_id)?;
                self.project(&mut response)?;
                Ok(response)
            }
            // The adapter can fail while rendering the terminal snapshot
            // after the core has already removed the artifact. The physical
            // outcome is unknown, so never cancel the tombstone here.
            Err(error) => Err(error),
        }
    }
}

fn private_state_uninstall_error() -> IpcError {
    IpcError::new(
        bbcom_contracts::AppErrorCode::Busy,
        "error.busy",
        true,
        "plugin_private_state_cleanup",
    )
}

/// Main-window v2 action service, extended by the runtime presentation/task
/// router during native capability-gateway composition.
pub struct NativePluginUiActionServiceV2 {
    commands: Arc<dyn IpcPluginCommandService>,
    lifecycle: Arc<dyn PluginRuntimeLifecycle>,
    projection: Arc<PluginRuntimeProjectionV2>,
    detached: Arc<dyn PluginDetachedProjectionPortV2>,
}

impl NativePluginUiActionServiceV2 {
    #[must_use]
    pub fn new(
        commands: Arc<dyn IpcPluginCommandService>,
        lifecycle: Arc<dyn PluginRuntimeLifecycle>,
        projection: Arc<PluginRuntimeProjectionV2>,
        detached: Arc<dyn PluginDetachedProjectionPortV2>,
    ) -> Self {
        Self {
            commands,
            lifecycle,
            projection,
            detached,
        }
    }

    fn snapshot(
        &self,
        request_id: String,
        revision: u64,
        operation_id: String,
    ) -> Result<PluginCommandResponse, IpcError> {
        self.commands
            .execute(PluginCommand::Snapshot(PluginSnapshotRequest {
                request_id,
                revision,
                operation_id,
            }))
    }

    fn emit_surface_event(
        &self,
        request: EmitPluginSurfaceEventRequestV2,
    ) -> Result<PluginCommandResponse, IpcError> {
        let event = request.event;
        let interaction = self
            .projection
            .validate_surface_interaction(&event)
            .map_err(|_| IpcError::invalid_input("plugin_emit_surface_event_v2", "event"))?;
        if matches!(
            interaction,
            super::presentation_v2::ValidatedSurfaceInteractionV2::Action
        ) && self
            .projection
            .contains_command(&event.runtime, &event.node_id)
        {
            self.projection
                .begin_command_task(&event.runtime, &request.operation_id, &event.node_id)
                .map_err(|_| {
                    IpcError::invalid_input("plugin_emit_surface_event_v2", "commandId")
                })?;
            self.lifecycle
                .deliver_envelope(
                    &event.runtime.plugin_id,
                    envelope::Payload::Request(wire::Request {
                        operation: Some(request::Operation::RunCommand(wire::RunCommandRequest {
                            invocation: Some(wire::CommandInvocation {
                                command_id: event.node_id,
                                invocation_id: request.operation_id.clone(),
                                arguments: Vec::new(),
                            }),
                        })),
                    }),
                )
                .inspect_err(|_| {
                    let _ = self.projection.fail_started_task(
                        &event.runtime,
                        &request.operation_id,
                        wire::ErrorCode::Unavailable,
                    );
                    self.projection.notify_changed();
                })
                .map_err(|_| IpcError::security_denied("plugin_emit_surface_event_v2"))?;
            return self.snapshot(request.request_id, request.revision, request.operation_id);
        }
        let value = match interaction {
            super::presentation_v2::ValidatedSurfaceInteractionV2::Action => {
                wire::surface_interaction::Value::Action(wire::EmptyNode {})
            }
            super::presentation_v2::ValidatedSurfaceInteractionV2::Text(value) => {
                wire::surface_interaction::Value::Text(value)
            }
            super::presentation_v2::ValidatedSurfaceInteractionV2::Number(value) => {
                wire::surface_interaction::Value::Number(value)
            }
            super::presentation_v2::ValidatedSurfaceInteractionV2::Toggle(value) => {
                wire::surface_interaction::Value::Toggle(value)
            }
            super::presentation_v2::ValidatedSurfaceInteractionV2::Selection(value) => {
                wire::surface_interaction::Value::Selection(value)
            }
        };
        self.lifecycle
            .deliver_envelope(
                &event.runtime.plugin_id,
                envelope::Payload::Request(wire::Request {
                    operation: Some(request::Operation::HandleEvent(wire::HandleEventRequest {
                        event: Some(wire::PluginEvent {
                            item: Some(plugin_event::Item::Surface(wire::SurfaceInteraction {
                                surface_id: event.surface_id,
                                revision: event.revision,
                                node_id: event.node_id,
                                value: Some(value),
                            })),
                        }),
                    })),
                }),
            )
            .map_err(|_| IpcError::security_denied("plugin_emit_surface_event_v2"))?;
        self.snapshot(request.request_id, request.revision, request.operation_id)
    }

    fn cancel_task(
        &self,
        request: CancelPluginTaskRequestV2,
    ) -> Result<PluginCommandResponse, IpcError> {
        if !self
            .projection
            .contains_task(&request.runtime, &request.task_id)
        {
            return Err(IpcError::invalid_input("plugin_cancel_task_v2", "taskId"));
        }
        self.projection
            .mark_task_cancelling(&request.runtime, &request.task_id)
            .map_err(|_| IpcError::invalid_input("plugin_cancel_task_v2", "taskId"))?;
        let task_id = request.task_id.clone();
        self.lifecycle
            .deliver_envelope(
                &request.runtime.plugin_id,
                envelope::Payload::Request(wire::Request {
                    operation: Some(request::Operation::HandleEvent(wire::HandleEventRequest {
                        event: Some(wire::PluginEvent {
                            item: Some(plugin_event::Item::CancelTask(wire::CancelTaskEvent {
                                task_id: task_id.clone(),
                            })),
                        }),
                    })),
                }),
            )
            .inspect_err(|_| {
                let _ = self.projection.fail_started_task(
                    &request.runtime,
                    &task_id,
                    wire::ErrorCode::Unavailable,
                );
                self.projection.notify_changed();
            })
            .map_err(|_| IpcError::security_denied("plugin_cancel_task_v2"))?;
        self.snapshot(request.request_id, request.revision, request.operation_id)
    }

    fn run_command(
        &self,
        request: RunPluginCommandRequestV2,
    ) -> Result<PluginCommandResponse, IpcError> {
        if !self
            .projection
            .contains_command(&request.runtime, &request.command_id)
        {
            return Err(IpcError::invalid_input(
                "plugin_run_command_v2",
                "commandId",
            ));
        }
        self.projection
            .begin_command_task(&request.runtime, &request.operation_id, &request.command_id)
            .map_err(|_| IpcError::invalid_input("plugin_run_command_v2", "commandId"))?;
        self.lifecycle
            .deliver_envelope(
                &request.runtime.plugin_id,
                envelope::Payload::Request(wire::Request {
                    operation: Some(request::Operation::RunCommand(wire::RunCommandRequest {
                        invocation: Some(wire::CommandInvocation {
                            command_id: request.command_id,
                            invocation_id: request.operation_id.clone(),
                            arguments: Vec::new(),
                        }),
                    })),
                }),
            )
            .inspect_err(|_| {
                let _ = self.projection.fail_started_task(
                    &request.runtime,
                    &request.operation_id,
                    wire::ErrorCode::Unavailable,
                );
                self.projection.notify_changed();
            })
            .map_err(|_| IpcError::security_denied("plugin_run_command_v2"))?;
        self.snapshot(request.request_id, request.revision, request.operation_id)
    }

    fn set_surface_placement(
        &self,
        request: SetPluginSurfacePlacementRequestV2,
    ) -> Result<PluginCommandResponse, IpcError> {
        self.projection
            .set_surface_placement(&request.runtime, &request.surface_id, request.placement)
            .map_err(|_| IpcError::invalid_input("plugin_set_surface_placement_v2", "surface"))?;
        let projection = self.projection.snapshot();
        match request.placement {
            PluginSurfacePlacement::DetachedWindow => self
                .detached
                .open(
                    request.revision,
                    &request.runtime,
                    &request.surface_id,
                    &projection,
                )
                .map_err(|_| IpcError::security_denied("plugin_set_surface_placement_v2"))?,
            PluginSurfacePlacement::Workspace => self
                .detached
                .revoke_surface(&request.runtime, &request.surface_id),
        }
        self.snapshot(request.request_id, request.revision, request.operation_id)
    }
}

impl PluginUiActionServiceV2 for NativePluginUiActionServiceV2 {
    fn execute(&self, action: PluginUiActionV2) -> Result<PluginCommandResponse, IpcError> {
        match action {
            PluginUiActionV2::EmitSurfaceEvent(request) => self.emit_surface_event(request),
            PluginUiActionV2::CancelTask(request) => self.cancel_task(request),
            PluginUiActionV2::RunCommand(request) => self.run_command(request),
            PluginUiActionV2::SetSurfacePlacement(request) => self.set_surface_placement(request),
        }
    }
}

/// Process-lifetime holder swapped exactly when the v2 runtime is composed.
#[derive(Clone)]
pub struct PluginUiActionStateV2 {
    service: Arc<Mutex<Arc<dyn PluginUiActionServiceV2>>>,
}

impl PluginUiActionStateV2 {
    #[must_use]
    pub fn new(service: Arc<dyn PluginUiActionServiceV2>) -> Self {
        Self {
            service: Arc::new(Mutex::new(service)),
        }
    }

    #[must_use]
    pub fn current_service(&self) -> Arc<dyn PluginUiActionServiceV2> {
        Arc::clone(
            &*self
                .service
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    pub fn replace_service(&self, service: Arc<dyn PluginUiActionServiceV2>) {
        *self
            .service
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = service;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use bbcom_plugin_broker::{GatewayContext, PluginCapabilityGateway};
    use bbcom_plugin_contracts::generated_v2::{self as wire, request};

    use super::*;

    struct RejectLifecycle;

    impl PluginRuntimeLifecycle for RejectLifecycle {
        fn poll_host_exits(
            &self,
        ) -> Vec<Result<bbcom_plugin_manager::PluginSnapshot, super::super::PluginServiceError>>
        {
            Vec::new()
        }

        fn open_workspace(
            &self,
            _: String,
            _: Vec<bbcom_plugin_manager::WorkspacePluginBinding>,
            _: Vec<bbcom_plugin_manager::OpaqueProjectPluginState>,
        ) -> Result<(), super::super::PluginServiceError> {
            Err(super::super::PluginServiceError::StatePoisoned)
        }

        fn close_project(&self) -> Result<(), super::super::PluginServiceError> {
            Ok(())
        }
    }

    struct NoopSink;

    impl super::super::PluginCapabilityEventSinkV2 for NoopSink {
        fn emit_serial(
            &self,
            _: &bbcom_contracts::PluginSerialCapabilityInboundV2,
        ) -> Result<(), super::super::PluginCapabilitySinkErrorV2> {
            Err(super::super::PluginCapabilitySinkErrorV2)
        }
    }

    struct NoopDetached;

    impl PluginDetachedProjectionPortV2 for NoopDetached {
        fn sync(
            &self,
            _: u64,
            _: &super::super::PluginRuntimeProjectionSnapshotV2,
        ) -> Result<(), bbcom_contracts::PluginErrorCodeV2> {
            Ok(())
        }

        fn open(
            &self,
            _: u64,
            _: &bbcom_contracts::RuntimeInstanceKey,
            _: &str,
            _: &super::super::PluginRuntimeProjectionSnapshotV2,
        ) -> Result<(), bbcom_contracts::PluginErrorCodeV2> {
            Ok(())
        }

        fn revoke_surface(&self, _: &bbcom_contracts::RuntimeInstanceKey, _: &str) {}
        fn revoke_runtime(&self, _: &bbcom_contracts::RuntimeInstanceKey) {}
    }

    struct RecordingPrivateStateUninstall {
        stage_fails: bool,
        cancel_fails: bool,
        remove_fails: bool,
        calls: Mutex<Vec<&'static str>>,
    }

    impl RecordingPrivateStateUninstall {
        fn successful() -> Self {
            Self {
                stage_fails: false,
                cancel_fails: false,
                remove_fails: false,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl PluginPrivateStateUninstallPortV2 for RecordingPrivateStateUninstall {
        fn stage_plugin_removal(&self, _: &str) -> Result<(), HostFailure> {
            self.calls.lock().unwrap().push("stage-state");
            if self.stage_fails {
                Err(HostFailure::Initialization)
            } else {
                Ok(())
            }
        }

        fn cancel_plugin_removal(&self, _: &str) -> Result<(), HostFailure> {
            self.calls.lock().unwrap().push("cancel-state");
            if self.cancel_fails {
                Err(HostFailure::Initialization)
            } else {
                Ok(())
            }
        }

        fn remove_plugin(&self, _: &str) -> Result<(), HostFailure> {
            self.calls.lock().unwrap().push("remove-state");
            if self.remove_fails {
                Err(HostFailure::Initialization)
            } else {
                Ok(())
            }
        }
    }

    #[derive(Clone, Copy)]
    enum UninstallOutcome {
        Completed,
        Failed,
        Unknown,
    }

    struct RecordingUninstallService {
        calls: AtomicUsize,
        outcome: UninstallOutcome,
    }

    impl IpcPluginCommandService for RecordingUninstallService {
        fn execute(&self, _: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.outcome {
                UninstallOutcome::Completed => Ok(PluginCommandResponse::Completed {
                    request_id: "request-uninstall".to_owned(),
                    operation_id: "operation-uninstall".to_owned(),
                    revision: 1,
                    data: empty_center_data(),
                }),
                UninstallOutcome::Failed => Ok(PluginCommandResponse::Failed {
                    request_id: "request-uninstall".to_owned(),
                    operation_id: "operation-uninstall".to_owned(),
                    revision: 1,
                    failure: bbcom_contracts::PluginFailure {
                        code: bbcom_contracts::PluginFailureCode::InstallationFailed,
                    },
                    data: None,
                }),
                UninstallOutcome::Unknown => Err(IpcError::new(
                    bbcom_contracts::AppErrorCode::Busy,
                    "error.busy",
                    true,
                    "test_unknown_uninstall",
                )),
            }
        }
    }

    fn empty_center_data() -> bbcom_contracts::PluginCenterData {
        bbcom_contracts::PluginCenterData {
            revision: 1,
            catalog: Vec::new(),
            installed: Vec::new(),
            sources: Vec::new(),
            surfaces: None,
            tasks: None,
            command_contributions: None,
        }
    }

    fn uninstall_command() -> PluginCommand {
        PluginCommand::Uninstall(bbcom_contracts::UninstallPluginRequest {
            request_id: "request-uninstall".to_owned(),
            revision: 0,
            operation_id: "operation-uninstall".to_owned(),
            plugin_id: "dev.bbcom.fixture".to_owned(),
            contribution_disposition: bbcom_contracts::PluginContributionDisposition::Delete,
        })
    }

    fn projecting_uninstall_service_with_state(
        inner: Arc<RecordingUninstallService>,
        private_state: Arc<RecordingPrivateStateUninstall>,
    ) -> ProjectingPluginCommandServiceV2 {
        ProjectingPluginCommandServiceV2::new_with_private_state_port(
            inner,
            Arc::new(PluginRuntimeProjectionV2::default()),
            Arc::new(NoopDetached),
            private_state,
        )
    }

    fn runtime() -> bbcom_contracts::RuntimeInstanceKey {
        bbcom_contracts::RuntimeInstanceKey {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.fixture".to_owned(),
            instance_id: 7,
            generation: 7,
        }
    }

    fn reject_delivery_service() -> (
        NativePluginUiActionServiceV2,
        Arc<PluginRuntimeProjectionV2>,
    ) {
        let projection = Arc::new(PluginRuntimeProjectionV2::default());
        let gateway = super::super::NativePluginCapabilityGatewayV2::new(
            Arc::new(NoopSink),
            Arc::new(super::super::SerialCapabilityCorrelationRegistryV2::default()),
            Arc::clone(&projection),
            Arc::new(super::super::PluginFileGrantService::default()),
        );
        gateway
            .invoke(
                &GatewayContext {
                    workspace_id: "workspace-1".to_owned(),
                    plugin_id: "dev.bbcom.fixture".to_owned(),
                    instance_id: "7".to_owned(),
                    generation: 7,
                    granted_capabilities: BTreeSet::from([wire::Capability::UiWorkspace]),
                },
                1,
                request::Operation::RegisterCommand(wire::RegisterCommandRequest {
                    command: Some(wire::CommandContribution {
                        command_id: "status".to_owned(),
                        title: "Status".to_owned(),
                        description: String::new(),
                        long_running: false,
                        confirmation: None,
                    }),
                }),
            )
            .unwrap();
        let service = NativePluginUiActionServiceV2::new(
            Arc::new(crate::commands::plugin::UnavailablePluginCommandService),
            Arc::new(RejectLifecycle),
            Arc::clone(&projection),
            Arc::new(NoopDetached),
        );
        (service, projection)
    }

    #[test]
    fn unavailable_boundary_fails_closed_without_a_runtime() {
        let state = PluginUiActionStateV2::new(Arc::new(UnavailablePluginUiActionServiceV2));
        let action = PluginUiActionV2::RunCommand(RunPluginCommandRequestV2 {
            request_id: "request-1".to_owned(),
            revision: 0,
            operation_id: "operation-1".to_owned(),
            runtime: bbcom_contracts::RuntimeInstanceKey {
                workspace_id: "workspace-1".to_owned(),
                plugin_id: "dev.bbcom.mcumgr".to_owned(),
                instance_id: 1,
                generation: 1,
            },
            command_id: "image-state".to_owned(),
        });
        let error = state.current_service().execute(action).unwrap_err();
        assert_eq!(error.code, bbcom_contracts::AppErrorCode::SecurityDenied);
    }

    #[test]
    fn command_and_cancel_delivery_failures_leave_typed_terminal_tasks() {
        let (service, projection) = reject_delivery_service();
        let runtime = runtime();
        let run = RunPluginCommandRequestV2 {
            request_id: "request-1".to_owned(),
            revision: 0,
            operation_id: "operation-1".to_owned(),
            runtime: runtime.clone(),
            command_id: "status".to_owned(),
        };
        assert!(service.run_command(run).is_err());
        let task = projection
            .snapshot()
            .tasks
            .into_iter()
            .find(|task| task.task_id == "operation-1")
            .unwrap();
        assert_eq!(task.status, bbcom_contracts::PluginTaskStatusV2::Failed);
        assert_eq!(
            task.failure.unwrap().code,
            bbcom_contracts::PluginErrorCodeV2::Unavailable
        );

        projection
            .begin_command_task(&runtime, "operation-2", "status")
            .unwrap();
        assert!(
            service
                .cancel_task(CancelPluginTaskRequestV2 {
                    request_id: "request-2".to_owned(),
                    revision: 0,
                    operation_id: "cancel-2".to_owned(),
                    runtime,
                    task_id: "operation-2".to_owned(),
                })
                .is_err()
        );
        let task = projection
            .snapshot()
            .tasks
            .into_iter()
            .find(|task| task.task_id == "operation-2")
            .unwrap();
        assert_eq!(task.status, bbcom_contracts::PluginTaskStatusV2::Failed);
        assert_eq!(
            task.failure.unwrap().code,
            bbcom_contracts::PluginErrorCodeV2::Unavailable
        );
    }

    #[test]
    fn artifact_uninstall_failure_cancels_the_private_state_tombstone() {
        let inner = Arc::new(RecordingUninstallService {
            calls: AtomicUsize::new(0),
            outcome: UninstallOutcome::Failed,
        });
        let private_state = Arc::new(RecordingPrivateStateUninstall::successful());
        let service =
            projecting_uninstall_service_with_state(Arc::clone(&inner), Arc::clone(&private_state));

        assert!(matches!(
            service.execute(uninstall_command()).unwrap(),
            PluginCommandResponse::Failed { .. }
        ));
        assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
        assert_eq!(private_state.calls(), ["stage-state", "cancel-state"]);
    }

    #[test]
    fn successful_uninstall_removes_private_state() {
        let inner = Arc::new(RecordingUninstallService {
            calls: AtomicUsize::new(0),
            outcome: UninstallOutcome::Completed,
        });
        let private_state = Arc::new(RecordingPrivateStateUninstall::successful());
        let service =
            projecting_uninstall_service_with_state(Arc::clone(&inner), Arc::clone(&private_state));

        assert!(matches!(
            service.execute(uninstall_command()).unwrap(),
            PluginCommandResponse::Completed { .. }
        ));
        assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
        assert_eq!(private_state.calls(), ["stage-state", "remove-state"]);
    }

    #[test]
    fn private_cleanup_failure_after_artifact_removal_fails_closed() {
        let inner = Arc::new(RecordingUninstallService {
            calls: AtomicUsize::new(0),
            outcome: UninstallOutcome::Completed,
        });
        let private_state = Arc::new(RecordingPrivateStateUninstall {
            stage_fails: false,
            cancel_fails: false,
            remove_fails: true,
            calls: Mutex::new(Vec::new()),
        });
        let service =
            projecting_uninstall_service_with_state(Arc::clone(&inner), Arc::clone(&private_state));

        assert!(service.execute(uninstall_command()).is_err());
        assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
        assert_eq!(private_state.calls(), ["stage-state", "remove-state"]);
    }

    #[test]
    fn unknown_artifact_outcome_keeps_the_durable_tombstone() {
        let inner = Arc::new(RecordingUninstallService {
            calls: AtomicUsize::new(0),
            outcome: UninstallOutcome::Unknown,
        });
        let private_state = Arc::new(RecordingPrivateStateUninstall::successful());
        let service =
            projecting_uninstall_service_with_state(Arc::clone(&inner), Arc::clone(&private_state));

        assert!(service.execute(uninstall_command()).is_err());
        assert_eq!(private_state.calls(), ["stage-state"]);
    }
}
