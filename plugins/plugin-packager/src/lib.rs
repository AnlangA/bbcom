//! Reusable packaging for standalone BBCOM plugin Component workspaces.

use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use bbcom_plugin_contracts::PluginManifest;
use sha2::{Digest, Sha256};

const DIGEST_MARKER: &str = "@SHA256@";
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageReceipt {
    pub digest: String,
    pub component_bytes: u64,
    pub manifest_path: PathBuf,
    pub component_path: PathBuf,
}

/// Creates the directory shape consumed by BBCOM's local-package installer.
///
/// The template must contain exactly one `@SHA256@` marker. The resulting
/// manifest is parsed by the same production contract crate as the host before
/// any output is written.
pub fn package_component(
    component: &Path,
    manifest_template: &str,
    output: &Path,
) -> Result<PackageReceipt, String> {
    if component.extension().and_then(|value| value.to_str()) != Some("wasm") {
        return Err("component input must end in .wasm".to_string());
    }
    validate_wasm_magic(component)?;
    if manifest_template.matches(DIGEST_MARKER).count() != 1 {
        return Err("manifest template must contain one @SHA256@ marker".to_string());
    }

    let (digest, component_bytes) = sha256_file(component)?;
    let manifest_text = manifest_template.replace(DIGEST_MARKER, &digest);
    let manifest = PluginManifest::parse(&manifest_text)
        .map_err(|error| format!("manifest rejected by production contracts: {error}"))?;
    manifest
        .require_v2()
        .map_err(|error| format!("manifest is not protocol v2: {error}"))?;
    if manifest.component.path != "component/plugin.wasm" {
        return Err("manifest component.path must be component/plugin.wasm".to_string());
    }
    if manifest.component.sha256 != digest {
        return Err("manifest component digest does not match generated digest".to_string());
    }

    let component_directory = output.join("component");
    fs::create_dir_all(&component_directory)
        .map_err(|error| format!("create output directory: {error}"))?;
    let component_path = component_directory.join("plugin.wasm");
    fs::copy(component, &component_path)
        .map_err(|error| format!("copy component into package: {error}"))?;
    let manifest_path = output.join("plugin.toml");
    fs::write(&manifest_path, manifest_text).map_err(|error| format!("write manifest: {error}"))?;

    Ok(PackageReceipt {
        digest,
        component_bytes,
        manifest_path,
        component_path,
    })
}

fn validate_wasm_magic(component: &Path) -> Result<(), String> {
    let mut file = File::open(component).map_err(|error| format!("open component: {error}"))?;
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|error| format!("read component header: {error}"))?;
    if magic != *b"\0asm" {
        return Err("component input is not WebAssembly".to_string());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|error| format!("open component for digest: {error}"))?;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, file);
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("read component for digest: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| "component length overflow".to_string())?;
    }
    let mut encoded = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(&mut encoded, "{byte:02x}").expect("write to String cannot fail");
    }
    Ok((encoded, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_the_standard_sha256_value() {
        let root = std::env::temp_dir().join(format!(
            "bbcom-plugin-packager-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("digest")
        ));
        fs::create_dir_all(&root).unwrap();
        let component = root.join("sample.wasm");
        fs::write(&component, b"\0asmabc").unwrap();
        let (digest, bytes) = sha256_file(&component).unwrap();
        assert_eq!(bytes, 7);
        assert_eq!(
            digest,
            "4e7b7ce2593282a31f4c47d5cbf62f70d349f8d8bae1ab6b4a529f97efba4ada"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_ambiguous_digest_templates_before_writing() {
        let root = std::env::temp_dir().join(format!(
            "bbcom-plugin-packager-marker-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let component = root.join("sample.wasm");
        fs::write(&component, b"\0asm").unwrap();
        let output = root.join("output");
        assert!(package_component(&component, "no marker", &output).is_err());
        assert!(!output.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
