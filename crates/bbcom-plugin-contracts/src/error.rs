use thiserror::Error;

pub type Result<T> = std::result::Result<T, ContractError>;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContractError {
    #[error("invalid plugin contract field: {field}")]
    InvalidField { field: &'static str },
    #[error("unknown plugin contract field: {field}")]
    UnknownField { field: String },
    #[error("plugin contract limit exceeded for {field}: {actual} > {limit}")]
    LimitExceeded {
        field: &'static str,
        limit: u64,
        actual: u64,
    },
    #[error("plugin protocol major version is incompatible: {found}")]
    IncompatibleMajor { found: u32 },
    #[error("plugin protocol envelope has no supported payload")]
    UnknownPayload,
    #[error("plugin protocol frame is truncated")]
    TruncatedFrame,
    #[error("plugin manifest is invalid TOML")]
    ManifestSyntax,
    #[error("plugin repository index is invalid JSON")]
    RepositorySyntax,
    #[error("plugin protocol payload is invalid protobuf")]
    Protobuf,
}
