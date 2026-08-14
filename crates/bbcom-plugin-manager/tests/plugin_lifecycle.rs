use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use bbcom_plugin_contracts::{AuthorizationKey, Permission};
use bbcom_plugin_manager::{
    ApprovalReason, ArtifactRevocationStore, ArtifactSlot, AuthorizationFailure, Clock, CrashKind,
    DisableReason, HostFailure, HostHandle, HostLaunchMode, HostLaunchRequest, HostLauncher,
    HostReport, InstallationFailure, InstallationPort, MAX_PLUGIN_PROJECT_STATE_BYTES,
    ManagerErrorCode, ManualPackageRequest, OpaqueProjectPluginState, PluginArtifact,
    PluginAuthorizationGrant, PluginAuthorizationStore, PluginManager, PluginSnapshot,
    PluginStatus, PreparationKind, PreparationToken, PreparedInstallation, RevocationFailure,
};

const PLUGIN_ID: &str = "dev.bbcom.golden";
const WORKSPACE_ONE: &str = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_TWO: &str = "22222222-2222-2222-2222-222222222222";

fn publisher() -> String {
    format!("publisher:sha256-{}", "a".repeat(64))
}

fn artifact(version: &str, permissions: &[Permission]) -> PluginArtifact {
    PluginArtifact::new(PLUGIN_ID, version, publisher(), permissions.iter().copied()).unwrap()
}

fn request(version: &str) -> ManualPackageRequest {
    ManualPackageRequest::new("first-party", PLUGIN_ID, version).unwrap()
}

#[derive(Default)]
struct InstallerState {
    plans: BTreeMap<String, PluginArtifact>,
    rollback: Option<PluginArtifact>,
    active: Option<PluginArtifact>,
}

#[derive(Clone)]
struct FakeInstaller {
    state: Rc<RefCell<InstallerState>>,
    audit: Rc<RefCell<Vec<String>>>,
}

impl FakeInstaller {
    fn new(
        artifacts: impl IntoIterator<Item = PluginArtifact>,
        audit: Rc<RefCell<Vec<String>>>,
    ) -> Self {
        let plans = artifacts
            .into_iter()
            .map(|artifact| (artifact.version.clone(), artifact))
            .collect();
        Self {
            state: Rc::new(RefCell::new(InstallerState {
                plans,
                ..InstallerState::default()
            })),
            audit,
        }
    }

    fn active_version(&self) -> Option<String> {
        self.state
            .borrow()
            .active
            .as_ref()
            .map(|artifact| artifact.version.clone())
    }

    fn set_rollback(&self, artifact: PluginArtifact) {
        self.state.borrow_mut().rollback = Some(artifact);
    }
}

impl InstallationPort for FakeInstaller {
    fn prepare_manual(
        &mut self,
        request: &ManualPackageRequest,
        current: Option<&PluginArtifact>,
    ) -> std::result::Result<PreparedInstallation, InstallationFailure> {
        let artifact = self
            .state
            .borrow()
            .plans
            .get(&request.version)
            .cloned()
            .ok_or(InstallationFailure)?;
        let kind = if current.is_some() {
            PreparationKind::ManualUpgrade
        } else {
            PreparationKind::InitialInstall
        };
        let copy_kind = if current.is_some() {
            "data-copy"
        } else {
            "empty-data"
        };
        self.audit.borrow_mut().push(format!(
            "installer:prepare:{}:{copy_kind}",
            artifact.version
        ));
        PreparedInstallation::new(
            PreparationToken::new(format!("manual-{}", artifact.version)).unwrap(),
            artifact,
            kind,
        )
        .map_err(|_| InstallationFailure)
    }

    fn prepare_rollback(
        &mut self,
        _current: &PluginArtifact,
    ) -> std::result::Result<Option<PreparedInstallation>, InstallationFailure> {
        let Some(artifact) = self.state.borrow().rollback.clone() else {
            return Ok(None);
        };
        self.audit.borrow_mut().push(format!(
            "installer:rollback-stage:{}:data-snapshot-copy",
            artifact.version
        ));
        PreparedInstallation::new(
            PreparationToken::new(format!("rollback-{}", artifact.version)).unwrap(),
            artifact,
            PreparationKind::Rollback,
        )
        .map(Some)
        .map_err(|_| InstallationFailure)
    }

    fn commit(
        &mut self,
        prepared: &PreparedInstallation,
    ) -> std::result::Result<PluginArtifact, InstallationFailure> {
        self.audit.borrow_mut().push(format!(
            "installer:commit:{}:package-and-data-atomic",
            prepared.artifact.version
        ));
        self.state.borrow_mut().active = Some(prepared.artifact.clone());
        Ok(prepared.artifact.clone())
    }

