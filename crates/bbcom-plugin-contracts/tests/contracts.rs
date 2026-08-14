use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use bbcom_plugin_contracts::generated::{Envelope, HostHello, envelope};
use bbcom_plugin_contracts::{
    AuthorizationKey, CALL_TIMEOUT_MS, ContractError, FRAME_LENGTH_PREFIX_BYTES,
    HANDSHAKE_TIMEOUT_MS, HOST_PROCESS_MEMORY_LIMIT_BYTES, LONG_TASK_TIMEOUT_MS, MAX_FRAME_BYTES,
    MAX_PACKAGE_DOWNLOAD_BYTES, MAX_PACKAGE_EXPANDED_BYTES, MAX_PACKAGE_FILES,
    MAX_PLUGIN_PERSISTED_STATE_BYTES, MAX_PLUGIN_STATE_CHUNK_BYTES, MAX_QUEUE_BYTES,
    MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES, PLUGIN_STATE_SCHEMA_VERSION, PROTOCOL_MAJOR,
    PROTOCOL_MINOR, Permission, PermissionRisk, PluginManifest, RepositoryCatalog, RepositoryIndex,
    RiskCombination, Sha256Digest, WASM_MEMORY_LIMIT_BYTES, WIT_PACKAGE, decode_frame,
    encode_frame, permission_plan, validate_persistent_grant, validate_queue_bytes,
};
use prost::Message;

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/plugins/contracts")
        .join(name);
    fs::read_to_string(path).unwrap()
}

fn host_hello() -> Envelope {
    Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        request_id: 7,
        payload: Some(envelope::Payload::HostHello(HostHello {
            wit_package: WIT_PACKAGE.to_owned(),
            plugin_id: "dev.bbcom.golden".to_owned(),
            plugin_version: "1.2.3".to_owned(),
            granted_capabilities: vec!["ui.panel".to_owned()],
        })),
    }
}

#[test]
fn golden_manifest_and_repository_are_strict_and_bounded() {
    let manifest = PluginManifest::parse(&fixture("plugin.toml")).unwrap();
    assert_eq!(manifest.id, "dev.bbcom.golden");
    assert_eq!(manifest.component.path, "component/plugin.wasm");
    assert_eq!(
        manifest.permissions().unwrap(),
        vec![
            Permission::SessionMetadataRead,
            Permission::SessionCaptureRead,
            Permission::SerialWriteProposal,
        ]
    );

    let index = RepositoryIndex::parse(&fixture("repository-index-v1.json")).unwrap();
    assert_eq!(index.schema, 1);
    assert_eq!(index.origin, "https://plugins.bbcom.dev");
    assert_eq!(index.update_policy, "manual");
    assert_eq!(index.plugins[0].packages[0].version, "1.2.3");
    let mut second = index.clone();
    second.origin = "https://plugins.example.org".to_owned();
    second.plugins[0].packages[0].url =
        "https://plugins.example.org/packages/dev.bbcom.golden-1.2.3.zip".to_owned();
    assert!(RepositoryCatalog::new(vec![index.clone(), second]).is_ok());
    assert!(RepositoryCatalog::new(vec![index.clone(), index]).is_err());

    for forbidden in [
        "executable = \"install.exe\"",
        "install-script = \"setup.sh\"",
        "symlink = \"component/plugin.wasm\"",
    ] {
        let invalid = fixture("plugin.toml").replacen(
            "[component]",
            &format!("{forbidden}\n\n[component]"),
            1,
        );
        assert!(matches!(
            PluginManifest::parse(&invalid),
            Err(ContractError::UnknownField { .. })
        ));
    }

    let network = fixture("plugin.toml").replace("\"session.metadata.read\",", "\"network.http\",");
    assert!(matches!(
        PluginManifest::parse(&network),
        Err(ContractError::UnsupportedCapability { capability }) if capability == "network.http"
    ));

    let http = fixture("repository-index-v1.json").replace("https://plugins", "http://plugins");
    assert!(RepositoryIndex::parse(&http).is_err());
    let oversize = fixture("repository-index-v1.json").replace(
        "\"download_bytes\": 1048576",
        &format!("\"download_bytes\": {}", MAX_PACKAGE_DOWNLOAD_BYTES + 1),
    );
    assert!(matches!(
        RepositoryIndex::parse(&oversize),
        Err(ContractError::LimitExceeded {
            field: "downloadBytes",
            ..
        })
    ));
}

