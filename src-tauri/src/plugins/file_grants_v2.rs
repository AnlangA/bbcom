//! Native opaque, chunked file resources for plugin protocol v2.
//!
//! Dialog-selected paths enter this service from trusted native code. Guests
//! and WebViews only ever see the returned metadata and random handle id.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bbcom_contracts::{PluginErrorCodeV2, RuntimeInstanceKey};

const MAX_FILE_HANDLES: usize = 16;
pub const MAX_PLUGIN_FILE_CHUNK_BYTES: usize = 256 * 1024;
const FILE_GRANT_TTL: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginFileGrantView {
    pub handle_id: String,
    pub display_name: String,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginFileError {
    pub code: PluginErrorCodeV2,
}

impl PluginFileError {
    fn new(code: PluginErrorCodeV2) -> Self {
        Self { code }
    }
}

enum PluginFileResource {
    Read {
        owner: RuntimeInstanceKey,
        file: File,
        size: u64,
        last_activity: Instant,
    },
    Save {
        owner: RuntimeInstanceKey,
        file: File,
        temporary: PathBuf,
        target: PathBuf,
        written: u64,
        last_activity: Instant,
    },
}

impl PluginFileResource {
    fn owner(&self) -> &RuntimeInstanceKey {
        match self {
            Self::Read { owner, .. } | Self::Save { owner, .. } => owner,
        }
    }

    fn last_activity(&self) -> Instant {
        match self {
            Self::Read { last_activity, .. } | Self::Save { last_activity, .. } => *last_activity,
        }
    }

    fn temporary_path(&self) -> Option<&Path> {
        match self {
            Self::Read { .. } => None,
            Self::Save { temporary, .. } => Some(temporary),
        }
    }
}

#[derive(Default)]
pub struct PluginFileGrantService {
    resources: Mutex<HashMap<String, PluginFileResource>>,
}

impl PluginFileGrantService {
    /// Native-dialog ingress for `file.open-read`.
    pub fn issue_read_selected(
        &self,
        owner: RuntimeInstanceKey,
        selected_path: PathBuf,
    ) -> Result<PluginFileGrantView, PluginFileError> {
        validate_owner(&owner)?;
        let path = fs::canonicalize(selected_path)
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        let metadata =
            fs::metadata(&path).map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        if !metadata.is_file() {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        }
        let display_name = display_name(&path)?;
        let file = OpenOptions::new()
            .read(true)
            .open(&path)
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        let resource = PluginFileResource::Read {
            owner,
            file,
            size: metadata.len(),
            last_activity: Instant::now(),
        };
        self.issue(resource, display_name, metadata.len())
    }

    /// Native-dialog ingress for `file.save-write`. The target remains
    /// untouched until `commit_save`; all chunks go to a private sibling.
    pub fn issue_save_selected(
        &self,
        owner: RuntimeInstanceKey,
        selected_path: PathBuf,
    ) -> Result<PluginFileGrantView, PluginFileError> {
        validate_owner(&owner)?;
        if !selected_path.is_absolute() || selected_path.is_dir() {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        }
        let display_name = display_name(&selected_path)?;
        let parent = selected_path
            .parent()
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::InvalidInput))?;
        let parent = fs::canonicalize(parent)
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        let target = parent.join(&display_name);
        let (temporary, file) = create_temporary_save(&parent)?;
        let resource = PluginFileResource::Save {
            owner,
            file,
            temporary,
            target,
            written: 0,
            last_activity: Instant::now(),
        };
        self.issue(resource, display_name, 0)
    }

    pub fn read_at(
        &self,
        owner: &RuntimeInstanceKey,
        handle_id: &str,
        offset: u64,
        maximum_bytes: usize,
    ) -> Result<Vec<u8>, PluginFileError> {
        self.read_at_with_size(owner, handle_id, offset, maximum_bytes)
            .map(|(payload, _)| payload)
    }

    pub fn read_at_with_size(
        &self,
        owner: &RuntimeInstanceKey,
        handle_id: &str,
        offset: u64,
        maximum_bytes: usize,
    ) -> Result<(Vec<u8>, u64), PluginFileError> {
        validate_chunk(maximum_bytes)?;
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
        cleanup_expired(&mut resources);
        let resource = resources
            .get_mut(handle_id)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::StaleHandle))?;
        require_owner(resource.owner(), owner)?;
        let PluginFileResource::Read {
            file,
            size,
            last_activity,
            ..
        } = resource
        else {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        };
        if offset > *size {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        }
        let remaining = size.saturating_sub(offset);
        let length = usize::try_from(remaining.min(maximum_bytes as u64))
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::LimitExceeded))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        let mut output = vec![0; length];
        file.read_exact(&mut output)
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        *last_activity = Instant::now();
        Ok((output, *size))
    }

    /// Protocol-v2 save imports are sequential and therefore do not expose an
    /// offset. The native resource remains the single source of truth for the
    /// next accepted byte.
    pub fn append_chunk(
        &self,
        owner: &RuntimeInstanceKey,
        handle_id: &str,
        bytes: &[u8],
    ) -> Result<u64, PluginFileError> {
        validate_chunk(bytes.len())?;
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
        cleanup_expired(&mut resources);
        let resource = resources
            .get_mut(handle_id)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::StaleHandle))?;
        require_owner(resource.owner(), owner)?;
        let PluginFileResource::Save {
            file,
            written,
            last_activity,
            ..
        } = resource
        else {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        };
        file.write_all(bytes)
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        *written = written
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::LimitExceeded))?;
        *last_activity = Instant::now();
        Ok(bytes.len() as u64)
    }

    /// Save writes are sequential by construction. This avoids sparse files,
    /// overlapping chunk ambiguity and resume-after-crash assumptions.
    pub fn write_chunk(
        &self,
        owner: &RuntimeInstanceKey,
        handle_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, PluginFileError> {
        validate_chunk(bytes.len())?;
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
        cleanup_expired(&mut resources);
        let resource = resources
            .get_mut(handle_id)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::StaleHandle))?;
        require_owner(resource.owner(), owner)?;
        let PluginFileResource::Save {
            file,
            written,
            last_activity,
            ..
        } = resource
        else {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        };
        if offset != *written {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        }
        file.write_all(bytes)
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
        *written = written
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::LimitExceeded))?;
        *last_activity = Instant::now();
        Ok(*written)
    }

    pub fn commit_save(
        &self,
        owner: &RuntimeInstanceKey,
        handle_id: &str,
    ) -> Result<u64, PluginFileError> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
        cleanup_expired(&mut resources);
        let resource = resources
            .get(handle_id)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::StaleHandle))?;
        require_owner(resource.owner(), owner)?;
        if !matches!(resource, PluginFileResource::Save { .. }) {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        }
        let resource = resources
            .remove(handle_id)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::StaleHandle))?;
        let PluginFileResource::Save {
            file,
            temporary,
            target,
            written,
            ..
        } = resource
        else {
            return Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput));
        };
        let result = (|| {
            file.sync_all()
                .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
            drop(file);
            atomic_replace(&temporary, &target)?;
            sync_parent(&target)?;
            Ok(written)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn close(
        &self,
        owner: &RuntimeInstanceKey,
        handle_id: &str,
    ) -> Result<(), PluginFileError> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
        let resource = resources
            .get(handle_id)
            .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::StaleHandle))?;
        require_owner(resource.owner(), owner)?;
        if let Some(resource) = resources.remove(handle_id)
            && let Some(temporary) = resource.temporary_path()
        {
            let _ = fs::remove_file(temporary);
        }
        Ok(())
    }

    /// Crash, disable, workspace close and cancellation all converge here.
    pub fn revoke_runtime(&self, owner: &RuntimeInstanceKey) -> usize {
        let Ok(mut resources) = self.resources.lock() else {
            return 0;
        };
        let revoked = resources
            .iter()
            .filter(|(_, resource)| resource.owner() == owner)
            .map(|(handle, _)| handle.clone())
            .collect::<Vec<_>>();
        for handle in &revoked {
            if let Some(resource) = resources.remove(handle)
                && let Some(temporary) = resource.temporary_path()
            {
                let _ = fs::remove_file(temporary);
            }
        }
        revoked.len()
    }

    fn issue(
        &self,
        resource: PluginFileResource,
        display_name: String,
        size: u64,
    ) -> Result<PluginFileGrantView, PluginFileError> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
        cleanup_expired(&mut resources);
        if resources.len() >= MAX_FILE_HANDLES {
            if let Some(temporary) = resource.temporary_path() {
                let _ = fs::remove_file(temporary);
            }
            return Err(PluginFileError::new(PluginErrorCodeV2::LimitExceeded));
        }
        for _ in 0..4 {
            let handle_id = random_handle()?;
            if resources.contains_key(&handle_id) {
                continue;
            }
            resources.insert(handle_id.clone(), resource);
            return Ok(PluginFileGrantView {
                handle_id,
                display_name,
                size,
            });
        }
        if let Some(temporary) = resource.temporary_path() {
            let _ = fs::remove_file(temporary);
        }
        Err(PluginFileError::new(PluginErrorCodeV2::Unavailable))
    }
}