    fn discard(
        &mut self,
        prepared: &PreparedInstallation,
    ) -> std::result::Result<(), InstallationFailure> {
        self.audit
            .borrow_mut()
            .push(format!("installer:discard:{}", prepared.artifact.version));
        Ok(())
    }
}

#[derive(Default)]
struct HostState {
    next_id: u64,
    live: BTreeMap<String, u64>,
    launches: Vec<HostLaunchRequest>,
}

#[derive(Clone)]
struct FakeHosts {
    state: Rc<RefCell<HostState>>,
    audit: Rc<RefCell<Vec<String>>>,
}

impl FakeHosts {
    fn new(audit: Rc<RefCell<Vec<String>>>) -> Self {
        Self {
            state: Rc::new(RefCell::new(HostState::default())),
            audit,
        }
    }

    fn launch_count(&self) -> usize {
        self.state.borrow().launches.len()
    }

    fn live_count(&self) -> usize {
        self.state.borrow().live.len()
    }

    fn crash(&self, instance_id: u64) {
        let plugin_id = self
            .state
            .borrow()
            .live
            .iter()
            .find_map(|(plugin_id, live_id)| (*live_id == instance_id).then(|| plugin_id.clone()))
            .expect("test crash targets a live host");
        self.state.borrow_mut().live.remove(&plugin_id);
        self.audit
            .borrow_mut()
            .push(format!("host:crash:{plugin_id}:{instance_id}"));
    }
}

impl HostLauncher for FakeHosts {
    fn launch(
        &mut self,
        request: &HostLaunchRequest,
    ) -> std::result::Result<HostHandle, HostFailure> {
        let mut state = self.state.borrow_mut();
        if state.live.contains_key(&request.artifact.plugin_id) {
            return Err(HostFailure::Launch);
        }
        state.next_id += 1;
        let instance_id = state.next_id;
        state
            .live
            .insert(request.artifact.plugin_id.clone(), instance_id);
        state.launches.push(request.clone());
        let mode = match request.mode {
            HostLaunchMode::Active => "active",
            HostLaunchMode::UpdatePreflight => "preflight",
        };
        let slot = match request.artifact_slot {
            ArtifactSlot::Active => "active",
            ArtifactSlot::Prepared(_) => "prepared-data-copy",
        };
        self.audit.borrow_mut().push(format!(
            "host:launch:{}:{mode}:{slot}",
            request.artifact.version
        ));
        Ok(HostHandle::new(
            instance_id,
            &request.artifact.plugin_id,
            &request.artifact.version,
        ))
    }

    fn initialize(&mut self, handle: &HostHandle) -> std::result::Result<(), HostFailure> {
        self.audit
            .borrow_mut()
            .push(format!("host:initialize:{}", handle.version));
        Ok(())
    }

    fn shutdown(&mut self, handle: &HostHandle) -> std::result::Result<(), HostFailure> {
        let removed = self.state.borrow_mut().live.remove(&handle.plugin_id);
        if removed != Some(handle.instance_id) {
            return Err(HostFailure::Shutdown);
        }
        self.audit
            .borrow_mut()
            .push(format!("host:shutdown:{}", handle.version));
        Ok(())
    }

    fn terminate(&mut self, handle: &HostHandle) {
        self.state.borrow_mut().live.remove(&handle.plugin_id);
        self.audit
            .borrow_mut()
            .push(format!("host:terminate:{}", handle.version));
    }
}

type GrantKey = (String, String, String);

#[derive(Clone, Default)]
struct FakeAuthorizations {
    grants: Rc<RefCell<BTreeMap<GrantKey, PluginAuthorizationGrant>>>,
}

impl FakeAuthorizations {
    fn grant(&self, workspace_id: &str, artifact: &PluginArtifact, revision: u64) {
        let key = AuthorizationKey {
            plugin_id: artifact.plugin_id.clone(),
            publisher_identity: artifact.publisher_identity.clone(),
            plugin_major: artifact.version.split('.').next().unwrap().parse().unwrap(),
            workspace_id: workspace_id.to_owned(),
        };
        self.grants.borrow_mut().insert(
            (
                workspace_id.to_owned(),
                artifact.plugin_id.clone(),
                artifact.version.clone(),
            ),
            PluginAuthorizationGrant {
                key,
                artifact_version: artifact.version.clone(),
                reviewed_permissions: artifact.requested_permissions.clone(),
                revision,
            },
        );
    }
}

