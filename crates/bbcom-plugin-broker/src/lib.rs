//! Trusted, deny-by-default mediation between plugins and bbcom capabilities.
//!
//! This crate deliberately has no serial, filesystem, network, keyring, Tauri,
//! or WebView dependency. It returns narrowly-scoped actions to trusted
//! application code only after authorization or per-request user approval.

mod audit;
mod authorization;
mod error;
mod limits;
mod panel;
mod proposal;

pub use audit::{AuditEvent, AuditOperation, AuditSink, NoopAuditSink};
pub use authorization::{
    AuthorizationBroker, AuthorizationGeneration, AuthorizationReview, AuthorizationState,
    AuthorizationStore, AuthorizationStoreError, ExtraConfirmationReason, ReviewCapability,
    VERIFIED_PUBLISHER_IDENTITY_PREFIX, validate_authorization_key,
};
pub use error::{BrokerError, BrokerErrorCode, LimitKind, Result};
pub use limits::{
    BROKER_LONG_TIMEOUT_MS, BROKER_NORMAL_TIMEOUT_MS, InvocationClass, validate_invocation,
};
pub use panel::{
    DeclarativePanel, DeclarativePanelBroker, HostedPanel, PanelControlKind, PanelEvent,
    PanelEventAction, PanelField, PanelValidation, validate_panel, validate_panel_event,
};
pub use proposal::{
    BrokerAction, NoActionReason, ProposalContext, ProposalDecision, ProposalResolution,
    SerialProposalBroker, SerialProposalRequest, SerialProposalView,
};
