use std::collections::BTreeSet;

use sha2::{Digest, Sha256};

use crate::fetch::{RepositoryEndpoint, fetch_bounded};
use crate::model::{
    Key, MetadataDescription, RepositoryState, Role, RootMetadata, Signed, SnapshotMetadata,
    TargetDescription, TargetsMetadata, TimestampMetadata,
};
use crate::{Error, FetchPort, Result};

pub const MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PACKAGE_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_PACKAGE_FILES: u32 = 2_048;

pub trait MetadataDecoder {
    type Error;

    fn root(&self, bytes: &[u8]) -> std::result::Result<Signed<RootMetadata>, Self::Error>;
    fn timestamp(
        &self,
        bytes: &[u8],
    ) -> std::result::Result<Signed<TimestampMetadata>, Self::Error>;
    fn snapshot(&self, bytes: &[u8]) -> std::result::Result<Signed<SnapshotMetadata>, Self::Error>;
    fn targets(&self, bytes: &[u8]) -> std::result::Result<Signed<TargetsMetadata>, Self::Error>;
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

/// Production implementations must perform strict Ed25519 verification and
/// reject non-canonical encodings. Algorithm selection is intentionally not
/// supplied by repository metadata.
pub trait Ed25519Verifier {
    fn verify(&self, public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustPolicy {
    Stable,
    FirstPartyPreview,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedPackage {
    pub repository_id: String,
    pub repository_origin: String,
    pub plugin_id: String,
    pub version: String,
    pub publisher_identity: String,
    pub package_url: String,
    pub sha256: String,
    pub expanded_bytes: u64,
    pub files: u32,
    pub bytes: Vec<u8>,
}

/// Named bootstrap state for one repository trust authority.
///
/// Keeping the durable root, rollback state, release policy and verification
/// time in one value prevents positional constructor arguments from being
/// accidentally reordered at the native integration boundary.
pub struct TrustedRepositoryBootstrap {
    pub trusted_root: Signed<RootMetadata>,
    pub state: RepositoryState,
    pub policy: TrustPolicy,
    pub now_unix: u64,
}

pub struct TrustedRepository<F, D, V> {
    endpoint: RepositoryEndpoint,
    fetch: F,
    decoder: D,
    verifier: V,
    trusted_root: Signed<RootMetadata>,
    state: RepositoryState,
    policy: TrustPolicy,
}

impl<F, D, V> TrustedRepository<F, D, V>
where
    F: FetchPort,
    D: MetadataDecoder,
    V: Ed25519Verifier,
{
    pub fn new(
        endpoint: RepositoryEndpoint,
        fetch: F,
        decoder: D,
        verifier: V,
        bootstrap: TrustedRepositoryBootstrap,
    ) -> Result<Self> {
        let TrustedRepositoryBootstrap {
            trusted_root,
            mut state,
            policy,
            now_unix,
        } = bootstrap;
        validate_root_shape(&trusted_root.signed)?;
        verify_role(&trusted_root, Role::Root, &trusted_root.signed, &verifier)?;
        reject_expired(trusted_root.signed.expires_unix, now_unix)?;
        if state.root_version > trusted_root.signed.version {
            return Err(Error::VersionRollback);
        }
        state.root_version = trusted_root.signed.version;
        Ok(Self {
            endpoint,
            fetch,
            decoder,
            verifier,
            trusted_root,
            state,
            policy,
        })
    }

    #[must_use]
    pub fn state(&self) -> &RepositoryState {
        &self.state
    }

    #[must_use]
    pub fn trusted_root(&self) -> &Signed<RootMetadata> {
        &self.trusted_root
    }

    pub fn apply_root_update(&mut self, bytes: &[u8], now_unix: u64) -> Result<()> {
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_METADATA_BYTES {
            return Err(Error::ResponseTooLarge);
        }
        let next = self.decoder.root(bytes).map_err(|_| Error::Decode)?;
        validate_root_shape(&next.signed)?;
        if next.signed.version <= self.trusted_root.signed.version {
            return Err(Error::VersionRollback);
        }
        if next.signed.version != self.trusted_root.signed.version + 1 {
            return Err(Error::VersionGap);
        }
        reject_expired(next.signed.expires_unix, now_unix)?;
        // TUF root rotation requires both the currently trusted root threshold
        // and the incoming root's own threshold.
        verify_role(&next, Role::Root, &self.trusted_root.signed, &self.verifier)?;
        verify_role(&next, Role::Root, &next.signed, &self.verifier)?;
        self.state.root_version = next.signed.version;
        self.trusted_root = next;
        Ok(())
    }

    pub fn refresh_and_download(
        &mut self,
        plugin_id: &str,
        version: &str,
        now_unix: u64,
    ) -> Result<TrustedPackage> {
        validate_request(plugin_id, version)?;
        reject_expired(self.trusted_root.signed.expires_unix, now_unix)?;

        let timestamp_bytes = fetch_bounded(
            &mut self.fetch,
            &self.endpoint,
            "timestamp.json",
            MAX_METADATA_BYTES,
        )?;
        let timestamp = self
            .decoder
            .timestamp(&timestamp_bytes)
            .map_err(|_| Error::Decode)?;
        verify_role(
            &timestamp,
            Role::Timestamp,
            &self.trusted_root.signed,
            &self.verifier,
        )?;
        reject_expired(timestamp.signed.expires_unix, now_unix)?;
        reject_replay(
            timestamp.signed.version,
            digest(&timestamp.canonical_signed),
            self.state.timestamp_version,
            self.state.timestamp_sha256,
        )?;
        validate_description(&timestamp.signed.snapshot, MAX_METADATA_BYTES)?;

        let snapshot_name = metadata_name(
            "snapshot.json",
            timestamp.signed.snapshot.version,
            self.trusted_root.signed.consistent_snapshot,
        );
        let snapshot_bytes = fetch_bounded(
            &mut self.fetch,
            &self.endpoint,
            &snapshot_name,
            timestamp.signed.snapshot.length,
        )?;
        verify_description(&timestamp.signed.snapshot, &snapshot_bytes)?;
        let snapshot = self
            .decoder
            .snapshot(&snapshot_bytes)
            .map_err(|_| Error::Decode)?;
        verify_role(
            &snapshot,
            Role::Snapshot,
            &self.trusted_root.signed,
            &self.verifier,
        )?;
        reject_expired(snapshot.signed.expires_unix, now_unix)?;
        if snapshot.signed.version != timestamp.signed.snapshot.version {
            return Err(Error::MixAndMatch);
        }
        reject_replay(
            snapshot.signed.version,
            digest(&snapshot.canonical_signed),
            self.state.snapshot_version,
            self.state.snapshot_sha256,
        )?;
        validate_description(&snapshot.signed.targets, MAX_METADATA_BYTES)?;

        let targets_name = metadata_name(
            "targets.json",
            snapshot.signed.targets.version,
            self.trusted_root.signed.consistent_snapshot,
        );
        let targets_bytes = fetch_bounded(
            &mut self.fetch,
            &self.endpoint,
            &targets_name,
            snapshot.signed.targets.length,
        )?;
        verify_description(&snapshot.signed.targets, &targets_bytes)?;
        let targets = self
            .decoder
            .targets(&targets_bytes)
            .map_err(|_| Error::Decode)?;
        verify_role(
            &targets,
            Role::Targets,
            &self.trusted_root.signed,
            &self.verifier,
        )?;
        reject_expired(targets.signed.expires_unix, now_unix)?;
        if targets.signed.version != snapshot.signed.targets.version {
            return Err(Error::MixAndMatch);
        }
        reject_replay(
            targets.signed.version,
            digest(&targets.canonical_signed),
            self.state.targets_version,
            self.state.targets_sha256,
        )?;

        let target_path = format!("plugins/{plugin_id}/{version}.bbcom");
        let target = targets
            .signed
            .targets
            .get(&target_path)
            .ok_or(Error::TargetNotFound)?;
        validate_target(target, plugin_id, version)?;
        let package_path = target_name(
            &target_path,
            target.sha256,
            self.trusted_root.signed.consistent_snapshot,
        );
        let package = fetch_bounded(
            &mut self.fetch,
            &self.endpoint,
            &package_path,
            target.length,
        )?;
        verify_length_digest(target.length, target.sha256, &package)?;
        verify_publisher(self.policy, target, &package, &self.verifier)?;

        self.state.timestamp_version = timestamp.signed.version;
        self.state.timestamp_sha256 = Some(digest(&timestamp.canonical_signed));
        self.state.snapshot_version = snapshot.signed.version;
        self.state.snapshot_sha256 = Some(digest(&snapshot.canonical_signed));
        self.state.targets_version = targets.signed.version;
        self.state.targets_sha256 = Some(digest(&targets.canonical_signed));

        Ok(TrustedPackage {
            repository_id: self.endpoint.id().to_owned(),
            repository_origin: self.endpoint.origin().to_owned(),
            plugin_id: plugin_id.to_owned(),
            version: version.to_owned(),
            publisher_identity: format!("publisher:sha256-{}", hex(&digest(&target.publisher_key))),
            package_url: self.endpoint.target_url(&package_path)?,
            sha256: hex(&target.sha256),
            expanded_bytes: target.expanded_bytes,
            files: target.files,
            bytes: package,
        })
    }
}

fn validate_root_shape(root: &RootMetadata) -> Result<()> {
    if root.version == 0 || root.keys.is_empty() || root.roles.len() != 4 {
        return Err(Error::InvalidMetadata);
    }
    for role in [Role::Root, Role::Timestamp, Role::Snapshot, Role::Targets] {
        let definition = root.roles.get(&role).ok_or(Error::MissingMetadata)?;
        if definition.threshold == 0
            || usize::try_from(definition.threshold).unwrap_or(usize::MAX)
                > definition.key_ids.len()
        {
            return Err(Error::InvalidMetadata);
        }
        let mut unique = BTreeSet::new();
        for key_id in &definition.key_ids {
            if !unique.insert(key_id) || !root.keys.contains_key(key_id) {
                return Err(Error::InvalidMetadata);
            }
        }
    }
    Ok(())
}

fn verify_role<T>(
    metadata: &Signed<T>,
    role: Role,
    root: &RootMetadata,
    verifier: &impl Ed25519Verifier,
) -> Result<()> {
    let definition = root.roles.get(&role).ok_or(Error::MissingMetadata)?;
    let authorized: BTreeSet<&str> = definition.key_ids.iter().map(String::as_str).collect();
    let mut accepted = BTreeSet::new();
    for signature in &metadata.signatures {
        if !authorized.contains(signature.key_id.as_str()) || !accepted.insert(&signature.key_id) {
            continue;
        }
        let Key { ed25519 } = root
            .keys
            .get(&signature.key_id)
            .ok_or(Error::InvalidMetadata)?;
        if !verifier.verify(ed25519, &metadata.canonical_signed, &signature.ed25519) {
            accepted.remove(&signature.key_id);
        }
    }
    if accepted.len() < usize::try_from(definition.threshold).unwrap_or(usize::MAX) {
        return Err(Error::SignatureThreshold);
    }
    Ok(())
}

fn reject_expired(expires_unix: u64, now_unix: u64) -> Result<()> {
    if expires_unix <= now_unix {
        Err(Error::ExpiredMetadata)
    } else {
        Ok(())
    }
}

fn reject_replay(
    version: u64,
    hash: [u8; 32],
    accepted_version: u64,
    accepted_hash: Option<[u8; 32]>,
) -> Result<()> {
    if version < accepted_version {
        return Err(Error::VersionRollback);
    }
    if version == accepted_version && accepted_hash.is_some_and(|accepted| accepted != hash) {
        return Err(Error::FreezeAttack);
    }
    Ok(())
}

fn validate_description(description: &MetadataDescription, maximum: u64) -> Result<()> {
    if description.version == 0 || description.length == 0 || description.length > maximum {
        Err(Error::InvalidMetadata)
    } else {
        Ok(())
    }
}

fn verify_description(description: &MetadataDescription, bytes: &[u8]) -> Result<()> {
    verify_length_digest(description.length, description.sha256, bytes).map_err(|error| match error
    {
        Error::LengthMismatch | Error::DigestMismatch => Error::MixAndMatch,
        other => other,
    })
}

fn verify_length_digest(length: u64, expected: [u8; 32], bytes: &[u8]) -> Result<()> {
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != length {
        return Err(Error::LengthMismatch);
    }
    if digest(bytes) != expected {
        return Err(Error::DigestMismatch);
    }
    Ok(())
}

fn validate_target(target: &TargetDescription, plugin_id: &str, version: &str) -> Result<()> {
    if target.plugin_id != plugin_id
        || target.version != version
        || target.length == 0
        || target.length > MAX_PACKAGE_BYTES
        || target.expanded_bytes == 0
        || target.expanded_bytes > MAX_PACKAGE_EXPANDED_BYTES
        || target.files == 0
        || target.files > MAX_PACKAGE_FILES
    {
        return Err(Error::TargetMismatch);
    }
    Ok(())
}

fn verify_publisher(
    policy: TrustPolicy,
    target: &TargetDescription,
    package: &[u8],
    verifier: &impl Ed25519Verifier,
) -> Result<()> {
    let Some(signature) = target.publisher_signature else {
        return if policy == TrustPolicy::Stable {
            Err(Error::UnsignedStablePackage)
        } else {
            Ok(())
        };
    };
    if !verifier.verify(&target.publisher_key, package, &signature) {
        return Err(Error::PublisherSignature);
    }
    Ok(())
}

fn metadata_name(name: &str, version: u64, consistent_snapshot: bool) -> String {
    if consistent_snapshot {
        format!("{version}.{name}")
    } else {
        name.to_owned()
    }
}

fn target_name(path: &str, sha256: [u8; 32], consistent_snapshot: bool) -> String {
    if !consistent_snapshot {
        return path.to_owned();
    }
    match path.rsplit_once('/') {
        Some((directory, file)) => format!("{directory}/{}.{file}", hex(&sha256)),
        None => format!("{}.{path}", hex(&sha256)),
    }
}

fn validate_request(plugin_id: &str, version: &str) -> Result<()> {
    if plugin_id.len() < 3
        || plugin_id.len() > 128
        || !plugin_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        || plugin_id.starts_with(['.', '-'])
        || plugin_id.ends_with(['.', '-'])
        || plugin_id.contains("..")
        || version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err(Error::InvalidConfiguration);
    }
    Ok(())
}
