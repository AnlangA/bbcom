use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use bbcom_plugin_contracts::generated::{PluginStorageEntry, PluginStorageSnapshot};
use bbcom_plugin_contracts::generated::{
    CaptureReadQuery, SerialProposalEvent, SessionListQuery, SessionQueryRequest,
};
use bbcom_plugin_contracts::{
    MAX_PLUGIN_PERSISTED_STATE_BYTES, PLUGIN_STATE_SCHEMA_VERSION, Permission,
};
use prost::Message;
use wasmtime::{ResourceLimiter, StoreLimits, StoreLimitsBuilder};

use crate::bindings::bbcom::plugin::host::Host;
use crate::bindings::bbcom::plugin::types::{
    CaptureFrame, CapturePage, ContractError, DeclarativePanel, FrameDirection, ProposalResult,
    ProposalStatus, SerialSendProposal, SessionMetadata,
};
use crate::uplink::{ProposalOutcome, Uplink};

impl crate::bindings::bbcom::plugin::types::Host for StoreState {}

const MAX_STORAGE_KEY_BYTES: usize = 256;
const MAX_CAPTURE_PAGE_FRAMES: u32 = 256;
const MAX_CAPTURE_PAGE_BYTES: u32 = 512 * 1024;
/// Bounded wait for main-process session/capture data.
const SESSION_QUERY_TIMEOUT_MS: u64 = 10_000;

pub(crate) struct StoreState {
    pub limits: TrackingLimits,
    permissions: BTreeSet<Permission>,
    storage: BTreeMap<String, Vec<u8>>,
    storage_bytes: usize,
    project_state: Option<Vec<u8>>,
    sessions: Vec<SessionMetadata>,
    published_panel: Option<DeclarativePanel>,
    next_proposal_id: u64,
    next_query_id: u64,
    /// When absent (unit-test / example embedders) the data-dependent host
    /// imports keep their historical pure-local behavior.
    uplink: Option<Arc<Uplink>>,
}

impl StoreState {
    pub fn new(limits: TrackingLimits, permissions: BTreeSet<Permission>) -> Self {
        Self {
            limits,
            permissions,
            storage: BTreeMap::new(),
            storage_bytes: 0,
            project_state: None,
            sessions: Vec::new(),
            published_panel: None,
            next_proposal_id: 1,
            next_query_id: 1,
            uplink: None,
        }
    }

    pub fn with_uplink(mut self, uplink: Arc<Uplink>) -> Self {
        self.uplink = Some(uplink);
        self
    }

    fn next_query_id(&mut self) -> u64 {
        let id = self.next_query_id;
        self.next_query_id = self.next_query_id.saturating_add(1);
        id
    }

    /// Drains the most recently published panel (initialize return value or
    /// an explicit publish) for embedders and tests.
    pub fn take_published_panel(&mut self) -> Option<DeclarativePanel> {
        self.published_panel.take()
    }

    pub fn publish_returned_panel(&mut self, panel: DeclarativePanel) {
        self.published_panel = Some(panel);
    }

    pub fn restore_persisted_state(
        &mut self,
        plugin_storage: &[u8],
        project_state: Option<Vec<u8>>,
    ) -> Result<(), ContractError> {
        if plugin_storage
            .len()
            .saturating_add(project_state.as_ref().map_or(0, Vec::len))
            > MAX_PLUGIN_PERSISTED_STATE_BYTES
        {
            return Err(ContractError::LimitExceeded);
        }
        let snapshot = PluginStorageSnapshot::decode(plugin_storage)
            .map_err(|_| ContractError::InvalidInput)?;
        if snapshot.state_schema_version != PLUGIN_STATE_SCHEMA_VERSION {
            return Err(ContractError::InvalidInput);
        }
        let mut storage = BTreeMap::new();
        let mut storage_bytes = 0usize;
        for PluginStorageEntry { key, value } in snapshot.entries {
            if key.is_empty() || key.len() > MAX_STORAGE_KEY_BYTES || storage.contains_key(&key) {
                return Err(ContractError::InvalidInput);
            }
            storage_bytes = storage_bytes
                .checked_add(value.len())
                .ok_or(ContractError::LimitExceeded)?;
            storage.insert(key, value);
        }
        if storage_bytes.saturating_add(project_state.as_ref().map_or(0, Vec::len))
            > MAX_PLUGIN_PERSISTED_STATE_BYTES
        {
            return Err(ContractError::LimitExceeded);
        }
        self.storage = storage;
        self.storage_bytes = storage_bytes;
        self.project_state = project_state;
        Ok(())
    }

