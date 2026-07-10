//! Bounded, backend-owned export sessions.

use crate::export::{ExportFormat, formatter};
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::ErrorKind;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncWrite, AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

pub const MAX_EXPORT_FRAMES: usize = 100_000;
pub const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BATCH_FRAMES: usize = 256;
pub const MAX_BATCH_BYTES: usize = 512 * 1024;
const MAX_ACTIVE_EXPORTS: usize = 8;
const MAX_FRAME_ID_BYTES: usize = 256;
const EXPORT_SESSION_TTL: Duration = Duration::from_secs(30 * 60);
// A part file can only be removed when it is unmistakably abandoned.  Export
// sessions themselves expire much sooner, but their files remain recoverable
// for a full day so a delayed scheduler cannot delete a live user's output.
const STALE_EXPORT_PART_TTL: Duration = Duration::from_secs(24 * 60 * 60);
type SharedExportSession = Arc<Mutex<ExportSession>>;

#[cfg(windows)]
type TargetIdentity = String;
#[cfg(not(windows))]
type TargetIdentity = PathBuf;

pub struct ExportSessionManager {
    sessions: Mutex<HashMap<String, SharedExportSession>>,
    active_temps: Mutex<HashSet<PathBuf>>,
    reserved_ids: Mutex<HashSet<String>>,
    active_targets: Arc<StdMutex<HashSet<TargetIdentity>>>,
    slots: Arc<Semaphore>,
    session_ttl: Duration,
}

struct ExportSession {
    format: ExportFormat,
    target: PathBuf,
    temp: PathBuf,
    writer: Option<BufWriter<File>>,
    frame_count: usize,
    raw_bytes: usize,
    output_bytes: usize,
    started_at: Instant,
    last_activity: Instant,
    terminal: bool,
    _slot: OwnedSemaphorePermit,
    _target: TargetReservation,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportAppendStats {
    pub total_frames: usize,
    pub total_raw_bytes: usize,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFinishStats {
    pub frames: usize,
    pub raw_bytes: usize,
    pub output_bytes: usize,
    pub duration_ms: u64,
}

struct TargetReservation {
    active_targets: Arc<StdMutex<HashSet<TargetIdentity>>>,
    identity: TargetIdentity,
}

impl Drop for TargetReservation {
    fn drop(&mut self) {
        self.active_targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.identity);
    }
}

impl Default for ExportSessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            active_temps: Mutex::new(HashSet::new()),
            reserved_ids: Mutex::new(HashSet::new()),
            active_targets: Arc::new(StdMutex::new(HashSet::new())),
            slots: Arc::new(Semaphore::new(MAX_ACTIVE_EXPORTS)),
            session_ttl: EXPORT_SESSION_TTL,
        }
    }
}

impl ExportSessionManager {
    pub async fn begin(&self, format: ExportFormat, target: PathBuf) -> Result<String, AppError> {
        self.cleanup_expired().await;
        // Reserve capacity before touching the filesystem. A semaphore makes
        // concurrent begin calls part of the same admission decision, so a
        // burst cannot temporarily create more than MAX_ACTIVE_EXPORTS temp
        // files while each caller observes a stale map length.
        let slot = Arc::clone(&self.slots)
            .try_acquire_owned()
            .map_err(|_| limit_error("exportId", MAX_ACTIVE_EXPORTS, MAX_ACTIVE_EXPORTS + 1))?;
        let target_identity = canonical_target_identity(&target, format).await?;
        let target_reservation = self.reserve_target(target_identity)?;
        let active_temps = self.active_temp_paths().await;
        reconcile_export_residue(
            &target,
            SystemTime::now(),
            STALE_EXPORT_PART_TTL,
            &active_temps,
            format,
        )
        .await?;

        let id = self.reserve_new_id().await?;
        let (temp, file) = match create_temp_file(&target, format, &id).await {
            Ok(value) => value,
            Err(error) => {
                self.reserved_ids.lock().await.remove(&id);
                return Err(error);
            }
        };
        let writer = BufWriter::with_capacity(64 * 1024, file);
        let mut header = Vec::new();
        formatter::append_header(&mut header, format);
        let writer = match initialize_writer(writer, &header, &temp, format, &target).await {
            Ok(writer) => writer,
            Err(error) => {
                self.reserved_ids.lock().await.remove(&id);
                return Err(error);
            }
        };

        let session = Arc::new(Mutex::new(ExportSession {
            format,
            target,
            temp: temp.clone(),
            writer: Some(writer),
            frame_count: 0,
            raw_bytes: 0,
            output_bytes: header.len(),
            started_at: Instant::now(),
            last_activity: Instant::now(),
            terminal: false,
            _slot: slot,
            _target: target_reservation,
        }));
        self.active_temps.lock().await.insert(temp);
        let replaced = self
            .sessions
            .lock()
            .await
            .insert(id.clone(), Arc::clone(&session));
        self.reserved_ids.lock().await.remove(&id);
        debug_assert!(replaced.is_none(), "export ids must be unique per manager");
        Ok(id)
    }

