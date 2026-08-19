use std::fmt;
use std::sync::{Mutex, MutexGuard};

use bbcom_plugin_manager::{
    Clock, HostLauncher, InstallationPort, ManagerError, ManualPackageRequest,
    OpaqueProjectPluginState, PluginManager, PluginSnapshot,
};

use super::HostExitMonitor;

type LockedPluginManager<I, H, C> = PluginManager<I, H, C>;
type PluginManagerGuard<'a, I, H, C> =
    Result<MutexGuard<'a, LockedPluginManager<I, H, C>>, PluginServiceError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginServiceError {
    Manager(ManagerError),
    HostMonitorUnavailable,
    StatePoisoned,
}

impl fmt::Display for PluginServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Manager(error) => fmt::Display::fmt(error, formatter),
            Self::HostMonitorUnavailable => {
                formatter.write_str("plugin host monitor is unavailable")
            }
            Self::StatePoisoned => formatter.write_str("plugin application service is unavailable"),
        }
    }
}

impl std::error::Error for PluginServiceError {}

impl From<ManagerError> for PluginServiceError {
    fn from(error: ManagerError) -> Self {
        Self::Manager(error)
    }
}

/// Application-owned plugin lifecycle service.
///
/// The service is intentionally synchronous behind one mutex: lifecycle
/// transitions, host-exit reports and crash-loop rollback cannot race. Tauri
/// setup owns one instance for the entire process lifetime. No WebView command
/// receives this object or any contained filesystem path.
pub struct PluginService<I, H, C> {
    manager: Mutex<PluginManager<I, H, C>>,
    exits: HostExitMonitor,
}

impl<I, H, C> PluginService<I, H, C>
where
    I: InstallationPort,
    H: HostLauncher,
    C: Clock,
{
    #[must_use]
    pub fn new(manager: PluginManager<I, H, C>, exits: HostExitMonitor) -> Self {
        Self {
            manager: Mutex::new(manager),
            exits,
        }
    }

    pub fn observe_installed(
        &self,
        artifact: bbcom_plugin_manager::PluginArtifact,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.observe_installed(artifact)?)
    }

    pub fn open_project(
        &self,
        workspace_id: String,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<Vec<PluginSnapshot>, PluginServiceError> {
        Ok(self.lock()?.open_project(workspace_id, states)?)
    }

    pub fn open_workspace(
        &self,
        workspace_id: String,
        bindings: Vec<bbcom_plugin_manager::WorkspacePluginBinding>,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<Vec<PluginSnapshot>, PluginServiceError> {
        Ok(self
            .lock()?
            .open_workspace(workspace_id, bindings, states)?)
    }

    /// Enabling is an explicit native action. Declared, implemented
    /// capabilities are granted automatically by the manager.
    pub fn enable(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.enable(plugin_id)?)
    }

    pub fn disable(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.disable(plugin_id)?)
    }

    pub fn install_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.install_manual(request)?)
    }

    pub fn update_manual(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.begin_manual_upgrade(request)?)
    }

    pub fn install_local(
        &self,
        package_root: &std::path::Path,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.install_local(package_root)?)
    }

    pub fn uninstall(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.uninstall(plugin_id)?)
    }

    /// Push a protocol-v2 event/cancel/stream payload into a running sidecar.
    pub fn deliver_envelope(
        &self,
        plugin_id: &str,
        payload: bbcom_plugin_contracts::generated_v2::envelope::Payload,
    ) -> Result<(), PluginServiceError> {
        Ok(self.lock()?.deliver_envelope(plugin_id, payload)?)
    }

    pub fn notify_port_catalog_changed(&self) -> Result<usize, PluginServiceError> {
        Ok(self.lock()?.notify_port_catalog_changed()?)
    }

    pub fn notify_host_context_changed(
        &self,
        locale: Option<String>,
        theme: Option<bbcom_plugin_contracts::generated_v2::ColorScheme>,
    ) -> Result<usize, PluginServiceError> {
        Ok(self.lock()?.notify_host_context_changed(locale, theme)?)
    }

    pub fn begin_manual_upgrade(
        &self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.begin_manual_upgrade(request)?)
    }

    pub fn approve_pending_upgrade(
        &self,
        plugin_id: &str,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.complete_pending_upgrade(plugin_id)?)
    }

    pub fn cancel_pending_upgrade(
        &self,
        plugin_id: &str,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.cancel_pending_upgrade(plugin_id)?)
    }

    pub fn set_project_state(
        &self,
        state: OpaqueProjectPluginState,
    ) -> Result<Vec<OpaqueProjectPluginState>, PluginServiceError> {
        Ok(self.lock()?.set_project_state(state)?)
    }

    pub fn snapshots(&self) -> Result<Vec<PluginSnapshot>, PluginServiceError> {
        Ok(self.lock()?.snapshots())
    }

    pub fn workspace_id(&self) -> Result<Option<String>, PluginServiceError> {
        Ok(self.lock()?.workspace_id().map(str::to_owned))
    }

    /// Reaps each exited sidecar once, feeds the exact instance identity into
    /// the manager and lets its three-crash rollback policy decide the result.
    pub fn poll_host_exits(&self) -> Vec<Result<PluginSnapshot, PluginServiceError>> {
        let events = match self.exits.poll() {
            Ok(events) => events,
            Err(_) => return vec![Err(PluginServiceError::HostMonitorUnavailable)],
        };
        if events.is_empty() {
            return Vec::new();
        }
        let Ok(mut manager) = self.lock() else {
            return vec![Err(PluginServiceError::StatePoisoned)];
        };
        events
            .into_iter()
            .map(|event| {
                manager
                    .report_host_exit(&event.plugin_id, event.instance_id, event.report)
                    .map_err(PluginServiceError::from)
            })
            .collect()
    }

    /// Used by native project transitions and process shutdown. Closing a
    /// project force-stops every host and does not launch another one.
    pub fn close_project(&self) -> Result<(), PluginServiceError> {
        self.lock()?.close_project();
        Ok(())
    }

    fn lock(&self) -> PluginManagerGuard<'_, I, H, C> {
        self.manager
            .lock()
            .map_err(|_| PluginServiceError::StatePoisoned)
    }
}
