use std::collections::{BTreeMap, VecDeque};
use std::io::{Cursor, Write};
use std::sync::Mutex;

use bbcom_plugin_contracts::{RepositoryIndex, Sha256Digest};
use bbcom_plugin_repository::{
    HttpsResponse, HttpsTransport, InstallOutcome, PluginInstaller, RepositoryClient,
    RepositoryConfiguration, RepositoryEndpoint, RepositoryError, TransportError,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const PLUGIN_ID: &str = "dev.bbcom.fixture";

#[derive(Debug)]
struct PackageFixture {
    bytes: Vec<u8>,
    expanded_bytes: u64,
    files: u32,
}

#[derive(Default)]
struct MockTransport {
    responses: Mutex<BTreeMap<String, VecDeque<HttpsResponse>>>,
}

impl MockTransport {
    fn add(&mut self, url: &str, response: HttpsResponse) {
        self.responses
            .get_mut()
            .unwrap()
            .entry(url.to_owned())
            .or_default()
            .push_back(response);
    }
}

impl HttpsTransport for MockTransport {
    fn get(
        &self,
        url: &str,
        _max_response_bytes: u64,
    ) -> std::result::Result<HttpsResponse, TransportError> {
        self.responses
            .lock()
            .unwrap()
            .get_mut(url)
            .and_then(VecDeque::pop_front)
            .ok_or_else(|| TransportError::new(format!("unexpected URL {url}")))
    }
}

#[test]
fn multiple_https_repositories_are_manual_and_redirects_are_same_origin() {
    let first = valid_package("1.1.0", &[]);
    let second = valid_package("1.2.0", &[]);
    let first_index = index_json(
        "https://repo-one.test",
        "https://repo-one.test/packages/plugin-1.1.0.zip",
        "1.1.0",
        &first,
        None,
    );
    let second_index = index_json(
        "https://repo-two.test",
        "https://repo-two.test/packages/plugin-1.2.0.zip",
        "1.2.0",
        &second,
        None,
    );
    let mut transport = MockTransport::default();
    transport.add(
        "https://repo-one.test/index.json",
        HttpsResponse::new(
            302,
            vec![("Location".to_owned(), "/catalog/index.json".to_owned())],
            Vec::new(),
        ),
    );
    transport.add(
        "https://repo-one.test/catalog/index.json",
        HttpsResponse::new(200, Vec::new(), first_index.into_bytes()),
    );
    transport.add(
        "https://repo-two.test/index.json",
        HttpsResponse::new(200, Vec::new(), second_index.into_bytes()),
    );
    let client = RepositoryClient::new(transport);
    let configuration = RepositoryConfiguration::new(vec![
        RepositoryEndpoint::new("repo-one", "https://repo-one.test/index.json").unwrap(),
        RepositoryEndpoint::new("repo-two", "https://repo-two.test/index.json").unwrap(),
    ])
    .unwrap();
    let catalog = client.fetch_catalog(&configuration).unwrap();
    let candidates = client
        .manual_update_candidates(&catalog, PLUGIN_ID, "1.0.0")
        .unwrap();
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].package.version, "1.2.0");
    assert_eq!(candidates[1].package.version, "1.1.0");
    assert!(
        catalog
            .repositories
            .iter()
            .all(|repository| repository.update_policy == "manual")
    );

    let mut hostile = MockTransport::default();
    hostile.add(
        "https://repo-one.test/index.json",
        HttpsResponse::new(
            307,
            vec![(
                "location".to_owned(),
                "https://cdn.attacker.test/index.json".to_owned(),
            )],
            Vec::new(),
        ),
    );
    let hostile_client = RepositoryClient::new(hostile);
    let one = RepositoryConfiguration::new(vec![
        RepositoryEndpoint::new("repo-one", "https://repo-one.test/index.json").unwrap(),
    ])
    .unwrap();
    assert!(matches!(
        hostile_client.fetch_catalog(&one),
        Err(RepositoryError::CrossOriginRedirect)
    ));
}

#[test]
fn downloads_require_exact_declared_size_and_sha256() {
    let package = valid_package("1.0.0", &[]);
    let url = "https://repo.test/plugin.zip";
    let wrong_size = index_json(
        "https://repo.test",
        url,
        "1.0.0",
        &package,
        Some((package.bytes.len() as u64) + 1),
    );
    let index = RepositoryIndex::parse(&wrong_size).unwrap();
    let mut transport = MockTransport::default();
    transport.add(
        url,
        HttpsResponse::new(200, Vec::new(), package.bytes.clone()),
    );
    let client = RepositoryClient::new(transport);
    assert!(matches!(
        client.download_package(&index, PLUGIN_ID, "1.0.0"),
        Err(RepositoryError::PackageMetadataMismatch {
            field: "downloadBytes",
            ..
        })
    ));

    let wrong_digest = index_json("https://repo.test", url, "1.0.0", &package, None)
        .replace(&sha256_hex(&package.bytes), &"0".repeat(64));
    let index = RepositoryIndex::parse(&wrong_digest).unwrap();
    let mut transport = MockTransport::default();
    transport.add(
        url,
        HttpsResponse::new(200, Vec::new(), package.bytes.clone()),
    );
    let client = RepositoryClient::new(transport);
    assert!(matches!(
        client.download_package(&index, PLUGIN_ID, "1.0.0"),
        Err(RepositoryError::PackageDigestMismatch)
    ));
}