    pub async fn append(
        &self,
        id: &str,
        frames: &[DataFrame],
    ) -> Result<ExportAppendStats, AppError> {
        validate_session_id(id)?;
        let batch_bytes = validate_frame_batch(frames, MAX_BATCH_FRAMES, MAX_BATCH_BYTES)?;
        let shared = self.get(id).await?;
        let mut session = shared.lock().await;
        Self::append_locked(&mut session, frames, batch_bytes).await
    }

    async fn append_locked(
        session: &mut ExportSession,
        frames: &[DataFrame],
        batch_bytes: usize,
    ) -> Result<ExportAppendStats, AppError> {
        if session.terminal || session.writer.is_none() {
            return Err(validation_error(
                "exportId",
                "unknown or finished export session",
            ));
        }

        let next_frame_count = session.frame_count.saturating_add(frames.len());
        let next_raw_bytes = session.raw_bytes.saturating_add(batch_bytes);
        if next_frame_count > MAX_EXPORT_FRAMES {
            return Err(limit_error("frames", MAX_EXPORT_FRAMES, next_frame_count));
        }
        if next_raw_bytes > MAX_EXPORT_BYTES {
            return Err(limit_error("frames", MAX_EXPORT_BYTES, next_raw_bytes));
        }

        let mut encoded = Vec::with_capacity(batch_bytes.min(64 * 1024));
        formatter::append_frames(
            &mut encoded,
            frames,
            session.format,
            &display_name(&session.target),
        )?;
        let format = session.format;
        let target = session.target.clone();
        session
            .writer
            .as_mut()
            .expect("active export session must own its writer")
            .write_all(&encoded)
            .await
            .map_err(|error| export_error(error, format, &target))?;
        session.frame_count = next_frame_count;
        session.raw_bytes = next_raw_bytes;
        session.output_bytes = session.output_bytes.saturating_add(encoded.len());
        session.last_activity = Instant::now();
        Ok(ExportAppendStats {
            total_frames: session.frame_count,
            total_raw_bytes: session.raw_bytes,
        })
    }

    pub async fn finish(&self, id: &str) -> Result<ExportFinishStats, AppError> {
        validate_session_id(id)?;
        let shared = self.get(id).await?;
        let (format, target, temp, mut writer, stats) = {
            let mut session = shared.lock().await;
            if session.terminal || session.writer.is_none() {
                return Err(validation_error(
                    "exportId",
                    "unknown or finished export session",
                ));
            }
            if session.frame_count == 0 {
                return Err(validation_error(
                    "frames",
                    "export session must contain a frame",
                ));
            }
            session.terminal = true;
            session.last_activity = Instant::now();
            let writer = session
                .writer
                .take()
                .expect("active export session must own its writer");
            (
                session.format,
                session.target.clone(),
                session.temp.clone(),
                writer,
                ExportFinishStats {
                    frames: session.frame_count,
                    raw_bytes: session.raw_bytes,
                    output_bytes: session.output_bytes,
                    duration_ms: u64::try_from(session.started_at.elapsed().as_millis())
                        .unwrap_or(u64::MAX),
                },
            )
        };

        let result = async {
            writer
                .flush()
                .await
                .map_err(|error| export_error(error, format, &target))?;
            writer
                .get_ref()
                .sync_all()
                .await
                .map_err(|error| export_error(error, format, &target))?;
            drop(writer);
            replace_target(&temp, &target, format).await
        }
        .await;
        if result.is_err() {
            remove_if_exists(&temp).await;
        }
        self.remove_current(id, &shared).await;
        self.active_temps.lock().await.remove(&temp);
        result.map(|()| stats)
    }

    pub async fn abort(&self, id: &str) -> Result<(), AppError> {
        validate_session_id(id)?;
        let Ok(shared) = self.get(id).await else {
            return Ok(());
        };
        let (path, writer) = {
            let mut session = shared.lock().await;
            if session.terminal {
                return Err(validation_error(
                    "exportId",
                    "export session is already finishing",
                ));
            }
            session.terminal = true;
            session.last_activity = Instant::now();
            (session.temp.clone(), session.writer.take())
        };
        self.remove_current(id, &shared).await;
        drop(writer);
        remove_if_exists(&path).await;
        self.active_temps.lock().await.remove(&path);
        Ok(())
    }

