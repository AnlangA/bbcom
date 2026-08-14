use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use bbcom_plugin_contracts::{
    MAX_PACKAGE_EXPANDED_BYTES, MAX_PACKAGE_FILES, PluginManifest, Sha256Digest,
};
use wasmparser::{Parser, Validator};
use zip::CompressionMethod;
use zip::read::ZipArchive;

use crate::{DownloadedPackage, RepositoryError, Result};

pub(crate) const MANIFEST_FILE: &str = "plugin.toml";
pub(crate) const INSTALL_MARKER_FILE: &str = ".bbcom-package.json";
pub(crate) const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug)]
struct EntryPlan {
    index: usize,
    path: PathBuf,
    is_directory: bool,
    size: u64,
}

#[derive(Debug)]
pub(crate) struct StagedPackage {
    pub manifest: PluginManifest,
}

pub(crate) fn extract_and_verify(
    download: &DownloadedPackage,
    destination: &Path,
) -> Result<StagedPackage> {
    ensure_empty_directory(destination)?;
    let cursor = Cursor::new(download.bytes());
    let mut archive = ZipArchive::new(cursor)
        .map_err(|_| RepositoryError::InvalidArchive("central directory"))?;
    let plans = preflight(&mut archive, download)?;

    for plan in plans {
        let mut entry = archive
            .by_index(plan.index)
            .map_err(|_| RepositoryError::InvalidArchive("entry"))?;
        let output = destination.join(&plan.path);
        if plan.is_directory {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)?;
        copy_regular_entry(&mut entry, &mut file, plan.size)?;
        file.sync_all()?;
        set_read_only_package_permissions(&output)?;
    }

    let manifest_path = destination.join(MANIFEST_FILE);
    let manifest_bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES)
        .map_err(|_| RepositoryError::ManifestUnavailable)?;
    let manifest_text =
        std::str::from_utf8(&manifest_bytes).map_err(|_| RepositoryError::ManifestUnavailable)?;
    let manifest = PluginManifest::parse(manifest_text)?;
    if manifest.id != download.plugin_id() {
        return Err(RepositoryError::ManifestMismatch("id"));
    }
    if manifest.version != download.package().version {
        return Err(RepositoryError::ManifestMismatch("version"));
    }
    if manifest.publisher.identity != download.publisher_identity() {
        return Err(RepositoryError::ManifestMismatch("publisher.identity"));
    }

    let component_path = destination.join(&manifest.component.path);
    let component = read_bounded(&component_path, MAX_PACKAGE_EXPANDED_BYTES)
        .map_err(|_| RepositoryError::InvalidComponent)?;
    let expected = Sha256Digest::parse_hex(&manifest.component.sha256, "component.sha256")?;
    if !expected.verifies(&component) {
        return Err(RepositoryError::ComponentDigestMismatch);
    }
    if !Parser::is_component(&component) || Validator::new().validate_all(&component).is_err() {
        return Err(RepositoryError::InvalidComponent);
    }
    Ok(StagedPackage { manifest })
}

