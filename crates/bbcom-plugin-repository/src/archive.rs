use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};

use bbcom_plugin_contracts::{PluginManifest, Sha256Digest};
use zip::read::ZipArchive;

use crate::{DownloadedPackage, RepositoryError, Result};

pub(crate) const MANIFEST_FILE: &str = "plugin.toml";
pub(crate) const INSTALL_MARKER_FILE: &str = ".bbcom-package.json";
pub(crate) const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub(crate) struct StagedPackage {
    pub manifest: PluginManifest,
}

/// Extracts a downloaded package into `destination` and parses its manifest.
///
/// No integrity, digest, signature, component or metadata validation is
/// performed. The component digest is computed from the extracted bytes and
/// recorded on the manifest purely for bookkeeping.
pub(crate) fn extract_and_verify(
    download: &DownloadedPackage,
    destination: &Path,
) -> Result<StagedPackage> {
    ensure_empty_directory(destination)?;
    let cursor = Cursor::new(download.bytes());
    let mut archive = ZipArchive::new(cursor)
        .map_err(|_| RepositoryError::InvalidArchive("central directory"))?;
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| RepositoryError::InvalidArchive("entry"))?;
        let path = validate_entry_path(entry.name(), entry.is_dir())?;
        if path == Path::new(INSTALL_MARKER_FILE) || !seen.insert(path.clone()) {
            continue;
        }
        let output = destination.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&output)?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|_| RepositoryError::InvalidArchive("entry data"))?;
        file.sync_all()?;
    }

    let manifest_path = destination.join(MANIFEST_FILE);
    let manifest_bytes =
        fs::read(&manifest_path).map_err(|_| RepositoryError::ManifestUnavailable)?;
    let manifest_text =
        std::str::from_utf8(&manifest_bytes).map_err(|_| RepositoryError::ManifestUnavailable)?;
    let mut manifest = PluginManifest::parse(manifest_text)?;

    let component_path = destination.join(&manifest.component.path);
    let component = fs::read(&component_path).map_err(|_| RepositoryError::InvalidComponent)?;
    let digest = Sha256Digest::calculate(&component);
    manifest.component.sha256 = digest
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(StagedPackage { manifest })
}

/// Keeps extraction inside the destination directory. This is filesystem
/// safety for the extractor itself, not plugin validation.
fn validate_entry_path(raw: &str, is_directory: bool) -> Result<PathBuf> {
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') || raw.starts_with('/') {
        return Err(RepositoryError::InvalidArchive(
            "absolute or malformed path",
        ));
    }
    let normalized = raw.trim_end_matches('/');
    if normalized.is_empty() && is_directory {
        return Err(RepositoryError::InvalidArchive("root entry"));
    }
    let path = PathBuf::from(normalized);
    for component in path.components() {
        let Component::Normal(_) = component else {
            return Err(RepositoryError::InvalidArchive("path traversal"));
        };
    }
    Ok(path)
}

fn ensure_empty_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(RepositoryError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RepositoryError::UnsafeFilesystemRoot);
    }
    if fs::read_dir(path)?.next().is_some() {
        return Err(RepositoryError::InvalidArchive(
            "non-empty staging directory",
        ));
    }
    Ok(())
}
