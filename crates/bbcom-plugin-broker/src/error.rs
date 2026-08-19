use thiserror::Error;

pub type Result<T> = std::result::Result<T, BrokerError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrokerErrorCode {
    InvocationLimit,
    InvocationTimeoutInvalid,
}

impl BrokerErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvocationLimit => "PLUGIN_INVOCATION_LIMIT",
            Self::InvocationTimeoutInvalid => "PLUGIN_INVOCATION_TIMEOUT_INVALID",
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::InvocationLimit => "plugin.error.invocationLimit",
            Self::InvocationTimeoutInvalid => "plugin.error.invocationTimeoutInvalid",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitKind {
    FrameBytes,
    QueueBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum BrokerError {
    #[error("plugin invocation exceeds a fixed limit: {0:?}")]
    InvocationLimit(LimitKind),
    #[error("plugin invocation timeout is outside the fixed policy")]
    InvocationTimeoutInvalid,
}

impl BrokerError {
    #[must_use]
    pub const fn code(self) -> BrokerErrorCode {
        match self {
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
