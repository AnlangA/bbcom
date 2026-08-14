use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::Duration;

use bbcom_plugin_broker::{
    AuditEvent, AuditOperation, AuditSink, AuthorizationBroker, AuthorizationGeneration,
    AuthorizationReview, AuthorizationState, AuthorizationStore, AuthorizationStoreError,
    BROKER_LONG_TIMEOUT_MS, BROKER_NORMAL_TIMEOUT_MS, BrokerAction, BrokerError, BrokerErrorCode,
    DeclarativePanel, DeclarativePanelBroker, ExtraConfirmationReason, InvocationClass,
    NoActionReason, PanelControlKind, PanelEvent, PanelField, ProposalContext, ProposalDecision,
    ProposalResolution, SerialProposalBroker, SerialProposalRequest, validate_authorization_key,
    validate_invocation, validate_panel, validate_panel_event,
};
use bbcom_plugin_contracts::{AuthorizationKey, MAX_FRAME_BYTES, MAX_QUEUE_BYTES, Permission};

#[derive(Default)]
struct MemoryAuthorizationStore {
    states: Mutex<BTreeMap<(AuthorizationKey, Permission), AuthorizationState>>,
    fail: Mutex<bool>,
}

impl AuthorizationStore for MemoryAuthorizationStore {
    fn state(
        &self,
        key: &AuthorizationKey,
        permission: Permission,
    ) -> std::result::Result<AuthorizationState, AuthorizationStoreError> {
        if *self.fail.lock().unwrap() {
            return Err(AuthorizationStoreError);
        }
        Ok(self
            .states
            .lock()
            .unwrap()
            .get(&(key.clone(), permission))
            .copied()
            .unwrap_or(AuthorizationState::Missing))
    }

    fn replace_states(
        &self,
        key: &AuthorizationKey,
        decisions: &[(Permission, AuthorizationState)],
    ) -> std::result::Result<AuthorizationGeneration, AuthorizationStoreError> {
        if *self.fail.lock().unwrap() {
            return Err(AuthorizationStoreError);
        }
        let mut states = self.states.lock().unwrap();
        states.retain(|(existing, _), _| existing != key);
        for (permission, state) in decisions {
            states.insert((key.clone(), *permission), *state);
        }
        Ok(AuthorizationGeneration::from_bytes([1; 32]))
    }
}

#[derive(Default)]
struct MemoryAuditSink(Mutex<Vec<AuditEvent>>);

impl AuditSink for MemoryAuditSink {
    fn record(&self, event: AuditEvent) {
        self.0.lock().unwrap().push(event);
    }
}

fn key() -> AuthorizationKey {
    AuthorizationKey {
        plugin_id: "dev.bbcom.fixture".to_owned(),
        publisher_identity: format!("publisher:sha256-{}", "a1".repeat(32)),
        plugin_major: 1,
        workspace_id: "8e7b84cf-35f4-45cd-baf0-55d94ebf0213".to_owned(),
    }
}

fn declared(values: &[Permission]) -> BTreeSet<Permission> {
    values.iter().copied().collect()
}

fn review_with_capture_and_network(
    broker: &AuthorizationBroker<'_, MemoryAuthorizationStore, MemoryAuditSink>,
) -> AuthorizationReview {
    broker
        .review(
            key(),
            &[
                Permission::SessionCaptureRead,
                Permission::AiConversationRead,
                Permission::Notification,
            ],
            true,
        )
        .unwrap()
}