    #[must_use]
    pub fn persisted_state(&self) -> (Vec<u8>, Option<Vec<u8>>) {
        let storage = encode_plugin_storage(&self.storage);
        (storage, self.project_state.clone())
    }

    fn has(&self, permission: Permission) -> bool {
        permission.is_implicit() || self.permissions.contains(&permission)
    }
}

pub(crate) struct TrackingLimits {
    inner: StoreLimits,
    memory_limit_bytes: usize,
    memory_limit_hit: bool,
}

impl TrackingLimits {
    pub fn fixed(memory_limit_bytes: usize) -> Self {
        Self {
            inner: StoreLimitsBuilder::new()
                .memory_size(memory_limit_bytes)
                .table_elements(65_536)
                .instances(64)
                .tables(64)
                .memories(1)
                .trap_on_grow_failure(true)
                .build(),
            memory_limit_bytes,
            memory_limit_hit: false,
        }
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) const fn memory_limit_bytes(&self) -> usize {
        self.memory_limit_bytes
    }

    #[must_use]
    pub const fn memory_limit_hit(&self) -> bool {
        self.memory_limit_hit
    }

    pub fn reset_memory_limit_hit(&mut self) {
        self.memory_limit_hit = false;
    }
}

impl ResourceLimiter for TrackingLimits {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.memory_limit_bytes {
            self.memory_limit_hit = true;
        }
        self.inner.memory_growing(current, desired, maximum)
    }

    fn memory_grow_failed(&mut self, error: wasmtime::Error) -> wasmtime::Result<()> {
        self.inner.memory_grow_failed(error)
    }

    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        self.inner.table_growing(current, desired, maximum)
    }

    fn table_grow_failed(&mut self, error: wasmtime::Error) -> wasmtime::Result<()> {
        self.inner.table_grow_failed(error)
    }

    fn instances(&self) -> usize {
        self.inner.instances()
    }

    fn tables(&self) -> usize {
        self.inner.tables()
    }

    fn memories(&self) -> usize {
        self.inner.memories()
    }
}

impl Host for StoreState {
    fn storage_get(&mut self, key: String) -> Result<Option<Vec<u8>>, ContractError> {
        if key.is_empty() || key.len() > MAX_STORAGE_KEY_BYTES {
            return Err(ContractError::InvalidInput);
        }
        Ok(self.storage.get(&key).cloned())
    }

    fn storage_set(&mut self, key: String, value: Vec<u8>) -> Result<(), ContractError> {
        if key.is_empty() || key.len() > MAX_STORAGE_KEY_BYTES {
            return Err(ContractError::InvalidInput);
        }
        let old = self.storage.get(&key).map_or(0, Vec::len);
        let next = self
            .storage_bytes
            .saturating_sub(old)
            .checked_add(value.len())
            .ok_or(ContractError::LimitExceeded)?;
        let mut candidate = self.storage.clone();
        candidate.insert(key.clone(), value.clone());
        if encode_plugin_storage(&candidate)
            .len()
            .saturating_add(self.project_state.as_ref().map_or(0, Vec::len))
            > MAX_PLUGIN_PERSISTED_STATE_BYTES
        {
            return Err(ContractError::LimitExceeded);
        }
        self.storage.insert(key, value);
        self.storage_bytes = next;
        Ok(())
    }

