use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    HostHandle, HostLaunchRequest, HostPanel, ManualPackageRequest, PluginArtifact,
    PreparedInstallation,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstallationFailure;

/// Repository and installation boundary.
///
/// `prepare_manual` must download and verify a package into private staging.
/// For an update it must also copy the current plugin data into staging; any
/// migration or first-run writes happen only against that copy. It must not
/// alter the active package or active data.
///
/// `prepare_rollback` must stage the selected verified previous package and
/// its matching pre-upgrade data snapshot. It returns `None` only when no
/// eligible candidate exists.
///
/// `commit` is one logical atomic activation: after success both the selected
/// package and its staged data are active; after failure neither is active.
/// Its returned descriptor must exactly equal `prepared.artifact`.
pub trait InstallationPort {
    fn prepare_manual(
        &mut self,
        request: &ManualPackageRequest,
        current: Option<&PluginArtifact>,
    ) -> std::result::Result<PreparedInstallation, InstallationFailure>;

    fn prepare_rollback(
        &mut self,
        current: &PluginArtifact,
    ) -> std::result::Result<Option<PreparedInstallation>, InstallationFailure>;

    fn commit(
        &mut self,
        prepared: &PreparedInstallation,
    ) -> std::result::Result<PluginArtifact, InstallationFailure>;

    fn discard(
        &mut self,
        prepared: &PreparedInstallation,
    ) -> std::result::Result<(), InstallationFailure>;

    /// Development-mode local install: stages a package from a user-selected
    /// local directory. The native implementation enforces the manifest's
    /// component digest but no repository or publisher-signature boundary.
    fn prepare_local(
        &mut self,
        package_root: &std::path::Path,
        current: Option<&PluginArtifact>,
    ) -> std::result::Result<PreparedInstallation, InstallationFailure>;

    /// Removes one plugin's durable installation (packages, history, and
    /// staged private data). Stopping hosts and clearing grants or persisted
    /// state stays the caller's responsibility.
    fn remove_installed(
        &mut self,
        artifact: &PluginArtifact,
    ) -> std::result::Result<(), InstallationFailure>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostFailure {
    Launch,
    Handshake,
    Initialization,
    Shutdown,
    Transport,
    SandboxUnavailable,
}

/// Native host boundary.
///
/// Every successful `launch` must create one new native host process dedicated
/// to the requested plugin and one new Wasmtime Component Store owned only by
/// that process. The implementation must apply the fixed G41 sandbox, memory,
/// fuel, epoch, and timeout policy. It must never multiplex plugins. For
/// `ArtifactSlot::Prepared`, plugin storage must resolve only to the staged
/// private data copy; successful initialization must not mutate active data.
pub trait HostLauncher {
    fn launch(
        &mut self,
        request: &HostLaunchRequest,
    ) -> std::result::Result<HostHandle, HostFailure>;

    fn initialize(&mut self, handle: &HostHandle) -> std::result::Result<(), HostFailure>;

    fn shutdown(&mut self, handle: &HostHandle) -> std::result::Result<(), HostFailure>;

    fn take_published_panel(
        &mut self,
        _handle: &HostHandle,
    ) -> std::result::Result<Option<HostPanel>, HostFailure> {
        Ok(None)
    }

    fn invoke_panel_event(
        &mut self,
        _handle: &HostHandle,
        _field_id: &str,
        _value: &str,
    ) -> std::result::Result<Option<HostPanel>, HostFailure> {
        Err(HostFailure::Transport)
    }

    /// Forcefully terminates an instance after graceful shutdown or protocol
    /// handling failed. This operation must be idempotent.
    fn terminate(&mut self, handle: &HostHandle);

    /// Push an unsolicited envelope to the sidecar (proposal decisions,
    /// session-query data) for a guest call parked inside the plugin's own
    /// host process. The default fails closed: embedders without a real
    /// sidecar never accept pushes.
    fn deliver_envelope(
        &mut self,
        _handle: &HostHandle,
        _payload: bbcom_plugin_contracts::generated::envelope::Payload,
    ) -> std::result::Result<(), HostFailure> {
        Err(HostFailure::Transport)
    }

    /// Stream sidecar-initiated push requests (serial write proposals, G43
    /// session/capture queries) into the application. The default drops
    /// them: embedders without the pipeline keep the old behavior.
    fn attach_push_sink(&mut self, _sink: std::sync::Arc<dyn HostPushSink>) {}
}

/// Receiver for sidecar push requests routed out of the host reader thread.
pub trait HostPushSink: Send + Sync + 'static {
    fn serial_proposal(&self, event: bbcom_plugin_contracts::generated::SerialProposalEvent);
    fn session_query(
        &self,
        request: bbcom_plugin_contracts::generated::SessionQueryRequest,
    ) -> bbcom_plugin_contracts::generated::SessionQueryResponse;
}

pub trait Clock {
    fn now_millis(&self) -> u64;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> u64 {
        u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_reports_unix_milliseconds() {
        assert!(SystemClock.now_millis() > 0);
    }
}
