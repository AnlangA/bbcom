use std::fmt;
use std::sync::{Mutex, MutexGuard};

use bbcom_plugin_manager::{
    ArtifactRevocationStore, AuthorizationTarget, Clock, HostLauncher, InstallationPort,
    ManagerError, ManualPackageRequest, OpaqueProjectPluginState, PluginAuthorizationStore,
    PluginManager, PluginSnapshot,
};

use super::HostExitMonitor;

type LockedPluginManager<I, H, A, R, C> = PluginManager<I, H, A, R, C>;
type PluginManagerGuard<'a, I, H, A, R, C> =
    Result<MutexGuard<'a, LockedPluginManager<I, H, A, R, C>>, PluginServiceError>;

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
pub struct PluginService<I, H, A, R, C> {
    manager: Mutex<PluginManager<I, H, A, R, C>>,
    exits: HostExitMonitor,
}

impl<I, H, A, R, C> PluginService<I, H, A, R, C>
where
    I: InstallationPort,
    H: HostLauncher,
    A: PluginAuthorizationStore,
    R: ArtifactRevocationStore,
    C: Clock,
{
    #[must_use]
    pub fn new(manager: PluginManager<I, H, A, R, C>, exits: HostExitMonitor) -> Self {
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

    /// Project opening never calls this method. Enabling is an explicit native
    /// action after a current authorization receipt has been persisted.
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
        Ok(self.lock()?.approve_pending_upgrade(plugin_id)?)
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

    pub fn authorization_target(
        &self,
        plugin_id: &str,
    ) -> Result<AuthorizationTarget, PluginServiceError> {
        Ok(self.lock()?.authorization_target(plugin_id)?)
    }

    pub fn complete_authorization(
        &self,
        target: &AuthorizationTarget,
        approved: bool,
    ) -> Result<PluginSnapshot, PluginServiceError> {
        Ok(self.lock()?.complete_authorization(target, approved)?)
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

    fn lock(&self) -> PluginManagerGuard<'_, I, H, A, R, C> {
        self.manager
            .lock()
            .map_err(|_| PluginServiceError::StatePoisoned)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use bbcom_plugin_contracts::{AuthorizationKey, Permission};
    use bbcom_plugin_manager::{
        ArtifactRevocationStore, AuthorizationFailure, HostFailure, HostHandle, HostLaunchRequest,
        InstallationFailure, OpaqueProjectPluginState, PluginArtifact, PluginAuthorizationGrant,
        PreparedInstallation, RevocationFailure,
    };

    use super::*;

    struct FailingInstaller;

    impl InstallationPort for FailingInstaller {
        fn prepare_manual(
            &mut self,
            _request: &ManualPackageRequest,
            _current: Option<&PluginArtifact>,
        ) -> Result<PreparedInstallation, InstallationFailure> {
            Err(InstallationFailure)
        }

        fn prepare_rollback(
            &mut self,
            _current: &PluginArtifact,
        ) -> Result<Option<PreparedInstallation>, InstallationFailure> {
            Ok(None)
        }

        fn commit(
            &mut self,
            _prepared: &PreparedInstallation,
        ) -> Result<PluginArtifact, InstallationFailure> {
            Err(InstallationFailure)
        }

        fn discard(&mut self, _prepared: &PreparedInstallation) -> Result<(), InstallationFailure> {
            Ok(())
        }
    }

    struct FailingHost;

    impl HostLauncher for FailingHost {
        fn launch(&mut self, _request: &HostLaunchRequest) -> Result<HostHandle, HostFailure> {
            Err(HostFailure::Launch)
        }

        fn initialize(&mut self, _handle: &HostHandle) -> Result<(), HostFailure> {
            Err(HostFailure::Initialization)
        }

        fn shutdown(&mut self, _handle: &HostHandle) -> Result<(), HostFailure> {
            Err(HostFailure::Shutdown)
        }

        fn terminate(&mut self, _handle: &HostHandle) {}
    }

    struct MissingAuthorization;

    impl PluginAuthorizationStore for MissingAuthorization {
        fn current_grant(
            &self,
            _key: &AuthorizationKey,
            _artifact_version: &str,
        ) -> Result<Option<PluginAuthorizationGrant>, AuthorizationFailure> {
            Ok(None)
        }
    }

    struct NoRevocations;

    impl ArtifactRevocationStore for NoRevocations {
        fn is_revoked(&self, _artifact: &PluginArtifact) -> Result<bool, RevocationFailure> {
            Ok(false)
        }
    }

    struct FixedClock;

    impl Clock for FixedClock {
        fn now_millis(&self) -> u64 {
            1
        }
    }

    fn artifact() -> PluginArtifact {
        PluginArtifact::new(
            "dev.bbcom.coverage",
            "1.0.0",
            format!("publisher:sha256-{}", "b".repeat(64)),
            BTreeSet::from([Permission::SessionMetadataRead]),
        )
        .unwrap()
    }

    fn service()
    -> PluginService<FailingInstaller, FailingHost, MissingAuthorization, NoRevocations, FixedClock>
    {
        PluginService::new(
            PluginManager::new(
                FailingInstaller,
                FailingHost,
                MissingAuthorization,
                NoRevocations,
                FixedClock,
            ),
            HostExitMonitor::empty(),
        )
    }

    #[test]
    fn application_service_forwards_every_lifecycle_action_without_auto_starting() {
        let service = service();
        assert!(service.poll_host_exits().is_empty());
        let installed = service.observe_installed(artifact()).unwrap();
        assert_eq!(installed.running_instance_id, None);
        let snapshots = service
            .open_project(
                "11111111-1111-1111-1111-111111111111".to_owned(),
                Vec::new(),
            )
            .unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(service.snapshots().unwrap().len(), 1);
        assert!(service.enable("dev.bbcom.coverage").is_err());
        assert!(service.disable("dev.bbcom.coverage").is_ok());

        let request =
            ManualPackageRequest::new("first-party", "dev.bbcom.coverage", "1.0.0").unwrap();
        assert!(service.install_manual(&request).is_err());
        assert!(service.begin_manual_upgrade(&request).is_err());
        assert!(
            service
                .approve_pending_upgrade("dev.bbcom.coverage")
                .is_err()
        );
        assert!(
            service
                .cancel_pending_upgrade("dev.bbcom.coverage")
                .is_err()
        );
        assert_eq!(
            service
                .set_project_state(
                    OpaqueProjectPluginState::new("dev.bbcom.coverage", vec![1, 2, 3]).unwrap(),
                )
                .unwrap()
                .len(),
            1
        );
        service.close_project().unwrap();
    }

    #[test]
    fn service_errors_are_stable_and_poisoning_fails_closed() {
        let manager_error: ManagerError =
            bbcom_plugin_manager::ManagerErrorCode::PluginNotFound.into();
        let wrapped = PluginServiceError::from(manager_error);
        assert!(!wrapped.to_string().is_empty());
        assert_eq!(
            PluginServiceError::HostMonitorUnavailable.to_string(),
            "plugin host monitor is unavailable"
        );
        assert_eq!(
            PluginServiceError::StatePoisoned.to_string(),
            "plugin application service is unavailable"
        );

        let service = service();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = service.manager.lock().unwrap();
            panic!("poison the application-owned manager mutex");
        }));
        assert_eq!(service.snapshots(), Err(PluginServiceError::StatePoisoned));
    }
}
