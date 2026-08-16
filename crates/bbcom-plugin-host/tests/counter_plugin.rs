//! End-to-end contract test for the bundled sample plugin
//! (`tests/fixtures/plugins/counter`, built from `plugins/counter-plugin`).
//!
//! Exercises the real wasmtime host: the guest calls the `plugin.storage`
//! and `publish-panel` host imports, panels flow back through the published
//! panel channel, and persisted storage survives into a fresh runtime.

use std::collections::BTreeSet;

use sha2::{Digest, Sha256};

use bbcom_plugin_contracts::Permission;
use bbcom_plugin_host::{PluginEngineFactory, TrustedPluginArtifact};

const PACKAGE_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/plugins/counter"
);

fn load_artifact() -> TrustedPluginArtifact {
    let manifest =
        std::fs::read_to_string(format!("{PACKAGE_ROOT}/plugin.toml")).expect("manifest");
    TrustedPluginArtifact::load(std::path::Path::new(PACKAGE_ROOT), &manifest)
        .expect("trusted counter artifact")
}

fn panel_field<'a>(
    panel: &'a bbcom_plugin_host::bindings::DeclarativePanel,
    id: &str,
) -> &'a bbcom_plugin_host::bindings::bbcom::plugin::types::PanelField {
    panel
        .fields
        .iter()
        .find(|field| field.id == id)
        .unwrap_or_else(|| panic!("panel field {id} missing"))
}

fn sha256_of_component() -> String {
    use std::io::Read;
    let mut file = std::fs::File::open(format!("{PACKAGE_ROOT}/component/plugin.wasm")).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn event(id: &str, value: &str) -> bbcom_plugin_host::bindings::PanelEvent {
    bbcom_plugin_host::bindings::PanelEvent {
        field_id: id.to_owned(),
        value: value.to_owned(),
    }
}

/// The host allows one live store per process; serialize the tests.
static HOST_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The fixture binary must match the manifest digest; a tampered digest must
/// be rejected before the engine ever sees the component.
#[test]
fn counter_artifact_digest_is_enforced() {
    let _serial = HOST_STORE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let artifact = load_artifact();
    assert_eq!(artifact.manifest.id, "dev.bbcom.counter-panel");

    let manifest = std::fs::read_to_string(format!("{PACKAGE_ROOT}/plugin.toml")).unwrap();
    let tampered = manifest.replace(
        &sha256_of_component(),
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert_ne!(&tampered, &manifest, "digest must appear in the manifest");
    let rejected = TrustedPluginArtifact::load(std::path::Path::new(PACKAGE_ROOT), &tampered);
    assert!(rejected.is_err(), "digest mismatch must fail closed");
}

#[test]
fn counter_panel_lifecycle_storage_and_events_round_trip() {
    let _serial = HOST_STORE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let artifact = load_artifact();
    let granted: BTreeSet<Permission> = [
        Permission::UiPanel,
        Permission::PluginStorage,
        Permission::SessionMetadataRead,
    ]
    .into_iter()
    .collect();
    let factory = PluginEngineFactory::new().expect("engine policy");
    let mut runtime = factory
        .load(&artifact, granted.clone())
        .expect("counter plugin loads");

    runtime.initialize().expect("initialize");
    let panel = runtime.take_published_panel().expect("initial panel");
    assert_eq!(panel.title, "Serial counter");
    assert_eq!(panel_field(&panel, "count").value, "0");
    assert_eq!(panel_field(&panel, "sessions").value, "0");
    assert_eq!(panel.fields.len(), 4);

    runtime.handle_panel_event(event("bump", "")).expect("bump");
    assert_eq!(
        runtime
            .take_published_panel()
            .expect("bumped panel")
            .fields
            .iter()
            .find(|field| field.id == "count")
            .map(|field| field.value.as_str()),
        Some("1"),
        "the guest persisted and republished the incremented counter"
    );

    runtime
        .handle_panel_event(event("bump", ""))
        .expect("bump 2");
    runtime
        .handle_panel_event(event("reset", ""))
        .expect("reset");
    let panel = runtime.take_published_panel().expect("reset panel");
    assert_eq!(panel_field(&panel, "count").value, "0");

    // Bump after reset proves the guest re-reads its own persisted state.
    runtime
        .handle_panel_event(event("bump", ""))
        .expect("bump 3");

    runtime.shutdown().expect("clean shutdown");

    // The storage the guest wrote through the host import is capture here;
    // restoring it into a fresh runtime must resurrect the counter.
    let (plugin_storage, _project_state) = runtime.persisted_state();
    assert!(!plugin_storage.is_empty(), "storage bytes were captured");
    drop(runtime);

    let mut revived = factory
        .load(&artifact, granted)
        .expect("second runtime loads");
    revived
        .restore_persisted_state(&plugin_storage, None)
        .expect("restore persisted storage");
    revived.initialize().expect("revived initialize");
    let panel = revived.take_published_panel().expect("revived panel");
    assert_eq!(
        panel_field(&panel, "count").value,
        "1",
        "counter survived process death via plugin storage"
    );
    revived.shutdown().expect("revived shutdown");
}

#[test]
fn counter_panel_fails_closed_without_session_metadata_permission() {
    let _serial = HOST_STORE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let artifact = load_artifact();
    let factory = PluginEngineFactory::new().expect("engine policy");
    // Implicit grants only: the guest's session-list import is denied by the
    // host, and the guest surfaces that as a rejected initialization.
    let granted: BTreeSet<Permission> = [Permission::UiPanel, Permission::PluginStorage]
        .into_iter()
        .collect();
    let mut runtime = factory.load(&artifact, granted).expect("loads");

    let error = runtime.initialize().expect_err("session metadata denied");
    assert_eq!(error.code(), "PLUGIN_REQUEST_REJECTED");
    assert!(
        runtime.take_published_panel().is_none(),
        "no panel may publish from a rejected initialization"
    );
    // A rejected initialization still leaves the guest callable; its trivial
    // shutdown completing is fine — the panel above never published.
    runtime.shutdown().expect("shutdown after rejection");
}
