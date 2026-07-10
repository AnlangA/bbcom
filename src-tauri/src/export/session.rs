//! Bounded, backend-owned export sessions.

use crate::export::{ExportFormat, formatter};
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::ErrorKind;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, atomic::AtomicU64, atomic::Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncWrite, AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

pub const MAX_EXPORT_FRAMES: usize = 100_000;
pub const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BATCH_FRAMES: usize = 512;
pub const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTIVE_EXPORTS: usize = 8;
const MAX_FRAME_ID_BYTES: usize = 256;
const EXPORT_SESSION_TTL: Duration = Duration::from_secs(30 * 60);
type SharedExportSession = Arc<Mutex<ExportSession>>;

#[cfg(windows)]
type TargetIdentity = String;
#[cfg(not(windows))]
type TargetIdentity = PathBuf;

pub struct ExportSessionManager {
    sessions: Mutex<HashMap<String, SharedExportSession>>,
    active_temps: Mutex<HashSet<PathBuf>>,
    active_targets: Arc<StdMutex<HashSet<TargetIdentity>>>,
    slots: Arc<Semaphore>,
    next_id: AtomicU64,
    session_ttl: Duration,
}

struct ExportSession {
    format: ExportFormat,
    target: PathBuf,
    temp: PathBuf,
    writer: Option<BufWriter<File>>,
    frame_count: usize,
    raw_bytes: usize,
    last_activity: Instant,
    terminal: bool,
    _slot: OwnedSemaphorePermit,
    _target: TargetReservation,
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
            active_targets: Arc::new(StdMutex::new(HashSet::new())),
            slots: Arc::new(Semaphore::new(MAX_ACTIVE_EXPORTS)),
            next_id: AtomicU64::new(0),
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
        let slot = Arc::clone(&self.slots).try_acquire_owned().map_err(|_| {
            validation_error(
                "exportId",
                format!("too many active exports (max {MAX_ACTIVE_EXPORTS})"),
            )
        })?;
        let target_identity = canonical_target_identity(&target, format).await?;
        let target_reservation = self.reserve_target(target_identity)?;
        let active_temps = self.active_temp_paths().await;
        reconcile_target_residue(
            &target,
            SystemTime::now(),
            self.session_ttl,
            &active_temps,
            format,
        )
        .await?;

        let id = self.new_id();
        let (temp, file) = create_temp_file(&target, format).await?;
        let writer = BufWriter::with_capacity(64 * 1024, file);
        let mut header = Vec::new();
        formatter::append_header(&mut header, format);
        let writer = initialize_writer(writer, &header, &temp, format, &target).await?;