    fn session_list(&mut self) -> Result<Vec<SessionMetadata>, ContractError> {
        if !self.has(Permission::SessionMetadataRead) {
            return Err(ContractError::PermissionDenied);
        }
        let Some(uplink) = self.uplink.clone() else {
            return Ok(self.sessions.clone());
        };
        let query_id = format!("session-list-{}", self.next_query_id());
        let request = SessionQueryRequest {
            plugin_id: uplink.plugin_id().to_owned(),
            query_id,
            query: Some(bbcom_plugin_contracts::generated::session_query_request::Query::List(
                SessionListQuery {},
            )),
        };
        let response = uplink
            .request_session_query(request, Duration::from_millis(SESSION_QUERY_TIMEOUT_MS))
            .map_err(|_| ContractError::Unavailable)?
            .ok_or(ContractError::Unavailable)?;
        if !response.ok {
            return Err(query_error(&response.error_code));
        }
        Ok(response
            .sessions
            .iter()
            .map(|entry| SessionMetadata {
                session_id: entry.session_id.clone(),
                name: entry.name.clone(),
                kind: entry.kind.clone(),
                connected: entry.connected,
                rx_bytes: entry.rx_bytes,
                tx_bytes: entry.tx_bytes,
            })
            .collect())
    }

    fn capture_read(
        &mut self,
        session_id: String,
        from_sequence: u64,
        max_frames: u32,
        max_bytes: u32,
    ) -> Result<CapturePage, ContractError> {
        if !self.has(Permission::SessionCaptureRead) {
            return Err(ContractError::PermissionDenied);
        }
        if max_frames == 0
            || max_frames > MAX_CAPTURE_PAGE_FRAMES
            || max_bytes == 0
            || max_bytes > MAX_CAPTURE_PAGE_BYTES
        {
            return Err(ContractError::LimitExceeded);
        }
        let Some(uplink) = self.uplink.clone() else {
            // No parent process (unit embedders): no capture material.
            return Ok(CapturePage {
                frames: Vec::new(),
                next_sequence: None,
            });
        };
        let request = SessionQueryRequest {
            plugin_id: uplink.plugin_id().to_owned(),
            query_id: format!("capture-{}", self.next_query_id()),
            query: Some(bbcom_plugin_contracts::generated::session_query_request::Query::Capture(
                CaptureReadQuery {
                    session_id,
                    from_sequence,
                    max_frames,
                    max_bytes,
                },
            )),
        };
        let response = uplink
            .request_session_query(request, Duration::from_millis(SESSION_QUERY_TIMEOUT_MS))
            .map_err(|_| ContractError::Unavailable)?
            .ok_or(ContractError::Unavailable)?;
        if !response.ok {
            return Err(query_error(&response.error_code));
        }
        Ok(CapturePage {
            frames: response
                .frames
                .iter()
                .map(|frame| CaptureFrame {
                    sequence: frame.sequence,
                    timestamp_ms: frame.timestamp_ms,
                    direction: if frame.tx {
                        FrameDirection::Tx
                    } else {
                        FrameDirection::Rx
                    },
                    payload: frame.payload.clone(),
                })
                .collect(),
            next_sequence: response.has_more.then_some(response.next_sequence),
        })
    }

    fn project_state_get(&mut self) -> Result<Option<Vec<u8>>, ContractError> {
        if !self.has(Permission::ProjectSettingsReadWrite) {
            return Err(ContractError::PermissionDenied);
        }
        Ok(self.project_state.clone())
    }

    fn project_state_set(&mut self, value: Vec<u8>) -> Result<(), ContractError> {
        if !self.has(Permission::ProjectSettingsReadWrite) {
            return Err(ContractError::PermissionDenied);
        }
        if value
            .len()
            .saturating_add(encode_plugin_storage(&self.storage).len())
            > MAX_PLUGIN_PERSISTED_STATE_BYTES
        {
            return Err(ContractError::LimitExceeded);
        }
        self.project_state = Some(value);
        Ok(())
    }

