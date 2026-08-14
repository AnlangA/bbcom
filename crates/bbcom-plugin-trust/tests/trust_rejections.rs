use std::collections::{BTreeMap, VecDeque};

use bbcom_plugin_trust::{
    Ed25519Verifier, Error, FetchPort, FetchResponse, Key, MetadataDecoder, MetadataDescription,
    RepositoryEndpoint, RepositoryState, Role, RoleDefinition, RootMetadata, Signature, Signed,
    SnapshotMetadata, TargetDescription, TargetsMetadata, TimestampMetadata, TrustPolicy,
    TrustedRepository, TrustedRepositoryBootstrap,
};
use sha2::{Digest, Sha256};

const NOW: u64 = 1_900_000_000;

#[derive(Default)]
struct FakeFetch(VecDeque<FetchResponse>);

impl FetchPort for FakeFetch {
    type Error = ();

    fn get(&mut self, _url: &str, _maximum_bytes: u64) -> Result<FetchResponse, Self::Error> {
        self.0.pop_front().ok_or(())
    }
}

#[derive(Clone, Copy)]
struct FakeVerifier;

impl Ed25519Verifier for FakeVerifier {
    fn verify(&self, public_key: &[u8; 32], _message: &[u8], signature: &[u8; 64]) -> bool {
        signature[0] == public_key[0]
    }
}

struct FixtureDecoder {
    timestamp: Signed<TimestampMetadata>,
    snapshot: Signed<SnapshotMetadata>,
    targets: Signed<TargetsMetadata>,
    next_root: Signed<RootMetadata>,
}

impl MetadataDecoder for FixtureDecoder {
    type Error = ();

    fn root(&self, _bytes: &[u8]) -> Result<Signed<RootMetadata>, Self::Error> {
        Ok(self.next_root.clone())
    }

    fn timestamp(&self, _bytes: &[u8]) -> Result<Signed<TimestampMetadata>, Self::Error> {
        Ok(self.timestamp.clone())
    }

    fn snapshot(&self, _bytes: &[u8]) -> Result<Signed<SnapshotMetadata>, Self::Error> {
        Ok(self.snapshot.clone())
    }

    fn targets(&self, _bytes: &[u8]) -> Result<Signed<TargetsMetadata>, Self::Error> {
        Ok(self.targets.clone())
    }
}

#[test]
fn rejects_http_and_cross_origin_redirects() {
    assert_eq!(
        RepositoryEndpoint::new("stable", "http://repo.test/metadata/").unwrap_err(),
        Error::InvalidUrl
    );
    let mut fixture = fixture();
    fixture.0.0.push_front(FetchResponse {
        status: 302,
        location: Some("https://evil.test/timestamp.json".to_owned()),
        body: Vec::new(),
    });
    let mut repository = TrustedRepository::new(
        endpoint(),
        fixture.0,
        fixture.1,
        fixture.2,
        bootstrap(fixture.3, RepositoryState::default()),
    )
    .unwrap();
    assert_eq!(
        repository
            .refresh_and_download("dev.bbcom.fixture", "1.0.0", NOW)
            .unwrap_err(),
        Error::CrossOriginRedirect
    );
}