    async fn remove_current(&self, id: &str, shared: &SharedExportSession) -> bool {
        let mut sessions = self.sessions.lock().await;
        let is_current = sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, shared));
        if is_current {
            sessions.remove(id);
        }
        is_current
    }

    async fn get(&self, id: &str) -> Result<SharedExportSession, AppError> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| validation_error("exportId", "unknown or finished export session"))
    }

    async fn cleanup_expired(&self) -> usize {
        let now = Instant::now();
        let snapshot = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .map(|(id, session)| (id.clone(), Arc::clone(session)))
                .collect::<Vec<_>>()
        };

        let mut count = 0;
        for (id, shared) in snapshot {
            // A session holding its mutex is actively writing/flushing. Never
            // make a new export wait behind that disk I/O merely to perform a
            // best-effort expiry sweep; it can be reconsidered next begin.
            let Ok(mut session) = shared.try_lock() else {
                continue;
            };
            if now.saturating_duration_since(session.last_activity) < self.session_ttl {
                continue;
            }
            let removed = self.remove_current(&id, &shared).await;
            if !removed {
                continue;
            }
            let temp = session.temp.clone();
            let writer = session.writer.take();
            drop(session);
            drop(writer);
            remove_if_exists(&temp).await;
            self.active_temps.lock().await.remove(&temp);
            count += 1;
        }
        if count > 0 {
            tracing::info!(count, "removed expired export sessions");
        }
        count
    }

    async fn active_temp_paths(&self) -> HashSet<PathBuf> {
        self.active_temps.lock().await.clone()
    }

    fn reserve_target(&self, identity: TargetIdentity) -> Result<TargetReservation, AppError> {
        let mut active = self
            .active_targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !active.insert(identity.clone()) {
            return Err(validation_error(
                "path",
                "an export for this target is already active",
            ));
        }
        drop(active);
        Ok(TargetReservation {
            active_targets: Arc::clone(&self.active_targets),
            identity,
        })
    }

    async fn reserve_new_id(&self) -> Result<String, AppError> {
        for _ in 0..8 {
            let id = random_id_hex()?;
            if self.sessions.lock().await.contains_key(&id) {
                continue;
            }
            if self.reserved_ids.lock().await.insert(id.clone()) {
                return Ok(id);
            }
        }
        Err(AppError::IoError {
            message: "failed to allocate a unique export session id".to_string(),
            kind: ErrorKind::Other,
        })
    }
}

async fn initialize_writer<W: AsyncWrite + Unpin>(
    mut writer: W,
    header: &[u8],
    temp: &Path,
    format: ExportFormat,
    target: &Path,
) -> Result<W, AppError> {
    if !header.is_empty()
        && let Err(error) = writer.write_all(header).await
    {
        drop(writer);
        remove_if_exists(temp).await;
        return Err(export_error(error, format, target));
    }
    Ok(writer)
}

async fn canonical_target_identity(
    target: &Path,
    format: ExportFormat,
) -> Result<TargetIdentity, AppError> {
    let identity_path = if fs::try_exists(target)
        .await
        .map_err(|error| export_error(error, format, target))?
    {
        fs::canonicalize(target)
            .await
            .map_err(|error| export_error(error, format, target))?
    } else {
        let parent = target.parent().ok_or_else(|| {
            validation_error("path", "export target must have a parent directory")
        })?;
        let file_name = target
            .file_name()
            .ok_or_else(|| validation_error("path", "export target must have a file name"))?;
        fs::canonicalize(parent)
            .await
            .map_err(|error| export_error(error, format, target))?
            .join(file_name)
    };
    normalize_target_identity(identity_path)
}

#[cfg(windows)]
fn normalize_target_identity(path: PathBuf) -> Result<TargetIdentity, AppError> {
    Ok(path.to_string_lossy().replace('/', "\\").to_lowercase())
}

#[cfg(not(windows))]
fn normalize_target_identity(path: PathBuf) -> Result<TargetIdentity, AppError> {
    Ok(path)
}

