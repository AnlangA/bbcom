use thiserror::Error;

pub type Result<T> = std::result::Result<T, BrokerError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrokerErrorCode {
    AuthorizationKeyInvalid,
    PublisherIdentityUnverified,
    CapabilityUndeclared,
    PermissionDenied,
    PersistentGrantForbidden,
    ExtraConfirmationRequired,
    AuthorizationStoreUnavailable,
    NetworkUnavailable,
    PanelInvalid,
    PanelLimitExceeded,
    ProposalInvalid,
    ProposalQueueLimit,
    InvocationLimit,
    InvocationTimeoutInvalid,
}

impl BrokerErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthorizationKeyInvalid => "PLUGIN_AUTHORIZATION_KEY_INVALID",
            Self::PublisherIdentityUnverified => "PLUGIN_PUBLISHER_IDENTITY_UNVERIFIED",
            Self::CapabilityUndeclared => "PLUGIN_CAPABILITY_UNDECLARED",
            Self::PermissionDenied => "PLUGIN_PERMISSION_DENIED",
            Self::PersistentGrantForbidden => "PLUGIN_PERSISTENT_GRANT_FORBIDDEN",
            Self::ExtraConfirmationRequired => "PLUGIN_EXTRA_CONFIRMATION_REQUIRED",
            Self::AuthorizationStoreUnavailable => "PLUGIN_AUTHORIZATION_STORE_UNAVAILABLE",
            Self::NetworkUnavailable => "PLUGIN_NETWORK_UNAVAILABLE",
            Self::PanelInvalid => "PLUGIN_PANEL_INVALID",
            Self::PanelLimitExceeded => "PLUGIN_PANEL_LIMIT_EXCEEDED",
            Self::ProposalInvalid => "PLUGIN_PROPOSAL_INVALID",
            Self::ProposalQueueLimit => "PLUGIN_PROPOSAL_QUEUE_LIMIT",
            Self::InvocationLimit => "PLUGIN_INVOCATION_LIMIT",
            Self::InvocationTimeoutInvalid => "PLUGIN_INVOCATION_TIMEOUT_INVALID",
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::AuthorizationKeyInvalid => "plugin.error.authorizationKeyInvalid",
            Self::PublisherIdentityUnverified => "plugin.error.publisherIdentityUnverified",
            Self::CapabilityUndeclared => "plugin.error.capabilityUndeclared",
            Self::PermissionDenied => "plugin.error.permissionDenied",
            Self::PersistentGrantForbidden => "plugin.error.persistentGrantForbidden",
            Self::ExtraConfirmationRequired => "plugin.error.extraConfirmationRequired",
            Self::AuthorizationStoreUnavailable => "plugin.error.authorizationStoreUnavailable",
            Self::NetworkUnavailable => "plugin.error.networkUnavailable",
            Self::PanelInvalid => "plugin.error.panelInvalid",
            Self::PanelLimitExceeded => "plugin.error.panelLimitExceeded",
            Self::ProposalInvalid => "plugin.error.proposalInvalid",
            Self::ProposalQueueLimit => "plugin.error.proposalQueueLimit",
            Self::InvocationLimit => "plugin.error.invocationLimit",
            Self::InvocationTimeoutInvalid => "plugin.error.invocationTimeoutInvalid",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitKind {
    FrameBytes,
    QueueBytes,
    PanelNodes,
    PanelDepth,
    PanelOptions,
    PanelText,
    ProposalBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum BrokerError {
    #[error("plugin authorization key is invalid")]
    AuthorizationKeyInvalid,
    #[error("publisher identity is not an upstream-verified canonical key fingerprint")]
    PublisherIdentityUnverified,
    #[error("plugin did not declare the requested capability")]
    CapabilityUndeclared,
    #[error("plugin capability is not authorized")]
    PermissionDenied,
    #[error("this capability cannot receive a persistent grant")]
    PersistentGrantForbidden,
    #[error("the risk combination requires an explicit extra confirmation")]
    ExtraConfirmationRequired,
    #[error("the application-profile authorization store is unavailable")]
    AuthorizationStoreUnavailable,
    #[error("plugin network execution is unavailable in protocol v1")]
    NetworkUnavailable,
    #[error("declarative panel is invalid")]
    PanelInvalid,
    #[error("declarative panel exceeds a fixed limit: {0:?}")]
    PanelLimitExceeded(LimitKind),
    #[error("serial send proposal is invalid")]
    ProposalInvalid,
    #[error("serial send proposal queue exceeds the fixed limit")]
    ProposalQueueLimit,
    #[error("plugin invocation exceeds a fixed limit: {0:?}")]
    InvocationLimit(LimitKind),
    #[error("plugin invocation timeout is outside the fixed policy")]
    InvocationTimeoutInvalid,
}

impl BrokerError {
    #[must_use]
    pub const fn code(self) -> BrokerErrorCode {
        match self {
            Self::AuthorizationKeyInvalid => BrokerErrorCode::AuthorizationKeyInvalid,
            Self::PublisherIdentityUnverified => BrokerErrorCode::PublisherIdentityUnverified,
            Self::CapabilityUndeclared => BrokerErrorCode::CapabilityUndeclared,
            Self::PermissionDenied => BrokerErrorCode::PermissionDenied,
            Self::PersistentGrantForbidden => BrokerErrorCode::PersistentGrantForbidden,
            Self::ExtraConfirmationRequired => BrokerErrorCode::ExtraConfirmationRequired,
            Self::AuthorizationStoreUnavailable => BrokerErrorCode::AuthorizationStoreUnavailable,
            Self::NetworkUnavailable => BrokerErrorCode::NetworkUnavailable,
            Self::PanelInvalid => BrokerErrorCode::PanelInvalid,
            Self::PanelLimitExceeded(_) => BrokerErrorCode::PanelLimitExceeded,
            Self::ProposalInvalid => BrokerErrorCode::ProposalInvalid,
            Self::ProposalQueueLimit => BrokerErrorCode::ProposalQueueLimit,
            Self::InvocationLimit(_) => BrokerErrorCode::InvocationLimit,
            Self::InvocationTimeoutInvalid => BrokerErrorCode::InvocationTimeoutInvalid,
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        self.code().message_key()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_broker_denial_has_a_stable_public_code_and_message_key() {
        let errors = [
            BrokerError::AuthorizationKeyInvalid,
            BrokerError::PublisherIdentityUnverified,
            BrokerError::CapabilityUndeclared,
            BrokerError::PermissionDenied,
            BrokerError::PersistentGrantForbidden,
            BrokerError::ExtraConfirmationRequired,
            BrokerError::AuthorizationStoreUnavailable,
            BrokerError::NetworkUnavailable,
            BrokerError::PanelInvalid,
            BrokerError::PanelLimitExceeded(LimitKind::PanelNodes),
            BrokerError::ProposalInvalid,
            BrokerError::ProposalQueueLimit,
            BrokerError::InvocationLimit(LimitKind::FrameBytes),
            BrokerError::InvocationTimeoutInvalid,
        ];
        for error in errors {
            let code = error.code();
            assert!(code.as_str().starts_with("PLUGIN_"));
            assert!(code.message_key().starts_with("plugin.error."));
            assert_eq!(error.message_key(), code.message_key());
        }
    }
}