#[test]
fn rejects_expiry_rollback_freeze_and_mix_and_match() {
    let (_, mut decoder, verifier, root, _) = fixture();
    decoder.next_root = make_root(2, NOW);
    let mut expired = TrustedRepository::new(
        endpoint(),
        FakeFetch::default(),
        decoder,
        verifier,
        bootstrap(root, RepositoryState::default()),
    )
    .unwrap();
    assert_eq!(
        expired.apply_root_update(b"root", NOW).unwrap_err(),
        Error::ExpiredMetadata
    );

    let (fetch, mut decoder, verifier, root, _) = fixture();
    decoder.timestamp.signed.version = 1;
    let state = RepositoryState {
        timestamp_version: 2,
        ..RepositoryState::default()
    };
    let mut repository =
        TrustedRepository::new(endpoint(), fetch, decoder, verifier, bootstrap(root, state))
            .unwrap();
    assert_eq!(
        repository
            .refresh_and_download("dev.bbcom.fixture", "1.0.0", NOW)
            .unwrap_err(),
        Error::VersionRollback
    );

    let (fetch, decoder, verifier, root, _) = fixture();
    let state = RepositoryState {
        timestamp_version: 2,
        timestamp_sha256: Some([9; 32]),
        ..RepositoryState::default()
    };
    let mut repository =
        TrustedRepository::new(endpoint(), fetch, decoder, verifier, bootstrap(root, state))
            .unwrap();
    assert_eq!(
        repository
            .refresh_and_download("dev.bbcom.fixture", "1.0.0", NOW)
            .unwrap_err(),
        Error::FreezeAttack
    );

    let (fetch, mut decoder, verifier, root, _) = fixture();
    decoder.snapshot.signed.version += 1;
    let mut repository = TrustedRepository::new(
        endpoint(),
        fetch,
        decoder,
        verifier,
        bootstrap(root, RepositoryState::default()),
    )
    .unwrap();
    assert_eq!(
        repository
            .refresh_and_download("dev.bbcom.fixture", "1.0.0", NOW)
            .unwrap_err(),
        Error::MixAndMatch
    );
}

#[test]
fn stable_rejects_unsigned_or_bad_publisher_signature() {
    let (fetch, mut decoder, verifier, root, _) = fixture();
    decoder
        .targets
        .signed
        .targets
        .values_mut()
        .next()
        .unwrap()
        .publisher_signature = None;
    let mut repository = TrustedRepository::new(
        endpoint(),
        fetch,
        decoder,
        verifier,
        bootstrap(root, RepositoryState::default()),
    )
    .unwrap();
    assert_eq!(
        repository
            .refresh_and_download("dev.bbcom.fixture", "1.0.0", NOW)
            .unwrap_err(),
        Error::UnsignedStablePackage
    );

    let (fetch, mut decoder, verifier, root, _) = fixture();
    decoder
        .targets
        .signed
        .targets
        .values_mut()
        .next()
        .unwrap()
        .publisher_signature = Some([9; 64]);
    let mut repository = TrustedRepository::new(
        endpoint(),
        fetch,
        decoder,
        verifier,
        bootstrap(root, RepositoryState::default()),
    )
    .unwrap();
    assert_eq!(
        repository
            .refresh_and_download("dev.bbcom.fixture", "1.0.0", NOW)
            .unwrap_err(),
        Error::PublisherSignature
    );
}

#[test]
fn root_rotation_requires_sequential_old_and_new_thresholds() {
    let (_, decoder, verifier, root, mut repository) = fixture();
    let _ = (decoder, verifier, root);
    assert_eq!(
        repository.apply_root_update(b"new-root", NOW).unwrap_err(),
        Error::VersionGap
    );
}

