//! Native, transport-agnostic trust core for stable plugin repositories.
//!
//! Parsing, HTTP, and Ed25519 implementations are injected. This crate owns
//! the fail-closed state machine: HTTPS origin policy, bounded downloads, TUF
//! thresholds, expiry/version/rollback/freeze/mix-and-match checks, package
//! integrity, and publisher authorization.

mod decoder;
mod error;
mod fetch;
mod model;
mod state;
mod trust;
mod verifier;

pub use decoder::{CanonicalJsonDecoder, DecodeError};
pub use error::{Error, Result};
pub use fetch::{FetchPort, FetchResponse, RepositoryConfiguration, RepositoryEndpoint};
pub use model::{
    Key, KeyId, MetadataDescription, RepositoryState, Role, RoleDefinition, RootMetadata,
    Signature, Signed, SnapshotMetadata, TargetDescription, TargetsMetadata, TimestampMetadata,
};
pub use state::{PersistedTrustState, TrustedStateStore};
pub use trust::{
    Ed25519Verifier, MetadataDecoder, TrustPolicy, TrustedPackage, TrustedRepository,
    TrustedRepositoryBootstrap,
};
pub use verifier::RingEd25519Verifier;
