use std::env;
use std::path::PathBuf;

use bbcom_plugin_packager::package_component;

const MANIFEST_TEMPLATE: &str = include_str!("../../package/plugin.toml.template");

fn main() {
    if let Err(error) = run() {
        eprintln!("counter-v2 packager: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let component = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let output = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
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

fn usage() -> String {
    "usage: bbcom-counter-v2-packager <component.wasm> <output-directory>".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_is_a_production_valid_v2_manifest() {
        assert_eq!(MANIFEST_TEMPLATE.matches("@SHA256@").count(), 1);
        let manifest = MANIFEST_TEMPLATE.replace("@SHA256@", &"0".repeat(64));
        let manifest = bbcom_plugin_contracts::PluginManifest::parse(&manifest).unwrap();
        manifest.require_v2().unwrap();
        assert_eq!(manifest.id, "dev.bbcom.counter-v2");
        assert_eq!(
            manifest.requested_capabilities,
            [
                "ui.workspace",
                "serial.sessions.manage",
                "serial.io",
                "session.commands.read-write",
                "project.state.read-write",
            ]
        );
    }

}