#[test]
fn authorization_is_deny_by_default_exactly_scoped_and_requires_composite_confirmation() {
    let store = MemoryAuthorizationStore::default();
    let audit = MemoryAuditSink::default();
    let broker = AuthorizationBroker::new(&store, &audit);
    let permissions = declared(&[Permission::SessionCaptureRead]);

    assert!(
        broker
            .authorize(&key(), &permissions, Permission::UiPanel)
            .is_ok()
    );
    assert!(
        broker
            .authorize(&key(), &permissions, Permission::PluginStorage)
            .is_ok()
    );
    assert_eq!(
        broker.authorize(&key(), &permissions, Permission::SessionCaptureRead),
        Err(BrokerError::PermissionDenied)
    );
    assert_eq!(
        broker.authorize(&key(), &BTreeSet::new(), Permission::SessionCaptureRead),
        Err(BrokerError::CapabilityUndeclared)
    );

    let review = review_with_capture_and_network(&broker);
    assert!(review.extra_confirmation());
    assert!(
        review
            .extra_confirmation_reasons()
            .contains(&ExtraConfirmationReason::CaptureWithNetwork)
    );
    assert!(
        review
            .extra_confirmation_reasons()
            .contains(&ExtraConfirmationReason::ConversationWithNetwork)
    );
    assert_eq!(
        broker.record_decision(
            &review,
            Permission::SessionCaptureRead,
            AuthorizationState::Granted,
            false,
        ),
        Err(BrokerError::ExtraConfirmationRequired)
    );
    broker
        .record_decision(
            &review,
            Permission::SessionCaptureRead,
            AuthorizationState::Granted,
            true,
        )
        .unwrap();
    assert!(
        broker
            .authorize(&key(), &permissions, Permission::SessionCaptureRead)
            .is_ok()
    );

    let mut other_workspace = key();
    other_workspace.workspace_id = "65981dbf-942d-4cc8-a351-22060936e92d".to_owned();
    assert_eq!(
        broker.authorize(
            &other_workspace,
            &permissions,
            Permission::SessionCaptureRead,
        ),
        Err(BrokerError::PermissionDenied)
    );
    let mut other_major = key();
    other_major.plugin_major = 2;
    assert_eq!(
        broker.authorize(&other_major, &permissions, Permission::SessionCaptureRead),
        Err(BrokerError::PermissionDenied)
    );
    let mut display_identity = key();
    display_identity.publisher_identity = "publisher:ordinary-display-name".to_owned();
    assert_eq!(
        validate_authorization_key(&display_identity),
        Err(BrokerError::PublisherIdentityUnverified)
    );

    let serial_review = broker
        .review(key(), &[Permission::SerialWriteProposal], false)
        .unwrap();
    assert!(
        serial_review
            .requires_per_request_approval()
            .contains(&Permission::SerialWriteProposal)
    );
    assert_eq!(
        broker.record_decision(
            &serial_review,
            Permission::SerialWriteProposal,
            AuthorizationState::Granted,
            true,
        ),
        Err(BrokerError::PersistentGrantForbidden)
    );
    assert_eq!(
        broker.require_network(&key()),
        Err(BrokerError::NetworkUnavailable)
    );

    let events = audit.0.lock().unwrap();
    assert!(
        events
            .iter()
            .all(|event| event.plugin_id == key().plugin_id)
    );
    assert!(events.iter().any(|event| {
        event.operation == AuditOperation::AuthorizationCheck
            && event.error_code == Some(BrokerErrorCode::PermissionDenied)
    }));
}

#[test]
fn grouped_authorization_decisions_replace_the_complete_review_atomically() {
    let store = MemoryAuthorizationStore::default();
    let audit = MemoryAuditSink::default();
    let broker = AuthorizationBroker::new(&store, &audit);
    let review = review_with_capture_and_network(&broker);
    let decisions = [
        (Permission::SessionCaptureRead, AuthorizationState::Granted),
        (Permission::AiConversationRead, AuthorizationState::Denied),
        (Permission::Notification, AuthorizationState::Granted),
    ];

    assert_eq!(
        broker.record_decisions(&review, &decisions, false),
        Err(BrokerError::ExtraConfirmationRequired)
    );
    assert_eq!(
        broker.record_decisions(&review, &decisions[..2], true),
        Err(BrokerError::CapabilityUndeclared)
    );
    broker.record_decisions(&review, &decisions, true).unwrap();

    assert_eq!(
        store.state(&key(), Permission::SessionCaptureRead).unwrap(),
        AuthorizationState::Granted
    );
    assert_eq!(
        store.state(&key(), Permission::AiConversationRead).unwrap(),
        AuthorizationState::Denied
    );
    assert_eq!(
        store.state(&key(), Permission::Notification).unwrap(),
        AuthorizationState::Granted
    );
}