pub fn validate_frame_batch(
    frames: &[DataFrame],
    max_frames: usize,
    max_bytes: usize,
) -> Result<usize, AppError> {
    if frames.len() > max_frames {
        return Err(limit_error("frames", max_frames, frames.len()));
    }
    let mut total = 0usize;
    for frame in frames {
        if frame.id.len() > MAX_FRAME_ID_BYTES {
            return Err(limit_error("frames", MAX_FRAME_ID_BYTES, frame.id.len()));
        }
        if frame.data.len() > MAX_FRAME_BYTES {
            return Err(limit_error("frames", MAX_FRAME_BYTES, frame.data.len()));
        }
        total = total
            .checked_add(frame.data.len())
            .ok_or_else(|| limit_error("frames", max_bytes, usize::MAX))?;
        // A frame is indivisible. It may exceed the normal batch byte budget
        // only when it is the sole frame in the batch, up to MAX_FRAME_BYTES.
        if total > max_bytes && frames.len() != 1 {
            return Err(limit_error("frames", max_bytes, total));
        }
    }
    Ok(total)
}

fn validate_session_id(id: &str) -> Result<(), AppError> {
    if id.len() != 32 || !is_lower_hex(id, 32) {
        return Err(validation_error("exportId", "invalid export session id"));
    }
    Ok(())
}

fn temp_path(target: &Path, id: &str) -> Option<PathBuf> {
    let parent = target.parent()?;
    Some(parent.join(format!(".bbcom.{id}.part")))
}

fn classify_artifact(file_name: &str) -> Option<&str> {
    let id = file_name.strip_prefix(".bbcom.")?.strip_suffix(".part")?;
    (id.len() == 32 && is_lower_hex(id, 32)).then_some(id)
}

fn is_lower_hex(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn reconcile_export_residue(
    target: &Path,
    now: SystemTime,
    ttl: Duration,
    active_temps: &HashSet<PathBuf>,
    format: ExportFormat,
) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| validation_error("path", "export target must have a parent directory"))?;
    let mut directory = fs::read_dir(parent)
        .await
        .map_err(|error| export_error(error, format, target))?;
    let mut removed_temps = 0usize;

    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| export_error(error, format, target))?
    {
        let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if classify_artifact(&file_name).is_none() {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(
                    operation = "reconcile_export_residue",
                    error_kind = ?error.kind(),
                    "could not inspect export residue"
                );
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        let modified = match entry
            .metadata()
            .await
            .and_then(|metadata| metadata.modified())
        {
            Ok(modified) => modified,
            Err(error) => {
                tracing::warn!(
                    operation = "reconcile_export_residue",
                    error_kind = ?error.kind(),
                    "could not inspect export residue age"
                );
                continue;
            }
        };
        let expired = now.duration_since(modified).is_ok_and(|age| age >= ttl);
        if expired && !active_temps.contains(&entry.path()) {
            match fs::remove_file(entry.path()).await {
                Ok(()) => removed_temps += 1,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(
                        operation = "reconcile_export_residue",
                        error_kind = ?error.kind(),
                        "failed to remove expired export temp"
                    );
                }
            }
        }
    }

    if removed_temps > 0 {
        tracing::info!(
            operation = "reconcile_export_residue",
            count = removed_temps,
            "removed expired export temp files"
        );
    }
    Ok(())
}

async fn create_temp_file(
    target: &Path,
    format: ExportFormat,
    id: &str,
) -> Result<(PathBuf, File), AppError> {
    validate_session_id(id)?;
    let temp = temp_path(target, id)
        .ok_or_else(|| validation_error("path", "export target must have a parent directory"))?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(|error| export_error(error, format, target))?;
    Ok((temp, file))
}

fn random_id_hex() -> Result<String, AppError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| AppError::IoError {
        message: format!("failed to obtain randomness for export session id: {error}"),
        kind: ErrorKind::Other,
    })?;
    let mut id = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

async fn replace_target(temp: &Path, target: &Path, format: ExportFormat) -> Result<(), AppError> {
    if temp.parent() != target.parent() {
        return Err(validation_error(
            "path",
            "export temp and target must be in the same directory",
        ));
    }
    atomic_replace(temp, target, format).await?;
    sync_parent_directory(target, format).await
}

#[cfg(windows)]
async fn atomic_replace(temp: &Path, target: &Path, format: ExportFormat) -> Result<(), AppError> {
    let temp = temp.to_owned();
    let target = target.to_owned();
    let error_target = target.clone();
    tokio::task::spawn_blocking(move || {
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
        };

        let source = null_terminated_wide(&temp)?;
        let destination = null_terminated_wide(&target)?;
        // SAFETY: both buffers are owned, NUL-terminated UTF-16 paths and stay
        // alive for the complete call. Existing targets use ReplaceFileW so
        // their replacement is one atomic OS operation; a first export has no
        // target to replace and is atomically moved into the same directory.
        let moved = if target.exists() {
            unsafe {
                ReplaceFileW(
                    destination.as_ptr(),
                    source.as_ptr(),
                    std::ptr::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            }
        } else {
            unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_WRITE_THROUGH,
                )
            }
        };
        if moved == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })
    .await
    .map_err(|error| AppError::ExportError {
        message: format!("atomic export replace task failed: {error}"),
        format: format.label().to_string(),
        path: display_name(&error_target),
        kind: ErrorKind::Other,
    })?
    .map_err(|error| export_error(error, format, &error_target))
}

