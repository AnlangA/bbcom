use std::collections::{BTreeMap, BTreeSet};

use bbcom_plugin_contracts::{AuthorizationKey, MAX_FRAME_BYTES, MAX_QUEUE_BYTES, Permission};

use crate::{
    AuditEvent, AuditOperation, AuditSink, BrokerError, Result, validate_authorization_key,
};

pub const SERIAL_PROPOSAL_TTL_MS: u64 = 60_000;
const MAX_CONTEXT_ID_BYTES: usize = 128;
const MAX_DISPLAY_LABEL_BYTES: usize = 128;
const HEX_PREVIEW_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SerialProposalRequest {
    pub operation_id: String,
    pub session_id: String,
    pub payload: Vec<u8>,
    pub display_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SerialProposalView {
    pub proposal_id: String,
    pub plugin_id: String,
    pub operation_id: String,
    pub session_id: String,
    pub display_label: String,
    pub byte_count: usize,
    pub hex_preview: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalContext {
    pub operation_id: String,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalDecision {
    Approve,
    Reject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoActionReason {
    Rejected,
    Expired,
    ContextChanged,
    UnknownOrConsumed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrokerAction {
    SerialSend {
        proposal_id: String,
        plugin_id: String,
        operation_id: String,
        session_id: String,
        payload: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProposalResolution {
    Action(BrokerAction),
    NoAction(NoActionReason),
}

struct PendingProposal {
    view: SerialProposalView,
    payload: Vec<u8>,
}

pub struct SerialProposalBroker<'a, A> {
    audit: &'a A,
    pending: BTreeMap<String, PendingProposal>,
    queued_bytes: usize,
    next_id: u64,
}

impl<'a, A: AuditSink> SerialProposalBroker<'a, A> {
    #[must_use]
    pub fn new(audit: &'a A) -> Self {
        Self {
            audit,
            pending: BTreeMap::new(),
            queued_bytes: 0,
            next_id: 1,
        }
    }

    pub fn create(
        &mut self,
        key: &AuthorizationKey,
        declared: &BTreeSet<Permission>,
        request: SerialProposalRequest,
        now_ms: u64,
    ) -> Result<SerialProposalView> {
        validate_authorization_key(key)?;
        if !declared.contains(&Permission::SerialWriteProposal) {
            return self.fail_create(
                key,
                BrokerError::CapabilityUndeclared,
                request.payload.len(),
            );
        }
        if !valid_context_id(&request.operation_id)
            || !valid_context_id(&request.session_id)
            || request.payload.is_empty()
            || request.payload.len() > MAX_FRAME_BYTES
            || request.display_label.is_empty()
            || request.display_label.len() > MAX_DISPLAY_LABEL_BYTES
            || unsafe_text(&request.display_label)
        {
            return self.fail_create(key, BrokerError::ProposalInvalid, request.payload.len());
        }
        let next_queue = self
            .queued_bytes
            .checked_add(request.payload.len())
            .ok_or(BrokerError::ProposalQueueLimit)?;
        if next_queue > MAX_QUEUE_BYTES {
            return self.fail_create(key, BrokerError::ProposalQueueLimit, request.payload.len());
        }
        let proposal_id = format!("proposal-{now_ms:016x}-{:016x}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        let view = SerialProposalView {
            proposal_id: proposal_id.clone(),
            plugin_id: key.plugin_id.clone(),
            operation_id: request.operation_id,
            session_id: request.session_id,
            display_label: request.display_label,
            byte_count: request.payload.len(),
            hex_preview: hex_preview(&request.payload),
            expires_at_ms: now_ms.saturating_add(SERIAL_PROPOSAL_TTL_MS),
        };
        self.pending.insert(
            proposal_id,
            PendingProposal {
                view: view.clone(),
                payload: request.payload,
            },
        );
        self.queued_bytes = next_queue;
        self.audit.record(AuditEvent {
            plugin_id: key.plugin_id.clone(),
            operation: AuditOperation::SerialProposalCreate,
            error_code: None,
            byte_count: view.byte_count as u64,
        });
        Ok(view)
    }

    /// Resolve exactly once. Rejection, expiration, a changed operation/session,
    /// or replay returns `NoAction`; none of those paths can reach serial code.
    pub fn resolve(
        &mut self,
        proposal_id: &str,
        decision: ProposalDecision,
        current: &ProposalContext,
        now_ms: u64,
    ) -> ProposalResolution {
        let Some(pending) = self.pending.remove(proposal_id) else {
            return ProposalResolution::NoAction(NoActionReason::UnknownOrConsumed);
        };
        self.queued_bytes = self.queued_bytes.saturating_sub(pending.payload.len());
        let reason = if now_ms >= pending.view.expires_at_ms {
            Some(NoActionReason::Expired)
        } else if decision == ProposalDecision::Reject {
            Some(NoActionReason::Rejected)
        } else if current.operation_id != pending.view.operation_id
            || current.session_id != pending.view.session_id
        {
            Some(NoActionReason::ContextChanged)
        } else {
            None
        };
        self.audit.record(AuditEvent {
            plugin_id: pending.view.plugin_id.clone(),
            operation: AuditOperation::SerialProposalResolve,
            error_code: reason.map(|_| BrokerError::PermissionDenied.code()),
            byte_count: pending.payload.len() as u64,
        });
        if let Some(reason) = reason {
            return ProposalResolution::NoAction(reason);
        }
        ProposalResolution::Action(BrokerAction::SerialSend {
            proposal_id: pending.view.proposal_id,
            plugin_id: pending.view.plugin_id,
            operation_id: pending.view.operation_id,
            session_id: pending.view.session_id,
            payload: pending.payload,
        })
    }

    #[must_use]
    pub const fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }

    fn fail_create<T>(
        &self,
        key: &AuthorizationKey,
        error: BrokerError,
        byte_count: usize,
    ) -> Result<T> {
        self.audit.record(AuditEvent {
            plugin_id: key.plugin_id.clone(),
            operation: AuditOperation::SerialProposalCreate,
            error_code: Some(error.code()),
            byte_count: byte_count as u64,
        });
        Err(error)
    }
}

fn hex_preview(payload: &[u8]) -> String {
    let shown = payload.len().min(HEX_PREVIEW_BYTES);
    let mut preview = String::with_capacity(shown.saturating_mul(3).saturating_add(24));
    for (index, byte) in payload[..shown].iter().enumerate() {
        if index != 0 {
            preview.push(' ');
        }
        use std::fmt::Write;
        let _ = write!(preview, "{byte:02X}");
    }
    if payload.len() > shown {
        use std::fmt::Write;
        let _ = write!(preview, " … (+{} bytes)", payload.len() - shown);
    }
    preview
}

fn valid_context_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CONTEXT_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn unsafe_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.chars().any(char::is_control)
        || value.contains('<')
        || value.contains('>')
        || lower.contains("://")
        || lower.contains("javascript:")
        || lower.contains("file:")
}