    fn propose_serial_send(
        &mut self,
        proposal: SerialSendProposal,
    ) -> Result<ProposalResult, ContractError> {
        if !self.has(Permission::SerialWriteProposal) {
            return Err(ContractError::PermissionDenied);
        }
        if proposal.session_id.is_empty()
            || proposal.payload.is_empty()
            || proposal.payload.len() > bbcom_plugin_contracts::MAX_FRAME_BYTES
            || proposal.display_label.is_empty()
        {
            return Err(ContractError::InvalidInput);
        }
        let proposal_number = self.next_proposal_id;
        self.next_proposal_id = self.next_proposal_id.saturating_add(1);
        let proposal_id = format!("proposal-{proposal_number}");
        let Some(uplink) = self.uplink.clone() else {
            return Ok(ProposalResult {
                proposal_id,
                status: ProposalStatus::PendingUserConfirmation,
            });
        };
        // Forward to the trusted main process and park this guest call until
        // the user decision (or the broker TTL) resolves it. The parked call
        // blocks only this plugin's own host loop, matching the per-plugin
        // process isolation model.
        let event = SerialProposalEvent {
            plugin_id: uplink.plugin_id().to_owned(),
            proposal_id: proposal_id.clone(),
            operation_id: format!("sidecar-proposal-{proposal_number}"),
            session_id: proposal.session_id,
            display_label: proposal.display_label,
            payload: proposal.payload,
        };
        let outcome = uplink
            .request_proposal_outcome(event)
            .map_err(|_| ContractError::Unavailable)?;
        let status = match outcome {
            Some(ProposalOutcome::Approved) => ProposalStatus::Accepted,
            Some(ProposalOutcome::Rejected) => ProposalStatus::Rejected,
            // TTL expiry, main shutdown, or unknown — the WIT contract maps
            // all of them to the cancelled status the guest understands.
            Some(ProposalOutcome::Expired) | None => ProposalStatus::Cancelled,
        };
        Ok(ProposalResult {
            proposal_id,
            status,
        })
    }

    fn publish_panel(&mut self, panel: DeclarativePanel) -> Result<(), ContractError> {
        if panel.title.is_empty() || panel.fields.len() > 256 {
            return Err(ContractError::LimitExceeded);
        }
        self.published_panel = Some(panel);
        Ok(())
    }
}

/// Map a main-process query error name onto the WIT contract error. Unknown
/// names degrade to `unavailable` rather than leaking error text.
fn query_error(code: &str) -> ContractError {
    match code {
        "permission-denied" => ContractError::PermissionDenied,
        "invalid-input" | "not-found" => ContractError::InvalidInput,
        "limit-exceeded" => ContractError::LimitExceeded,
        _ => ContractError::Unavailable,
    }
}

