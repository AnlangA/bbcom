//! Least-privilege detached windows for host-rendered plugin surfaces.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use bbcom_contracts::{
    AppErrorCode, CancelPluginTaskRequestV2, EmitPluginSurfaceEventRequestV2, IpcError,
    PluginDetachedSurfaceEventRequestV2, PluginDetachedSurfaceViewV2,
    PluginDetachedTaskCancelRequestV2, PluginSurfaceEventV2, RuntimeInstanceKey,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::validate_detached_surface_view_v2;

pub const PLUGIN_DETACHED_SURFACE_UPDATE_EVENT_V2: &str = "plugin-detached-surface-update-v2";
const MAX_DETACHED_PLUGIN_WINDOWS: usize = 8;
const TOKEN_BYTES: usize = 32;

#[derive(Clone)]
struct DetachedSurfaceRecord {
    token: String,
    label: String,
    surface_key: String,
    view: PluginDetachedSurfaceViewV2,
}

#[derive(Default)]
struct DetachedSurfaceState {
    by_token: HashMap<String, DetachedSurfaceRecord>,
    token_by_surface: HashMap<String, String>,
}

/// Narrow callback installed by the application composition root. Closing a
/// detached editor must revoke any serial lease owned by that exact runtime,
/// without granting the window a serial command or tearing down unrelated
/// plugin projections.
pub trait PluginDetachedSerialRevocationPortV2: Send + Sync + 'static {
    fn revoke_serial_runtime(&self, runtime: &RuntimeInstanceKey);
}

/// Process-lifetime owner of detached surface grants. Tokens are memory-only,
/// bound to one exact Tauri window label and one runtime generation.
pub struct PluginDetachedWindowServiceV2 {
    state: Mutex<DetachedSurfaceState>,
    serial_revoker: Mutex<Option<std::sync::Arc<dyn PluginDetachedSerialRevocationPortV2>>>,
    next_label: AtomicU64,
    next_action: AtomicU64,
}

impl Default for PluginDetachedWindowServiceV2 {
    fn default() -> Self {
        Self {
            state: Mutex::new(DetachedSurfaceState::default()),
            serial_revoker: Mutex::new(None),
            next_label: AtomicU64::new(1),
            next_action: AtomicU64::new(1),
        }
    }
}

impl PluginDetachedWindowServiceV2 {
    pub fn install_serial_revoker(
        &self,
        revoker: std::sync::Arc<dyn PluginDetachedSerialRevocationPortV2>,
    ) {
        *self
            .serial_revoker
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(revoker);
    }

