use std::collections::BTreeSet;
use std::sync::Mutex;
use std::time::Duration;

use bbcom_plugin_broker::{
    AuditEvent, AuditSink, BROKER_LONG_TIMEOUT_MS, BROKER_NORMAL_TIMEOUT_MS, BrokerAction,
    BrokerError, DeclarativePanel, DeclarativePanelBroker, InvocationClass, NoActionReason,
    PanelControlKind, PanelEvent, PanelField, ProposalContext, ProposalDecision,
    ProposalResolution, SerialProposalBroker, SerialProposalRequest, validate_invocation,
    validate_panel,
};
use bbcom_plugin_contracts::{MAX_FRAME_BYTES, MAX_QUEUE_BYTES, Permission};

#[derive(Default)]
struct MemoryAuditSink(Mutex<Vec<AuditEvent>>);

impl AuditSink for MemoryAuditSink {
    fn record(&self, event: AuditEvent) {
        self.0.lock().unwrap().push(event);
    }
}

fn declared(values: &[Permission]) -> BTreeSet<Permission> {
    values.iter().copied().collect()
}

#[test]
fn serial_proposals_require_declaration_and_are_context_bound() {
    let audit = MemoryAuditSink::default();
    let mut broker = SerialProposalBroker::new(&audit);
    let request = SerialProposalRequest {
        operation_id: "operation-1".to_owned(),
        session_id: "session-1".to_owned(),
        payload: vec![0x01, 0x02],
        display_label: "write two bytes".to_owned(),
    };
    assert_eq!(
        broker.create("dev.bbcom.fixture", &BTreeSet::new(), request.clone(), 10),
        Err(BrokerError::CapabilityUndeclared)
    );
    let view = broker
        .create(
            "dev.bbcom.fixture",
            &declared(&[Permission::SerialWriteProposal]),
            request,
            10,
        )
        .unwrap();
    assert!(matches!(
        broker.resolve(
            &view.proposal_id,
            ProposalDecision::Approve,
            &ProposalContext {
                operation_id: "operation-1".to_owned(),
                session_id: "session-1".to_owned(),
            },
            11,
        ),
        ProposalResolution::Action(BrokerAction::SerialSend { .. })
    ));
    assert_eq!(
        broker.resolve(
            &view.proposal_id,
            ProposalDecision::Approve,
            &ProposalContext {
                operation_id: "operation-1".to_owned(),
                session_id: "session-1".to_owned(),
            },
            12,
        ),
        ProposalResolution::NoAction(NoActionReason::UnknownOrConsumed)
    );
}

#[test]
fn declarative_panels_are_validated_and_bound_to_plugin_id() {
    let audit = MemoryAuditSink::default();
    let broker = DeclarativePanelBroker::new(&audit);
    let panel = DeclarativePanel {
        title: "Counter".to_owned(),
        fields: vec![PanelField {
            id: "increment".to_owned(),
            label: "Increment".to_owned(),
            kind: PanelControlKind::Button,
            value: String::new(),
            options: Vec::new(),
            disabled: false,
        }],
    };
    assert!(validate_panel(&panel).is_ok());
    let hosted = broker.publish("dev.bbcom.fixture", panel).unwrap();
    let action = broker
        .event(
            &hosted,
            PanelEvent {
                field_id: "increment".to_owned(),
                value: String::new(),
            },
        )
        .unwrap();
    assert_eq!(action.plugin_id, "dev.bbcom.fixture");
}

#[test]
fn invocation_limits_remain_bounded() {
    const {
        assert!(BROKER_NORMAL_TIMEOUT_MS > 0);
        assert!(BROKER_LONG_TIMEOUT_MS >= BROKER_NORMAL_TIMEOUT_MS);
    }
    assert!(
        validate_invocation(
            MAX_FRAME_BYTES,
            MAX_QUEUE_BYTES,
            InvocationClass::Normal,
            Duration::from_millis(BROKER_NORMAL_TIMEOUT_MS),
        )
        .is_ok()
    );
}
