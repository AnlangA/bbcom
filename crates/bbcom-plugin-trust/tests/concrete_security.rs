use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use bbcom_plugin_trust::{
    CanonicalJsonDecoder, Ed25519Verifier, Error, MetadataDecoder, PersistedTrustState,
    RepositoryState, RingEd25519Verifier, TrustedStateStore,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

static DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[test]
fn ring_verifier_accepts_rfc8032_vector_and_rejects_mutation() {
    let public =
        decode_array::<32>("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    let signature = decode_array::<64>(concat!(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    ));
    let verifier = RingEd25519Verifier;
    assert!(verifier.verify(&public, b"", &signature));
    let mut mutated = signature;
    mutated[0] ^= 1;
    assert!(!verifier.verify(&public, b"", &mutated));
}

#[test]
fn canonical_decoder_rejects_duplicate_and_unknown_fields() {
    let duplicate = br#"{
      "signatures": [],
      "signed": {"_type":"root","_type":"root"}
    }"#;
    assert!(CanonicalJsonDecoder.root(duplicate).is_err());

    let mut root = root_envelope(1);
    root.as_object_mut()
        .unwrap()
        .insert("unexpected".to_owned(), Value::Bool(true));
    assert!(
        CanonicalJsonDecoder
            .root(&serde_json::to_vec(&root).unwrap())
            .is_err()
    );
}

#[test]
fn state_store_round_trips_and_rejects_durable_rollback() {
    let directory = temporary_directory();
    let store = TrustedStateStore::new(&directory, "stable").unwrap();
    let root = serde_json::to_vec(&root_envelope(1)).unwrap();
    let accepted = PersistedTrustState::new(
        RepositoryState {
            root_version: 1,
            timestamp_version: 2,
            timestamp_sha256: Some([2; 32]),
            snapshot_version: 2,
            snapshot_sha256: Some([3; 32]),
            targets_version: 2,
            targets_sha256: Some([4; 32]),
        },
        root.clone(),
    )
    .unwrap();
    store.commit(&accepted).unwrap();
    assert_eq!(store.load().unwrap(), Some(accepted));

    let rollback = PersistedTrustState::new(
        RepositoryState {
            root_version: 1,
            timestamp_version: 1,
            timestamp_sha256: Some([1; 32]),
            snapshot_version: 2,
            snapshot_sha256: Some([3; 32]),
            targets_version: 2,
            targets_sha256: Some([4; 32]),
        },
        root,
    )
    .unwrap();
    assert_eq!(store.commit(&rollback).unwrap_err(), Error::VersionRollback);
    std::fs::remove_dir_all(directory).unwrap();
}

fn root_envelope(version: u64) -> Value {
    let public = "11".repeat(32);
    let key = json!({
        "keytype": "ed25519",
        "keyval": {"public": public},
        "scheme": "ed25519"
    });
    let key_id = hex(&Sha256::digest(serde_json::to_vec(&key).unwrap()));
    let mut keys = serde_json::Map::new();
    keys.insert(key_id.clone(), key);
    json!({
        "signatures": [{"keyid": key_id, "sig": "00".repeat(64)}],
        "signed": {
            "_type": "root",
            "consistent_snapshot": true,
            "expires": "2099-01-01T00:00:00Z",
            "keys": Value::Object(keys),
            "roles": {
                "root": {"keyids": [key_id.clone()], "threshold": 1},
                "snapshot": {"keyids": [key_id.clone()], "threshold": 1},
                "targets": {"keyids": [key_id.clone()], "threshold": 1},
                "timestamp": {"keyids": [key_id], "threshold": 1}
            },
            "spec_version": "1.0.31",
            "version": version
        }
    })
}

fn temporary_directory() -> std::path::PathBuf {
    let sequence = DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "bbcom-plugin-trust-{}-{sequence}-{nanos}",
        std::process::id()
    ))
}

fn decode_array<const N: usize>(value: &str) -> [u8; N] {
    let mut output = [0_u8; N];
    for (target, pair) in output.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        *target = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    output
}

fn nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        _ => panic!("invalid test hex"),
    }
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
