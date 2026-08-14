use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Path, PathBuf};

use bbcom_plugin_contracts::{
    MAX_PACKAGE_DOWNLOAD_BYTES, MAX_PACKAGE_EXPANDED_BYTES, MAX_PACKAGE_FILES, PluginManifest,
    Sha256Digest,
};

use crate::{HostError, Result};

#[derive(Clone, Debug)]
pub struct TrustedPluginArtifact {
    pub manifest: PluginManifest,
    component_bytes: Vec<u8>,
}

impl TrustedPluginArtifact {
    pub fn load(package_root: &Path, manifest_text: &str) -> Result<Self> {
        let manifest = PluginManifest::parse(manifest_text)?;
        validate_package_tree(package_root)?;
        let component_path = resolve_component_path(package_root, &manifest)?;
        let metadata =
            fs::symlink_metadata(&component_path).map_err(|_| HostError::ArtifactRead)?;
        if metadata.file_type().is_symlink() {
            return Err(HostError::ArtifactSymlink);
        }
        if !metadata.is_file() {
            return Err(HostError::InvalidArtifact);
        }
        if metadata.len() > MAX_PACKAGE_DOWNLOAD_BYTES {
            return Err(HostError::ComponentLimitExceeded);
        }

        let file = File::open(&component_path).map_err(|_| HostError::ArtifactRead)?;
        let mut reader: Take<File> = file.take(MAX_PACKAGE_DOWNLOAD_BYTES + 1);
        let mut component_bytes = Vec::new();
        reader
            .read_to_end(&mut component_bytes)
            .map_err(|_| HostError::ArtifactRead)?;
        if component_bytes.len() as u64 > MAX_PACKAGE_DOWNLOAD_BYTES {
            return Err(HostError::ComponentLimitExceeded);
        }
        let expected = Sha256Digest::parse_hex(&manifest.component.sha256, "component.sha256")?;
        if !expected.verifies(&component_bytes) {
            return Err(HostError::ComponentDigestMismatch);
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

fn resolve_component_path(package_root: &Path, manifest: &PluginManifest) -> Result<PathBuf> {
    if is_native_executable_name(&manifest.component.path) {
        return Err(HostError::NativeExecutableForbidden);
    }
    // `PluginManifest::parse` already restricts this to exactly
    // `component/<name>.wasm` with normal relative path components.
    Ok(package_root.join(&manifest.component.path))
}

fn is_native_executable_name(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [".exe", ".dll", ".so", ".dylib", ".bat", ".cmd", ".sh"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

fn validate_package_tree(package_root: &Path) -> Result<()> {
    let root_metadata = fs::symlink_metadata(package_root).map_err(|_| HostError::ArtifactRead)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(HostError::InvalidArtifact);
    }
    let mut directories = vec![package_root.to_owned()];
    let mut file_count = 0_u32;
    let mut total_bytes = 0_u64;
    while let Some(directory) = directories.pop() {
        let entries = fs::read_dir(directory).map_err(|_| HostError::ArtifactRead)?;
        for entry in entries {
            let entry = entry.map_err(|_| HostError::ArtifactRead)?;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| HostError::ArtifactRead)?;
            if metadata.file_type().is_symlink() {
                return Err(HostError::ArtifactSymlink);
            }
            if metadata.is_dir() {
                directories.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                return Err(HostError::InvalidArtifact);
            }
            file_count = file_count
                .checked_add(1)
                .ok_or(HostError::ComponentLimitExceeded)?;
            total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or(HostError::ComponentLimitExceeded)?;
            if file_count > MAX_PACKAGE_FILES || total_bytes > MAX_PACKAGE_EXPANDED_BYTES {
                return Err(HostError::ComponentLimitExceeded);
            }
            let path = entry.path();
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(is_native_executable_name)
                || has_executable_mode(&metadata)
                || has_native_magic(&path)?
            {
                return Err(HostError::NativeExecutableForbidden);
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn has_executable_mode(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_mode(_metadata: &fs::Metadata) -> bool {
    false
}

fn has_native_magic(path: &Path) -> Result<bool> {
    let mut file = File::open(path).map_err(|_| HostError::ArtifactRead)?;
    let mut prefix = [0_u8; 4];
    let read = file
        .read(&mut prefix)
        .map_err(|_| HostError::ArtifactRead)?;
    let prefix = &prefix[..read];
    Ok(prefix.starts_with(b"MZ")
        || prefix.starts_with(b"\x7fELF")
        || matches!(
            prefix,
            [0xfe, 0xed, 0xfa, 0xce]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
        ))
}