impl PluginAuthorizationStore for FakeAuthorizations {
    fn current_grant(
        &self,
        key: &AuthorizationKey,
        artifact_version: &str,
    ) -> std::result::Result<Option<PluginAuthorizationGrant>, AuthorizationFailure> {
        Ok(self
            .grants
            .borrow()
            .get(&(
                key.workspace_id.clone(),
                key.plugin_id.clone(),
                artifact_version.to_owned(),
            ))
            .cloned())
    }
}

#[derive(Clone, Default)]
struct FakeRevocations {
    revoked: Rc<RefCell<BTreeSet<(String, String)>>>,
}

impl FakeRevocations {
    fn revoke(&self, artifact: &PluginArtifact) {
        self.revoked
            .borrow_mut()
            .insert((artifact.plugin_id.clone(), artifact.version.clone()));
    }
}

impl ArtifactRevocationStore for FakeRevocations {
    fn is_revoked(
        &self,
        artifact: &PluginArtifact,
    ) -> std::result::Result<bool, RevocationFailure> {
        Ok(self
            .revoked
            .borrow()
            .contains(&(artifact.plugin_id.clone(), artifact.version.clone())))
    }
}

#[derive(Clone, Default)]
struct FakeClock(Rc<Cell<u64>>);

impl FakeClock {
    fn advance(&self, millis: u64) {
        self.0.set(self.0.get() + millis);
    }
}

impl Clock for FakeClock {
    fn now_millis(&self) -> u64 {
        self.0.get()
    }
}

fn crash_current<I, A, R>(
    manager: &mut PluginManager<I, FakeHosts, A, R, FakeClock>,
    hosts: &FakeHosts,
    clock: &FakeClock,
    kind: CrashKind,
) -> PluginSnapshot
where
    I: InstallationPort,
    A: PluginAuthorizationStore,
    R: ArtifactRevocationStore,
{
    let instance_id = manager
        .snapshot(PLUGIN_ID)
        .unwrap()
        .running_instance_id
        .unwrap();
    hosts.crash(instance_id);
    clock.advance(100);
    manager
        .report_host_exit(PLUGIN_ID, instance_id, HostReport::Crashed(kind))
        .unwrap()
}

#[test]
fn full_manual_lifecycle_expansion_and_crash_loop_rollback_are_ordered() {
    let audit = Rc::new(RefCell::new(Vec::new()));
    let v1 = artifact("1.0.0", &[Permission::SessionMetadataRead]);
    let v2 = artifact(
        "1.1.0",
        &[
            Permission::SessionMetadataRead,
            Permission::SessionCaptureRead,
        ],
    );
    let installer = FakeInstaller::new([v1.clone(), v2.clone()], audit.clone());
    installer.set_rollback(v1.clone());
    let hosts = FakeHosts::new(audit.clone());
    let authorizations = FakeAuthorizations::default();
    let revocations = FakeRevocations::default();
    let clock = FakeClock::default();
    let mut manager = PluginManager::new(
        installer.clone(),
        hosts.clone(),
        authorizations.clone(),
        revocations,
        clock.clone(),
    );

    manager.open_project(WORKSPACE_ONE, Vec::new()).unwrap();
    let installed = manager.install_manual(&request("1.0.0")).unwrap();
    assert_eq!(
        installed.status,
        PluginStatus::ApprovalRequired(ApprovalReason::InitialInstall)
    );
    assert_eq!(
        manager.enable(PLUGIN_ID).unwrap_err().code(),
        ManagerErrorCode::AuthorizationRequired
    );

    authorizations.grant(WORKSPACE_ONE, &v1, 1);
    let running = manager.enable(PLUGIN_ID).unwrap();
    assert_eq!(running.status, PluginStatus::Running);
    assert_eq!(hosts.launch_count(), 1);
    manager.enable(PLUGIN_ID).unwrap();
    assert_eq!(hosts.launch_count(), 1, "enable is idempotent");

    let awaiting_review = manager.begin_manual_upgrade(&request("1.1.0")).unwrap();
    assert_eq!(
        awaiting_review.status,
        PluginStatus::ApprovalRequired(ApprovalReason::PermissionExpansion)
    );
    assert_eq!(awaiting_review.pending_version.as_deref(), Some("1.1.0"));
    assert_eq!(installer.active_version().as_deref(), Some("1.0.0"));
    assert_eq!(hosts.live_count(), 0);

    let target = manager.authorization_target(PLUGIN_ID).unwrap();
    authorizations.grant(WORKSPACE_ONE, &v2, 2);
    let updated = manager.complete_authorization(&target, true).unwrap();
    assert_eq!(updated.status, PluginStatus::Running);
    assert_eq!(updated.artifact.version, "1.1.0");
    assert_eq!(installer.active_version().as_deref(), Some("1.1.0"));
    assert_eq!(hosts.live_count(), 1);

    let audit_snapshot = audit.borrow();
    let prepare = audit_snapshot
        .iter()
        .position(|event| event == "installer:prepare:1.1.0:data-copy")
        .unwrap();
    let preflight = audit_snapshot
        .iter()
        .position(|event| event == "host:launch:1.1.0:preflight:prepared-data-copy")
        .unwrap();
    let commit = audit_snapshot
        .iter()
        .position(|event| event == "installer:commit:1.1.0:package-and-data-atomic")
        .unwrap();
    let active = audit_snapshot
        .iter()
        .rposition(|event| event == "host:launch:1.1.0:active:active")
        .unwrap();
    assert!(prepare < preflight && preflight < commit && commit < active);
    drop(audit_snapshot);

    let first = crash_current(&mut manager, &hosts, &clock, CrashKind::ProcessCrash);
    assert_eq!(first.status, PluginStatus::Running);
    assert_eq!(first.crashes_in_window, 1);
    let second = crash_current(&mut manager, &hosts, &clock, CrashKind::ExecutionTimeout);
    assert_eq!(second.status, PluginStatus::Running);
    assert_eq!(second.crashes_in_window, 2);
    let third = crash_current(&mut manager, &hosts, &clock, CrashKind::MemoryLimit);
    assert_eq!(
        third.status,
        PluginStatus::Disabled(DisableReason::CrashLoopRolledBack)
    );
    assert_eq!(third.artifact.version, "1.0.0");
    assert_eq!(third.running_instance_id, None);
    assert_eq!(third.crashes_in_window, 0);
    assert_eq!(installer.active_version().as_deref(), Some("1.0.0"));
    assert_eq!(hosts.live_count(), 0);
    assert!(
        audit
            .borrow()
            .iter()
            .any(|event| { event == "installer:rollback-stage:1.0.0:data-snapshot-copy" })
    );
}