#[cfg(windows)]
fn null_terminated_wide(path: &Path) -> std::io::Result<Vec<u16>> {
    let mut value = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if value.contains(&0) {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "path contains an interior NUL",
        ));
    }
    value.push(0);
    Ok(value)
}

#[cfg(not(windows))]
async fn atomic_replace(temp: &Path, target: &Path, format: ExportFormat) -> Result<(), AppError> {
    fs::rename(temp, target)
        .await
        .map_err(|error| export_error(error, format, target))
}

#[cfg(unix)]
async fn sync_parent_directory(target: &Path, format: ExportFormat) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| validation_error("path", "export target must have a parent directory"))?;
    let directory = File::open(parent)
        .await
        .map_err(|error| export_error(error, format, target))?;
    directory
        .sync_all()
        .await
        .map_err(|error| export_error(error, format, target))
}

#[cfg(not(unix))]
async fn sync_parent_directory(_target: &Path, _format: ExportFormat) -> Result<(), AppError> {
    Ok(())
}

async fn remove_if_exists(path: &Path) {
    if let Err(error) = fs::remove_file(path).await
        && error.kind() != ErrorKind::NotFound
    {
        tracing::warn!(
            operation = "remove_export_temp",
            error_kind = ?error.kind(),
            "failed to remove export temp file"
        );
    }
}

fn validation_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::ValidationError {
        message: message.into(),
        field: field.to_string(),
    }
}

fn limit_error(field: &str, limit: usize, actual: usize) -> AppError {
    AppError::LimitError {
        message: format!("{field} exceeds its limit"),
        field: field.to_string(),
        limit,
        actual,
    }
}