#[test]
fn staging_rejects_traversal_links_scripts_and_oversized_manifests() {
    let temporary = TempDir::new().unwrap();
    let installer = PluginInstaller::new(
        temporary.path().join("packages"),
        temporary.path().join("data"),
    )
    .unwrap();

    let traversal = valid_package("1.0.0", &[("../escaped.txt", b"escape")]);
    let download = download_fixture("https://repo.test/traversal.zip", "1.0.0", traversal);
    assert!(matches!(
        installer.install(&download),
        Err(RepositoryError::InvalidArchive("path traversal"))
            | Err(RepositoryError::InvalidArchive(
                "absolute or malformed path"
            ))
    ));
    assert!(!temporary.path().join("escaped.txt").exists());

    let linked = package_with_symlink("1.0.0");
    let download = download_fixture("https://repo.test/link.zip", "1.0.0", linked);
    assert!(matches!(
        installer.install(&download),
        Err(RepositoryError::LinkEntryForbidden)
    ));

    let script = valid_package("1.0.0", &[("setup.sh", b"#!/bin/sh\nexit 0\n")]);
    let download = download_fixture("https://repo.test/script.zip", "1.0.0", script);
    assert!(matches!(
        installer.install(&download),
        Err(RepositoryError::NativeExecutableForbidden)
    ));

    let oversized = package_with_oversized_manifest("1.0.0");
    let download = download_fixture("https://repo.test/manifest.zip", "1.0.0", oversized);
    assert!(matches!(
        installer.install(&download),
        Err(RepositoryError::ManifestUnavailable)
    ));
}

#[test]
fn upgrades_are_side_by_side_atomic_and_keep_two_rollback_candidates() {
    let temporary = TempDir::new().unwrap();
    let package_root = temporary.path().join("packages");
    let data_root = temporary.path().join("data");
    let installer = PluginInstaller::new(&package_root, &data_root).unwrap();

    let v1 = download_fixture(
        "https://repo.test/v1.zip",
        "1.0.0",
        valid_package("1.0.0", &[]),
    );
    assert!(matches!(
        installer.install(&v1).unwrap(),
        InstallOutcome::Activated {
            previous_version: None,
            ..
        }
    ));
    let plugin_data = data_root.join(PLUGIN_ID);
    std::fs::create_dir_all(&plugin_data).unwrap();
    std::fs::write(plugin_data.join("state.bin"), b"stable-data").unwrap();

    let v2 = download_fixture(
        "https://repo.test/v2.zip",
        "2.0.0",
        valid_package("2.0.0", &[]),
    );
    installer.install(&v2).unwrap();
    assert_eq!(
        std::fs::read(plugin_data.join("state.bin")).unwrap(),
        b"stable-data"
    );
    let first_candidates = installer.rollback_candidates(PLUGIN_ID).unwrap();
    assert_eq!(first_candidates.len(), 1);
    assert_eq!(first_candidates[0].version, "1.0.0");
    assert_eq!(
        std::fs::read(
            first_candidates[0]
                .data_snapshot_directory
                .as_ref()
                .unwrap()
                .join("state.bin")
        )
        .unwrap(),
        b"stable-data"
    );

    let malicious_v3 = download_fixture(
        "https://repo.test/v3-bad.zip",
        "3.0.0",
        valid_package("3.0.0", &[("install.exe", b"MZpayload")]),
    );
    assert!(matches!(
        installer.install(&malicious_v3),
        Err(RepositoryError::NativeExecutableForbidden)
    ));
    assert_eq!(
        installer
            .active_installation(PLUGIN_ID)
            .unwrap()
            .unwrap()
            .version,
        "2.0.0"
    );
    assert_eq!(
        std::fs::read(plugin_data.join("state.bin")).unwrap(),
        b"stable-data"
    );

    for version in ["3.0.0", "4.0.0"] {
        let url = format!("https://repo.test/v{version}.zip");
        let download = download_fixture(&url, version, valid_package(version, &[]));
        installer.install(&download).unwrap();
    }
    let active = installer.active_installation(PLUGIN_ID).unwrap().unwrap();
    assert_eq!(active.version, "4.0.0");
    let candidates = installer.rollback_candidates(PLUGIN_ID).unwrap();
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.version.as_str())
            .collect::<Vec<_>>(),
        vec!["3.0.0", "2.0.0"]
    );
    for version in ["1.0.0", "2.0.0", "3.0.0", "4.0.0"] {
        assert!(
            package_root
                .join("plugins")
                .join(PLUGIN_ID)
                .join("versions")
                .join(version)
                .is_dir()
        );
    }

    let conflicting_v4 = download_fixture(
        "https://repo.test/v4-conflict.zip",
        "4.0.0",
        valid_package("4.0.0", &[("notes.txt", b"different package")]),
    );
    assert!(matches!(
        installer.install(&conflicting_v4),
        Err(RepositoryError::VersionDigestConflict)
    ));
}