#[test]
fn non_expanding_upgrade_requires_a_fresh_exact_target_receipt() {
    let audit = Rc::new(RefCell::new(Vec::new()));
    let v1 = artifact("1.0.0", &[Permission::SessionMetadataRead]);
    let v2 = artifact("1.1.0", &[Permission::SessionMetadataRead]);
    let installer = FakeInstaller::new([v1.clone(), v2.clone()], audit.clone());
    let hosts = FakeHosts::new(audit);
    let authorizations = FakeAuthorizations::default();
    let mut manager = PluginManager::new(
        installer.clone(),
        hosts,
        authorizations.clone(),
        FakeRevocations::default(),
        FakeClock::default(),
    );

    manager.open_project(WORKSPACE_ONE, Vec::new()).unwrap();
    manager.install_manual(&request("1.0.0")).unwrap();
    authorizations.grant(WORKSPACE_ONE, &v1, 1);
    manager.enable(PLUGIN_ID).unwrap();

    let pending = manager.begin_manual_upgrade(&request("1.1.0")).unwrap();
    assert_eq!(
        pending.status,
        PluginStatus::ApprovalRequired(ApprovalReason::ArtifactChanged)
    );
    let target = manager.authorization_target(PLUGIN_ID).unwrap();
    assert_eq!(target.artifact, v2);
    assert!(target.preparation_token.is_some());
    assert_eq!(installer.active_version().as_deref(), Some("1.0.0"));

    let mut stale_target = target.clone();
    stale_target.preparation_token = Some(PreparationToken::new("replaced-stage").unwrap());
    assert_eq!(
        manager
            .complete_authorization(&stale_target, true)
            .unwrap_err()
            .code(),
        ManagerErrorCode::InvalidStateTransition
    );

    let rejected = manager.complete_authorization(&target, false).unwrap();
    assert_eq!(rejected.artifact.version, "1.0.0");
    assert_eq!(rejected.pending_version, None);
    assert_eq!(installer.active_version().as_deref(), Some("1.0.0"));

    manager.begin_manual_upgrade(&request("1.1.0")).unwrap();
    let target = manager.authorization_target(PLUGIN_ID).unwrap();

    authorizations.grant(WORKSPACE_ONE, &target.artifact, 2);
    let updated = manager.complete_authorization(&target, true).unwrap();
    assert_eq!(updated.artifact.version, "1.1.0");
    assert_eq!(installer.active_version().as_deref(), Some("1.1.0"));
}