fn encode_plugin_storage(storage: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    PluginStorageSnapshot {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        entries: storage
            .iter()
            .map(|(key, value)| PluginStorageEntry {
                key: key.clone(),
                value: value.clone(),
            })
            .collect(),
    }
    .encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(permissions: impl IntoIterator<Item = Permission>) -> StoreState {
        StoreState::new(
            TrackingLimits::fixed(64 * 1024),
            permissions.into_iter().collect(),
        )
    }

    fn proposal() -> SerialSendProposal {
        SerialSendProposal {
            session_id: "session-1".to_owned(),
            payload: vec![0x01, 0x02],
            display_label: "diagnostic".to_owned(),
        }
    }

    #[test]
    fn host_storage_and_project_state_are_bounded_and_permission_scoped() {
        let mut denied = state([]);
        assert_eq!(
            denied.storage_get(String::new()),
            Err(ContractError::InvalidInput)
        );
        assert_eq!(
            denied.storage_set("x".repeat(MAX_STORAGE_KEY_BYTES + 1), Vec::new()),
            Err(ContractError::InvalidInput)
        );
        denied.storage_set("key".to_owned(), vec![1, 2, 3]).unwrap();
        denied.storage_set("key".to_owned(), vec![4]).unwrap();
        assert_eq!(denied.storage_get("key".to_owned()).unwrap(), Some(vec![4]));
        assert_eq!(
            denied.storage_set(
                "large".to_owned(),
                vec![0; MAX_PLUGIN_PERSISTED_STATE_BYTES],
            ),
            Err(ContractError::LimitExceeded)
        );
        assert_eq!(
            denied.project_state_get(),
            Err(ContractError::PermissionDenied)
        );
        assert_eq!(
            denied.project_state_set(vec![1]),
            Err(ContractError::PermissionDenied)
        );

        let mut allowed = state([Permission::ProjectSettingsReadWrite]);
        allowed.project_state_set(vec![7, 8]).unwrap();
        assert_eq!(allowed.project_state_get().unwrap(), Some(vec![7, 8]));
        assert_eq!(
            allowed.project_state_set(vec![0; MAX_PLUGIN_PERSISTED_STATE_BYTES + 1]),
            Err(ContractError::LimitExceeded)
        );
    }

    #[test]
    fn sensitive_host_calls_deny_by_default_and_validate_every_request() {
        let mut denied = state([]);
        assert_eq!(
            denied.session_list().err(),
            Some(ContractError::PermissionDenied)
        );
        assert_eq!(
            denied.capture_read("session-1".to_owned(), 0, 1, 1).err(),
            Some(ContractError::PermissionDenied)
        );
        assert_eq!(
            denied.propose_serial_send(proposal()).err(),
            Some(ContractError::PermissionDenied)
        );

        let mut allowed = state([
            Permission::SessionMetadataRead,
            Permission::SessionCaptureRead,
            Permission::SerialWriteProposal,
        ]);
        assert!(allowed.session_list().unwrap().is_empty());
        assert_eq!(
            allowed.capture_read("session-1".to_owned(), 0, 0, 1).err(),
            Some(ContractError::LimitExceeded)
        );
        let page = allowed
            .capture_read(
                "session-1".to_owned(),
                0,
                MAX_CAPTURE_PAGE_FRAMES,
                MAX_CAPTURE_PAGE_BYTES,
            )
            .unwrap();
        assert!(page.frames.is_empty());
        assert!(page.next_sequence.is_none());
        let mut invalid = proposal();
        invalid.payload.clear();
        assert_eq!(
            allowed.propose_serial_send(invalid).err(),
            Some(ContractError::InvalidInput)
        );
        assert_eq!(
            allowed.propose_serial_send(proposal()).unwrap().proposal_id,
            "proposal-1"
        );
        assert_eq!(
            allowed.propose_serial_send(proposal()).unwrap().proposal_id,
            "proposal-2"
        );
    }

    #[test]
    fn panels_and_resource_limits_are_fail_closed() {
        let mut state = state([]);
        let invalid = DeclarativePanel {
            title: String::new(),
            fields: Vec::new(),
        };
        assert_eq!(
            state.publish_panel(invalid),
            Err(ContractError::LimitExceeded)
        );
        let panel = DeclarativePanel {
            title: "Panel".to_owned(),
            fields: Vec::new(),
        };
        state.publish_panel(panel.clone()).unwrap();
        state.publish_returned_panel(panel);

        assert!(!state.limits.memory_limit_hit());
        assert!(state.limits.memory_growing(0, 64 * 1024, None).unwrap());
        assert!(state.limits.memory_growing(0, 64 * 1024 + 1, None).is_err());
        assert!(state.limits.memory_limit_hit());
        state.limits.reset_memory_limit_hit();
        assert!(!state.limits.memory_limit_hit());
        assert!(state.limits.table_growing(0, 1, None).unwrap());
        assert_eq!(state.limits.instances(), 64);
        assert_eq!(state.limits.tables(), 64);
        assert_eq!(state.limits.memories(), 1);
    }
}
