use bbcom_plugin_contracts::ContractError;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, HostError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionFailureKind {
    Trap,
    Timeout,
    Cancelled,
    FuelExhausted,
    MemoryLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
#[error("plugin execution failed: {kind:?}")]
pub struct ExecutionFailure {
    pub kind: ExecutionFailureKind,
}

impl ExecutionFailure {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self.kind {
            ExecutionFailureKind::Trap => "PLUGIN_TRAP",
            ExecutionFailureKind::Timeout => "PLUGIN_TIMEOUT",
            ExecutionFailureKind::Cancelled => "PLUGIN_CANCELLED",
            ExecutionFailureKind::FuelExhausted => "PLUGIN_FUEL_EXHAUSTED",
            ExecutionFailureKind::MemoryLimit => "PLUGIN_MEMORY_LIMIT",
        }
    }

    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self.kind {
            ExecutionFailureKind::Trap => "plugin.error.trap",
            ExecutionFailureKind::Timeout => "plugin.error.timeout",
            ExecutionFailureKind::Cancelled => "plugin.error.cancelled",
            ExecutionFailureKind::FuelExhausted => "plugin.error.fuelExhausted",
            ExecutionFailureKind::MemoryLimit => "plugin.error.memoryLimit",
        }
    }
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("plugin contract rejected")]
    Contract(#[from] ContractError),
    #[error("plugin artifact path is not a regular component file")]
    InvalidArtifact,
    #[error("plugin component exceeds the package limit")]
    ComponentLimitExceeded,
    #[error("plugin artifact could not be read")]
    ArtifactRead,
    #[error("this process already owns a plugin store")]
    ProcessAlreadyHosting,
    #[error("plugin engine configuration failed")]
    EngineConfiguration,
    #[error("plugin binary is not a valid Wasm Component")]
    InvalidComponent,
    #[error("plugin component could not be instantiated")]
    ComponentInstantiation,
    #[error("plugin rejected the host request")]
    PluginRejected,
    #[error(transparent)]
    Execution(#[from] ExecutionFailure),
    #[error("plugin handshake deadline elapsed")]
    HandshakeTimeout,
    #[error("plugin handshake frame is invalid")]
    InvalidHandshake,
    #[error("plugin host is already closed")]
    Closed,
    #[error("plugin frame stream is truncated")]
    TruncatedTransport,
    #[error("plugin frame transport failed")]
    Transport,
    #[error("plugin request method is unsupported")]
    UnsupportedMethod,
}

impl HostError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Contract(_) => "PLUGIN_PROTOCOL_INVALID",
            Self::InvalidArtifact | Self::ArtifactRead => "PLUGIN_ARTIFACT_INVALID",
            Self::ComponentLimitExceeded => "PLUGIN_PACKAGE_LIMIT",
            Self::ProcessAlreadyHosting => "PLUGIN_PROCESS_OCCUPIED",
            Self::EngineConfiguration | Self::InvalidComponent | Self::ComponentInstantiation => {
                "PLUGIN_COMPONENT_INVALID"
            }
            Self::PluginRejected => "PLUGIN_REQUEST_REJECTED",
            Self::Execution(failure) => failure.code(),
            Self::HandshakeTimeout => "PLUGIN_HANDSHAKE_TIMEOUT",
            Self::InvalidHandshake => "PLUGIN_HANDSHAKE_INVALID",
            Self::Closed => "PLUGIN_HOST_CLOSED",
            Self::TruncatedTransport | Self::Transport => "PLUGIN_TRANSPORT_FAILED",
            Self::UnsupportedMethod => "PLUGIN_METHOD_UNSUPPORTED",
        }
    }

    #[must_use]
    pub const fn message_key(&self) -> &'static str {
        match self {
            Self::Execution(failure) => failure.message_key(),
            Self::HandshakeTimeout => "plugin.error.handshakeTimeout",
            Self::ComponentLimitExceeded => "plugin.error.packageLimit",
            Self::ProcessAlreadyHosting => "plugin.error.processOccupied",
            Self::UnsupportedMethod => "plugin.error.methodUnsupported",
            Self::PluginRejected => "plugin.error.requestRejected",
            Self::Closed => "plugin.error.hostClosed",
            Self::TruncatedTransport | Self::Transport => "plugin.error.transport",
            Self::InvalidHandshake | Self::Contract(_) => "plugin.error.protocolInvalid",
            Self::InvalidArtifact
            | Self::ArtifactRead
            | Self::InvalidComponent
            | Self::ComponentInstantiation
            | Self::EngineConfiguration => "plugin.error.componentInvalid",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_failures_expose_only_stable_codes_and_localization_keys() {
        let errors = [
            HostError::Contract(ContractError::UnknownPayload),
            HostError::InvalidArtifact,
            HostError::ComponentLimitExceeded,
            HostError::ArtifactRead,
            HostError::ProcessAlreadyHosting,
            HostError::EngineConfiguration,
            HostError::InvalidComponent,
            HostError::ComponentInstantiation,
            HostError::PluginRejected,
            HostError::Execution(ExecutionFailure {
                kind: ExecutionFailureKind::Trap,
            }),
            HostError::Execution(ExecutionFailure {
                kind: ExecutionFailureKind::Timeout,
            }),
            HostError::Execution(ExecutionFailure {
                kind: ExecutionFailureKind::FuelExhausted,
            }),
            HostError::Execution(ExecutionFailure {
                kind: ExecutionFailureKind::MemoryLimit,
            }),
            HostError::HandshakeTimeout,
            HostError::InvalidHandshake,
            HostError::Closed,
            HostError::TruncatedTransport,
            HostError::Transport,
            HostError::UnsupportedMethod,
        ];
        for error in errors {
            assert!(error.code().starts_with("PLUGIN_"));
            assert!(error.message_key().starts_with("plugin.error."));
        }
    }
}
