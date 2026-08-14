use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidConfiguration,
    InvalidUrl,
    CrossOriginRedirect,
    RedirectLimit,
    HttpStatus(u16),
    ResponseTooLarge,
    Transport,
    Decode,
    MissingMetadata,
    InvalidMetadata,
    InvalidSignature,
    SignatureThreshold,
    ExpiredMetadata,
    VersionRollback,
    VersionGap,
    FreezeAttack,
    MixAndMatch,
    LengthMismatch,
    DigestMismatch,
    TargetNotFound,
    TargetMismatch,
    UnsignedStablePackage,
    PublisherSignature,
    StateIo,
    StateEncoding,
    StateCorrupt,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidConfiguration => "invalid repository trust configuration",
            Self::InvalidUrl => "repository URL is not strict HTTPS",
            Self::CrossOriginRedirect => "repository redirect crossed its configured origin",
            Self::RedirectLimit => "repository redirect limit exceeded",
            Self::HttpStatus(_) => "repository returned an unsuccessful HTTP status",
            Self::ResponseTooLarge => "repository response exceeded its declared limit",
            Self::Transport => "repository transport failed",
            Self::Decode => "repository metadata decoding failed",
            Self::MissingMetadata => "required repository metadata is missing",
            Self::InvalidMetadata => "repository metadata is structurally invalid",
            Self::InvalidSignature => "repository metadata signature is invalid",
            Self::SignatureThreshold => "repository metadata signature threshold was not met",
            Self::ExpiredMetadata => "repository metadata is expired",
            Self::VersionRollback => "repository metadata version rolled back",
            Self::VersionGap => "repository root rotation skipped a version",
            Self::FreezeAttack => "repository reused a metadata version with different content",
            Self::MixAndMatch => "repository metadata descriptions do not match downloaded roles",
            Self::LengthMismatch => "repository object length does not match signed metadata",
            Self::DigestMismatch => "repository object SHA-256 does not match signed metadata",
            Self::TargetNotFound => "requested plugin package is absent from signed targets",
            Self::TargetMismatch => "signed target does not match the requested plugin package",
            Self::UnsignedStablePackage => "stable plugin package lacks a publisher signature",
            Self::PublisherSignature => "plugin publisher signature is invalid",
            Self::StateIo => "trusted repository state I/O failed",
            Self::StateEncoding => "trusted repository state encoding failed",
            Self::StateCorrupt => "trusted repository state is corrupt",
        };
        match self {
            Self::HttpStatus(status) => write!(formatter, "{message}: {status}"),
            _ => formatter.write_str(message),
        }
    }
}

impl std::error::Error for Error {}