    /// Opens or focuses the single editor for a detached surface.
    pub fn open<R: tauri::Runtime>(
        self: &std::sync::Arc<Self>,
        app: &AppHandle<R>,
        view: PluginDetachedSurfaceViewV2,
    ) -> Result<(), IpcError> {
        const OPERATION: &str = "plugin_open_detached_surface_v2";
        validate_detached_surface_view_v2(&view)
            .map_err(|field| IpcError::invalid_input(OPERATION, field))?;
        let record = self.issue(view)?;
        if let Some(window) = app.get_webview_window(&record.label) {
            window.show().map_err(|_| unavailable(OPERATION))?;
            let _ = window.set_focus();
            return Ok(());
        }
        let url = format!("index.html?window=plugin&token={}", record.token);
        let window = WebviewWindowBuilder::new(app, &record.label, WebviewUrl::App(url.into()))
            .title(record.view.surface.title.clone())
            .inner_size(920.0, 720.0)
            .min_inner_size(520.0, 360.0)
            .resizable(true)
            .maximizable(true)
            .minimizable(true)
            .decorations(true)
            .visible(true)
            .build()
            .map_err(|_| {
                self.take_by_label(&record.label);
                unavailable(OPERATION)
            })?;
        let service = std::sync::Arc::clone(self);
        let label = record.label;
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed)
                && let Some(runtime) = service
                    .take_by_label(&label)
                    .map(|record| record.view.surface.runtime)
            {
                service.revoke_serial_runtime(&runtime);
            }
        });
        Ok(())
    }

    #[must_use]
    pub fn snapshot(&self, window_label: &str, token: &str) -> Option<PluginDetachedSurfaceViewV2> {
        let state = self.lock();
        state
            .by_token
            .get(token)
            .filter(|record| record.label == window_label)
            .map(|record| record.view.clone())
    }

    /// Resolves a renderer interaction through its unforgeable window grant.
    /// Runtime, surface and center correlation are always taken from the
    /// native snapshot rather than accepted from the detached WebView.
    pub fn surface_action(
        &self,
        window_label: &str,
        request: &PluginDetachedSurfaceEventRequestV2,
    ) -> Result<EmitPluginSurfaceEventRequestV2, IpcError> {
        const OPERATION: &str = "plugin_detached_emit_surface_event_v2";
        let record = self.authorized_record(window_label, &request.token, OPERATION)?;
        super::validate_detached_surface_interaction_v2(&record.view.surface, request)
            .map_err(|field| IpcError::invalid_input(OPERATION, field))?;
        let sequence = self.next_action_sequence(OPERATION)?;
        Ok(EmitPluginSurfaceEventRequestV2 {
            request_id: format!("detached-event-{sequence}"),
            revision: record.view.center_revision,
            operation_id: format!("detached-event-{sequence}"),
            event: PluginSurfaceEventV2 {
                runtime: record.view.surface.runtime,
                surface_id: record.view.surface.surface_id,
                revision: request.surface_revision,
                node_id: request.node_id.clone(),
                event: request.event,
                value: request.value.clone(),
            },
        })
    }

    /// Resolves a task cancellation through the same exact window grant.
    pub fn task_cancel_action(
        &self,
        window_label: &str,
        request: &PluginDetachedTaskCancelRequestV2,
    ) -> Result<CancelPluginTaskRequestV2, IpcError> {
        const OPERATION: &str = "plugin_detached_cancel_task_v2";
        let record = self.authorized_record(window_label, &request.token, OPERATION)?;
        let task = record
            .view
            .tasks
            .iter()
            .find(|task| task.task_id == request.task_id && task.cancellable)
            .ok_or_else(|| IpcError::invalid_input(OPERATION, "taskId"))?;
        let sequence = self.next_action_sequence(OPERATION)?;
        Ok(CancelPluginTaskRequestV2 {
            request_id: format!("detached-cancel-{sequence}"),
            revision: record.view.center_revision,
            operation_id: format!("detached-cancel-{sequence}"),
            runtime: task.runtime.clone(),
            task_id: task.task_id.clone(),
        })
    }

    /// Publishes a newer projection to the bound window. Stale revisions and
    /// identity changes revoke the attempted update instead of weakening the
    /// existing grant.
    pub fn update<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        view: PluginDetachedSurfaceViewV2,
    ) -> Result<bool, IpcError> {
        const OPERATION: &str = "plugin_update_detached_surface_v2";
        validate_detached_surface_view_v2(&view)
            .map_err(|field| IpcError::invalid_input(OPERATION, field))?;
        let key = surface_key(&view.surface.runtime, &view.surface.surface_id);
        let (label, projected) = {
            let mut state = self.lock();
            let Some(token) = state.token_by_surface.get(&key).cloned() else {
                return Ok(false);
            };
            let Some(record) = state.by_token.get_mut(&token) else {
                state.token_by_surface.remove(&key);
                return Ok(false);
            };
            if view.surface.revision < record.view.surface.revision
                || view.center_revision < record.view.center_revision
            {
                return Err(IpcError::new(
                    AppErrorCode::RevisionConflict,
                    "error.revision_conflict",
                    true,
                    OPERATION,
                ));
            }
            record.view = view;
            (record.label.clone(), record.view.clone())
        };
        app.emit_to(&label, PLUGIN_DETACHED_SURFACE_UPDATE_EVENT_V2, projected)
            .map_err(|_| unavailable(OPERATION))?;
        Ok(true)
    }

    pub fn revoke_runtime(&self, runtime: &RuntimeInstanceKey) -> Vec<String> {
        let mut state = self.lock();
        let tokens = state
            .by_token
            .iter()
            .filter_map(|(token, record)| {
                (record.view.surface.runtime == *runtime).then_some(token.clone())
            })
            .collect::<Vec<_>>();
        tokens
            .into_iter()
            .filter_map(|token| remove_token(&mut state, &token).map(|record| record.label))
            .collect()
    }

    pub fn revoke_surface(&self, runtime: &RuntimeInstanceKey, surface_id: &str) -> Option<String> {
        let key = surface_key(runtime, surface_id);
        let mut state = self.lock();
        let token = state.token_by_surface.get(&key)?.clone();
        remove_token(&mut state, &token).map(|record| record.label)
    }

    pub fn revoke_all(&self) -> Vec<String> {
        let mut state = self.lock();
        let labels = state
            .by_token
            .values()
            .map(|record| record.label.clone())
            .collect();
        *state = DetachedSurfaceState::default();
        labels
    }

    fn issue(&self, view: PluginDetachedSurfaceViewV2) -> Result<DetachedSurfaceRecord, IpcError> {
        const OPERATION: &str = "plugin_open_detached_surface_v2";
        let key = surface_key(&view.surface.runtime, &view.surface.surface_id);
        let mut state = self.lock();
        if let Some(token) = state.token_by_surface.get(&key).cloned()
            && let Some(record) = state.by_token.get_mut(&token)
        {
            if view.surface.revision < record.view.surface.revision
                || view.center_revision < record.view.center_revision
            {
                return Err(IpcError::new(
                    AppErrorCode::RevisionConflict,
                    "error.revision_conflict",
                    true,
                    OPERATION,
                ));
            }
            record.view = view;
            return Ok(record.clone());
        }
        if state.by_token.len() >= MAX_DETACHED_PLUGIN_WINDOWS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                OPERATION,
            )
            .with_size(
                MAX_DETACHED_PLUGIN_WINDOWS,
                state.by_token.len().saturating_add(1),
            ));
        }
        let token = random_token().map_err(|_| unavailable(OPERATION))?;
        let sequence = self.next_label.fetch_add(1, Ordering::AcqRel);
        if sequence == 0 {
            return Err(unavailable(OPERATION));
        }
        let label = format!("plugin-surface-{}-{sequence}", &token[..16]);
        let record = DetachedSurfaceRecord {
            token: token.clone(),
            label,
            surface_key: key.clone(),
            view,
        };
        state.token_by_surface.insert(key, token.clone());
        state.by_token.insert(token, record.clone());
        Ok(record)
    }

    fn take_by_label(&self, label: &str) -> Option<DetachedSurfaceRecord> {
        let mut state = self.lock();
        let token = state
            .by_token
            .iter()
            .find_map(|(token, record)| (record.label == label).then_some(token.clone()));
        token.and_then(|token| remove_token(&mut state, &token))
    }

    fn revoke_serial_runtime(&self, runtime: &RuntimeInstanceKey) {
        let revoker = self
            .serial_revoker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(revoker) = revoker {
            revoker.revoke_serial_runtime(runtime);
        }
    }

    fn authorized_record(
        &self,
        window_label: &str,
        token: &str,
        operation: &'static str,
    ) -> Result<DetachedSurfaceRecord, IpcError> {
        if !valid_token(token) {
            return Err(IpcError::security_denied(operation));
        }
        self.lock()
            .by_token
            .get(token)
            .filter(|record| record.label == window_label)
            .cloned()
            .ok_or_else(|| IpcError::security_denied(operation))
    }

    fn next_action_sequence(&self, operation: &'static str) -> Result<u64, IpcError> {
        let sequence = self.next_action.fetch_add(1, Ordering::AcqRel);
        if sequence == 0 || sequence > 9_007_199_254_740_991 {
            Err(unavailable(operation))
        } else {
            Ok(sequence)
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DetachedSurfaceState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn remove_token(state: &mut DetachedSurfaceState, token: &str) -> Option<DetachedSurfaceRecord> {
    let record = state.by_token.remove(token)?;
    if state
        .token_by_surface
        .get(&record.surface_key)
        .map(String::as_str)
        == Some(token)
    {
        state.token_by_surface.remove(&record.surface_key);
    }
    Some(record)
}

fn surface_key(runtime: &RuntimeInstanceKey, surface_id: &str) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}",
        runtime.workspace_id,
        runtime.plugin_id,
        runtime.instance_id,
        runtime.generation,
        surface_id
    )
}