#[test]
fn serial_proposals_emit_one_context_bound_action_and_nothing_on_other_paths() {
    let audit = MemoryAuditSink::default();
    let mut broker = SerialProposalBroker::new(&audit);
    let permissions = declared(&[Permission::SerialWriteProposal]);
    let request = || SerialProposalRequest {
        operation_id: "operation-7".to_owned(),
        session_id: "session-3".to_owned(),
        payload: vec![0x01, 0xA5, 0xFF],
        display_label: "Write diagnostic frame".to_owned(),
    };
    let context = ProposalContext {
        operation_id: "operation-7".to_owned(),
        session_id: "session-3".to_owned(),
    };

    let view = broker
        .create(&key(), &permissions, request(), 1_000)
        .unwrap();
    assert_eq!(view.byte_count, 3);
    assert_eq!(view.hex_preview, "01 A5 FF");
    let wrong = ProposalContext {
        operation_id: "operation-8".to_owned(),
        ..context.clone()
    };
    assert_eq!(
        broker.resolve(&view.proposal_id, ProposalDecision::Approve, &wrong, 1_001),
        ProposalResolution::NoAction(NoActionReason::ContextChanged)
    );
    assert_eq!(
        broker.resolve(
            &view.proposal_id,
            ProposalDecision::Approve,
            &context,
            1_002
        ),
        ProposalResolution::NoAction(NoActionReason::UnknownOrConsumed)
    );

    let accepted = broker
        .create(&key(), &permissions, request(), 2_000)
        .unwrap();
    assert_eq!(
        broker.resolve(
            &accepted.proposal_id,
            ProposalDecision::Approve,
            &context,
            2_001,
        ),
        ProposalResolution::Action(BrokerAction::SerialSend {
            proposal_id: accepted.proposal_id.clone(),
            plugin_id: key().plugin_id,
            operation_id: context.operation_id.clone(),
            session_id: context.session_id.clone(),
            payload: vec![0x01, 0xA5, 0xFF],
        })
    );
    assert_eq!(
        broker.resolve(
            &accepted.proposal_id,
            ProposalDecision::Approve,
            &context,
            2_002,
        ),
        ProposalResolution::NoAction(NoActionReason::UnknownOrConsumed)
    );

    let rejected = broker
        .create(&key(), &permissions, request(), 3_000)
        .unwrap();
    assert_eq!(
        broker.resolve(
            &rejected.proposal_id,
            ProposalDecision::Reject,
            &context,
            3_001,
        ),
        ProposalResolution::NoAction(NoActionReason::Rejected)
    );
    let expired = broker
        .create(&key(), &permissions, request(), 4_000)
        .unwrap();
    assert_eq!(
        broker.resolve(
            &expired.proposal_id,
            ProposalDecision::Approve,
            &context,
            64_001,
        ),
        ProposalResolution::NoAction(NoActionReason::Expired)
    );
    assert_eq!(broker.queued_bytes(), 0);

    assert_eq!(
        broker.create(&key(), &BTreeSet::new(), request(), 5_000),
        Err(BrokerError::CapabilityUndeclared)
    );
    assert_eq!(
        broker.create(
            &key(),
            &permissions,
            SerialProposalRequest {
                payload: vec![0; MAX_FRAME_BYTES + 1],
                ..request()
            },
            5_000,
        ),
        Err(BrokerError::ProposalInvalid)
    );
}

fn valid_panel() -> DeclarativePanel {
    DeclarativePanel {
        title: "Serial tools".to_owned(),
        fields: vec![
            PanelField {
                id: "mode".to_owned(),
                label: "Mode".to_owned(),
                kind: PanelControlKind::Select,
                value: "safe".to_owned(),
                options: vec!["safe".to_owned(), "diagnostic".to_owned()],
                disabled: false,
            },
            PanelField {
                id: "run".to_owned(),
                label: "Prepare proposal".to_owned(),
                kind: PanelControlKind::Button,
                value: String::new(),
                options: Vec::new(),
                disabled: false,
            },
        ],
    }
}