#[test]
fn rollback_atomically_selects_package_and_restores_matching_data() {
    let temporary = TempDir::new().unwrap();
    let data_root = temporary.path().join("data");
    let installer = PluginInstaller::new(temporary.path().join("packages"), &data_root).unwrap();
    let v1 = download_fixture(
        "https://repo.test/v1.zip",
        "1.0.0",
        valid_package("1.0.0", &[]),
    );
    installer.install(&v1).unwrap();
    let plugin_data = data_root.join(PLUGIN_ID);
    std::fs::create_dir_all(&plugin_data).unwrap();
    std::fs::write(plugin_data.join("state.bin"), b"v1-state").unwrap();

    let v2 = download_fixture(
        "https://repo.test/v2.zip",
        "2.0.0",
        valid_package("2.0.0", &[]),
    );
    installer.install(&v2).unwrap();
    std::fs::write(plugin_data.join("state.bin"), b"v2-state").unwrap();

    let rollback = installer.activate_rollback(PLUGIN_ID, "1.0.0").unwrap();
    assert_eq!(rollback.previous_version, "2.0.0");
    assert_eq!(rollback.active.version, "1.0.0");
    assert_eq!(
        std::fs::read(plugin_data.join("state.bin")).unwrap(),
        b"v1-state"
    );

    let forward = installer.activate_rollback(PLUGIN_ID, "2.0.0").unwrap();
    assert_eq!(forward.active.version, "2.0.0");
    assert_eq!(
        std::fs::read(plugin_data.join("state.bin")).unwrap(),
        b"v2-state"
    );
}

#[test]
fn durable_prepare_does_not_activate_and_survives_installer_reopen() {
    let temporary = TempDir::new().unwrap();
    let package_root = temporary.path().join("packages");
    let data_root = temporary.path().join("data");
    let download = download_fixture(
        "https://repo.test/v1.zip",
        "1.0.0",
        valid_package("1.0.0", &[]),
    );
    let installer = PluginInstaller::new(&package_root, &data_root).unwrap();
    let prepared = installer.prepare_install(&download).unwrap();
    assert!(installer.active_installation(PLUGIN_ID).unwrap().is_none());
    assert!(
        installer
            .prepared_package_directory(&prepared)
            .unwrap()
            .is_dir()
    );
    let token = prepared.token().to_owned();
    drop(installer);

    let reopened = PluginInstaller::new(&package_root, &data_root).unwrap();
    let recovered = reopened.prepared_installation(&token).unwrap();
    assert_eq!(recovered, prepared);
    let active = reopened.commit_prepared(&recovered).unwrap();
    assert_eq!(active.version, "1.0.0");
    assert_eq!(
        reopened
            .active_package_directory(PLUGIN_ID, "1.0.0")
            .unwrap(),
        active.package_directory
    );
    assert!(reopened.prepared_installation(&token).is_err());
}

#[test]
fn discard_is_exact_and_path_tokens_cannot_escape_staging() {
    let temporary = TempDir::new().unwrap();
    let installer = PluginInstaller::new(
        temporary.path().join("packages"),
        temporary.path().join("data"),
    )
    .unwrap();
    let download = download_fixture(
        "https://repo.test/v1.zip",
        "1.0.0",
        valid_package("1.0.0", &[]),
    );
    let prepared = installer.prepare_install(&download).unwrap();
    installer.discard_prepared(&prepared).unwrap();
    installer.discard_prepared(&prepared).unwrap();
    assert!(installer.prepared_installation(prepared.token()).is_err());
    assert!(installer.prepared_installation("../../outside").is_err());
    assert!(installer.active_installation(PLUGIN_ID).unwrap().is_none());
}

