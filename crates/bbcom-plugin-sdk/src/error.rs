#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ContractError {
    InvalidInput,
    PermissionDenied,
    Unavailable,
    Busy,
    NotFound,
    StaleHandle,
    Disconnected,
    Timeout,
    Cancelled,
    LimitExceeded,
    PartialWrite,
    UnknownOutcome,
    ProtocolError,
    IoError,
}

pub type Result<T> = core::result::Result<T, ContractError>;

impl ContractError {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid-input",
            Self::PermissionDenied => "permission-denied",
            Self::Unavailable => "unavailable",
            Self::Busy => "busy",
            Self::NotFound => "not-found",
            Self::StaleHandle => "stale-handle",
            Self::Disconnected => "disconnected",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::LimitExceeded => "limit-exceeded",
            Self::PartialWrite => "partial-write",
            Self::UnknownOutcome => "unknown-outcome",
            Self::ProtocolError => "protocol-error",
            Self::IoError => "io-error",
        }
    }
}
