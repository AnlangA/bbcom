use std::collections::BTreeSet;

use bbcom_plugin_contracts::{
    AuthorizationKey, Permission, RiskCombination, permission_plan, validate_persistent_grant,
};

use crate::{AuditEvent, AuditOperation, AuditSink, BrokerError, Result};

pub const VERIFIED_PUBLISHER_IDENTITY_PREFIX: &str = "publisher:sha256-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationState {
    Missing,
    Granted,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorizationStoreError;

/// Opaque, high-entropy identity of one complete decision-set replacement.
/// Receipts persist the same value so an interrupted or interleaved write can
/// only invalidate authorization, never bind a receipt to different choices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorizationGeneration([u8; 32]);

impl AuthorizationGeneration {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Application-profile authorization persistence injected by trusted bbcom
/// code. Implementations must live outside project files and plugin storage.
/// No filesystem path is accepted or exposed by this interface.
pub trait AuthorizationStore: Send + Sync {
    fn state(
        &self,
        key: &AuthorizationKey,
        permission: Permission,
    ) -> std::result::Result<AuthorizationState, AuthorizationStoreError>;

    /// Atomically replaces the complete reviewed decision set for one exact
    /// authorization key. Implementations must not expose a partially written
    /// subset if persistence fails.
    fn replace_states(
        &self,
        key: &AuthorizationKey,
        decisions: &[(Permission, AuthorizationState)],
    ) -> std::result::Result<AuthorizationGeneration, AuthorizationStoreError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReviewCapability {
    Permission(Permission),
    /// Risk-review marker only. Protocol v1 never authorizes or executes it.
    Network,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ExtraConfirmationReason {
    CaptureWithNetwork,
    ConversationWithNetwork,
    CaptureWithExternalSink,
    ConversationWithExternalSink,
    SerialControlAndWriteProposal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationReview {
    key: AuthorizationKey,
    implicit: BTreeSet<Permission>,
    requires_persistent_approval: BTreeSet<Permission>,
    requires_per_request_approval: BTreeSet<Permission>,
    unavailable: BTreeSet<ReviewCapability>,
    extra_confirmation: bool,
    extra_confirmation_reasons: BTreeSet<ExtraConfirmationReason>,
}

impl AuthorizationReview {
    #[must_use]
    pub const fn key(&self) -> &AuthorizationKey {
        &self.key
    }

    #[must_use]
    pub const fn implicit(&self) -> &BTreeSet<Permission> {
        &self.implicit
    }

    #[must_use]
    pub const fn requires_persistent_approval(&self) -> &BTreeSet<Permission> {
        &self.requires_persistent_approval
    }

    #[must_use]
    pub const fn requires_per_request_approval(&self) -> &BTreeSet<Permission> {
        &self.requires_per_request_approval
    }

    #[must_use]
    pub const fn unavailable(&self) -> &BTreeSet<ReviewCapability> {
        &self.unavailable
    }

    #[must_use]
    pub const fn extra_confirmation(&self) -> bool {
        self.extra_confirmation
    }

    #[must_use]
    pub const fn extra_confirmation_reasons(&self) -> &BTreeSet<ExtraConfirmationReason> {
        &self.extra_confirmation_reasons
    }
}

pub struct AuthorizationBroker<'a, S, A> {
    store: &'a S,
    audit: &'a A,
}

impl<'a, S, A> AuthorizationBroker<'a, S, A>
where
    S: AuthorizationStore,
    A: AuditSink,
{
    #[must_use]
    pub const fn new(store: &'a S, audit: &'a A) -> Self {
        Self { store, audit }
    }

    pub fn review(
        &self,
        key: AuthorizationKey,
        requested: &[Permission],
        network_requested: bool,
    ) -> Result<AuthorizationReview> {
        validate_authorization_key(&key)?;
        let requested: BTreeSet<_> = requested.iter().copied().collect();
        let plan = permission_plan(&requested.iter().copied().collect::<Vec<_>>());
        let requires_per_request_approval = plan
            .requires_approval
            .iter()
            .copied()
            .filter(|permission| permission.is_per_request_only())
            .collect::<BTreeSet<_>>();
        let requires_persistent_approval = plan
            .requires_approval
            .iter()
            .copied()
            .filter(|permission| !permission.is_per_request_only())
            .collect::<BTreeSet<_>>();
        let mut reasons = BTreeSet::new();
        if network_requested && requested.contains(&Permission::SessionCaptureRead) {
            reasons.insert(ExtraConfirmationReason::CaptureWithNetwork);
        }
        if network_requested && requested.contains(&Permission::AiConversationRead) {
            reasons.insert(ExtraConfirmationReason::ConversationWithNetwork);
        }
        for combination in plan.risk_combinations {
            reasons.insert(match combination {
                RiskCombination::CaptureWithExternalSink => {
                    ExtraConfirmationReason::CaptureWithExternalSink
                }
                RiskCombination::ConversationWithExternalSink => {
                    ExtraConfirmationReason::ConversationWithExternalSink
                }
                RiskCombination::SerialControlAndWriteProposal => {
                    ExtraConfirmationReason::SerialControlAndWriteProposal
                }
            });
        }
        let unavailable = if network_requested {
            [ReviewCapability::Network].into_iter().collect()
        } else {
            BTreeSet::new()
        };
        Ok(AuthorizationReview {
            key,
            implicit: plan.implicit,
            requires_persistent_approval,
            requires_per_request_approval,
            unavailable,
            extra_confirmation: !reasons.is_empty(),
            extra_confirmation_reasons: reasons,
        })
    }

    /// Check a capability at its use site. Anything not implicit, declared,
    /// and exactly granted for this key is denied.
    pub fn authorize(
        &self,
        key: &AuthorizationKey,
        declared: &BTreeSet<Permission>,
        permission: Permission,
    ) -> Result<()> {
        validate_authorization_key(key)?;
        let result = (|| {
            if permission.is_implicit() {
                Ok(())
            } else if !declared.contains(&permission) {
                Err(BrokerError::CapabilityUndeclared)
            } else if permission.is_per_request_only() {
                Err(BrokerError::PersistentGrantForbidden)
            } else {
                match self
                    .store
                    .state(key, permission)
                    .map_err(|_| BrokerError::AuthorizationStoreUnavailable)?
                {
                    AuthorizationState::Granted => Ok(()),
                    AuthorizationState::Missing | AuthorizationState::Denied => {
                        Err(BrokerError::PermissionDenied)
                    }
                }
            }
        })();
        self.audit.record(AuditEvent {
            plugin_id: key.plugin_id.clone(),
            operation: AuditOperation::AuthorizationCheck,
            error_code: result.as_ref().err().copied().map(BrokerError::code),
            byte_count: 0,
        });
        result
    }

    /// Persist one reviewed decision. The caller must explicitly acknowledge
    /// any composite-risk confirmation shown by trusted UI.
    pub fn record_decision(
        &self,
        review: &AuthorizationReview,
        permission: Permission,
        state: AuthorizationState,
        extra_confirmation_acknowledged: bool,
    ) -> Result<AuthorizationGeneration> {
        let result = (|| {
            validate_authorization_key(&review.key)?;
            if permission.is_per_request_only() {
                return Err(BrokerError::PersistentGrantForbidden);
            }
            if !review.requires_persistent_approval.contains(&permission) {
                return Err(BrokerError::CapabilityUndeclared);
            }
            validate_persistent_grant(permission)
                .map_err(|_| BrokerError::PersistentGrantForbidden)?;
            if review.extra_confirmation
                && state == AuthorizationState::Granted
                && !extra_confirmation_acknowledged
            {
                return Err(BrokerError::ExtraConfirmationRequired);
            }
            let decisions = review
                .requires_persistent_approval
                .iter()
                .copied()
                .map(|candidate| {
                    (
                        candidate,
                        if candidate == permission {
                            state
                        } else {
                            AuthorizationState::Denied
                        },
                    )
                })
                .collect::<Vec<_>>();
            self.store
                .replace_states(&review.key, &decisions)
                .map_err(|_| BrokerError::AuthorizationStoreUnavailable)
        })();
        self.audit.record(AuditEvent {
            plugin_id: review.key.plugin_id.clone(),
            operation: AuditOperation::AuthorizationDecision,
            error_code: result.as_ref().err().copied().map(BrokerError::code),
            byte_count: 0,
        });
        result
    }

    /// Persists one complete review as an indivisible decision set.
    ///
    /// The submitted permissions must match the review exactly; omitted,
    /// duplicate, implicit and per-request-only capabilities are rejected.
    pub fn record_decisions(
        &self,
        review: &AuthorizationReview,
        decisions: &[(Permission, AuthorizationState)],
        extra_confirmation_acknowledged: bool,
    ) -> Result<AuthorizationGeneration> {
        let result = (|| {
            validate_authorization_key(&review.key)?;
            let submitted = decisions
                .iter()
                .map(|(permission, _)| *permission)
                .collect::<BTreeSet<_>>();
            if submitted.len() != decisions.len()
                || submitted != review.requires_persistent_approval
                || decisions
                    .iter()
                    .any(|(_, state)| *state == AuthorizationState::Missing)
            {
                return Err(BrokerError::CapabilityUndeclared);
            }
            for (permission, _) in decisions {
                validate_persistent_grant(*permission)
                    .map_err(|_| BrokerError::PersistentGrantForbidden)?;
            }
            if review.extra_confirmation
                && decisions
                    .iter()
                    .any(|(_, state)| *state == AuthorizationState::Granted)
                && !extra_confirmation_acknowledged
            {
                return Err(BrokerError::ExtraConfirmationRequired);
            }
            self.store
                .replace_states(&review.key, decisions)
                .map_err(|_| BrokerError::AuthorizationStoreUnavailable)
        })();
        self.audit.record(AuditEvent {
            plugin_id: review.key.plugin_id.clone(),
            operation: AuditOperation::AuthorizationDecision,
            error_code: result.as_ref().err().copied().map(BrokerError::code),
            byte_count: 0,
        });
        result
    }

    pub fn require_network(&self, key: &AuthorizationKey) -> Result<()> {
        validate_authorization_key(key)?;
        self.audit.record(AuditEvent {
            plugin_id: key.plugin_id.clone(),
            operation: AuditOperation::AuthorizationCheck,
            error_code: Some(BrokerError::NetworkUnavailable.code()),
            byte_count: 0,
        });
        Err(BrokerError::NetworkUnavailable)
    }
}

pub fn validate_authorization_key(key: &AuthorizationKey) -> Result<()> {
    if !valid_plugin_id(&key.plugin_id)
        || key.plugin_major == 0
        || !valid_workspace_id(&key.workspace_id)
    {
        return Err(BrokerError::AuthorizationKeyInvalid);
    }
    if !valid_verified_publisher_identity(&key.publisher_identity) {
        return Err(BrokerError::PublisherIdentityUnverified);
    }
    Ok(())
}

fn valid_verified_publisher_identity(value: &str) -> bool {
    let Some(fingerprint) = value.strip_prefix(VERIFIED_PUBLISHER_IDENTITY_PREFIX) else {
        return false;
    };
    fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_plugin_id(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 128
        && value.contains('.')
        && value.split('.').all(valid_slug)
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'-' => index > 0 && index + 1 < value.len(),
            _ => false,
        })
}

fn valid_workspace_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