impl Drop for PluginFileGrantService {
    fn drop(&mut self) {
        if let Ok(resources) = self.resources.get_mut() {
            for resource in resources.values() {
                if let Some(temporary) = resource.temporary_path() {
                    let _ = fs::remove_file(temporary);
                }
            }
        }
    }
}

fn cleanup_expired(resources: &mut HashMap<String, PluginFileResource>) {
    let expired = resources
        .iter()
        .filter(|(_, resource)| resource.last_activity().elapsed() >= FILE_GRANT_TTL)
        .map(|(handle, _)| handle.clone())
        .collect::<Vec<_>>();
    for handle in expired {
        if let Some(resource) = resources.remove(&handle)
            && let Some(temporary) = resource.temporary_path()
        {
            let _ = fs::remove_file(temporary);
        }
    }
}

fn require_owner(
    actual: &RuntimeInstanceKey,
    requested: &RuntimeInstanceKey,
) -> Result<(), PluginFileError> {
    if actual == requested {
        Ok(())
    } else {
        Err(PluginFileError::new(PluginErrorCodeV2::StaleHandle))
    }
}

fn validate_owner(owner: &RuntimeInstanceKey) -> Result<(), PluginFileError> {
    if owner.workspace_id.is_empty()
        || owner.workspace_id.len() > 128
        || owner.plugin_id.is_empty()
        || owner.plugin_id.len() > 128
        || owner.instance_id == 0
        || owner.generation == 0
    {
        Err(PluginFileError::new(PluginErrorCodeV2::InvalidInput))
    } else {
        Ok(())
    }
}