#[test]
fn permissions_have_fixed_risk_and_authorization_scope() {
    let requested = [
        Permission::SessionMetadataRead,
        Permission::SessionCaptureRead,
        Permission::SerialWriteProposal,
    ];
    let plan = permission_plan(&requested);
    assert_eq!(
        plan.implicit,
        [Permission::UiPanel, Permission::PluginStorage]
            .into_iter()
            .collect()
    );
    assert_eq!(plan.maximum_risk, PermissionRisk::High);
    assert!(
        plan.requires_approval
            .contains(&Permission::SerialWriteProposal)
    );
    assert_eq!(
        validate_persistent_grant(Permission::SerialWriteProposal),
        Err(ContractError::SerialProposalNotPersistable)
    );
    assert!(validate_persistent_grant(Permission::SessionMetadataRead).is_ok());
    assert!(matches!(
        Permission::from_str("network.http"),
        Err(ContractError::UnsupportedCapability { .. })
    ));

    let key = AuthorizationKey {
        plugin_id: "dev.bbcom.golden".to_owned(),
        publisher_identity: "publisher:bbcom-contract-fixtures".to_owned(),
        plugin_major: 1,
        workspace_id: "8e7b84cf-35f4-45cd-baf0-55d94ebf0213".to_owned(),
    };
    let mut other_workspace = key.clone();
    other_workspace.workspace_id = "65981dbf-942d-4cc8-a351-22060936e92d".to_owned();
    assert_ne!(key, other_workspace);

    let critical = permission_plan(&[
        Permission::SessionCaptureRead,
        Permission::FileOpenSave,
        Permission::SerialControl,
        Permission::SerialWriteProposal,
    ]);
    assert_eq!(critical.maximum_risk, PermissionRisk::Critical);
    assert_eq!(
        critical.risk_combinations,
        [
            RiskCombination::CaptureWithExternalSink,
            RiskCombination::SerialControlAndWriteProposal,
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn u32_le_wire_fixture_is_stable_and_rejects_invalid_frames() {
    let envelope = host_hello();
    let frame = encode_frame(&envelope).unwrap();
    assert_eq!(
        frame.len(),
        FRAME_LENGTH_PREFIX_BYTES + envelope.encoded_len()
    );
    assert_eq!(
        u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize,
        envelope.encoded_len()
    );
    assert_eq!(decode_frame(&frame).unwrap(), envelope);

    let golden = decode_hex(fixture("envelope-host-hello-v1.hex").trim());
    assert_eq!(frame, golden, "field numbers or wire encoding changed");

    let mut wrong_major = host_hello();
    wrong_major.protocol_major = 2;
    assert_eq!(
        encode_frame(&wrong_major),
        Err(ContractError::IncompatibleMajor { found: 2 })
    );
    let mut no_payload = host_hello();
    no_payload.payload = None;
    assert_eq!(
        encode_frame(&no_payload),
        Err(ContractError::UnknownPayload)
    );

    let mut oversize = vec![0_u8; 4];
    oversize[..4].copy_from_slice(&((MAX_FRAME_BYTES as u32) + 1).to_le_bytes());
    assert!(matches!(
        decode_frame(&oversize),
        Err(ContractError::LimitExceeded {
            field: "frameBytes",
            ..
        })
    ));
    assert_eq!(
        decode_frame(&frame[..frame.len() - 1]),
        Err(ContractError::TruncatedFrame)
    );

    let unknown_payload =
        encode_raw_message(&[0x08, 0x01, 0x10, 0x00, 0x18, 0x01, 0xa2, 0x06, 0x00]);
    assert_eq!(
        decode_frame(&unknown_payload),
        Err(ContractError::UnknownPayload)
    );
}

#[test]
fn protocol_and_package_limits_are_fixed() {
    assert_eq!(PROTOCOL_MAJOR, 1);
    assert_eq!(PROTOCOL_MINOR, 1);
    assert_eq!(WIT_PACKAGE, "bbcom:plugin@1.0.0");
    assert_eq!(HANDSHAKE_TIMEOUT_MS, 5_000);
    assert_eq!(CALL_TIMEOUT_MS, 2_000);
    assert_eq!(LONG_TASK_TIMEOUT_MS, 60_000);
    assert_eq!(MAX_FRAME_BYTES, 1024 * 1024);
    assert_eq!(MAX_QUEUE_BYTES, 16 * 1024 * 1024);
    assert_eq!(WASM_MEMORY_LIMIT_BYTES, 64 * 1024 * 1024);
    assert_eq!(HOST_PROCESS_MEMORY_LIMIT_BYTES, 256 * 1024 * 1024);
    assert_eq!(PLUGIN_STATE_SCHEMA_VERSION, 1);
    assert_eq!(MAX_PLUGIN_PERSISTED_STATE_BYTES, 16 * 1024 * 1024);
    assert_eq!(MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES, 64 * 1024 * 1024);
    assert_eq!(MAX_PLUGIN_STATE_CHUNK_BYTES, 512 * 1024);
    assert_eq!(MAX_PACKAGE_DOWNLOAD_BYTES, 100 * 1024 * 1024);
    assert_eq!(MAX_PACKAGE_EXPANDED_BYTES, 256 * 1024 * 1024);
    assert_eq!(MAX_PACKAGE_FILES, 2_048);
    assert!(validate_queue_bytes(MAX_QUEUE_BYTES).is_ok());
    assert!(matches!(
        validate_queue_bytes(MAX_QUEUE_BYTES + 1),
        Err(ContractError::LimitExceeded {
            field: "queueBytes",
            ..
        })
    ));
    let digest = Sha256Digest::parse_hex(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "sha256",
    )
    .unwrap();
    assert!(digest.verifies(b"abc"));
}

#[test]
fn wit_is_the_only_wasm_surface_and_contains_no_ambient_authority() {
    let wit = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../wit/bbcom-plugin-v1/plugin.wit"),
    )
    .unwrap();
    assert!(wit.contains("package bbcom:plugin@1.0.0;"));
    for required in [
        "declarative-panel",
        "storage-get",
        "session-list",
        "capture-read",
        "project-state-get",
        "propose-serial-send",
    ] {
        assert!(wit.contains(required), "missing WIT operation {required}");
    }
    for forbidden in [
        "wasi:http",
        "wasi:filesystem",
        "wasi:sockets",
        "get-environment",
        "spawn-process",
        "tauri",
        "api-key",
        "file-handle",
    ] {
        assert!(
            !wit.contains(forbidden),
            "ambient authority leaked into WIT: {forbidden}"
        );
    }
}

fn encode_raw_message(message: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + message.len());
    frame.extend_from_slice(&(message.len() as u32).to_le_bytes());
    frame.extend_from_slice(message);
    frame
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(pair, 16).unwrap()
        })
        .collect()
}
