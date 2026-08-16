use std::collections::{BTreeMap, VecDeque};

use crate::model::valid_workspace_id;
use crate::ports::{Clock, HostLauncher, InstallationPort};
use crate::project_state::validate_project_states;
use crate::{
    ArtifactSlot, CRASH_THRESHOLD, CRASH_WINDOW_MS, DisableReason, HostHandle, HostLaunchMode,
    HostLaunchRequest, HostReport, ManagerError, ManagerErrorCode, ManualPackageRequest,
    OpaqueProjectPluginState, PluginArtifact, PluginSnapshot, PluginStatus, PreparationKind,
    PreparedInstallation, Result, WorkspacePluginBinding,
};

#[derive(Clone, Debug)]
struct PendingUpgrade {
    prepared: PreparedInstallation,
    restart_after_activation: bool,
    resume_status: PluginStatus,
}

#[derive(Clone, Debug)]
struct PluginRecord {
    artifact: PluginArtifact,
    expected_enabled: bool,
    generation: u64,
    status: PluginStatus,
    pending: Option<PendingUpgrade>,
    crash_times: VecDeque<u64>,
    last_error: Option<ManagerErrorCode>,
}

#[derive(Clone, Debug)]
struct RunningHost {
    handle: HostHandle,
    started_at_ms: u64,
}

/// Single-owner application service for plugin lifecycle transitions.
///
/// The service is intentionally synchronous and requires `&mut self` for every
/// mutation. The application must place it behind its existing operation
/// registry/actor boundary rather than invoking it concurrently.
pub struct PluginManager<I, H, C> {
    installer: I,
    hosts: H,
    clock: C,
    workspace_id: Option<String>,
    records: BTreeMap<String, PluginRecord>,
    running: BTreeMap<String, RunningHost>,
    project_states: Vec<OpaqueProjectPluginState>,
}