        let session = Arc::new(Mutex::new(ExportSession {
            format,
            target,
            temp: temp.clone(),
            writer: Some(writer),
            frame_count: 0,
            raw_bytes: 0,
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
        debug_assert!(replaced.is_none(), "export ids must be unique per manager");
        Ok(id)
    }

    pub async fn append(&self, id: &str, frames: &[DataFrame]) -> Result<(), AppError> {
        let batch_bytes = validate_frame_batch(frames, MAX_BATCH_FRAMES, MAX_BATCH_BYTES)?;
        let shared = self.get(id).await?;
        let mut session = shared.lock().await;
        if session.terminal || session.writer.is_none() {
            return Err(validation_error(
                "exportId",
                "unknown or finished export session",
            ));
        }

        let next_frame_count = session.frame_count.saturating_add(frames.len());
        let next_raw_bytes = session.raw_bytes.saturating_add(batch_bytes);
        if next_frame_count > MAX_EXPORT_FRAMES {
            return Err(validation_error(
                "frames",
                format!("too many frames: {next_frame_count} (max {MAX_EXPORT_FRAMES})"),
            ));
        }
        if next_raw_bytes > MAX_EXPORT_BYTES {
            return Err(validation_error(
                "frames",
                format!("export data exceeds {MAX_EXPORT_BYTES} bytes"),
            ));
        }

        let mut encoded = Vec::with_capacity(batch_bytes.min(64 * 1024));
        formatter::append_frames(
            &mut encoded,
            frames,
            session.format,
            &session.target.to_string_lossy(),
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
        session.last_activity = Instant::now();
        Ok(())
    }

    pub async fn finish(&self, id: &str) -> Result<(), AppError> {
        let shared = self.get(id).await?;
        let (format, target, temp, mut writer) = {
            let mut session = shared.lock().await;
            if session.terminal || session.writer.is_none() {
                return Err(validation_error(
                    "exportId",
                    "unknown or finished export session",
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
        result
    }

    pub async fn abort(&self, id: &str) -> Result<(), AppError> {
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

    fn new_id(&self) -> String {
        let counter = self.next_id.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        format!("export-{nanos:x}-{counter:x}")
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
        return Err(validation_error(
            "frames",
            format!("too many frames: {} (max {max_frames})", frames.len()),
        ));
    }
    let mut total = 0usize;
    for frame in frames {
        if frame.id.len() > MAX_FRAME_ID_BYTES {
            return Err(validation_error(
                "frames",
                format!("frame id exceeds {MAX_FRAME_ID_BYTES} bytes"),
            ));
        }
        if frame.data.len() > MAX_FRAME_BYTES {
            return Err(validation_error(
                "frames",
                format!("single frame exceeds {MAX_FRAME_BYTES} bytes"),
            ));
        }
        total = total
            .checked_add(frame.data.len())
            .ok_or_else(|| validation_error("frames", "frame byte count overflow"))?;
        if total > max_bytes {
            return Err(validation_error(
                "frames",
                format!("frame data exceeds {max_bytes} bytes"),
            ));
        }
    }
    Ok(total)
}

pub fn validate_export_path(path: &str, format: ExportFormat) -> Result<PathBuf, AppError> {
    if path.trim().is_empty() {
        return Err(validation_error("path", "export path cannot be empty"));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(validation_error("path", "export path must be absolute"));
    }
    if path.is_dir() {
        return Err(validation_error(
            "path",
            "export path cannot be a directory",
        ));
    }
    if path.file_name().and_then(|value| value.to_str()).is_none() {
        return Err(validation_error(
            "path",
            "export file name must be valid Unicode",
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        return Err(validation_error("path", "export directory does not exist"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !extension.is_empty() && extension != format.extension() {
        return Err(validation_error(
            "path",
            format!("export file extension must be .{}", format.extension()),
        ));
    }
    Ok(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExportArtifact {
    created_at: SystemTime,
}

fn artifact_prefix(target: &Path) -> Option<String> {
    let name = target.file_name()?.to_str()?;
    Some(format!(".bbcom-{name}-v2-"))
}

fn temp_path(target: &Path, created_at: SystemTime, nonce: &str) -> Option<PathBuf> {
    let parent = target.parent()?;
    let prefix = artifact_prefix(target)?;
    let nanos = u64::try_from(created_at.duration_since(UNIX_EPOCH).ok()?.as_nanos()).ok()?;
    Some(parent.join(format!("{prefix}{nanos:x}-{nonce}.tmp")))
}

fn classify_artifact(target: &Path, file_name: &str) -> Option<ExportArtifact> {
    let rest = file_name.strip_prefix(&artifact_prefix(target)?)?;
    let body = rest.strip_suffix(".tmp")?;
    let (nanos, nonce) = body.split_once('-')?;
    if !is_lower_hex(nanos, 16) || nonce.len() != 32 || !is_lower_hex(nonce, 32) {
        return None;
    }
    let nanos = u64::from_str_radix(nanos, 16).ok()?;
    Some(ExportArtifact {
        created_at: UNIX_EPOCH.checked_add(Duration::from_nanos(nanos))?,
    })
}

fn is_lower_hex(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn reconcile_target_residue(
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
        let Some(artifact) = classify_artifact(target, &file_name) else {
            continue;
        };
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(path = %entry.path().display(), "could not inspect export residue: {error}");
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        let expired = now
            .duration_since(artifact.created_at)
            .is_ok_and(|age| age >= ttl);
        if expired && !active_temps.contains(&entry.path()) {
            match fs::remove_file(entry.path()).await {
                Ok(()) => removed_temps += 1,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(path = %entry.path().display(), "failed to remove expired export temp: {error}");
                }
            }
        }
    }

    if removed_temps > 0 {
        tracing::info!(target = %target.display(), count = removed_temps, "removed expired export temp files");
    }
    Ok(())
}

async fn create_temp_file(
    target: &Path,
    format: ExportFormat,
) -> Result<(PathBuf, File), AppError> {
    for _ in 0..8 {
        let nonce = random_nonce_hex()?;
        let temp = temp_path(target, SystemTime::now(), &nonce).ok_or_else(|| {
            validation_error("path", "export target has an unsupported file name")
        })?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
        {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(export_error(error, format, target)),
        }
    }
    Err(AppError::ExportError {
        message: "failed to allocate a unique export temp file".to_string(),
        format: format.label().to_string(),
        path: target.to_string_lossy().into_owned(),
    })
}

fn random_nonce_hex() -> Result<String, AppError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| AppError::IoError {
        message: format!("failed to obtain randomness for export temp file: {error}"),
        kind: ErrorKind::Other,
    })?;
    let mut nonce = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut nonce, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(nonce)
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
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };

        let source = null_terminated_wide(&temp)?;
        let destination = null_terminated_wide(&target)?;
        // SAFETY: both buffers are owned, NUL-terminated UTF-16 paths and stay
        // alive for the complete call. Flags request one replace operation and
        // synchronous durability; no handles or borrowed output are involved.
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
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
        path: error_target.to_string_lossy().into_owned(),
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
        tracing::warn!(path = %path.display(), "failed to remove export temp file: {error}");
    }
}

fn validation_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::ValidationError {
        message: message.into(),
        field: field.to_string(),
    }
}

fn export_error(error: std::io::Error, format: ExportFormat, path: &Path) -> AppError {
    AppError::ExportError {
        message: error.to_string(),
        format: format.label().to_string(),
        path: path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::data_frame::Direction;
    use std::pin::Pin;
    use std::task::{Context, Poll};
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
        manager
            .append(&id, &[frame("1", &[0x41]), frame("2", &[0x42])])
            .await
            .unwrap();
        manager.finish(&id).await.unwrap();

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
        assert!(classify_artifact(&target, &file_name).is_some());
        assert!(file_name.contains("-v2-"));
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

    #[tokio::test]
    async fn begin_failure_after_target_reservation_releases_all_admission() {
        let manager = ExportSessionManager::default();
        let (directory, _) = isolated_target("placeholder.jsonl");
        let target = directory.join(format!("{}.jsonl", "x".repeat(220)));

        assert!(manager.begin(ExportFormat::Jsonl, target).await.is_err());

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
                Err(AppError::ValidationError { field, .. }) if field == "exportId" => {
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
        let session_guard = shared.lock().await;

        let map_guard = manager.sessions.lock().await;
        let first_manager = Arc::clone(&manager);
        let first_id = id.clone();
        let first = tokio::spawn(async move {
            first_manager
                .append(&first_id, &[frame("first", &[1])])
                .await
        });
        tokio::task::yield_now().await;
        drop(map_guard);
        let checkpoint = manager.sessions.lock().await;
        drop(checkpoint);

        let second_manager = Arc::clone(&manager);
        let second_id = id.clone();
        let second = tokio::spawn(async move {
            second_manager
                .append(&second_id, &[frame("second", &[2])])
                .await
        });
        tokio::task::yield_now().await;
        drop(session_guard);

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
    async fn residue_cleanup_is_target_scoped_strict_and_non_recursive() {
        let (directory, target) = isolated_target("capture.csv");
        std::fs::write(&target, b"current").unwrap();
        let stale = UNIX_EPOCH + Duration::from_nanos(0xdeadbeef);
        let owned = temp_path(&target, stale, "00000000000000000000000000000001").unwrap();
        let active = temp_path(&target, stale, "00000000000000000000000000000002").unwrap();
        let wrong_target =
            directory.join(".bbcom-other.csv-v2-deadbeef-00000000000000000000000000000003.tmp");
        let malformed = directory.join(".bbcom-capture.csv-v2-deadbeef-too-short.tmp");
        let legacy = directory.join(".bbcom-capture.csv-export-deadbeef-1-0.tmp");
        let nested = directory.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let nested_owned = nested.join(owned.file_name().unwrap());
        for path in [
            &owned,
            &active,
            &wrong_target,
            &malformed,
            &legacy,
            &nested_owned,
        ] {
            std::fs::write(path, b"residue").unwrap();
        }
        let active_temps = HashSet::from([active.clone()]);

        reconcile_target_residue(
            &target,
            SystemTime::now(),
            EXPORT_SESSION_TTL,
            &active_temps,
            ExportFormat::Csv,
        )
        .await
        .unwrap();

        assert!(!owned.exists());
        assert!(active.exists());
        assert!(wrong_target.exists());
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
        let stale = UNIX_EPOCH + Duration::from_nanos(0xdeadbeef);
        let link = temp_path(&target, stale, "00000000000000000000000000000004").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&victim, &link).is_err() {
            std::fs::remove_dir_all(directory).unwrap();
            return;
        }

        reconcile_target_residue(
            &target,
            SystemTime::now(),
            EXPORT_SESSION_TTL,
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
    fn random_temp_nonces_are_full_width_and_unpredictable() {
        let first = random_nonce_hex().unwrap();
        let second = random_nonce_hex().unwrap();
        assert_eq!(first.len(), 32);
        assert!(is_lower_hex(&first, 32));
        assert_ne!(first, second);
    }

    #[test]
    fn batch_limits_cover_count_single_frame_and_total_bytes() {
        let too_many = vec![frame("x", &[]); MAX_BATCH_FRAMES + 1];
        assert!(validate_frame_batch(&too_many, MAX_BATCH_FRAMES, MAX_BATCH_BYTES).is_err());
        assert!(
            validate_frame_batch(
                &[frame("large", &vec![0; MAX_FRAME_BYTES + 1])],
                MAX_BATCH_FRAMES,
                MAX_BATCH_BYTES,
            )
            .is_err()
        );
        assert!(
            validate_frame_batch(
                &[frame("a", &[0; 3]), frame("b", &[0; 3])],
                MAX_BATCH_FRAMES,
                5,
            )
            .is_err()
        );
    }
}
