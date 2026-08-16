//! Development-mode local install against the REAL durable installer:
//! staging from a local package directory, restart enumeration, and removal.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use bbcom_plugin_contracts::Permission;
use bbcom_plugin_repository::PluginInstaller;

const PACKAGE_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/plugins/counter"
);

fn installer(root: &Path) -> PluginInstaller {
    PluginInstaller::new(root.join("plugins-v1"), root.join("plugins-v1-data"))
        .expect("installer opens on a fresh tempdir")
}

#[test]
fn local_install_commits_enumerates_and_removes_durably() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());

    let prepared = installer
        .prepare_local_install(Path::new(PACKAGE_ROOT))
        .expect("local package stages through the normal pipeline");
    assert_eq!(prepared.plugin_id(), "dev.bbcom.counter-panel");
    assert_eq!(prepared.version(), "1.0.0");

    let active = installer.commit_prepared(&prepared).expect("commit");
    assert_eq!(active.plugin_id, "dev.bbcom.counter-panel");

    // Restart discovery: enumeration finds exactly the durable installation.
    let installed = installer.active_installations();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].plugin_id, "dev.bbcom.counter-panel");
    assert_eq!(installed[0].version, "1.0.0");
    assert!(installed[0].package_directory.join("plugin.toml").is_file());

    // Idempotent same-version install: AlreadyActive, not an error.
    // Re-preparing the identical active version is rejected — upgrades must
    // go through the version bump rules, same as repository packages.
    assert!(
        installer
            .prepare_local_install(Path::new(PACKAGE_ROOT))
            .is_err()
    );

    // Removal is durable and idempotent.
    installer
        .remove_installation("dev.bbcom.counter-panel")
        .expect("remove");
    installer
        .remove_installation("dev.bbcom.counter-panel")
        .expect("remove is idempotent");
    assert!(installer.active_installations().is_empty());
    assert!(
        !root
            .path()
            .join("plugins-v1/plugins/dev.bbcom.counter-panel")
            .exists()
    );
}

#[test]
fn local_install_rejects_digest_mismatch_fail_closed() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());

    let tampered = root.path().join("tampered");
    fs::create_dir_all(tampered.join("component")).expect("dirs");
    fs::copy(
        format!("{PACKAGE_ROOT}/plugin.toml"),
        tampered.join("plugin.toml"),
    )
    .expect("manifest copy");
    fs::write(tampered.join("component/plugin.wasm"), b"corrupted bytes").expect("component");

    let error = installer
        .prepare_local_install(&tampered)
        .expect_err("digest mismatch must fail closed");
    assert!(matches!(
        error,
        bbcom_plugin_repository::RepositoryError::PackageDigestMismatch
    ));
    assert!(installer.active_installations().is_empty());
}

#[test]
fn local_install_permissions_round_trip_through_manifest() {
    let root = tempfile::tempdir().expect("root");
    let installer = installer(root.path());
    let prepared = installer
        .prepare_local_install(Path::new(PACKAGE_ROOT))
        .expect("stages");
    let requested: BTreeSet<Permission> =
        prepared.requested_permissions().iter().copied().collect();
    assert_eq!(
        requested,
        [Permission::SessionMetadataRead].into_iter().collect()
    );
}