fn preflight(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    download: &DownloadedPackage,
) -> Result<Vec<EntryPlan>> {
    let entry_count = u64::try_from(archive.len()).unwrap_or(u64::MAX);
    if entry_count == 0 || entry_count > u64::from(MAX_PACKAGE_FILES) {
        return Err(RepositoryError::InvalidArchive("entry count"));
    }

    let mut plans = Vec::with_capacity(archive.len());
    let mut portable_paths = BTreeMap::<String, bool>::new();
    let mut regular_paths = BTreeSet::<PathBuf>::new();
    let mut regular_files = 0_u32;
    let mut expanded_bytes = 0_u64;
    let mut manifest_seen = false;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| RepositoryError::InvalidArchive("entry"))?;
        if entry.encrypted() {
            return Err(RepositoryError::InvalidArchive("encrypted entry"));
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(RepositoryError::InvalidArchive("compression method"));
        }
        if entry.is_symlink() || has_link_extra_field(entry.extra_data()) {
            return Err(RepositoryError::LinkEntryForbidden);
        }

        let is_directory = entry.is_dir();
        validate_unix_mode(entry.unix_mode(), is_directory)?;
        let path = validate_entry_path(entry.name(), is_directory)?;
        if path == Path::new(INSTALL_MARKER_FILE) {
            return Err(RepositoryError::InvalidArchive("reserved installer file"));
        }
        let portable = portable_key(&path);
        if portable_paths.insert(portable, is_directory).is_some() {
            return Err(RepositoryError::InvalidArchive("duplicate path"));
        }
        if is_directory {
            if entry.size() != 0 {
                return Err(RepositoryError::InvalidArchive("directory payload"));
            }
        } else {
            if is_forbidden_executable_name(&path) {
                return Err(RepositoryError::NativeExecutableForbidden);
            }
            regular_files = regular_files
                .checked_add(1)
                .ok_or(RepositoryError::InvalidArchive("file count"))?;
            expanded_bytes = expanded_bytes
                .checked_add(entry.size())
                .ok_or(RepositoryError::InvalidArchive("expanded size"))?;
            if regular_files > MAX_PACKAGE_FILES
                || expanded_bytes > MAX_PACKAGE_EXPANDED_BYTES
                || expanded_bytes > download.package().expanded_bytes
            {
                return Err(RepositoryError::InvalidArchive("expanded limits"));
            }
            if path == Path::new(MANIFEST_FILE) {
                if manifest_seen || entry.size() > MAX_MANIFEST_BYTES {
                    return Err(RepositoryError::ManifestUnavailable);
                }
                manifest_seen = true;
            }
            regular_paths.insert(path.clone());
        }
        plans.push(EntryPlan {
            index,
            path,
            is_directory,
            size: entry.size(),
        });
    }

    for path in &regular_paths {
        let mut ancestor = path.parent();
        while let Some(parent) = ancestor {
            if regular_paths.contains(parent) {
                return Err(RepositoryError::InvalidArchive("file is path ancestor"));
            }
            ancestor = parent.parent();
        }
    }
    if !manifest_seen {
        return Err(RepositoryError::ManifestUnavailable);
    }
    if regular_files != download.package().files {
        return Err(RepositoryError::PackageMetadataMismatch {
            field: "files",
            expected: u64::from(download.package().files),
            actual: u64::from(regular_files),
        });
    }
    if expanded_bytes != download.package().expanded_bytes {
        return Err(RepositoryError::PackageMetadataMismatch {
            field: "expandedBytes",
            expected: download.package().expanded_bytes,
            actual: expanded_bytes,
        });
    }
    Ok(plans)
}

fn validate_entry_path(raw: &str, is_directory: bool) -> Result<PathBuf> {
    if raw.is_empty()
        || raw.contains('\0')
        || raw.contains('\\')
        || raw.starts_with('/')
        || raw.starts_with("//")
        || raw.as_bytes().get(1) == Some(&b':')
        || (!is_directory && raw.ends_with('/'))
    {
        return Err(RepositoryError::InvalidArchive(
            "absolute or malformed path",
        ));
    }
    let normalized = raw.trim_end_matches('/');
    if normalized.is_empty() {
        return Err(RepositoryError::InvalidArchive("root entry"));
    }
    let path = PathBuf::from(normalized);
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err(RepositoryError::InvalidArchive("path traversal"));
        };
        let text = value
            .to_str()
            .ok_or(RepositoryError::InvalidArchive("non-UTF-8 path"))?;
        validate_portable_component(text)?;
    }
    Ok(path)
}

fn validate_portable_component(value: &str) -> Result<()> {
    if value.is_empty()
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err(RepositoryError::InvalidArchive("non-portable path"));
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && matches!(&stem[..3], "com" | "lpt")
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(RepositoryError::InvalidArchive("reserved path"));
    }
    Ok(())
}

