use std::fs;
use std::path::PathBuf;

use bbcom_plugin_contracts::generated_v2::Capability;
use bbcom_plugin_contracts::{
    ContractError, MAX_PACKAGE_DOWNLOAD_BYTES, MAX_PACKAGE_EXPANDED_BYTES, MAX_PACKAGE_FILES,
    MAX_PLUGIN_PERSISTED_STATE_BYTES, MAX_PLUGIN_STATE_CHUNK_BYTES,
    MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES, PluginManifest, RepositoryCatalog, RepositoryIndex,
    Sha256Digest,
};

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/plugins/contracts")
        .join(name);
    fs::read_to_string(path).unwrap()
}

#[test]
fn manifest_and_repository_are_v2_only_strict_and_bounded() {
    let manifest = PluginManifest::parse(&fixture("plugin.toml")).unwrap();
    assert_eq!(manifest.id, "dev.bbcom.golden");
    assert_eq!(manifest.component.path, "component/plugin.wasm");
    assert_eq!(
        manifest.v2_capabilities().unwrap(),
        vec![Capability::SerialIo, Capability::SessionCaptureRead]
    );

    let index = RepositoryIndex::parse(&fixture("repository-index.json")).unwrap();
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
        "identity = \"publisher:self-asserted\"",
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

    for unsupported_api in ["^3.0", "*", ">=2"] {
        let invalid = fixture("plugin.toml")
            .replace("api = \"^2.0\"", &format!("api = \"{unsupported_api}\""));
        assert!(matches!(
            PluginManifest::parse(&invalid),
            Err(ContractError::InvalidField { field: "api" })
        ));
    }

    let unknown = fixture("plugin.toml").replace("\"serial.io\",", "\"network.http\",");
    assert!(matches!(
        PluginManifest::parse(&unknown),
        Err(ContractError::InvalidField {
            field: "requestedCapabilities"
        })
    ));

    let publisher_claim = fixture("repository-index.json").replace(
        "\"description\": \"Protocol and repository contract fixture\",",
        "\"description\": \"Protocol and repository contract fixture\",\n      \"publisher_signature\": \"self-asserted\",",
    );
    assert!(matches!(
        RepositoryIndex::parse(&publisher_claim),
        Err(ContractError::UnknownField { .. })
    ));

    let http = fixture("repository-index.json").replace("https://plugins", "http://plugins");
    assert!(RepositoryIndex::parse(&http).is_err());
    let oversize = fixture("repository-index.json").replace(
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
fn package_and_state_limits_are_fixed() {
    assert_eq!(MAX_PLUGIN_PERSISTED_STATE_BYTES, 16 * 1024 * 1024);
    assert_eq!(MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES, 64 * 1024 * 1024);
    assert_eq!(MAX_PLUGIN_STATE_CHUNK_BYTES, 512 * 1024);
    assert_eq!(MAX_PACKAGE_DOWNLOAD_BYTES, 100 * 1024 * 1024);
    assert_eq!(MAX_PACKAGE_EXPANDED_BYTES, 256 * 1024 * 1024);
    assert_eq!(MAX_PACKAGE_FILES, 2_048);
    let digest = Sha256Digest::parse_hex(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "sha256",
    )
    .unwrap();
    assert!(digest.verifies(b"abc"));
}