#[test]
fn prepared_rollback_preflights_a_private_copy_before_commit() {
    let temporary = TempDir::new().unwrap();
    let installer = PluginInstaller::new(
        temporary.path().join("packages"),
        temporary.path().join("data"),
    )
    .unwrap();
    for version in ["1.0.0", "2.0.0"] {
        let download = download_fixture(
            &format!("https://repo.test/v{version}.zip"),
            version,
            valid_package(version, &[]),
        );
        installer.install(&download).unwrap();
    }
    let prepared = installer
        .prepare_rollback(PLUGIN_ID, "2.0.0")
        .unwrap()
        .unwrap();
    assert_eq!(prepared.version(), "1.0.0");
    assert!(
        installer
            .prepared_package_directory(&prepared)
            .unwrap()
            .is_dir()
    );
    assert_eq!(
        installer
            .active_installation(PLUGIN_ID)
            .unwrap()
            .unwrap()
            .version,
        "2.0.0"
    );
    assert_eq!(
        installer.commit_prepared(&prepared).unwrap().version,
        "1.0.0"
    );
}

fn download_fixture(
    url: &str,
    version: &str,
    fixture: PackageFixture,
) -> bbcom_plugin_repository::DownloadedPackage {
    let index = RepositoryIndex::parse(&index_json(
        "https://repo.test",
        url,
        version,
        &fixture,
        None,
    ))
    .unwrap();
    let mut transport = MockTransport::default();
    transport.add(url, HttpsResponse::new(200, Vec::new(), fixture.bytes));
    RepositoryClient::new(transport)
        .download_package(&index, PLUGIN_ID, version)
        .unwrap()
}

fn valid_package(version: &str, extra: &[(&str, &[u8])]) -> PackageFixture {
    let component = wat::parse_str("(component)").unwrap();
    let manifest = manifest(version, &sha256_hex(&component));
    let mut entries = vec![
        ("plugin.toml", manifest.into_bytes()),
        ("component/plugin.wasm", component),
    ];
    entries.extend(extra.iter().map(|(name, bytes)| (*name, bytes.to_vec())));
    zip_entries(entries, None)
}

fn package_with_symlink(version: &str) -> PackageFixture {
    let component = wat::parse_str("(component)").unwrap();
    let manifest = manifest(version, &sha256_hex(&component));
    let entries = vec![
        ("plugin.toml", manifest.into_bytes()),
        ("component/plugin.wasm", component),
    ];
    zip_entries(entries, Some(("component/alias.wasm", "plugin.wasm")))
}

fn package_with_oversized_manifest(version: &str) -> PackageFixture {
    let component = wat::parse_str("(component)").unwrap();
    let mut manifest = manifest(version, &sha256_hex(&component)).into_bytes();
    manifest.extend(std::iter::repeat_n(b' ', 65 * 1024));
    zip_entries(
        vec![
            ("plugin.toml", manifest),
            ("component/plugin.wasm", component),
        ],
        None,
    )
}

fn zip_entries(entries: Vec<(&str, Vec<u8>)>, symlink: Option<(&str, &str)>) -> PackageFixture {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);
    let mut expanded_bytes = 0_u64;
    let mut files = 0_u32;
    for (name, bytes) in entries {
        writer.start_file(name, options).unwrap();
        writer.write_all(&bytes).unwrap();
        expanded_bytes += bytes.len() as u64;
        files += 1;
    }
    if let Some((name, target)) = symlink {
        writer.add_symlink(name, target, options).unwrap();
        expanded_bytes += target.len() as u64;
        files += 1;
    }
    let bytes = writer.finish().unwrap().into_inner();
    PackageFixture {
        bytes,
        expanded_bytes,
        files,
    }
}

fn manifest(version: &str, component_sha256: &str) -> String {
    format!(
        r#"id = "{PLUGIN_ID}"
name = "Fixture"
version = "{version}"
api = "^2.0"
requested-capabilities = []

[component]
path = "component/plugin.wasm"
sha256 = "{component_sha256}"

[publisher]
name = "bbcom fixtures"
website = "https://bbcom.test"
"#
    )
}

fn index_json(
    origin: &str,
    package_url: &str,
    version: &str,
    fixture: &PackageFixture,
    download_bytes_override: Option<u64>,
) -> String {
    format!(
        r#"{{
  "schema": 1,
  "generated_at": "2026-08-13T00:00:00Z",
  "origin": "{origin}",
  "update_policy": "manual",
  "plugins": [{{
    "id": "{PLUGIN_ID}",
    "packages": [{{
      "version": "{version}",
      "url": "{package_url}",
      "sha256": "{}",
      "download_bytes": {},
      "expanded_bytes": {},
      "files": {}
    }}]
  }}]
}}"#,
        sha256_hex(&fixture.bytes),
        download_bytes_override.unwrap_or(fixture.bytes.len() as u64),
        fixture.expanded_bytes,
        fixture.files,
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    let calculated = Sha256Digest::calculate(bytes);
    debug_assert_eq!(calculated.as_bytes(), Sha256::digest(bytes).as_slice());
    calculated
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
