//! Loads a packaged plugin directory and instantiates its Component.
//!
//! Usage: `cargo run -p bbcom-plugin-host --example load_package -- <package-root>`

use std::path::PathBuf;

use bbcom_plugin_host::uplink::{CapabilityRpc, MessageIdSequence};
use bbcom_plugin_host::{PluginEngineFactory, PluginLaunchContext, PluginPackage};

fn main() {
    let package_root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("pass the package root directory"),
    );
    let manifest_text =
        std::fs::read_to_string(package_root.join("plugin.toml")).expect("read plugin.toml");
    let artifact =
        PluginPackage::load(&package_root, &manifest_text).expect("load artifact");
    println!(
        "manifest: id={} version={} component_bytes={}",
        artifact.manifest.id,
        artifact.manifest.version,
        artifact.component_bytes().len()
    );

    let granted = artifact.manifest.v2_capabilities().expect("capabilities");
    println!("granted capabilities: {granted:?}");

    let factory = PluginEngineFactory::new().expect("engine");
    let launch = PluginLaunchContext {
        workspace_id: "8e7b84cf-35f4-45cd-baf0-55d94ebf0213".to_owned(),
        instance_id: "1".to_owned(),
        generation: 1,
    };
    let rpc = CapabilityRpc::new(Box::new(std::io::sink()), MessageIdSequence::new());
    let _runtime = factory
        .load(&artifact, &launch, granted, rpc)
        .expect("instantiate component");
    println!("OK: component instantiated without any validation gate");
}
