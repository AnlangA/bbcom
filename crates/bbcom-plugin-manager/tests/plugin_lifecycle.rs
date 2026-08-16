use std::collections::BTreeSet;

use bbcom_plugin_contracts::Permission;
use bbcom_plugin_manager::{
    Clock, HostFailure, HostHandle, HostLaunchRequest, HostLauncher, InstallationFailure,
    InstallationPort, ManualPackageRequest, PluginArtifact, PluginArtifactSource, PluginManager,
    PluginSourceKind, PreparationKind, PreparationToken, PreparedInstallation,
    WorkspacePluginBinding,
};

const WORKSPACE: &str = "8e7b84cf-35f4-45cd-baf0-55d94ebf0213";

fn artifact() -> PluginArtifact {
    PluginArtifact::new(
        "dev.bbcom.fixture",
        "1.0.0",
        "a".repeat(64),
        "b".repeat(64),
        PluginArtifactSource {
            source_id: "official".to_owned(),
            kind: PluginSourceKind::Https,
        },
        [
            Permission::SessionMetadataRead,
            Permission::SerialControl,
            Permission::SerialWriteProposal,
        ],
    )
    .unwrap()
}

#[test]
fn global_install_and_uninstall_do_not_require_a_workspace() {
    let mut manager = PluginManager::new(Installer, Hosts::default(), FixedClock);
    let request = ManualPackageRequest::new("official", "dev.bbcom.fixture", "1.0.0").unwrap();
    let installed = manager.install_manual(&request).unwrap();
    assert!(!installed.expected_enabled);
    assert_eq!(installed.status.code().as_str(), "stopped");
    manager.uninstall("dev.bbcom.fixture").unwrap();
    assert!(manager.snapshots().is_empty());
}

#[test]
fn workspace_bindings_are_isolated_and_restart_expected_plugins() {
    let mut manager = PluginManager::new(Installer, Hosts::default(), FixedClock);
    manager.observe_installed(artifact()).unwrap();
    let enabled = WorkspacePluginBinding::new("dev.bbcom.fixture", true, "*").unwrap();
    let snapshots = manager
        .open_workspace(WORKSPACE, vec![enabled], Vec::new())
        .unwrap();
    assert!(snapshots[0].expected_enabled);
    assert_eq!(snapshots[0].status.code().as_str(), "running");

    let workspace_b = "11111111-1111-1111-1111-111111111111";
    let disabled = WorkspacePluginBinding::new("dev.bbcom.fixture", false, "*").unwrap();
    let snapshots = manager
        .open_workspace(workspace_b, vec![disabled], Vec::new())
        .unwrap();
    assert!(!snapshots[0].expected_enabled);
    assert_eq!(snapshots[0].status.code().as_str(), "stopped");
}

#[derive(Default)]
struct Installer;

impl InstallationPort for Installer {
    fn prepare_manual(
        &mut self,
        _request: &ManualPackageRequest,
        _current: Option<&PluginArtifact>,
    ) -> Result<PreparedInstallation, InstallationFailure> {
        PreparedInstallation::new(
            PreparationToken::new("prepared-1").unwrap(),
            artifact(),
            PreparationKind::InitialInstall,
        )
        .map_err(|_| InstallationFailure)
    }

    fn prepare_rollback(
        &mut self,
        _current: &PluginArtifact,
    ) -> Result<Option<PreparedInstallation>, InstallationFailure> {
        Ok(None)
    }

    fn commit(
        &mut self,
        prepared: &PreparedInstallation,
    ) -> Result<PluginArtifact, InstallationFailure> {
        Ok(prepared.artifact.clone())
    }

    fn discard(&mut self, _prepared: &PreparedInstallation) -> Result<(), InstallationFailure> {
        Ok(())
    }

    fn prepare_local(
        &mut self,
        _root: &std::path::Path,
        _current: Option<&PluginArtifact>,
    ) -> Result<PreparedInstallation, InstallationFailure> {
        Err(InstallationFailure)
    }

    fn remove_installed(&mut self, _artifact: &PluginArtifact) -> Result<(), InstallationFailure> {
        Ok(())
    }
}

#[derive(Default)]
struct Hosts {
    last_grants: BTreeSet<Permission>,
}

impl HostLauncher for Hosts {
    fn launch(&mut self, request: &HostLaunchRequest) -> Result<HostHandle, HostFailure> {
        self.last_grants = request.granted_permissions.clone();
        Ok(HostHandle::new(
            1,
            &request.artifact.plugin_id,
            &request.artifact.version,
        ))
    }

    fn initialize(&mut self, _handle: &HostHandle) -> Result<(), HostFailure> {
        Ok(())
    }

    fn shutdown(&mut self, _handle: &HostHandle) -> Result<(), HostFailure> {
        Ok(())
    }

    fn terminate(&mut self, _handle: &HostHandle) {}
}

struct FixedClock;
impl Clock for FixedClock {
    fn now_millis(&self) -> u64 {
        100
    }
}

#[test]
fn declared_implemented_capabilities_are_granted_without_authorization() {
    let mut manager = PluginManager::new(Installer, Hosts::default(), FixedClock);
    manager
        .open_project(WORKSPACE.to_owned(), Vec::new())
        .unwrap();
    manager.observe_installed(artifact()).unwrap();
    let running = manager.enable("dev.bbcom.fixture").unwrap();
    assert_eq!(running.status.code().as_str(), "running");
    assert!(
        running
            .artifact
            .effective_capabilities
            .contains(&Permission::SessionMetadataRead)
    );
    assert!(
        running
            .artifact
            .effective_capabilities
            .contains(&Permission::SerialWriteProposal)
    );
    assert!(
        running
            .artifact
            .unavailable_capabilities
            .contains(&Permission::SerialControl)
    );
    assert!(
        running
            .artifact
            .effective_capabilities
            .is_disjoint(&running.artifact.unavailable_capabilities)
    );
}