fn validate_chunk(length: usize) -> Result<(), PluginFileError> {
    if length == 0 || length > MAX_PLUGIN_FILE_CHUNK_BYTES {
        Err(PluginFileError::new(PluginErrorCodeV2::LimitExceeded))
    } else {
        Ok(())
    }
}

fn display_name(path: &Path) -> Result<String, PluginFileError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::InvalidInput))
}

fn create_temporary_save(parent: &Path) -> Result<(PathBuf, File), PluginFileError> {
    for _ in 0..4 {
        let temporary = parent.join(format!(".bbcom-plugin-{}.part", random_handle()?));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(PluginFileError::new(PluginErrorCodeV2::IoError)),
        }
    }
    Err(PluginFileError::new(PluginErrorCodeV2::Unavailable))
}

fn random_handle() -> Result<String, PluginFileError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| PluginFileError::new(PluginErrorCodeV2::Unavailable))?;
    Ok(random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), PluginFileError> {
    fs::rename(source, target).map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), PluginFileError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(PluginFileError::new(PluginErrorCodeV2::IoError))
    } else {
        Ok(())
    }
}

fn sync_parent(target: &Path) -> Result<(), PluginFileError> {
    let parent = target
        .parent()
        .ok_or_else(|| PluginFileError::new(PluginErrorCodeV2::IoError))?;
    #[cfg(unix)]
    {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| PluginFileError::new(PluginErrorCodeV2::IoError))?;
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(generation: u64) -> RuntimeInstanceKey {
        RuntimeInstanceKey {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.mcumgr".to_owned(),
            instance_id: 1,
            generation,
        }
    }

    #[test]
    fn read_grant_is_chunked_and_generation_bound_without_exposing_a_path() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("firmware.bin");
        fs::write(&source, b"0123456789").unwrap();
        let service = PluginFileGrantService::default();
        let grant = service.issue_read_selected(owner(2), source).unwrap();
        assert_eq!(grant.display_name, "firmware.bin");
        assert_eq!(grant.size, 10);
        assert!(!grant.handle_id.contains('/'));
        assert_eq!(
            service.read_at(&owner(2), &grant.handle_id, 3, 4).unwrap(),
            b"3456"
        );
        assert_eq!(
            service
                .read_at(&owner(3), &grant.handle_id, 0, 1)
                .unwrap_err()
                .code,
            PluginErrorCodeV2::StaleHandle
        );
    }

    #[test]
    fn save_is_invisible_until_atomic_commit_and_enforces_sequential_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("download.bin");
        fs::write(&target, b"old").unwrap();
        let service = PluginFileGrantService::default();
        let grant = service
            .issue_save_selected(owner(1), target.clone())
            .unwrap();
        service
            .write_chunk(&owner(1), &grant.handle_id, 0, b"new-")
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(
            service
                .write_chunk(&owner(1), &grant.handle_id, 0, b"overlap")
                .unwrap_err()
                .code,
            PluginErrorCodeV2::InvalidInput
        );
        service
            .write_chunk(&owner(1), &grant.handle_id, 4, b"content")
            .unwrap();
        assert_eq!(
            service.commit_save(&owner(1), &grant.handle_id).unwrap(),
            11
        );
        assert_eq!(fs::read(target).unwrap(), b"new-content");
    }

    #[test]
    fn cancellation_removes_uncommitted_temporary_files_and_handles() {
        let directory = tempfile::tempdir().unwrap();
        let service = PluginFileGrantService::default();
        let first = service
            .issue_save_selected(owner(9), directory.path().join("one.bin"))
            .unwrap();
        let second = service
            .issue_save_selected(owner(9), directory.path().join("two.bin"))
            .unwrap();
        service
            .write_chunk(&owner(9), &first.handle_id, 0, b"partial")
            .unwrap();
        assert_eq!(service.revoke_runtime(&owner(9)), 2);
        assert_eq!(
            service
                .write_chunk(&owner(9), &second.handle_id, 0, b"late")
                .unwrap_err()
                .code,
            PluginErrorCodeV2::StaleHandle
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejected_commit_does_not_consume_another_generation_save_grant() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("download.bin");
        let service = PluginFileGrantService::default();
        let grant = service
            .issue_save_selected(owner(4), target.clone())
            .unwrap();
        service
            .write_chunk(&owner(4), &grant.handle_id, 0, b"complete")
            .unwrap();

        assert_eq!(
            service
                .commit_save(&owner(5), &grant.handle_id)
                .unwrap_err()
                .code,
            PluginErrorCodeV2::StaleHandle
        );
        assert_eq!(service.commit_save(&owner(4), &grant.handle_id).unwrap(), 8);
        assert_eq!(fs::read(target).unwrap(), b"complete");
    }
}