#[test]
fn declarative_panels_are_flat_bounded_and_contain_no_active_or_url_content() {
    let panel = valid_panel();
    let validation = validate_panel(&panel).unwrap();
    assert_eq!(validation.node_count, 2);
    assert_eq!(validation.depth, 1);
    assert_eq!(validation.option_count, 2);
    validate_panel_event(
        &panel,
        &PanelEvent {
            field_id: "mode".to_owned(),
            value: "diagnostic".to_owned(),
        },
    )
    .unwrap();
    let audit = MemoryAuditSink::default();
    let panel_broker = DeclarativePanelBroker::new(&audit);
    let hosted = panel_broker.publish(&key(), panel.clone()).unwrap();
    let action = panel_broker
        .event(
            &hosted,
            PanelEvent {
                field_id: "mode".to_owned(),
                value: "diagnostic".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(action.plugin_id, key().plugin_id);
    assert_eq!(action.event.field_id, "mode");

    let mut html = panel.clone();
    html.fields[0].label = "<script>alert(1)</script>".to_owned();
    assert_eq!(validate_panel(&html), Err(BrokerError::PanelInvalid));
    let mut url = panel.clone();
    url.fields[0].value = "https://example.invalid".to_owned();
    assert_eq!(validate_panel(&url), Err(BrokerError::PanelInvalid));
    let mut too_many = panel.clone();
    too_many.fields = (0..257)
        .map(|index| PanelField {
            id: format!("field-{index}"),
            label: "Field".to_owned(),
            kind: PanelControlKind::Text,
            value: String::new(),
            options: Vec::new(),
            disabled: false,
        })
        .collect();
    assert!(matches!(
        validate_panel(&too_many),
        Err(BrokerError::PanelLimitExceeded(_))
    ));
    assert_eq!(
        validate_panel_event(
            &panel,
            &PanelEvent {
                field_id: "mode".to_owned(),
                value: "unlisted".to_owned(),
            },
        ),
        Err(BrokerError::PanelInvalid)
    );
}

#[test]
fn broker_invocations_use_fixed_frame_queue_and_deadline_limits() {
    validate_invocation(
        MAX_FRAME_BYTES,
        MAX_QUEUE_BYTES,
        InvocationClass::Normal,
        Duration::from_millis(BROKER_NORMAL_TIMEOUT_MS),
    )
    .unwrap();
    validate_invocation(
        1,
        1,
        InvocationClass::LongRunning,
        Duration::from_millis(BROKER_LONG_TIMEOUT_MS),
    )
    .unwrap();
    assert!(
        validate_invocation(
            MAX_FRAME_BYTES + 1,
            1,
            InvocationClass::Normal,
            Duration::from_secs(1),
        )
        .is_err()
    );
    assert!(
        validate_invocation(
            1,
            MAX_QUEUE_BYTES + 1,
            InvocationClass::Normal,
            Duration::from_secs(1),
        )
        .is_err()
    );
    assert_eq!(
        validate_invocation(
            1,
            1,
            InvocationClass::Normal,
            Duration::from_millis(BROKER_NORMAL_TIMEOUT_MS + 1),
        ),
        Err(BrokerError::InvocationTimeoutInvalid)
    );
}

#[test]
fn unavailable_authorization_store_fails_closed() {
    let store = MemoryAuthorizationStore::default();
    let audit = MemoryAuditSink::default();
    let broker = AuthorizationBroker::new(&store, &audit);
    let review = broker
        .review(key(), &[Permission::Notification], false)
        .unwrap();
    *store.fail.lock().unwrap() = true;
    assert_eq!(
        broker.authorize(
            &key(),
            &declared(&[Permission::Notification]),
            Permission::Notification,
        ),
        Err(BrokerError::AuthorizationStoreUnavailable)
    );
    assert_eq!(
        broker.record_decision(
            &review,
            Permission::Notification,
            AuthorizationState::Granted,
            true,
        ),
        Err(BrokerError::AuthorizationStoreUnavailable)
    );

    for invalid in [
        AuthorizationKey {
            plugin_id: "invalid".to_owned(),
            ..key()
        },
        AuthorizationKey {
            plugin_major: 0,
            ..key()
        },
        AuthorizationKey {
            workspace_id: "not-a-workspace".to_owned(),
            ..key()
        },
    ] {
        assert_eq!(
            validate_authorization_key(&invalid),
            Err(BrokerError::AuthorizationKeyInvalid)
        );
    }
}