fn random_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_BYTES * 2
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn unavailable(operation: &'static str) -> IpcError {
    IpcError::new(AppErrorCode::Busy, "error.busy", true, operation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bbcom_contracts::{
        PluginSurfacePlacement, PluginSurfaceSnapshot, PluginTextTone, PluginUiNode,
    };

    fn runtime(generation: u64) -> RuntimeInstanceKey {
        RuntimeInstanceKey {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.mcumgr".to_owned(),
            instance_id: 7,
            generation,
        }
    }

    fn view(generation: u64, revision: u64) -> PluginDetachedSurfaceViewV2 {
        PluginDetachedSurfaceViewV2 {
            center_revision: revision,
            surface: PluginSurfaceSnapshot {
                runtime: runtime(generation),
                surface_id: "overview".to_owned(),
                revision,
                title: "MCUmgr".to_owned(),
                placement: PluginSurfacePlacement::DetachedWindow,
                detached_allowed: true,
                editable: true,
                root: PluginUiNode::Text {
                    id: "status".to_owned(),
                    text: "Ready".to_owned(),
                    tone: PluginTextTone::Success,
                },
            },
            tasks: Vec::new(),
        }
    }

    #[test]
    fn token_is_window_and_generation_bound_with_single_editor() {
        let service = PluginDetachedWindowServiceV2::default();
        let first = service.issue(view(1, 1)).unwrap();
        let same = service.issue(view(1, 2)).unwrap();
        assert_eq!(first.token, same.token);
        assert_eq!(first.label, same.label);
        assert_eq!(
            service
                .snapshot(&first.label, &first.token)
                .unwrap()
                .center_revision,
            2
        );
        assert!(service.snapshot("main", &first.token).is_none());
        assert!(service.snapshot(&first.label, "0").is_none());

        let action = service
            .surface_action(
                &first.label,
                &PluginDetachedSurfaceEventRequestV2 {
                    token: first.token.clone(),
                    surface_revision: 2,
                    node_id: "status".to_owned(),
                    event: bbcom_contracts::PluginSurfaceEventKind::Activate,
                    value: None,
                },
            )
            .unwrap_err();
        assert_eq!(action.code, AppErrorCode::InvalidInput);

        let second_generation = service.issue(view(2, 1)).unwrap();
        assert_ne!(first.token, second_generation.token);
        assert_eq!(service.revoke_runtime(&runtime(1)), vec![first.label]);
        assert!(service.snapshot(&same.label, &same.token).is_none());
    }

    #[test]
    fn stale_update_and_non_detached_surface_are_rejected() {
        let service = PluginDetachedWindowServiceV2::default();
        service.issue(view(1, 2)).unwrap();
        assert!(service.issue(view(1, 1)).is_err());
        let mut invalid = view(1, 3);
        invalid.surface.placement = PluginSurfacePlacement::Workspace;
        assert!(validate_detached_surface_view_v2(&invalid).is_err());
    }

    #[test]
    fn detached_actions_take_identity_from_the_native_grant() {
        let service = PluginDetachedWindowServiceV2::default();
        let mut granted = view(1, 4);
        granted.tasks.push(bbcom_contracts::PluginTaskViewV2 {
            runtime: runtime(1),
            task_id: "upload".to_owned(),
            command_id: "image-upload".to_owned(),
            title: "Upload".to_owned(),
            status: bbcom_contracts::PluginTaskStatusV2::Running,
            completed: 1,
            total: 2,
            status_text: "Uploading".to_owned(),
            cancellable: true,
            failure: None,
        });
        granted.surface.root = PluginUiNode::Button {
            id: "refresh".to_owned(),
            label: "Refresh".to_owned(),
            disabled: false,
            dangerous: false,
            confirmation: None,
        };
        let record = service.issue(granted).unwrap();
        let event = service
            .surface_action(
                &record.label,
                &PluginDetachedSurfaceEventRequestV2 {
                    token: record.token.clone(),
                    surface_revision: 4,
                    node_id: "refresh".to_owned(),
                    event: bbcom_contracts::PluginSurfaceEventKind::Activate,
                    value: None,
                },
            )
            .unwrap();
        assert_eq!(event.event.runtime, runtime(1));
        assert_eq!(event.event.surface_id, "overview");
        assert_eq!(event.revision, 4);

        let cancel = service
            .task_cancel_action(
                &record.label,
                &PluginDetachedTaskCancelRequestV2 {
                    token: record.token,
                    task_id: "upload".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(cancel.runtime, runtime(1));
        assert_eq!(cancel.task_id, "upload");
    }

    #[test]
    fn destroyed_window_path_revokes_only_the_bound_runtime_serial_authority() {
        struct Revoker(AtomicU64);
        impl PluginDetachedSerialRevocationPortV2 for Revoker {
            fn revoke_serial_runtime(&self, runtime: &RuntimeInstanceKey) {
                self.0.store(runtime.generation, Ordering::Release);
            }
        }

        let service = PluginDetachedWindowServiceV2::default();
        let revoker = std::sync::Arc::new(Revoker(AtomicU64::new(0)));
        service.install_serial_revoker(revoker.clone());
        let record = service.issue(view(9, 1)).unwrap();
        let removed = service.take_by_label(&record.label).unwrap();
        service.revoke_serial_runtime(&removed.view.surface.runtime);
        assert_eq!(revoker.0.load(Ordering::Acquire), 9);
        assert!(service.snapshot(&record.label, &record.token).is_none());
    }
}
