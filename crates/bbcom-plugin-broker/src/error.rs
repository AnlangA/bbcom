use thiserror::Error;

pub type Result<T> = std::result::Result<T, BrokerError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrokerErrorCode {
    PluginContextInvalid,
    CapabilityUndeclared,
    PermissionDenied,
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
            Self::PluginContextInvalid => "PLUGIN_CONTEXT_INVALID",
            Self::CapabilityUndeclared => "PLUGIN_CAPABILITY_UNDECLARED",
            Self::PermissionDenied => "PLUGIN_PERMISSION_DENIED",
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
            Self::PluginContextInvalid => "plugin.error.contextInvalid",
            Self::CapabilityUndeclared => "plugin.error.capabilityUndeclared",
            Self::PermissionDenied => "plugin.error.permissionDenied",
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
    #[error("plugin context is invalid")]
    PluginContextInvalid,
    #[error("plugin did not declare the requested capability")]
    CapabilityUndeclared,
    #[error("plugin capability is not authorized")]
    PermissionDenied,
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
            Self::PluginContextInvalid => BrokerErrorCode::PluginContextInvalid,
            Self::CapabilityUndeclared => BrokerErrorCode::CapabilityUndeclared,
            Self::PermissionDenied => BrokerErrorCode::PermissionDenied,
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
            BrokerError::PluginContextInvalid,
            BrokerError::CapabilityUndeclared,
            BrokerError::PermissionDenied,
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
