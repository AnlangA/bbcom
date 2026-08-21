use std::fs::File;
use std::io::{Read, Take};
use std::path::Path;

use bbcom_plugin_contracts::{MAX_PACKAGE_DOWNLOAD_BYTES, PluginManifest};

use crate::{HostError, Result};

/// A plugin manifest and its raw WebAssembly component bytes.
#[derive(Clone, Debug)]
pub struct PluginPackage {
    pub manifest: PluginManifest,
    component_bytes: Vec<u8>,
}

impl PluginPackage {
    pub fn load(package_root: &Path, manifest_text: &str) -> Result<Self> {
        let manifest = PluginManifest::parse(manifest_text)?;
        let component_path = package_root.join(&manifest.component.path);
        let file = File::open(&component_path).map_err(|_| HostError::ArtifactRead)?;
        let mut reader: Take<File> = file.take(MAX_PACKAGE_DOWNLOAD_BYTES + 1);
        let mut component_bytes = Vec::new();
        reader
            .read_to_end(&mut component_bytes)
            .map_err(|_| HostError::ArtifactRead)?;
        if component_bytes.len() as u64 > MAX_PACKAGE_DOWNLOAD_BYTES {
            return Err(HostError::ComponentLimitExceeded);
        }
        Ok(Self {
            manifest,
            component_bytes,
        })
    }

    #[must_use]
    pub fn component_bytes(&self) -> &[u8] {
        &self.component_bytes
    }
}
