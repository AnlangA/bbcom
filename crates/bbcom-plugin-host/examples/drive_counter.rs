//! Interactive demo: load the bundled counter plugin into the real wasmtime
//! host, drive it through initialize / panel events / persistence, and print
//! every panel it returns.
//!
//! Run with: `cargo run -p bbcom-plugin-host --example drive_counter`

use std::collections::BTreeSet;

use bbcom_plugin_contracts::Permission;
use bbcom_plugin_host::bindings::PanelEvent;
use bbcom_plugin_host::{PluginEngineFactory, TrustedPluginArtifact};

const PACKAGE_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/plugins/counter"
);

fn print_panel(runtime: &mut bbcom_plugin_host::runtime::PluginRuntime, step: &str) {
    match runtime.take_published_panel() {
        Some(panel) => {
            println!("┌─ panel after {step}");
            println!("│ title: {}", panel.title);
            for field in &panel.fields {
                println!(
                    "│ field {:>10} | kind {:>6} | value {:?}{}",
                    field.id,
                    format!("{:?}", field.kind).to_lowercase(),
                    field.value,
                    if field.disabled { " (disabled)" } else { "" }
                );
            }
            println!("└─");
        }
        None => println!("(no panel published after {step})"),
    }
}

fn main() {
    let manifest =
        std::fs::read_to_string(format!("{PACKAGE_ROOT}/plugin.toml")).expect("counter manifest");
    let artifact = TrustedPluginArtifact::load(std::path::Path::new(PACKAGE_ROOT), &manifest)
        .expect("artifact loads (digest verified)");

    let granted: BTreeSet<Permission> = [
        Permission::UiPanel,
        Permission::PluginStorage,
        Permission::SessionMetadataRead,
    ]
    .into_iter()
    .collect();

    let factory = PluginEngineFactory::new().expect("engine policy");

    // First run: fresh storage.
    let mut runtime = factory
        .load(&artifact, granted.clone())
        .expect("plugin loads");
    runtime.initialize().expect("initialize");
    print_panel(&mut runtime, "initialize (fresh storage)");

    for field_id in ["bump", "bump", "reset", "bump", "unknown-field"] {
        runtime
            .handle_panel_event(PanelEvent {
                field_id: field_id.to_owned(),
                value: String::new(),
            })
            .unwrap_or_else(|error| panic!("event {field_id} failed: {}", error.code()));
        print_panel(&mut runtime, &format!("event {field_id:?}"));
    }

    // Persist the plugin's storage, kill the runtime, and revive it — the
    // counter must survive exactly as the sidecar would across app restarts.
    let (storage, _project) = runtime.persisted_state();
    runtime.shutdown().expect("shutdown");
    drop(runtime);
    println!();
    println!(
        ">>> destroying runtime, restoring from persisted storage ({} bytes)",
        storage.len()
    );

    let mut revived = factory.load(&artifact, granted).expect("plugin reloads");
    revived
        .restore_persisted_state(&storage, None)
        .expect("restore");
    revived.initialize().expect("revived initialize");
    print_panel(&mut revived, "revive from persisted storage");
    revived.shutdown().expect("revived shutdown");
}