fn fixture() -> (
    FakeFetch,
    FixtureDecoder,
    FakeVerifier,
    Signed<RootMetadata>,
    TrustedRepository<FakeFetch, FixtureDecoder, FakeVerifier>,
) {
    // Bytes and signed descriptions are intentionally independent in these
    // compile-only contract tests. Runtime vectors live with the concrete JSON
    // and Ed25519 adapters when those providers are selected.
    let timestamp_bytes = b"timestamp".to_vec();
    let snapshot_bytes = b"snapshot".to_vec();
    let targets_bytes = b"targets".to_vec();
    let package = b"package".to_vec();
    let root = make_root(1, NOW + 1_000);
    let timestamp = signed(
        TimestampMetadata {
            version: 2,
            expires_unix: NOW + 500,
            snapshot: description(1, &snapshot_bytes),
        },
        &timestamp_bytes,
        "timestamp",
        2,
    );
    let snapshot = signed(
        SnapshotMetadata {
            version: 1,
            expires_unix: NOW + 500,
            targets: description(1, &targets_bytes),
        },
        &snapshot_bytes,
        "snapshot",
        3,
    );
    let mut targets_map = BTreeMap::new();
    targets_map.insert(
        "plugins/dev.bbcom.fixture/1.0.0.bbcom".to_owned(),
        TargetDescription {
            plugin_id: "dev.bbcom.fixture".to_owned(),
            version: "1.0.0".to_owned(),
            length: package.len() as u64,
            sha256: sha256(&package),
            expanded_bytes: package.len() as u64,
            files: 2,
            publisher_key: [7; 32],
            publisher_signature: Some([7; 64]),
        },
    );
    let targets = signed(
        TargetsMetadata {
            version: 1,
            expires_unix: NOW + 500,
            targets: targets_map,
        },
        &targets_bytes,
        "targets",
        4,
    );
    let next_root = make_root(3, NOW + 1_000);
    let decoder = FixtureDecoder {
        timestamp,
        snapshot,
        targets,
        next_root,
    };
    let fetch = FakeFetch(VecDeque::from([
        response(timestamp_bytes),
        response(snapshot_bytes),
        response(targets_bytes),
        response(package),
    ]));
    let repository = TrustedRepository::new(
        endpoint(),
        FakeFetch::default(),
        FixtureDecoder {
            timestamp: decoder.timestamp.clone(),
            snapshot: decoder.snapshot.clone(),
            targets: decoder.targets.clone(),
            next_root: decoder.next_root.clone(),
        },
        FakeVerifier,
        bootstrap(root.clone(), RepositoryState::default()),
    )
    .unwrap();
    (fetch, decoder, FakeVerifier, root, repository)
}

fn endpoint() -> RepositoryEndpoint {
    RepositoryEndpoint::new("stable", "https://repo.test/metadata/").unwrap()
}

fn bootstrap(
    trusted_root: Signed<RootMetadata>,
    state: RepositoryState,
) -> TrustedRepositoryBootstrap {
    TrustedRepositoryBootstrap {
        trusted_root,
        state,
        policy: TrustPolicy::Stable,
        now_unix: NOW,
    }
}

fn make_root(version: u64, expires_unix: u64) -> Signed<RootMetadata> {
    let keys = BTreeMap::from([
        ("root".to_owned(), Key { ed25519: [1; 32] }),
        ("timestamp".to_owned(), Key { ed25519: [2; 32] }),
        ("snapshot".to_owned(), Key { ed25519: [3; 32] }),
        ("targets".to_owned(), Key { ed25519: [4; 32] }),
    ]);
    let roles = BTreeMap::from([
        (Role::Root, role("root")),
        (Role::Timestamp, role("timestamp")),
        (Role::Snapshot, role("snapshot")),
        (Role::Targets, role("targets")),
    ]);
    signed(
        RootMetadata {
            version,
            expires_unix,
            consistent_snapshot: false,
            keys,
            roles,
        },
        b"root",
        "root",
        1,
    )
}

fn role(key: &str) -> RoleDefinition {
    RoleDefinition {
        key_ids: vec![key.to_owned()],
        threshold: 1,
    }
}

fn signed<T>(value: T, bytes: &[u8], key: &str, marker: u8) -> Signed<T> {
    Signed {
        canonical_signed: bytes.to_vec(),
        signatures: vec![Signature {
            key_id: key.to_owned(),
            ed25519: [marker; 64],
        }],
        signed: value,
    }
}

fn description(version: u64, bytes: &[u8]) -> MetadataDescription {
    MetadataDescription {
        version,
        length: bytes.len() as u64,
        sha256: sha256(bytes),
    }
}

fn response(body: Vec<u8>) -> FetchResponse {
    FetchResponse {
        status: 200,
        location: None,
        body,
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
