use std::fs;
use std::path::PathBuf;

use bbcom_plugin_contracts::{PluginManifest, RepositoryIndex};

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/plugins/contracts")
        .join(name);
    fs::read_to_string(path).unwrap()
}

#[test]
fn legacy_manifest_publisher_identity_is_optional_and_ignored() {
    let valid = fixture("plugin.toml");
    let original = PluginManifest::parse(&valid).unwrap();
    assert_eq!(
        original.publisher.identity.as_deref(),
        Some("publisher:bbcom-contract-fixtures")
    );

    let missing = valid.replace("identity = \"publisher:bbcom-contract-fixtures\"\n", "");
    assert_eq!(
        PluginManifest::parse(&missing).unwrap().publisher.identity,
        None
    );

    let arbitrary = valid.replace(
        "publisher:bbcom-contract-fixtures",
        "legacy self-asserted value that is not an identity",
    );
    assert!(PluginManifest::parse(&arbitrary).is_ok());
}

#[test]
fn legacy_repository_publisher_identity_is_optional_and_ignored() {
    let valid = fixture("repository-index-v1.json");
    let original = RepositoryIndex::parse(&valid).unwrap();
    assert_eq!(
        original.plugins[0].publisher_identity.as_deref(),
        Some("publisher:bbcom-contract-fixtures")
    );

    let missing = valid.replace(
        "      \"publisher_identity\": \"publisher:bbcom-contract-fixtures\",\n",
        "",
    );
    assert_eq!(
        RepositoryIndex::parse(&missing).unwrap().plugins[0].publisher_identity,
        None
    );

    let arbitrary = valid.replace(
        "publisher:bbcom-contract-fixtures",
        "unsigned publisher note",
    );
    assert!(RepositoryIndex::parse(&arbitrary).is_ok());
}