fn portable_key(path: &Path) -> String {
    path.iter()
        .map(|part| part.to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("/")
}

fn validate_unix_mode(mode: Option<u32>, is_directory: bool) -> Result<()> {
    let Some(mode) = mode else {
        return Ok(());
    };
    const FILE_TYPE_MASK: u32 = 0o170000;
    const REGULAR_FILE: u32 = 0o100000;
    const DIRECTORY: u32 = 0o040000;
    let file_type = mode & FILE_TYPE_MASK;
    let expected = if is_directory {
        DIRECTORY
    } else {
        REGULAR_FILE
    };
    if file_type != 0 && file_type != expected {
        return Err(RepositoryError::LinkEntryForbidden);
    }
    if !is_directory && mode & 0o111 != 0 {
        return Err(RepositoryError::NativeExecutableForbidden);
    }
    Ok(())
}

fn has_link_extra_field(extra: Option<&[u8]>) -> bool {
    let Some(mut extra) = extra else {
        return false;
    };
    while extra.len() >= 4 {
        let id = u16::from_le_bytes([extra[0], extra[1]]);
        let size = usize::from(u16::from_le_bytes([extra[2], extra[3]]));
        extra = &extra[4..];
        if size > extra.len() {
            return true;
        }
        // PKWARE Unix and ASi Unix fields can carry link targets. The installer
        // does not materialize any link-like archive metadata.
        if matches!(id, 0x000d | 0x756e) {
            return true;
        }
        extra = &extra[size..];
    }
    !extra.is_empty()
}

fn is_forbidden_executable_name(path: &Path) -> bool {
    let lower = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".com",
        ".scr",
        ".cpl",
        ".sys",
        ".ocx",
        ".msi",
        ".bat",
        ".cmd",
        ".ps1",
        ".vbs",
        ".vbe",
        ".js",
        ".jse",
        ".mjs",
        ".cjs",
        ".ts",
        ".wsf",
        ".wsh",
        ".hta",
        ".sh",
        ".bash",
        ".zsh",
        ".fish",
        ".py",
        ".pyw",
        ".rb",
        ".pl",
        ".lua",
        ".php",
        ".tcl",
        ".jar",
        ".app",
        ".pkg",
        ".deb",
        ".rpm",
        ".appimage",
        ".run",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn copy_regular_entry(reader: &mut impl Read, writer: &mut File, expected_size: u64) -> Result<()> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut prefix = Vec::with_capacity(4);
    let mut copied = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| RepositoryError::InvalidArchive("entry data"))?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or(RepositoryError::InvalidArchive("entry size"))?;
        if copied > expected_size {
            return Err(RepositoryError::InvalidArchive("entry size"));
        }
        if prefix.len() < 4 {
            let needed = 4 - prefix.len();
            prefix.extend_from_slice(&buffer[..read.min(needed)]);
            if has_native_or_script_magic(&prefix) {
                return Err(RepositoryError::NativeExecutableForbidden);
            }
        }
        writer.write_all(&buffer[..read])?;
    }
    if copied != expected_size {
        return Err(RepositoryError::InvalidArchive("entry size"));
    }
    Ok(())
}

fn has_native_or_script_magic(prefix: &[u8]) -> bool {
    prefix.starts_with(b"MZ")
        || prefix.starts_with(b"\x7fELF")
        || prefix.starts_with(b"#!")
        || matches!(
            prefix,
            [0xfe, 0xed, 0xfa, 0xce, ..]
                | [0xfe, 0xed, 0xfa, 0xcf, ..]
                | [0xce, 0xfa, 0xed, 0xfe, ..]
                | [0xcf, 0xfa, 0xed, 0xfe, ..]
                | [0xca, 0xfe, 0xba, 0xbe, ..]
        )
}

fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(std::io::Error::other("file limit exceeded"));
    }
    Ok(bytes)
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

#[cfg(unix)]
fn set_read_only_package_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_read_only_package_permissions(_path: &Path) -> Result<()> {
    Ok(())
}