impl<I, H, C> PluginManager<I, H, C>
where
    I: InstallationPort,
    H: HostLauncher,
    C: Clock,
{
    #[must_use]
    pub fn new(installer: I, hosts: H, clock: C) -> Self {
        Self {
            installer,
            hosts,
            clock,
            workspace_id: None,
            records: BTreeMap::new(),
            running: BTreeMap::new(),
            project_states: Vec::new(),
        }
    }

    #[must_use]
    pub fn workspace_id(&self) -> Option<&str> {
        self.workspace_id.as_deref()
    }

    /// Registers an installation discovered during application bootstrap.
    pub fn observe_installed(&mut self, artifact: PluginArtifact) -> Result<PluginSnapshot> {
        artifact.validate()?;
        if let Some(existing) = self.records.get(&artifact.plugin_id) {
            if existing.artifact == artifact {
                return self.snapshot(&artifact.plugin_id);
            }
            return Err(ManagerErrorCode::PluginAlreadyInstalled.into());
        }
        let status = PluginStatus::Stopped;
        let plugin_id = artifact.plugin_id.clone();
        self.records.insert(
            plugin_id.clone(),
            PluginRecord {
                artifact,
                expected_enabled: false,
                generation: 0,
                status,
                pending: None,
                crash_times: VecDeque::new(),
                last_error: None,
            },
        );
        self.snapshot(&plugin_id)
    }

    /// Development-mode install from a user-selected local package directory.
    /// Mirrors `install_manual` exactly (validation, revocation check, exact
    /// commit) except the package source is a local path instead of the
    /// repository trust boundary.
    pub fn install_local(&mut self, package_root: &std::path::Path) -> Result<PluginSnapshot> {
        if self
            .records
            .contains_key(&Self::local_probe_plugin_id(package_root).unwrap_or_default())
        {
            return Err(ManagerErrorCode::PluginAlreadyInstalled.into());
        }
        let prepared = self
            .installer
            .prepare_local(package_root, None)
            .map_err(|_| ManagerErrorCode::InstallationPrepareFailed)?;
        if self.validate_initial_prepared_local(&prepared).is_err() {
            let _ = self.installer.discard(&prepared);
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }
        let committed = self.commit_exact(&prepared)?;
        let plugin_id = committed.plugin_id.clone();
        self.records.insert(
            plugin_id.clone(),
            PluginRecord {
                artifact: committed,
                expected_enabled: false,
                generation: 0,
                status: PluginStatus::Stopped,
                pending: None,
                crash_times: VecDeque::new(),
                last_error: None,
            },
        );
        self.snapshot(&plugin_id)
    }

    /// Removes an installed plugin at runtime: stops its host, discards any
    /// pending upgrade, and deletes the durable installation. The returned
    /// snapshot is the final pre-removal state for UI feedback.
    pub fn uninstall(&mut self, plugin_id: &str) -> Result<PluginSnapshot> {
        let record = self.record(plugin_id)?;
        if record.pending.is_some() {
            return Err(ManagerErrorCode::InvalidStateTransition.into());
        }
        let artifact = record.artifact.clone();
        let final_snapshot = self.snapshot(plugin_id)?;
        let stop_result = self.stop_running(plugin_id);
        self.records.remove(plugin_id);
        self.installer
            .remove_installed(&artifact)
            .map_err(|_| ManagerErrorCode::InstallationPrepareFailed)?;
        stop_result?;
        Ok(final_snapshot)
    }

    /// Best-effort plugin-id probe for a local package directory, used only
    /// to reject duplicate installs before staging work.
    fn local_probe_plugin_id(_package_root: &std::path::Path) -> Option<String> {
        None
    }

    fn validate_initial_prepared_local(&self, prepared: &PreparedInstallation) -> Result<()> {
        if prepared.kind != PreparationKind::InitialInstall {
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }
        prepared.artifact.validate()
    }

    /// Performs a user-requested repository installation. There is no timer or
    /// background path to this method.
    pub fn install_manual(&mut self, request: &ManualPackageRequest) -> Result<PluginSnapshot> {
        if self.records.contains_key(&request.plugin_id) {
            return Err(ManagerErrorCode::PluginAlreadyInstalled.into());
        }
        let prepared = self
            .installer
            .prepare_manual(request, None)
            .map_err(|_| ManagerErrorCode::InstallationPrepareFailed)?;
        if self.validate_initial_prepared(request, &prepared).is_err() {
            let _ = self.installer.discard(&prepared);
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }
        let artifact = self.commit_exact(&prepared)?;
        let plugin_id = artifact.plugin_id.clone();
        self.records.insert(
            plugin_id.clone(),
            PluginRecord {
                artifact,
                expected_enabled: false,
                generation: 0,
                status: PluginStatus::Stopped,
                pending: None,
                crash_times: VecDeque::new(),
                last_error: None,
            },
        );
        self.snapshot(&plugin_id)
    }

    /// Explicitly enables a plugin after checking a current, version-specific
    /// approval receipt. Calling this for an already-running plugin is
    /// idempotent and never creates a second host.
    pub fn enable(&mut self, plugin_id: &str) -> Result<PluginSnapshot> {
        self.require_workspace()?;
        self.record_mut(plugin_id)?.expected_enabled = true;
        if self.running.contains_key(plugin_id) {
            return self.snapshot(plugin_id);
        }
        let record = self.record(plugin_id)?;
        if record.pending.is_some() {
            return Err(ManagerErrorCode::InvalidStateTransition.into());
        }
        let artifact = record.artifact.clone();
        self.record_mut(plugin_id)?.status = PluginStatus::Starting;
        match self.start_active(&artifact) {
            Ok(()) => {
                let record = self.record_mut(plugin_id)?;
                record.status = PluginStatus::Running;
                record.last_error = None;
                self.snapshot(plugin_id)
            }
            Err(error) => {
                self.fail_record(plugin_id, error.code())?;
                Err(error)
            }
        }
    }

    pub fn disable(&mut self, plugin_id: &str) -> Result<PluginSnapshot> {
        self.record(plugin_id)?;
        self.record_mut(plugin_id)?.expected_enabled = false;
        let stop_result = self.stop_running(plugin_id);
        let record = self.record_mut(plugin_id)?;
        record.status = PluginStatus::Disabled(DisableReason::User);
        if let Err(error) = stop_result {
            record.last_error = Some(error.code());
            return Err(error);
        }
        record.last_error = None;
        self.snapshot(plugin_id)
    }

    /// Stages and atomically activates a user-selected newer version.
    pub fn begin_manual_upgrade(
        &mut self,
        request: &ManualPackageRequest,
    ) -> Result<PluginSnapshot> {
        self.require_workspace()?;
        let current = self.record(&request.plugin_id)?.artifact.clone();
        if self.record(&request.plugin_id)?.pending.is_some() {
            return Err(ManagerErrorCode::InvalidStateTransition.into());
        }
        let prepared = self
            .installer
            .prepare_manual(request, Some(&current))
            .map_err(|_| ManagerErrorCode::InstallationPrepareFailed)?;
        if self
            .validate_upgrade_prepared(request, &current, &prepared)
            .is_err()
        {
            let _ = self.installer.discard(&prepared);
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }

        let restart_after_activation = self.running.contains_key(&request.plugin_id);
        let resume_status = self.record(&request.plugin_id)?.status;
        if let Err(error) = self.stop_running(&request.plugin_id) {
            let _ = self.installer.discard(&prepared);
            self.fail_record(&request.plugin_id, error.code())?;
            return Err(error);
        }
        {
            let record = self.record_mut(&request.plugin_id)?;
            record.pending = Some(PendingUpgrade {
                prepared,
                restart_after_activation,
                resume_status,
            });
            record.status = PluginStatus::Updating;
            record.last_error = None;
        }
        self.finish_pending_upgrade(&request.plugin_id)
    }

    pub fn complete_pending_upgrade(&mut self, plugin_id: &str) -> Result<PluginSnapshot> {
        self.finish_pending_upgrade(plugin_id)
    }

    pub fn cancel_pending_upgrade(&mut self, plugin_id: &str) -> Result<PluginSnapshot> {
        let pending = self
            .record(plugin_id)?
            .pending
            .clone()
            .ok_or(ManagerErrorCode::InvalidStateTransition)?;
        if self.installer.discard(&pending.prepared).is_err() {
            self.fail_record(plugin_id, ManagerErrorCode::InstallationDiscardFailed)?;
            return Err(ManagerErrorCode::InstallationDiscardFailed.into());
        }
        self.record_mut(plugin_id)?.pending = None;
        self.restore_previous_status(plugin_id, &pending)?;
        self.snapshot(plugin_id)
    }

    /// Handles a native host exit. The report must identify the exact current
    /// instance; late reports from replaced processes are rejected.
    pub fn report_host_exit(
        &mut self,
        plugin_id: &str,
        instance_id: u64,
        report: HostReport,
    ) -> Result<PluginSnapshot> {
        let running = self
            .running
            .get(plugin_id)
            .ok_or(ManagerErrorCode::StaleHostReport)?;
        if running.handle.instance_id != instance_id {
            return Err(ManagerErrorCode::StaleHostReport.into());
        }
        let running = self
            .running
            .remove(plugin_id)
            .ok_or(ManagerErrorCode::StaleHostReport)?;
        match report {
            HostReport::CleanExit => {
                let record = self.record_mut(plugin_id)?;
                record.status = PluginStatus::Stopped;
                record.crash_times.clear();
                record.last_error = None;
                self.snapshot(plugin_id)
            }
            HostReport::Crashed(crash_kind) => {
                let now = self.clock.now_millis();
                let record = self.record_mut(plugin_id)?;
                if now.saturating_sub(running.started_at_ms) >= CRASH_WINDOW_MS {
                    record.crash_times.clear();
                }
                while record
                    .crash_times
                    .front()
                    .is_some_and(|timestamp| now.saturating_sub(*timestamp) > CRASH_WINDOW_MS)
                {
                    record.crash_times.pop_front();
                }
                record.crash_times.push_back(now);
                record.status = PluginStatus::Failed;
                record.last_error = Some(crash_error_code(crash_kind));
                if record.crash_times.len() >= CRASH_THRESHOLD {
                    self.rollback_after_crash_loop(plugin_id)?;
                    return self.snapshot(plugin_id);
                }

                let artifact = self.record(plugin_id)?.artifact.clone();
                match self.start_active(&artifact) {
                    Ok(()) => {
                        let record = self.record_mut(plugin_id)?;
                        record.status = PluginStatus::Running;
                        record.last_error = None;
                        self.snapshot(plugin_id)
                    }
                    Err(error) => {
                        self.fail_record(plugin_id, error.code())?;
                        Err(error)
                    }
                }
            }
        }
    }

    /// Replaces the project context after force-stopping all hosts. Opaque
    /// state is validated and retained byte-for-byte, including unknown plugin
    /// identifiers. This method contains no host launch path.
    pub fn open_project(
        &mut self,
        workspace_id: impl Into<String>,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<Vec<PluginSnapshot>> {
        self.open_workspace(workspace_id, Vec::new(), states)
    }

    /// Activates a workspace context without rebuilding the global manager.
    /// Bindings for uninstalled plugins are retained by the workspace store;
    /// only currently installed records are projected into runtime intent.
    pub fn open_workspace(
        &mut self,
        workspace_id: impl Into<String>,
        bindings: Vec<WorkspacePluginBinding>,
        states: Vec<OpaqueProjectPluginState>,
    ) -> Result<Vec<PluginSnapshot>> {
        let workspace_id = workspace_id.into();
        if !valid_workspace_id(&workspace_id) {
            return Err(ManagerErrorCode::ProjectStateInvalid.into());
        }
        validate_project_states(&states)?;
        let mut expected = BTreeMap::new();
        for binding in bindings {
            if expected
                .insert(binding.plugin_id, binding.expected_enabled)
                .is_some()
            {
                return Err(ManagerErrorCode::ProjectStateInvalid.into());
            }
        }
        self.stop_all_for_project_transition();
        self.discard_all_pending();
        self.workspace_id = Some(workspace_id);
        self.project_states = states;
        for record in self.records.values_mut() {
            record.crash_times.clear();
            record.status = PluginStatus::Stopped;
            record.expected_enabled = expected
                .get(&record.artifact.plugin_id)
                .copied()
                .unwrap_or(false);
        }
        let to_start = self
            .records
            .iter()
            .filter_map(|(plugin_id, record)| record.expected_enabled.then_some(plugin_id.clone()))
            .collect::<Vec<_>>();
        for plugin_id in to_start {
            // Preserve expected=true and surface a failed lifecycle snapshot;
            // one broken plugin must not prevent the workspace from opening.
            let _ = self.enable(&plugin_id);
        }
        Ok(self.snapshots())
    }

    pub fn close_project(&mut self) {
        self.stop_all_for_project_transition();
        self.discard_all_pending();
        self.workspace_id = None;
        self.project_states.clear();
        for record in self.records.values_mut() {
            record.crash_times.clear();
            record.status = PluginStatus::Stopped;
            record.expected_enabled = false;
        }
    }

    #[must_use]
    pub fn project_states(&self) -> Vec<OpaqueProjectPluginState> {
        self.project_states.clone()
    }

    pub fn set_project_state(
        &mut self,
        state: OpaqueProjectPluginState,
    ) -> Result<Vec<OpaqueProjectPluginState>> {
        self.require_workspace()?;
        let mut next = self.project_states.clone();
        if let Some(existing) = next
            .iter_mut()
            .find(|existing| existing.plugin_id == state.plugin_id)
        {
            *existing = state;
        } else {
            next.push(state);
        }
        validate_project_states(&next)?;
        self.project_states = next;
        Ok(self.project_states())
    }

    pub fn snapshot(&self, plugin_id: &str) -> Result<PluginSnapshot> {
        let record = self.record(plugin_id)?;
        Ok(PluginSnapshot {
            artifact: record.artifact.clone(),
            expected_enabled: record.expected_enabled,
            status: record.status,
            pending_version: record
                .pending
                .as_ref()
                .map(|pending| pending.prepared.artifact.version.clone()),
            running_instance_id: self
                .running
                .get(plugin_id)
                .map(|running| running.handle.instance_id),
            generation: record.generation,
            crashes_in_window: record.crash_times.len(),
            last_error: record.last_error,
        })
    }

    #[must_use]
    pub fn snapshots(&self) -> Vec<PluginSnapshot> {
        self.records
            .keys()
            .filter_map(|plugin_id| self.snapshot(plugin_id).ok())
            .collect()
    }

    pub fn take_published_panels(&mut self) -> Result<Vec<crate::HostPublishedPanel>> {
        let handles = self
            .running
            .values()
            .map(|running| running.handle.clone())
            .collect::<Vec<_>>();
        let mut panels = Vec::new();
        for handle in handles {
            if let Some(panel) = self
                .hosts
                .take_published_panel(&handle)
                .map_err(|_| ManagerErrorCode::HostInitializationFailed)?
            {
                panels.push(crate::HostPublishedPanel {
                    plugin_id: handle.plugin_id,
                    instance_id: handle.instance_id,
                    panel,
                });
            }
        }
        Ok(panels)
    }

    pub fn invoke_panel_event(
        &mut self,
        plugin_id: &str,
        field_id: &str,
        value: &str,
    ) -> Result<Option<crate::HostPanel>> {
        let handle = self
            .running
            .get(plugin_id)
            .map(|running| running.handle.clone())
            .ok_or(ManagerErrorCode::InvalidStateTransition)?;
        self.hosts
            .invoke_panel_event(&handle, field_id, value)
            .map_err(|_| ManagerErrorCode::HostInitializationFailed.into())
    }

    fn finish_pending_upgrade(&mut self, plugin_id: &str) -> Result<PluginSnapshot> {
        let pending = self
            .record(plugin_id)?
            .pending
            .clone()
            .ok_or(ManagerErrorCode::InvalidStateTransition)?;
        self.record_mut(plugin_id)?.status = PluginStatus::Updating;
        if let Err(error) = self.preflight(&pending.prepared) {
            return self.abort_pending_upgrade(plugin_id, &pending, error.code());
        }
        let activated = match self.commit_exact(&pending.prepared) {
            Ok(activated) => activated,
            Err(error) => {
                return self.abort_pending_upgrade(plugin_id, &pending, error.code());
            }
        };
        {
            let record = self.record_mut(plugin_id)?;
            record.artifact = activated.clone();
            record.pending = None;
            record.crash_times.clear();
            record.last_error = None;
            record.status = normalized_inactive_status(pending.resume_status);
        }
        if pending.restart_after_activation {
            self.record_mut(plugin_id)?.status = PluginStatus::Starting;
            if let Err(error) = self.start_active(&activated) {
                self.fail_record(plugin_id, error.code())?;
                return Err(error);
            }
            self.record_mut(plugin_id)?.status = PluginStatus::Running;
        }
        self.snapshot(plugin_id)
    }

    fn restore_previous_status(&mut self, plugin_id: &str, pending: &PendingUpgrade) -> Result<()> {
        let inactive_status = normalized_inactive_status(pending.resume_status);
        self.record_mut(plugin_id)?.status = inactive_status;
        if !pending.restart_after_activation {
            return Ok(());
        }
        let artifact = self.record(plugin_id)?.artifact.clone();
        match self.start_active(&artifact) {
            Ok(()) => {
                self.record_mut(plugin_id)?.status = PluginStatus::Running;
                Ok(())
            }
            Err(error) => {
                self.fail_record(plugin_id, error.code())?;
                Err(error)
            }
        }
    }

    fn abort_pending_upgrade(
        &mut self,
        plugin_id: &str,
        pending: &PendingUpgrade,
        cause: ManagerErrorCode,
    ) -> Result<PluginSnapshot> {
        if self.installer.discard(&pending.prepared).is_err() {
            self.fail_record(plugin_id, ManagerErrorCode::InstallationDiscardFailed)?;
            return Err(ManagerErrorCode::InstallationDiscardFailed.into());
        }
        self.record_mut(plugin_id)?.pending = None;
        self.restore_previous_status(plugin_id, pending)?;
        self.record_mut(plugin_id)?.last_error = Some(cause);
        Err(cause.into())
    }

    fn rollback_after_crash_loop(&mut self, plugin_id: &str) -> Result<()> {
        let current = self.record(plugin_id)?.artifact.clone();
        self.record_mut(plugin_id)?.status = PluginStatus::RollingBack;
        let prepared = match self.installer.prepare_rollback(&current) {
            Ok(Some(prepared)) => prepared,
            Ok(None) => {
                self.set_disabled(
                    plugin_id,
                    DisableReason::CrashLoopNoRollback,
                    ManagerErrorCode::RollbackUnavailable,
                )?;
                return Ok(());
            }
            Err(_) => {
                self.set_disabled(
                    plugin_id,
                    DisableReason::RollbackFailed,
                    ManagerErrorCode::RollbackFailed,
                )?;
                return Ok(());
            }
        };
        if self
            .validate_rollback_prepared(&current, &prepared)
            .is_err()
        {
            let _ = self.installer.discard(&prepared);
            self.set_disabled(
                plugin_id,
                DisableReason::RollbackFailed,
                ManagerErrorCode::RollbackFailed,
            )?;
            return Ok(());
        }
        let activated = match self.commit_exact(&prepared) {
            Ok(activated) => activated,
            Err(_) => {
                let _ = self.installer.discard(&prepared);
                self.set_disabled(
                    plugin_id,
                    DisableReason::RollbackFailed,
                    ManagerErrorCode::RollbackFailed,
                )?;
                return Ok(());
            }
        };
        let record = self.record_mut(plugin_id)?;
        record.artifact = activated;
        record.pending = None;
        record.crash_times.clear();
        record.status = PluginStatus::Disabled(DisableReason::CrashLoopRolledBack);
        record.last_error = None;
        Ok(())
    }

    fn start_active(&mut self, artifact: &PluginArtifact) -> Result<()> {
        if self.running.contains_key(&artifact.plugin_id) {
            return Err(ManagerErrorCode::InvalidStateTransition.into());
        }
        let record = self.record_mut(&artifact.plugin_id)?;
        record.generation = record
            .generation
            .checked_add(1)
            .ok_or(ManagerErrorCode::InvalidStateTransition)?;
        let request = self.host_request(artifact, ArtifactSlot::Active, HostLaunchMode::Active)?;
        let handle = self.launch_initialized(&request)?;
        self.running.insert(
            artifact.plugin_id.clone(),
            RunningHost {
                handle,
                started_at_ms: self.clock.now_millis(),
            },
        );
        Ok(())
    }

    fn preflight(&mut self, prepared: &PreparedInstallation) -> Result<()> {
        if self.running.contains_key(&prepared.artifact.plugin_id) {
            return Err(ManagerErrorCode::InvalidStateTransition.into());
        }
        let request = self.host_request(
            &prepared.artifact,
            ArtifactSlot::Prepared(prepared.token.clone()),
            HostLaunchMode::UpdatePreflight,
        )?;
        let handle = self.launch_initialized(&request)?;
        if self.hosts.shutdown(&handle).is_err() {
            self.hosts.terminate(&handle);
            return Err(ManagerErrorCode::HostStopFailed.into());
        }
        Ok(())
    }

    fn launch_initialized(&mut self, request: &HostLaunchRequest) -> Result<HostHandle> {
        let handle = self
            .hosts
            .launch(request)
            .map_err(|_| ManagerErrorCode::HostStartFailed)?;
        if handle.instance_id == 0
            || handle.plugin_id != request.artifact.plugin_id
            || handle.version != request.artifact.version
        {
            self.hosts.terminate(&handle);
            return Err(ManagerErrorCode::HostIdentityInvalid.into());
        }
        if self.hosts.initialize(&handle).is_err() {
            self.hosts.terminate(&handle);
            return Err(ManagerErrorCode::HostInitializationFailed.into());
        }
        Ok(handle)
    }

    fn host_request(
        &self,
        artifact: &PluginArtifact,
        artifact_slot: ArtifactSlot,
        mode: HostLaunchMode,
    ) -> Result<HostLaunchRequest> {
        let workspace_id = self.require_workspace()?.to_owned();
        let granted_permissions = artifact.effective_capabilities.clone();
        Ok(HostLaunchRequest {
            artifact: artifact.clone(),
            artifact_slot,
            workspace_id,
            granted_permissions,
            project_state: self
                .project_states
                .iter()
                .find(|state| state.plugin_id == artifact.plugin_id)
                .map(|state| state.bytes.clone()),
            mode,
        })
    }

    fn stop_running(&mut self, plugin_id: &str) -> Result<()> {
        let Some(running) = self.running.remove(plugin_id) else {
            return Ok(());
        };
        if self.hosts.shutdown(&running.handle).is_err() {
            self.hosts.terminate(&running.handle);
            return Err(ManagerErrorCode::HostStopFailed.into());
        }
        Ok(())
    }

    fn stop_all_for_project_transition(&mut self) {
        let plugin_ids: Vec<_> = self.running.keys().cloned().collect();
        for plugin_id in plugin_ids {
            if let Err(error) = self.stop_running(&plugin_id)
                && let Some(record) = self.records.get_mut(&plugin_id)
            {
                record.last_error = Some(error.code());
            }
        }
    }

    fn discard_all_pending(&mut self) {
        let pending: Vec<_> = self
            .records
            .iter_mut()
            .filter_map(|(plugin_id, record)| {
                record
                    .pending
                    .take()
                    .map(|pending| (plugin_id.clone(), pending.prepared))
            })
            .collect();
        for (plugin_id, prepared) in pending {
            if self.installer.discard(&prepared).is_err()
                && let Some(record) = self.records.get_mut(&plugin_id)
            {
                record.last_error = Some(ManagerErrorCode::InstallationDiscardFailed);
            }
        }
    }

    fn commit_exact(&mut self, prepared: &PreparedInstallation) -> Result<PluginArtifact> {
        let artifact = self
            .installer
            .commit(prepared)
            .map_err(|_| ManagerErrorCode::InstallationCommitFailed)?;
        artifact.validate()?;
        if artifact != prepared.artifact {
            return Err(ManagerErrorCode::InstallationCommitFailed.into());
        }
        Ok(artifact)
    }

    fn validate_initial_prepared(
        &self,
        request: &ManualPackageRequest,
        prepared: &PreparedInstallation,
    ) -> Result<()> {
        prepared.artifact.validate()?;
        if prepared.kind != PreparationKind::InitialInstall
            || prepared.artifact.plugin_id != request.plugin_id
            || prepared.artifact.version != request.version
        {
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }
        Ok(())
    }

    fn validate_upgrade_prepared(
        &self,
        request: &ManualPackageRequest,
        current: &PluginArtifact,
        prepared: &PreparedInstallation,
    ) -> Result<()> {
        prepared.artifact.validate()?;
        if prepared.kind != PreparationKind::ManualUpgrade
            || prepared.artifact.plugin_id != request.plugin_id
            || prepared.artifact.version != request.version
            || prepared.artifact.plugin_id != current.plugin_id
            || prepared.artifact.version()? <= current.version()?
        {
            return Err(ManagerErrorCode::UpdateTargetInvalid.into());
        }
        Ok(())
    }

    fn validate_rollback_prepared(
        &self,
        current: &PluginArtifact,
        prepared: &PreparedInstallation,
    ) -> Result<()> {
        prepared.artifact.validate()?;
        if prepared.kind != PreparationKind::Rollback
            || prepared.artifact.plugin_id != current.plugin_id
            || prepared.artifact.version()? >= current.version()?
        {
            return Err(ManagerErrorCode::RollbackFailed.into());
        }
        Ok(())
    }

    fn require_workspace(&self) -> Result<&str> {
        self.workspace_id
            .as_deref()
            .ok_or_else(|| ManagerError::from(ManagerErrorCode::WorkspaceNotOpen))
    }

    fn record(&self, plugin_id: &str) -> Result<&PluginRecord> {
        self.records
            .get(plugin_id)
            .ok_or_else(|| ManagerError::from(ManagerErrorCode::PluginNotFound))
    }

    fn record_mut(&mut self, plugin_id: &str) -> Result<&mut PluginRecord> {
        self.records
            .get_mut(plugin_id)
            .ok_or_else(|| ManagerError::from(ManagerErrorCode::PluginNotFound))
    }

    fn fail_record(&mut self, plugin_id: &str, code: ManagerErrorCode) -> Result<()> {
        let record = self.record_mut(plugin_id)?;
        record.status = PluginStatus::Failed;
        record.last_error = Some(code);
        Ok(())
    }

    fn set_disabled(
        &mut self,
        plugin_id: &str,
        reason: DisableReason,
        error: ManagerErrorCode,
    ) -> Result<()> {
        let record = self.record_mut(plugin_id)?;
        record.status = PluginStatus::Disabled(reason);
        record.last_error = Some(error);
        Ok(())
    }
}

fn normalized_inactive_status(previous: PluginStatus) -> PluginStatus {
    match previous {
        PluginStatus::Disabled(reason) => PluginStatus::Disabled(reason),
        _ => PluginStatus::Stopped,
    }
}

fn crash_error_code(kind: crate::CrashKind) -> ManagerErrorCode {
    match kind {
        crate::CrashKind::ProcessCrash => ManagerErrorCode::HostCrashed,
        crate::CrashKind::MemoryLimit => ManagerErrorCode::HostMemoryLimit,
        crate::CrashKind::ExecutionTimeout => ManagerErrorCode::HostExecutionTimeout,
        crate::CrashKind::ProtocolFailure => ManagerErrorCode::HostProtocolFailure,
    }
}
