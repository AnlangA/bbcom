//! Development-mode local install against the real durable installer.

use std::fs;
use std::path::{Path, PathBuf};

use bbcom_plugin_contracts::generated_v2::Capability;
use bbcom_plugin_repository::PluginInstaller;
use sha2::{Digest, Sha256};

fn installer(root: &Path) -> PluginInstaller {
    PluginInstaller::new(root.join("plugins"), root.join("plugin-data"))
        .expect("installer opens on a fresh tempdir")
}

fn package(root: &Path, id: &str, version: &str, capabilities: &[&str]) -> PathBuf {
    let package = root.join(format!("{id}-{version}"));
    fs::create_dir_all(package.join("component")).unwrap();
    let component = wat::parse_str("(component)").unwrap();
    let digest = format!("{:x}", Sha256::digest(&component));
    fs::write(package.join("component/plugin.wasm"), component).unwrap();
    let capabilities = capabilities
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join(", ");
    fs::write(
        package.join("plugin.toml"),
        format!(
            "id = \"{id}\"\nname = \"Fixture\"\nversion = \"{version}\"\napi = \"^2.0\"\nrequested-capabilities = [{capabilities}]\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{digest}\"\n\n[publisher]\nname = \"bbcom tests\"\nwebsite = \"https://example.invalid\"\n"
        ),
    )
    .unwrap();
    package
}

#[test]
fn local_install_commits_enumerates_and_removes_durably() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());
    let package = package(
        root.path(),
        "dev.bbcom.counter-v2",
        "2.0.0",
        &["ui.workspace"],
    );

    let prepared = installer
        .prepare_local_install(&package)
        .expect("local package stages through the normal pipeline");
    assert_eq!(prepared.plugin_id(), "dev.bbcom.counter-v2");
    assert_eq!(prepared.version(), "2.0.0");
    assert_eq!(
        prepared.requested_capabilities(),
        &[Capability::UiWorkspace].into_iter().collect()
    );

    let active = installer.commit_prepared(&prepared).expect("commit");
    assert_eq!(active.plugin_id, "dev.bbcom.counter-v2");
    let installed = installer.active_installations();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].version, "2.0.0");
    assert!(installed[0].package_directory.join("plugin.toml").is_file());
    assert!(installer.prepare_local_install(&package).is_err());

    installer
        .remove_installation("dev.bbcom.counter-v2")
        .expect("remove");
    installer
        .remove_installation("dev.bbcom.counter-v2")
        .expect("remove is idempotent");
    assert!(installer.active_installations().is_empty());
    assert!(
        !root
            .path()
            .join("plugins/plugins/dev.bbcom.counter-v2")
            .exists()
    );
}

#[test]
fn local_install_rejects_digest_mismatch_fail_closed() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());
    let package = package(root.path(), "dev.bbcom.fixture", "2.0.0", &[]);
    fs::write(package.join("component/plugin.wasm"), b"corrupted bytes").unwrap();

    let error = installer
        .prepare_local_install(&package)
        .expect_err("digest mismatch must fail closed");
    assert!(matches!(
        error,
        bbcom_plugin_repository::RepositoryError::PackageDigestMismatch
    ));
    assert!(installer.active_installations().is_empty());
}

#[test]
fn local_install_round_trips_the_closed_capability_set() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());
    let package = package(
        root.path(),
        "dev.bbcom.v2-fixture",
        "2.0.0",
        &["serial.io", "ui.workspace"],
    );
    let prepared = installer.prepare_local_install(&package).expect("stages");
    assert_eq!(
        prepared.requested_capabilities(),
        &[Capability::UiWorkspace, Capability::SerialIo]
            .into_iter()
            .collect()
    );
    assert_eq!(
        installer
            .prepared_installation(prepared.token())
            .expect("journal reload"),
        prepared
    );
}

#[test]
fn local_install_rejects_non_v2_api_at_the_manifest_boundary() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());
    let package = package(root.path(), "dev.bbcom.future", "3.0.0", &[]);
    let manifest = fs::read_to_string(package.join("plugin.toml"))
        .unwrap()
        .replace("api = \"^2.0\"", "api = \"^3.0\"");
    fs::write(package.join("plugin.toml"), manifest).unwrap();
    assert!(installer.prepare_local_install(&package).is_err());
    assert!(installer.active_installations().is_empty());
}
