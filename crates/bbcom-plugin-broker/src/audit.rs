use crate::BrokerErrorCode;

/// Fixed audit vocabulary. It intentionally cannot represent payloads, AI
/// content, tokens, filesystem paths, publisher metadata, or device handles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditOperation {
    PanelPublish,
    PanelEvent,
    SerialProposalCreate,
    SerialProposalResolve,
    InvocationValidate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEvent {
    pub plugin_id: String,
    pub operation: AuditOperation,
    pub error_code: Option<BrokerErrorCode>,
    pub byte_count: u64,
}

pub trait AuditSink: Send + Sync {
    fn record(&self, event: AuditEvent);
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoopAuditSink;

impl AuditSink for NoopAuditSink {
    fn record(&self, _event: AuditEvent) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_gate_executes_noop_audit_sink_without_sensitive_output() {
        NoopAuditSink.record(AuditEvent {
            plugin_id: "dev.bbcom.coverage".to_owned(),
            operation: AuditOperation::InvocationValidate,
            error_code: None,
            byte_count: 0,
        });
    }
}
