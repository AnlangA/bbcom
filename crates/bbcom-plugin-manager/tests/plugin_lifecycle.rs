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

/// Mock installer that counts durable removals so tests can prove whether a
/// failed local replace preserved the previous installation on disk.
#[derive(Clone, Default)]
struct RemovalCounter(std::rc::Rc<std::cell::Cell<usize>>);

struct CountingInstaller {
    removed: RemovalCounter,
}

impl InstallationPort for CountingInstaller {
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
        self.removed.0.set(self.removed.0.get() + 1);
        Ok(())
    }
}

fn local_package(root: &std::path::Path, declared_sha256: &str) {
    let component_dir = root.join("component");
    std::fs::create_dir_all(&component_dir).unwrap();
    std::fs::write(component_dir.join("plugin.wasm"), b"fake-component-bytes").unwrap();
    std::fs::write(
        root.join("plugin.toml"),
        format!(
            "id = \"dev.bbcom.fixture\"\nname = \"Fixture\"\nversion = \"2.0.0\"\napi = \"^1\"\n\n\
             [component]\npath = \"component/plugin.wasm\"\nsha256 = \"{declared_sha256}\"\n\n\
             [publisher]\nname = \"fixture\"\nwebsite = \"https://example.invalid\"\n"
        ),
    )
    .unwrap();
}

fn real_component_sha256() -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b"fake-component-bytes")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn local_replace_rejects_a_broken_package_before_removing_the_install() {
    let root = tempfile::tempdir().unwrap();
    local_package(root.path(), &"0".repeat(64)); // digest mismatch

    let removed = RemovalCounter::default();
    let mut manager = PluginManager::new(
        CountingInstaller {
            removed: removed.clone(),
        },
        Hosts::default(),
        FixedClock,
    );
    manager.observe_installed(artifact()).unwrap();

    let error = manager.install_local(root.path()).unwrap_err();
    assert_eq!(error.code().as_str(), "PLUGIN_ARTIFACT_INVALID");
    // The pre-check fired before any stop/remove: the durable installation
    // and the manager record survive untouched.
    assert_eq!(removed.0.get(), 0);
    assert_eq!(manager.snapshots().len(), 1);
}

#[test]
fn local_replace_accepts_a_matching_package_up_to_the_documented_staging_window() {
    let root = tempfile::tempdir().unwrap();
    local_package(root.path(), &real_component_sha256());

    let removed = RemovalCounter::default();
    let mut manager = PluginManager::new(
        CountingInstaller {
            removed: removed.clone(),
        },
        Hosts::default(),
        FixedClock,
    );
    manager.observe_installed(artifact()).unwrap();

    // prepare_local is mocked to fail, so the replace aborts INSIDE the
    // accepted wipe→staging window: removal happened, record is gone. This
    // pins the documented residual risk instead of leaving it implicit.
    assert!(manager.install_local(root.path()).is_err());
    assert_eq!(removed.0.get(), 1);
    assert!(manager.snapshots().is_empty());
}
