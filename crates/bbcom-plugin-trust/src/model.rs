use std::collections::BTreeMap;

pub type KeyId = String;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    /// Exactly 32 raw bytes for an Ed25519 public key.
    pub ed25519: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub key_id: KeyId,
    /// Exactly 64 raw bytes for an Ed25519 signature.
    pub ed25519: [u8; 64],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signed<T> {
    /// Canonical JSON bytes of the `signed` member, not the outer envelope.
    pub canonical_signed: Vec<u8>,
    pub signatures: Vec<Signature>,
    pub signed: T,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Root,
    Timestamp,
    Snapshot,
    Targets,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleDefinition {
    pub key_ids: Vec<KeyId>,
    pub threshold: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootMetadata {
    pub version: u64,
    pub expires_unix: u64,
    pub consistent_snapshot: bool,
    pub keys: BTreeMap<KeyId, Key>,
    pub roles: BTreeMap<Role, RoleDefinition>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetadataDescription {
    pub version: u64,
    pub length: u64,
    pub sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimestampMetadata {
    pub version: u64,
    pub expires_unix: u64,
    pub snapshot: MetadataDescription,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub version: u64,
    pub expires_unix: u64,
    /// Must contain exactly the authoritative `targets.json` description used
    /// by this client. Delegations are deliberately outside v1.
    pub targets: MetadataDescription,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetDescription {
    pub plugin_id: String,
    pub version: String,
    pub length: u64,
    pub sha256: [u8; 32],
    pub expanded_bytes: u64,
    pub files: u32,
    pub publisher_key: [u8; 32],
    pub publisher_signature: Option<[u8; 64]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetsMetadata {
    pub version: u64,
    pub expires_unix: u64,
    /// Key is a repository-relative package path.
    pub targets: BTreeMap<String, TargetDescription>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepositoryState {
    pub root_version: u64,
    pub timestamp_version: u64,
    pub timestamp_sha256: Option<[u8; 32]>,
    pub snapshot_version: u64,
    pub snapshot_sha256: Option<[u8; 32]>,
    pub targets_version: u64,
    pub targets_sha256: Option<[u8; 32]>,
}
