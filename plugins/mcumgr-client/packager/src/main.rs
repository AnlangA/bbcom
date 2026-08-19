use std::env;
use std::path::PathBuf;

use bbcom_plugin_packager::package_component;

const MANIFEST_TEMPLATE: &str = include_str!("../../package/plugin.toml.template");

fn main() {
    if let Err(error) = run() {
        eprintln!("mcumgr packager: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let component = arguments.next().map(PathBuf::from).ok_or_else(|| {
        "usage: bbcom-mcumgr-packager <component.wasm> <output-directory>".to_string()
    })?;
    let output = arguments.next().map(PathBuf::from).ok_or_else(|| {
        "usage: bbcom-mcumgr-packager <component.wasm> <output-directory>".to_string()
    })?;
    if arguments.next().is_some() {
        return Err("unexpected extra arguments".to_string());
    }
    let receipt = package_component(&component, MANIFEST_TEMPLATE, &output)?;
    println!(
        "packaged {} ({} bytes) with sha256 {}",
        output.display(),
        receipt.component_bytes,
        receipt.digest
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MANIFEST_TEMPLATE;

    #[test]
    fn embedded_manifest_declares_v2_and_every_required_capability() {
        let template = MANIFEST_TEMPLATE;
        assert!(template.contains("api = \"^2.0\""));
        for capability in [
            "ui.workspace",
            "ui.detached-window",
            "serial.ports.read",
            "serial.sessions.manage",
            "serial.io",
            "serial.control-lines",
            "session.capture.read",
            "session.commands.read-write",
            "file.open-read",
            "file.save-write",
            "project.state.read-write",
        ] {
            assert!(template.contains(capability), "{capability}");
        }
        assert_eq!(template.matches("@SHA256@").count(), 1);
        let manifest = template.replace("@SHA256@", &"0".repeat(64));
        let manifest = bbcom_plugin_contracts::PluginManifest::parse(&manifest)
            .expect("template must be accepted by the production host parser");
        manifest.require_v2().unwrap();
        assert_eq!(manifest.v2_capabilities().unwrap().len(), 11);
    }
}