fn export_error(error: std::io::Error, format: ExportFormat, path: &Path) -> AppError {
    AppError::ExportError {
        message: error.to_string(),
        format: format.label().to_string(),
        path: display_name(path),
        kind: error.kind(),
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export target".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::data_frame::Direction;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::task::{Context, Poll};
    use std::time::UNIX_EPOCH;
    use tokio::sync::oneshot;
    use tokio::time::timeout;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn target_path(extension: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        path.push(format!(
            "bbcom-export-session-{nonce}-{counter}.{extension}"
        ));
        path
    }

    fn isolated_target(file_name: &str) -> (PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!("bbcom-residue-{nonce}-{counter}"));
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join(file_name);
        (directory, target)
    }

    async fn shared_session(manager: &ExportSessionManager, id: &str) -> SharedExportSession {
        manager.sessions.lock().await.get(id).unwrap().clone()
    }

    fn frame(id: &str, data: &[u8]) -> DataFrame {
        DataFrame {
            id: id.to_string(),
            direction: Direction::Rx,
            timestamp: 1.0,
            data: data.to_vec(),
        }
    }

    #[derive(Debug)]
    struct FailingWriter;

    impl AsyncWrite for FailingWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Err(std::io::Error::other("injected header failure")))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn streams_batches_and_atomically_replaces_target() {
        let target = target_path("csv");
        std::fs::write(&target, "old data").unwrap();
        let manager = ExportSessionManager::default();
        let id = manager
            .begin(ExportFormat::Csv, target.clone())
            .await
            .unwrap();
        let append_stats = manager
            .append(&id, &[frame("1", &[0x41]), frame("2", &[0x42])])
            .await
            .unwrap();
        assert_eq!(
            append_stats,
            ExportAppendStats {
                total_frames: 2,
                total_raw_bytes: 2,
            }
        );
        let finish_stats = manager.finish(&id).await.unwrap();
        assert_eq!(finish_stats.frames, 2);
        assert_eq!(finish_stats.raw_bytes, 2);
        assert!(finish_stats.output_bytes > finish_stats.raw_bytes);

        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.starts_with("timestamp,direction,data\n"));
        assert!(content.contains("41"));
        assert!(content.contains("42"));
        assert!(!content.contains("old data"));
        assert!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
        );
        std::fs::remove_file(target).ok();
    }

    #[tokio::test]
    async fn abort_removes_backend_owned_temp_file() {
        let target = target_path("jsonl");
        let manager = ExportSessionManager::default();
        let id = manager
            .begin(ExportFormat::Jsonl, target.clone())
            .await
            .unwrap();
        let shared = shared_session(&manager, &id).await;
        let temp = shared.lock().await.temp.clone();
        assert!(temp.exists());
        let file_name = temp.file_name().unwrap().to_string_lossy();
        assert!(classify_artifact(&file_name).is_some());
        assert_eq!(file_name, format!(".bbcom.{id}.part"));
        drop(shared);
        manager.abort(&id).await.unwrap();
        assert!(!temp.exists());
        assert!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
        );
    }

    #[tokio::test]
    async fn expired_sessions_are_swept_before_they_consume_capacity() {
        let manager = ExportSessionManager::default();
        let mut temp_files = Vec::new();
        for _ in 0..MAX_ACTIVE_EXPORTS {
            let id = manager
                .begin(ExportFormat::Jsonl, target_path("jsonl"))
                .await
                .unwrap();
            let shared = shared_session(&manager, &id).await;
            temp_files.push(shared.lock().await.temp.clone());
        }

        let replacement_target = target_path("jsonl");
        assert!(
            manager
                .begin(ExportFormat::Jsonl, replacement_target.clone())
                .await
                .is_err()
        );
        let expired_at = Instant::now() - EXPORT_SESSION_TTL - Duration::from_secs(1);
        let sessions = manager
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for shared in sessions {
            shared.lock().await.last_activity = expired_at;
        }

        let replacement_id = manager
            .begin(ExportFormat::Jsonl, replacement_target)
            .await
            .unwrap();

        assert!(temp_files.iter().all(|path| !path.exists()));
        assert_eq!(manager.sessions.lock().await.len(), 1);
        assert_eq!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len(),
            1
        );
        manager.abort(&replacement_id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_export_does_not_hold_global_map_or_block_another_export() {
        let manager = Arc::new(ExportSessionManager::default());
        let first_target = target_path("jsonl");
        let second_target = target_path("jsonl");
        let first_id = manager
            .begin(ExportFormat::Jsonl, first_target.clone())
            .await
            .unwrap();
        let second_id = manager
            .begin(ExportFormat::Jsonl, second_target.clone())
            .await
            .unwrap();
        let first_shared = shared_session(&manager, &first_id).await;
        let first_guard = first_shared.lock().await;

        let map_guard = manager.sessions.lock().await;
        let blocked_manager = Arc::clone(&manager);
        let blocked_id = first_id.clone();
        let blocked = tokio::spawn(async move {
            blocked_manager
                .append(&blocked_id, &[frame("blocked", &[1])])
                .await
        });
        tokio::task::yield_now().await;
        drop(map_guard);

        let reacquired = timeout(Duration::from_secs(1), manager.sessions.lock())
            .await
            .expect("an append waiting on its session must release the global map");
        drop(reacquired);
        timeout(
            Duration::from_secs(1),
            manager.append(&second_id, &[frame("independent", &[2])]),
        )
        .await
        .expect("a different export id must remain writable")
        .unwrap();

        drop(first_guard);
        blocked.await.unwrap().unwrap();
        manager.finish(&first_id).await.unwrap();
        manager.finish(&second_id).await.unwrap();
        std::fs::remove_file(first_target).ok();
        std::fs::remove_file(second_target).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn beginning_an_export_never_waits_for_a_busy_session_sweep() {
        let manager = Arc::new(ExportSessionManager::default());
        let first_target = target_path("jsonl");
        let first_id = manager
            .begin(ExportFormat::Jsonl, first_target.clone())
            .await
            .unwrap();
        let first_shared = shared_session(&manager, &first_id).await;
        let first_guard = first_shared.lock().await;

        let second_target = target_path("jsonl");
        let second_id = timeout(
            Duration::from_secs(1),
            manager.begin(ExportFormat::Jsonl, second_target.clone()),
        )
        .await
        .expect("expiry cleanup must skip a session doing disk work")
        .unwrap();

        drop(first_guard);
        manager.abort(&first_id).await.unwrap();
        manager.abort(&second_id).await.unwrap();
        std::fs::remove_file(first_target).ok();
        std::fs::remove_file(second_target).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_aliases_of_the_same_target_are_rejected_until_release() {
        let manager = Arc::new(ExportSessionManager::default());
        let (directory, target) = isolated_target("capture.jsonl");
        let nested = directory.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let alias = nested.join("..").join("capture.jsonl");

        let (first, second) = tokio::join!(
            manager.begin(ExportFormat::Jsonl, target.clone()),
            manager.begin(ExportFormat::Jsonl, alias.clone())
        );
        let (active_id, rejected) = match (first, second) {
            (Ok(id), Err(error)) | (Err(error), Ok(id)) => (id, error),
            results => panic!("exactly one same-target begin must succeed: {results:?}"),
        };
        assert!(matches!(rejected, AppError::ValidationError { field, .. } if field == "path"));
        assert_eq!(manager.sessions.lock().await.len(), 1);
        assert_eq!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len(),
            1
        );
        assert_eq!(manager.slots.available_permits(), MAX_ACTIVE_EXPORTS - 1);

        manager.abort(&active_id).await.unwrap();
        assert_eq!(manager.slots.available_permits(), MAX_ACTIVE_EXPORTS);
        let next = manager
            .begin(ExportFormat::Jsonl, alias)
            .await
            .expect("target reservation must release after abort");
        manager.abort(&next).await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_begins_reserve_capacity_before_creating_sessions() {
        let manager = Arc::new(ExportSessionManager::default());
        let mut tasks = Vec::new();
        for _ in 0..MAX_ACTIVE_EXPORTS * 2 {
            let manager = Arc::clone(&manager);
            let target = target_path("jsonl");
            tasks.push(tokio::spawn(async move {
                let result = manager.begin(ExportFormat::Jsonl, target.clone()).await;
                (result, target)
            }));
        }

        let mut opened = Vec::new();
        let mut rejected = 0usize;
        for task in tasks {
            let (result, target) = task.await.unwrap();
            match result {
                Ok(id) => opened.push((id, target)),
                Err(AppError::LimitError {
                    field,
                    limit: MAX_ACTIVE_EXPORTS,
                    actual,
                    ..
                }) if field == "exportId" && actual == MAX_ACTIVE_EXPORTS + 1 => {
                    rejected += 1;
                }
                Err(error) => panic!("unexpected begin error: {error}"),
            }
        }

        assert_eq!(opened.len(), MAX_ACTIVE_EXPORTS);
        assert_eq!(rejected, MAX_ACTIVE_EXPORTS);
        assert_eq!(manager.sessions.lock().await.len(), MAX_ACTIVE_EXPORTS);
        assert_eq!(manager.active_temps.lock().await.len(), MAX_ACTIVE_EXPORTS);
        for (id, target) in opened {
            manager.abort(&id).await.unwrap();
            std::fs::remove_file(target).ok();
        }
        assert!(manager.active_temps.lock().await.is_empty());
    }

    #[tokio::test]
    async fn failed_atomic_replace_leaves_existing_target_unchanged() {
        let (directory, target) = isolated_target("capture.csv");
        std::fs::write(&target, b"original").unwrap();
        let missing_temp =
            directory.join(".bbcom-missing-v2-0-00000000000000000000000000000000.tmp");

        let error = replace_target(&missing_temp, &target, ExportFormat::Csv)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::ExportError { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn failed_finish_releases_target_and_capacity_reservations() {
        let manager = ExportSessionManager::default();
        let (directory, target) = isolated_target("capture.csv");
        let id = manager
            .begin(ExportFormat::Csv, target.clone())
            .await
            .unwrap();
        manager.append(&id, &[frame("1", &[0x41])]).await.unwrap();
        std::fs::create_dir(&target).unwrap();

        assert!(manager.finish(&id).await.is_err());

        assert_eq!(manager.slots.available_permits(), MAX_ACTIVE_EXPORTS);
        assert!(manager.sessions.lock().await.is_empty());
        assert!(manager.active_temps.lock().await.is_empty());
        assert!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batches_for_the_same_export_id_are_serialized() {
        let manager = Arc::new(ExportSessionManager::default());
        let target = target_path("jsonl");
        let id = manager
            .begin(ExportFormat::Jsonl, target.clone())
            .await
            .unwrap();
        let shared = shared_session(&manager, &id).await;
        let (first_has_lock, wait_for_second) = oneshot::channel();
        let (release_first, release_first_rx) = oneshot::channel();
        let first_shared = Arc::clone(&shared);
        let first = tokio::spawn(async move {
            let mut session = first_shared.lock().await;
            first_has_lock.send(()).unwrap();
            release_first_rx.await.unwrap();
            ExportSessionManager::append_locked(&mut session, &[frame("first", &[1])], 1).await
        });
        wait_for_second.await.unwrap();

        let (second_started, second_started_rx) = oneshot::channel();
        let second_manager = Arc::clone(&manager);
        let second_id = id.clone();
        let second = tokio::spawn(async move {
            second_started.send(()).unwrap();
            second_manager
                .append(&second_id, &[frame("second", &[2])])
                .await
        });
        second_started_rx.await.unwrap();
        release_first.send(()).unwrap();

        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        manager.finish(&id).await.unwrap();
        let lines = std::fs::read_to_string(&target).unwrap();
        let ids = lines
            .lines()
            .map(|line| serde_json::from_str::<DataFrame>(line).unwrap().id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["first", "second"]);
        std::fs::remove_file(target).ok();
    }

    #[tokio::test]
    async fn residue_cleanup_is_strict_parent_scoped_and_non_recursive() {
        let (directory, target) = isolated_target("capture.csv");
        std::fs::write(&target, b"current").unwrap();
        let owned = temp_path(&target, "00000000000000000000000000000001").unwrap();
        let active = temp_path(&target, "00000000000000000000000000000002").unwrap();
        let another_owned = directory.join(".bbcom.00000000000000000000000000000003.part");
        let malformed = directory.join(".bbcom.too-short.part");
        let legacy = directory.join(".bbcom-capture.csv-export-deadbeef-1-0.tmp");
        let nested = directory.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let nested_owned = nested.join(owned.file_name().unwrap());
        for path in [
            &owned,
            &active,
            &another_owned,
            &malformed,
            &legacy,
            &nested_owned,
        ] {
            std::fs::write(path, b"residue").unwrap();
        }
        let active_temps = HashSet::from([active.clone()]);

        reconcile_export_residue(
            &target,
            SystemTime::now(),
            Duration::ZERO,
            &active_temps,
            ExportFormat::Csv,
        )
        .await
        .unwrap();

        assert!(!owned.exists());
        assert!(active.exists());
        assert!(!another_owned.exists());
        assert!(malformed.exists());
        assert!(legacy.exists());
        assert!(nested_owned.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn residue_cleanup_never_deletes_or_follows_symbolic_links() {
        let (directory, target) = isolated_target("capture.csv");
        std::fs::write(&target, b"current").unwrap();
        let victim = directory.join("victim.bin");
        std::fs::write(&victim, b"do not delete").unwrap();
        let link = temp_path(&target, "00000000000000000000000000000004").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&victim, &link).is_err() {
            std::fs::remove_dir_all(directory).unwrap();
            return;
        }

        reconcile_export_residue(
            &target,
            SystemTime::now(),
            Duration::ZERO,
            &HashSet::new(),
            ExportFormat::Csv,
        )
        .await
        .unwrap();

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read(&victim).unwrap(), b"do not delete");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn header_write_failure_removes_allocated_temp_file() {
        let target = target_path("csv");
        let temp = target.with_extension("tmp");
        std::fs::write(&temp, b"allocated").unwrap();

        let error = initialize_writer(FailingWriter, b"header", &temp, ExportFormat::Csv, &target)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::ExportError { .. }));
        assert!(!temp.exists());
    }

    #[test]
    fn random_session_ids_are_full_width_and_unpredictable() {
        let first = random_id_hex().unwrap();
        let second = random_id_hex().unwrap();
        assert_eq!(first.len(), 32);
        assert!(is_lower_hex(&first, 32));
        assert_ne!(first, second);
        assert!(validate_session_id(&first).is_ok());
        assert!(validate_session_id("export-123").is_err());
    }

    #[test]
    fn batch_limits_cover_count_single_frame_and_total_bytes() {
        let too_many = vec![frame("x", &[]); MAX_BATCH_FRAMES + 1];
        assert!(matches!(
            validate_frame_batch(&too_many, MAX_BATCH_FRAMES, MAX_BATCH_BYTES),
            Err(AppError::LimitError {
                limit: MAX_BATCH_FRAMES,
                actual,
                ..
            }) if actual == MAX_BATCH_FRAMES + 1
        ));
        assert!(matches!(
            validate_frame_batch(
                &[frame("large", &vec![0; MAX_FRAME_BYTES + 1])],
                MAX_BATCH_FRAMES,
                MAX_BATCH_BYTES,
            ),
            Err(AppError::LimitError {
                limit: MAX_FRAME_BYTES,
                actual,
                ..
            }) if actual == MAX_FRAME_BYTES + 1
        ));
        assert!(matches!(
            validate_frame_batch(
                &[frame("a", &[0; 3]), frame("b", &[0; 3])],
                MAX_BATCH_FRAMES,
                5,
            ),
            Err(AppError::LimitError {
                limit: 5,
                actual: 6,
                ..
            })
        ));
        assert_eq!(
            validate_frame_batch(
                &[frame("singleton", &vec![0; MAX_FRAME_BYTES])],
                MAX_BATCH_FRAMES,
                MAX_BATCH_BYTES,
            )
            .unwrap(),
            MAX_FRAME_BYTES,
        );
    }
}