#[test]
fn revoked_previous_artifact_is_never_selected_by_automatic_rollback() {
    let audit = Rc::new(RefCell::new(Vec::new()));
    let v1 = artifact("1.0.0", &[Permission::SessionMetadataRead]);
    let v2 = artifact("1.1.0", &[Permission::SessionMetadataRead]);
    let installer = FakeInstaller::new([v1.clone(), v2.clone()], audit.clone());
    installer.set_rollback(v1.clone());
    let hosts = FakeHosts::new(audit);
    let authorizations = FakeAuthorizations::default();
    let revocations = FakeRevocations::default();
    revocations.revoke(&v1);
    let clock = FakeClock::default();
    let mut manager = PluginManager::new(
        installer.clone(),
        hosts.clone(),
        authorizations.clone(),
        revocations,
        clock.clone(),
    );

    manager.open_project(WORKSPACE_ONE, Vec::new()).unwrap();
    manager.observe_installed(v2.clone()).unwrap();
    authorizations.grant(WORKSPACE_ONE, &v2, 1);
    manager.enable(PLUGIN_ID).unwrap();
    crash_current(&mut manager, &hosts, &clock, CrashKind::ProcessCrash);
    crash_current(&mut manager, &hosts, &clock, CrashKind::ProcessCrash);
    let snapshot = crash_current(&mut manager, &hosts, &clock, CrashKind::ProcessCrash);

    assert_eq!(
        snapshot.status,
        PluginStatus::Disabled(DisableReason::RollbackBlockedRevoked)
    );
    assert_eq!(snapshot.artifact.version, "1.1.0");
    assert_eq!(snapshot.last_error, Some(ManagerErrorCode::ArtifactRevoked));
    assert_eq!(installer.active_version(), None);
    assert_eq!(hosts.live_count(), 0);
}

#[test]
fn project_switch_round_trips_unknown_state_and_never_auto_starts_plugins() {
    let audit = Rc::new(RefCell::new(Vec::new()));
    let v1 = artifact("1.0.0", &[Permission::SessionMetadataRead]);
    let installer = FakeInstaller::new([v1.clone()], audit.clone());
    let hosts = FakeHosts::new(audit);
    let authorizations = FakeAuthorizations::default();
    let clock = FakeClock::default();
    let mut manager = PluginManager::new(
        installer,
        hosts.clone(),
        authorizations.clone(),
        FakeRevocations::default(),
        clock,
    );
    manager.observe_installed(v1.clone()).unwrap();
    let first_states = vec![
        OpaqueProjectPluginState::new(PLUGIN_ID, vec![1, 2, 3]).unwrap(),
        OpaqueProjectPluginState::new("org.unknown.plugin", vec![9, 8, 7]).unwrap(),
    ];
    let opened = manager
        .open_project(WORKSPACE_ONE, first_states.clone())
        .unwrap();
    assert_eq!(opened[0].running_instance_id, None);
    assert_eq!(manager.project_states(), first_states);
    assert_eq!(hosts.launch_count(), 0);

    authorizations.grant(WORKSPACE_ONE, &v1, 1);
    manager.enable(PLUGIN_ID).unwrap();
    assert_eq!(hosts.launch_count(), 1);
    let second_states = vec![
        OpaqueProjectPluginState::new("org.unknown.plugin", vec![4, 5, 6]).unwrap(),
        OpaqueProjectPluginState::new(PLUGIN_ID, vec![3, 2, 1]).unwrap(),
    ];
    let switched = manager
        .open_project(WORKSPACE_TWO, second_states.clone())
        .unwrap();
    assert_eq!(hosts.launch_count(), 1, "project open has no launch path");
    assert_eq!(hosts.live_count(), 0);
    assert_eq!(manager.project_states(), second_states);
    assert_eq!(
        switched[0].status,
        PluginStatus::ApprovalRequired(ApprovalReason::WorkspaceChanged)
    );

    let oversized = OpaqueProjectPluginState::new(
        "org.unknown.oversized",
        vec![0; MAX_PLUGIN_PROJECT_STATE_BYTES + 1],
    )
    .unwrap();
    assert_eq!(
        manager
            .open_project(WORKSPACE_ONE, vec![oversized])
            .unwrap_err()
            .code(),
        ManagerErrorCode::ProjectStateLimitExceeded
    );
    assert_eq!(manager.workspace_id(), Some(WORKSPACE_TWO));
    assert_eq!(manager.project_states(), second_states);
}
