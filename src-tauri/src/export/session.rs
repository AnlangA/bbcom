//! Bounded, backend-owned export sessions.

use crate::commands::streaming_sessions::{
    SharedStreamingSession, StreamingSession, StreamingSessionNaming, StreamingSessionTable,
    is_lower_hex, limit_error, validate_hex_session_id, validation_error,
};
use crate::export::{ExportFormat, formatter};
use crate::models::data_frame::DataFrame;
use crate::models::errors::AppError;
use serde::Serialize;
use std::collections::HashSet;
use std::io::ErrorKind;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncWrite, AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex, OwnedSemaphorePermit};

pub use bbcom_contracts::{
    MAX_EXPORT_BATCH_BYTES as MAX_BATCH_BYTES, MAX_EXPORT_BATCH_FRAMES as MAX_BATCH_FRAMES,
    MAX_EXPORT_BYTES, MAX_EXPORT_FRAME_BYTES as MAX_FRAME_BYTES, MAX_EXPORT_FRAMES,
};
const MAX_ACTIVE_EXPORTS: usize = 8;
const MAX_FRAME_ID_BYTES: usize = 256;
const EXPORT_SESSION_TTL: Duration = Duration::from_secs(30 * 60);
/// Page size for backend-sourced frame reads. Mirrors the workspace crate's
/// hydration page cap so every internal page also satisfies the export batch
/// limits (`MAX_BATCH_FRAMES` / `MAX_BATCH_BYTES`) enforced by
/// [`ExportSessionManager::append_locked`].
pub const SOURCE_PAGE_FRAMES: usize = 256;
/// Longest accepted workspace/session identifier in a backend-source query;
/// the workspace crate's own identifier validation is the authoritative check.
const MAX_SOURCE_ID_BYTES: usize = 128;
// A part file can only be removed when it is unmistakably abandoned.  Export
// sessions themselves expire much sooner, but their files remain recoverable
// for a full day so a delayed scheduler cannot delete a live user's output.
const STALE_EXPORT_PART_TTL: Duration = Duration::from_secs(24 * 60 * 60);
type SharedExportSession = SharedStreamingSession<ExportSession>;

/// Identity and strict sequence ceiling of one backend-sourced export.
///
/// `to_seq_exclusive` is the caller's next append sequence after flushing its
/// save queue: every frame with `seq < to_seq_exclusive` is exported, every
/// frame at or above it is excluded even once persisted later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceFrameQuery {
    pub workspace_id: String,
    pub session_id: String,
    pub to_seq_exclusive: u64,
}

/// Frame and raw-payload-byte totals for one [`WorkspaceFrameQuery`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkspaceFrameTotals {
    pub frames: usize,
    pub raw_bytes: usize,
}

/// One bounded ascending page of frames plus the continuation cursor.
#[derive(Clone, Debug, Default)]
pub struct WorkspaceFrameSlice {
    pub frames: Vec<DataFrame>,
    /// Seq of the first frame below the ceiling that is not in this page, or
    /// `None` when no eligible frames remain.
    pub next_seq: Option<u64>,
}

/// Read-only paged frame source over a durable workspace, injected per
/// backend-sourced begin so the export manager stays workspace-crate agnostic
/// and unit-testable with a fake source. Implementations must honor the
/// `to_seq_exclusive` ceiling strictly and never mutate the source.
pub trait WorkspaceFrameSource: Send + Sync {
    /// Totals the backend will commit to enforce at finish.
    fn expected_totals(
        &self,
        query: &WorkspaceFrameQuery,
    ) -> Result<WorkspaceFrameTotals, AppError>;

    /// Frames with `from_seq <= seq < query.to_seq_exclusive`, ascending, at
    /// most [`SOURCE_PAGE_FRAMES`] frames per call.
    fn read_page(
        &self,
        query: &WorkspaceFrameQuery,
        from_seq: u64,
    ) -> Result<WorkspaceFrameSlice, AppError>;
}

#[cfg(windows)]
type TargetIdentity = String;
#[cfg(not(windows))]
type TargetIdentity = PathBuf;

pub struct ExportSessionManager {
    table: StreamingSessionTable<ExportSession>,
    active_temps: Mutex<HashSet<PathBuf>>,
    active_targets: Arc<StdMutex<HashSet<TargetIdentity>>>,
}

struct ExportSession {
    format: ExportFormat,
    target: PathBuf,
    temp: PathBuf,
    writer: Option<BufWriter<File>>,
    expected_frames: Option<usize>,
    expected_raw_bytes: Option<usize>,
    frame_count: usize,
    raw_bytes: usize,
    output_bytes: usize,
    started_at: Instant,
    last_activity: Instant,
    terminal: bool,
    /// Backend-sourced session: frames are paged in by the manager itself and
    /// renderer `append` calls are rejected for this id.
    backend_sourced: bool,
    _slot: OwnedSemaphorePermit,
    _target: TargetReservation,
}

impl StreamingSession for ExportSession {
    type Detached = (PathBuf, Option<BufWriter<File>>);

    fn last_activity(&self) -> Instant {
        self.last_activity
    }

    fn seal_expired(&mut self) {
        self.terminal = true;
        self.last_activity = Instant::now();
    }

    fn detach_expired(&mut self) -> Self::Detached {
        (self.temp.clone(), self.writer.take())
    }
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

/// Result of [`ExportSessionManager::begin_backend_sourced`]: the session id
/// plus the backend-computed frame total the finish will enforce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendExportBegin {
    pub export_id: String,
    pub expected_frames: usize,
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
            table: StreamingSessionTable::new(
                MAX_ACTIVE_EXPORTS,
                EXPORT_SESSION_TTL,
                StreamingSessionNaming {
                    id_field: "exportId",
                    noun: "export",
                    unknown_message: "unknown or finished export session",
                },
            ),
            active_temps: Mutex::new(HashSet::new()),
            active_targets: Arc::new(StdMutex::new(HashSet::new())),
        }
    }
}

impl ExportSessionManager {
    pub async fn begin(&self, format: ExportFormat, target: PathBuf) -> Result<String, AppError> {
        self.begin_inner(format, target, None, false).await
    }

    /// Start a frontend export whose confirmed totals must match exactly at
    /// finish. Keeping the expectations in the backend session prevents a
    /// mutable renderer source from replacing a complete-but-different file.
    pub async fn begin_with_expected_totals(
        &self,
        format: ExportFormat,
        target: PathBuf,
        expected_frames: usize,
        expected_raw_bytes: usize,
    ) -> Result<String, AppError> {
        validate_expected_totals(expected_frames, expected_raw_bytes)?;
        self.begin_inner(
            format,
            target,
            Some((expected_frames, expected_raw_bytes)),
            false,
        )
        .await
    }

    /// Start a backend-sourced export: the confirmed totals are read from the
    /// durable source (never trusted from the renderer), then the manager
    /// pages the frames in itself through the internal append path — no IPC
    /// per batch. When this returns, every source frame below
    /// `query.to_seq_exclusive` is already written to the temp file and the
    /// caller only owes `finish` (or `abort`).
    pub async fn begin_backend_sourced(
        &self,
        format: ExportFormat,
        target: PathBuf,
        source: std::sync::Arc<dyn WorkspaceFrameSource>,
        query: WorkspaceFrameQuery,
    ) -> Result<BackendExportBegin, AppError> {
        validate_source_query(&query)?;
        let totals = run_source_task(Arc::clone(&source), query.clone(), move |source, query| {
            source.expected_totals(&query)
        })
        .await?;
        validate_expected_totals(totals.frames, totals.raw_bytes)?;
        let id = self
            .begin_inner(
                format,
                target,
                Some((totals.frames, totals.raw_bytes)),
                true,
            )
            .await?;
        if let Err(error) = self.append_source_pages(&id, source, query).await {
            // A failed page loop is terminal: release the target and capacity
            // reservations and remove the backend-owned temp before returning.
            self.abort(&id).await.ok();
            return Err(error);
        }
        Ok(BackendExportBegin {
            export_id: id,
            expected_frames: totals.frames,
        })
    }

    /// Page the durable source in bounded slices and append each through the
    /// internal path so the per-session frame/byte accounting, the finish-time
    /// totals enforcement, and abort semantics all stay identical to the
    /// renderer-streamed flow.
    async fn append_source_pages(
        &self,
        id: &str,
        source: std::sync::Arc<dyn WorkspaceFrameSource>,
        query: WorkspaceFrameQuery,
    ) -> Result<(), AppError> {
        let mut from_seq = 0_u64;
        loop {
            let page = run_source_task(Arc::clone(&source), query.clone(), move |source, query| {
                source.read_page(&query, from_seq)
            })
            .await?;
            if page.frames.is_empty() {
                return Ok(());
            }
            let batch_bytes =
                validate_frame_batch(&page.frames, MAX_BATCH_FRAMES, MAX_BATCH_BYTES)?;
            let shared = self.get(id).await?;
            let mut session = shared.lock().await;
            Self::append_locked(&mut session, &page.frames, batch_bytes).await?;
            match page.next_seq {
                None => return Ok(()),
                Some(next_seq) if next_seq >= query.to_seq_exclusive => return Ok(()),
                Some(next_seq) if next_seq > from_seq => from_seq = next_seq,
                // A cursor that does not advance would loop forever; treat it
                // as a broken source instead of silently truncating.
                Some(_) => {
                    return Err(validation_error(
                        "source",
                        "workspace frame source cursor did not advance",
                    ));
                }
            }
        }
    }

    async fn begin_inner(
        &self,
        format: ExportFormat,
        target: PathBuf,
        expected_totals: Option<(usize, usize)>,
        backend_sourced: bool,
    ) -> Result<String, AppError> {
        self.cleanup_expired().await;
        // Reserve capacity before touching the filesystem. A semaphore makes
        // concurrent begin calls part of the same admission decision, so a
        // burst cannot temporarily create more than MAX_ACTIVE_EXPORTS temp
        // files while each caller observes a stale map length.
        let slot = self.table.acquire_slot()?;
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

        let id = self.table.reserve_new_id().await?;
        let (temp, file) = match create_temp_file(&target, format, &id).await {
            Ok(value) => value,
            Err(error) => {
                self.table.release_reserved(&id).await;
                return Err(error);
            }
        };
        let writer = BufWriter::with_capacity(64 * 1024, file);
        let mut header = Vec::new();
        formatter::append_header(&mut header, format);
        let writer = match initialize_writer(writer, &header, &temp, format, &target).await {
            Ok(writer) => writer,
            Err(error) => {
                self.table.release_reserved(&id).await;
                return Err(error);
            }
        };

        let session = Arc::new(Mutex::new(ExportSession {
            format,
            target,
            temp: temp.clone(),
            writer: Some(writer),
            expected_frames: expected_totals.map(|totals| totals.0),
            expected_raw_bytes: expected_totals.map(|totals| totals.1),
            frame_count: 0,
            raw_bytes: 0,
            output_bytes: header.len(),
            started_at: Instant::now(),
            last_activity: Instant::now(),
            terminal: false,
            backend_sourced,
            _slot: slot,
            _target: target_reservation,
        }));
        self.active_temps.lock().await.insert(temp);
        let replaced = self.table.insert(id.clone(), Arc::clone(&session)).await;
        self.table.release_reserved(&id).await;
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
        if session.backend_sourced {
            // The renderer must never feed a backend-sourced session: the
            // backend already wrote the confirmed totals below the seq
            // ceiling, and a mixed-source file would silently diverge.
            return Err(validation_error(
                "exportId",
                "append is only allowed for renderer-sourced export sessions",
            ));
        }
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
        let (format, target, temp, mut writer, stats, totals_error) = {
            let mut session = shared.lock().await;
            if session.terminal || session.writer.is_none() {
                return Err(validation_error(
                    "exportId",
                    "unknown or finished export session",
                ));
            }
            if session.frame_count == 0 && session.expected_frames.is_none() {
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
            let totals_error = if session
                .expected_frames
                .is_some_and(|expected| expected != session.frame_count)
            {
                Some(validation_error(
                    "expectedFrames",
                    "appended frame count does not match the confirmed export",
                ))
            } else if session
                .expected_raw_bytes
                .is_some_and(|expected| expected != session.raw_bytes)
            {
                Some(validation_error(
                    "expectedRawBytes",
                    "appended raw byte count does not match the confirmed export",
                ))
            } else {
                None
            };
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
                totals_error,
            )
        };

        // A mismatch is terminal and is resolved before flush/sync/replace.
        // Drop the writer first (required by Windows), remove the backend-owned
        // temp, and release all reservations while leaving any old target byte
        // for byte unchanged.
        if let Some(error) = totals_error {
            self.remove_current(id, &shared).await;
            drop(writer);
            remove_if_exists(&temp).await;
            self.active_temps.lock().await.remove(&temp);
            return Err(error);
        }

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
        self.table.remove_current(id, shared).await
    }

    async fn get(&self, id: &str) -> Result<SharedExportSession, AppError> {
        self.table.get(id).await
    }

    async fn cleanup_expired(&self) -> usize {
        // A session holding its mutex is actively writing/flushing. Never
        // make a new export wait behind that disk I/O merely to perform a
        // best-effort expiry sweep; it can be reconsidered next begin.
        let (count, expired) = self.table.sweep_expired().await;
        for (temp, writer) in expired {
            drop(writer);
            remove_if_exists(&temp).await;
            self.active_temps.lock().await.remove(&temp);
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
    validate_hex_session_id(id, "exportId", "export")
}

/// Shared admission bounds for confirmed totals (renderer-confirmed and
/// backend-computed alike).
fn validate_expected_totals(
    expected_frames: usize,
    expected_raw_bytes: usize,
) -> Result<(), AppError> {
    if expected_frames == 0 {
        return Err(validation_error(
            "expectedFrames",
            "expected frame count must be greater than zero",
        ));
    }
    if expected_frames > MAX_EXPORT_FRAMES {
        return Err(limit_error(
            "expectedFrames",
            MAX_EXPORT_FRAMES,
            expected_frames,
        ));
    }
    if expected_raw_bytes > MAX_EXPORT_BYTES {
        return Err(limit_error(
            "expectedRawBytes",
            MAX_EXPORT_BYTES,
            expected_raw_bytes,
        ));
    }
    Ok(())
}

fn validate_source_query(query: &WorkspaceFrameQuery) -> Result<(), AppError> {
    for (field, value) in [
        ("workspaceId", &query.workspace_id),
        ("sessionId", &query.session_id),
    ] {
        if value.is_empty() || value.len() > MAX_SOURCE_ID_BYTES {
            return Err(validation_error(
                field,
                "backend export source identifiers must be 1-128 bytes",
            ));
        }
    }
    if query.to_seq_exclusive == 0 {
        return Err(validation_error(
            "source",
            "toSeqExclusive must be greater than zero",
        ));
    }
    Ok(())
}

/// Run one blocking source read on the blocking pool (SQLite reads must stay
/// off the async runtime workers), mapping a task panic into a retryable
/// busy error.
async fn run_source_task<T, F>(
    source: Arc<dyn WorkspaceFrameSource>,
    query: WorkspaceFrameQuery,
    task: F,
) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(Arc<dyn WorkspaceFrameSource>, WorkspaceFrameQuery) -> Result<T, AppError>
        + Send
        + 'static,
{
    tokio::task::spawn_blocking(move || task(source, query))
        .await
        .map_err(|error| AppError::Busy {
            message: format!("workspace frame source task failed: {error}"),
        })?
}

fn temp_path(target: &Path, id: &str) -> Option<PathBuf> {
    let parent = target.parent()?;
    Some(parent.join(format!(".bbcom.{id}.part")))
}

fn classify_artifact(file_name: &str) -> Option<&str> {
    let id = file_name.strip_prefix(".bbcom.")?.strip_suffix(".part")?;
    (id.len() == 32 && is_lower_hex(id, 32)).then_some(id)
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
    use crate::commands::streaming_sessions::random_session_id_hex;
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
        manager.get(id).await.unwrap()
    }

    fn frame(id: &str, data: &[u8]) -> DataFrame {
        DataFrame {
            id: id.to_string(),
            direction: Direction::Rx,
            timestamp: 1.0,
            data: data.to_vec(),
            data_b64: None,
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
    async fn expected_total_mismatches_remove_session_and_preserve_existing_target() {
        let cases = [
            (
                "fewer-frames",
                2,
                1,
                vec![frame("1", &[0x41])],
                "expectedFrames",
            ),
            (
                "more-frames",
                1,
                2,
                vec![frame("1", &[0x41]), frame("2", &[0x42])],
                "expectedFrames",
            ),
            (
                "raw-bytes",
                1,
                2,
                vec![frame("1", &[0x41])],
                "expectedRawBytes",
            ),
        ];

        for (name, expected_frames, expected_raw_bytes, frames, expected_field) in cases {
            let (directory, target) = isolated_target(&format!("{name}.csv"));
            std::fs::write(&target, b"original target").unwrap();
            let manager = ExportSessionManager::default();
            let id = manager
                .begin_with_expected_totals(
                    ExportFormat::Csv,
                    target.clone(),
                    expected_frames,
                    expected_raw_bytes,
                )
                .await
                .unwrap();
            let shared = shared_session(&manager, &id).await;
            let temp = shared.lock().await.temp.clone();
            drop(shared);
            manager.append(&id, &frames).await.unwrap();

            let error = manager.finish(&id).await.unwrap_err();
            assert!(
                matches!(&error, AppError::ValidationError { field, .. } if field == expected_field),
                "unexpected {name} error: {error:?}"
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"original target");
            assert!(!temp.exists(), "{name} temp must be removed");
            assert!(manager.table.is_empty().await);
            assert!(manager.active_temps.lock().await.is_empty());
            assert!(
                manager
                    .active_targets
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_empty()
            );

            let finished_error = manager.finish(&id).await.unwrap_err();
            assert!(matches!(
                finished_error,
                AppError::ValidationError { ref field, .. } if field == "exportId"
            ));
            std::fs::remove_dir_all(directory).unwrap();
        }
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
            .table
            .snapshot()
            .await
            .into_iter()
            .map(|(_, shared)| shared)
            .collect::<Vec<_>>();
        for shared in sessions {
            shared.lock().await.last_activity = expired_at;
        }

        let replacement_id = manager
            .begin(ExportFormat::Jsonl, replacement_target)
            .await
            .unwrap();

        assert!(temp_files.iter().all(|path| !path.exists()));
        assert_eq!(manager.table.len().await, 1);
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

        let map_guard = manager.table.lock_map().await;
        let blocked_manager = Arc::clone(&manager);
        let blocked_id = first_id.clone();
        let blocked = tokio::spawn(async move {
            blocked_manager
                .append(&blocked_id, &[frame("blocked", &[1])])
                .await
        });
        tokio::task::yield_now().await;
        drop(map_guard);

        let reacquired = timeout(Duration::from_secs(1), manager.table.lock_map())
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
        assert_eq!(manager.table.len().await, 1);
        assert_eq!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len(),
            1
        );
        assert_eq!(manager.table.available_permits(), MAX_ACTIVE_EXPORTS - 1);

        manager.abort(&active_id).await.unwrap();
        assert_eq!(manager.table.available_permits(), MAX_ACTIVE_EXPORTS);
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
        assert_eq!(manager.table.len().await, MAX_ACTIVE_EXPORTS);
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

        assert_eq!(manager.table.available_permits(), MAX_ACTIVE_EXPORTS);
        assert!(manager.table.is_empty().await);
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
        let first = random_session_id_hex("export").unwrap();
        let second = random_session_id_hex("export").unwrap();
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

    // ---- backend-sourced sessions -----------------------------------------

    const SOURCE_WORKSPACE_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
    const SOURCE_SESSION_ID: &str = "session-1";

    fn source_query(to_seq_exclusive: u64) -> WorkspaceFrameQuery {
        WorkspaceFrameQuery {
            workspace_id: SOURCE_WORKSPACE_ID.to_owned(),
            session_id: SOURCE_SESSION_ID.to_owned(),
            to_seq_exclusive,
        }
    }

    /// In-memory fake durable source: dense 0-based seqs, optional per-page
    /// failure injection, optional totals override.
    struct FakeSource {
        frames: Vec<DataFrame>,
        totals_override: Option<WorkspaceFrameTotals>,
        fail_page_from: Option<usize>,
        pages_read: std::sync::atomic::AtomicUsize,
    }

    impl FakeSource {
        fn new(frames: Vec<DataFrame>) -> Arc<Self> {
            Arc::new(Self {
                frames,
                totals_override: None,
                fail_page_from: None,
                pages_read: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        fn pages_read(&self) -> usize {
            self.pages_read.load(Ordering::SeqCst)
        }

        fn frames_below(&self, ceiling: u64) -> &[DataFrame] {
            let limit = usize::try_from(ceiling).unwrap_or(0);
            &self.frames[..limit.min(self.frames.len())]
        }
    }

    impl WorkspaceFrameSource for FakeSource {
        fn expected_totals(
            &self,
            query: &WorkspaceFrameQuery,
        ) -> Result<WorkspaceFrameTotals, AppError> {
            let frames = self.frames_below(query.to_seq_exclusive);
            Ok(self.totals_override.unwrap_or(WorkspaceFrameTotals {
                frames: frames.len(),
                raw_bytes: frames.iter().map(|frame| frame.data.len()).sum(),
            }))
        }

        fn read_page(
            &self,
            query: &WorkspaceFrameQuery,
            from_seq: u64,
        ) -> Result<WorkspaceFrameSlice, AppError> {
            let page_index = self.pages_read.fetch_add(1, Ordering::SeqCst);
            if self.fail_page_from.is_some_and(|from| page_index >= from) {
                return Err(AppError::Busy {
                    message: "injected source failure".to_owned(),
                });
            }
            let frames = self.frames_below(query.to_seq_exclusive);
            let start = usize::try_from(from_seq).unwrap_or(usize::MAX);
            if start >= frames.len() {
                return Ok(WorkspaceFrameSlice::default());
            }
            let end = (start + SOURCE_PAGE_FRAMES).min(frames.len());
            Ok(WorkspaceFrameSlice {
                frames: frames[start..end].to_vec(),
                next_seq: (end < frames.len()).then(|| u64::try_from(end).unwrap()),
            })
        }
    }

    fn source_frame(id: &str, data: &[u8], direction: Direction) -> DataFrame {
        DataFrame {
            id: id.to_string(),
            direction,
            timestamp: 1.0,
            data: data.to_vec(),
            data_b64: None,
        }
    }

    fn source_frames(count: usize) -> Vec<DataFrame> {
        (0..count)
            .map(|index| {
                let data = vec![(index % 7) as u8; (index % 7) + 1];
                source_frame(
                    &format!("s{index}"),
                    &data,
                    if index % 2 == 0 {
                        Direction::Rx
                    } else {
                        Direction::Tx
                    },
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn backend_sourced_begin_pages_the_source_and_finishes_atomically() {
        let (directory, target) = isolated_target("backend.jsonl");
        std::fs::write(&target, b"previous").unwrap();
        let manager = ExportSessionManager::default();
        // 300 frames force two pages (page cap is SOURCE_PAGE_FRAMES).
        let frames = source_frames(SOURCE_PAGE_FRAMES + 44);
        let raw_bytes: usize = frames.iter().map(|frame| frame.data.len()).sum();
        let source = FakeSource::new(frames);
        let pages_before = source.pages_read();
        let begin = manager
            .begin_backend_sourced(
                ExportFormat::Jsonl,
                target.clone(),
                source.clone(),
                source_query(u64::try_from(SOURCE_PAGE_FRAMES + 44).unwrap()),
            )
            .await
            .unwrap();
        assert_eq!(begin.expected_frames, SOURCE_PAGE_FRAMES + 44);
        assert_eq!(
            source.pages_read() - pages_before,
            2,
            "multi-page sources are paged, not slurped"
        );
        let stats = manager.finish(&begin.export_id).await.unwrap();
        assert_eq!(stats.frames, SOURCE_PAGE_FRAMES + 44);
        assert_eq!(stats.raw_bytes, raw_bytes);
        let lines = std::fs::read_to_string(&target).unwrap().lines().count();
        assert_eq!(lines, SOURCE_PAGE_FRAMES + 44);
        assert!(
            !std::fs::read_to_string(&target)
                .unwrap()
                .contains("previous")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn backend_sourced_totals_enforcement_is_terminal_and_preserves_the_target() {
        let (directory, target) = isolated_target("diverged.csv");
        std::fs::write(&target, b"original target").unwrap();
        let manager = ExportSessionManager::default();
        // The source claims 4 frames in its totals but only holds 3: the
        // finish-time totals enforcement must fail the export, remove the
        // temp, and leave the existing target byte-for-byte unchanged.
        let frames = source_frames(3);
        let raw_bytes: usize = frames.iter().map(|frame| frame.data.len()).sum();
        let mut source = FakeSource::new(frames);
        Arc::get_mut(&mut source).unwrap().totals_override = Some(WorkspaceFrameTotals {
            frames: 4,
            raw_bytes,
        });
        let source: Arc<dyn WorkspaceFrameSource> = source;
        let begin = manager
            .begin_backend_sourced(ExportFormat::Csv, target.clone(), source, source_query(3))
            .await
            .unwrap();
        let error = manager.finish(&begin.export_id).await.unwrap_err();
        assert!(
            matches!(&error, AppError::ValidationError { field, .. } if field == "expectedFrames"),
            "unexpected totals error: {error:?}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"original target");
        assert_eq!(manager.table.available_permits(), MAX_ACTIVE_EXPORTS);
        assert!(manager.table.is_empty().await);
        assert!(manager.active_temps.lock().await.is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn renderer_appends_to_a_backend_sourced_session_are_rejected() {
        let (directory, target) = isolated_target("locked.jsonl");
        let manager = ExportSessionManager::default();
        let source: Arc<dyn WorkspaceFrameSource> = FakeSource::new(source_frames(2));
        let begin = manager
            .begin_backend_sourced(ExportFormat::Jsonl, target.clone(), source, source_query(2))
            .await
            .unwrap();
        let error = manager
            .append(&begin.export_id, &[frame("renderer", &[0x41])])
            .await
            .unwrap_err();
        assert!(
            matches!(&error, AppError::ValidationError { field, .. } if field == "exportId"),
            "unexpected append error: {error:?}"
        );
        // The backend-written content survives the rejected append.
        let stats = manager.finish(&begin.export_id).await.unwrap();
        assert_eq!(stats.frames, 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn backend_sourced_page_failure_aborts_and_releases_reservations() {
        let (directory, target) = isolated_target("failing.jsonl");
        let manager = ExportSessionManager::default();
        let mut source = FakeSource::new(source_frames(SOURCE_PAGE_FRAMES * 2));
        Arc::get_mut(&mut source).unwrap().fail_page_from = Some(1);
        let source: Arc<dyn WorkspaceFrameSource> = source;
        let error = manager
            .begin_backend_sourced(
                ExportFormat::Jsonl,
                target.clone(),
                source,
                source_query(u64::try_from(SOURCE_PAGE_FRAMES * 2).unwrap()),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error, AppError::Busy { .. }),
            "unexpected {error:?}"
        );
        assert!(!target.exists());
        assert_eq!(manager.table.available_permits(), MAX_ACTIVE_EXPORTS);
        assert!(manager.table.is_empty().await);
        assert!(manager.active_temps.lock().await.is_empty());
        assert!(
            manager
                .active_targets
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
        );
        let residue: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .collect();
        assert!(
            residue.is_empty(),
            "temp residue must be removed: {residue:?}"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn backend_sourced_export_matches_renderer_streamed_output_byte_for_byte() {
        use bbcom_contracts::{
            ApplyWorkspaceBatchRequest, WorkspaceAppendFramesPayload, WorkspaceFramePayload,
            WorkspaceMutation, WorkspaceSessionKind, WorkspaceSessionUpsertPayload,
        };
        use bbcom_workspace::{CreateWorkspaceRequest, WorkspaceService};

        const TOTAL_FRAMES: usize = 700; // spans several bounded pages
        const CEILING: u64 = 650; // frames 650..699 stay persisted but excluded
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let workspace_path = root.join(format!("{SOURCE_WORKSPACE_ID}.bbcom"));
        let mut service = WorkspaceService::create(
            &workspace_path,
            CreateWorkspaceRequest {
                workspace_id: SOURCE_WORKSPACE_ID.to_owned(),
                name: "Export parity".to_owned(),
                created_at_ms: 1_747_000_000_000,
            },
        )
        .unwrap();
        let mut revision = service
            .apply_batch(ApplyWorkspaceBatchRequest {
                workspace_id: SOURCE_WORKSPACE_ID.to_owned(),
                client_batch_id: "parity-bootstrap".to_owned(),
                base_revision: 0,
                mutations: vec![WorkspaceMutation::UpsertSession {
                    sequence: 0,
                    session_id: SOURCE_SESSION_ID.to_owned(),
                    payload: WorkspaceSessionUpsertPayload {
                        name: "Parity session".to_owned(),
                        sort_order: 0,
                        kind: WorkspaceSessionKind::Live,
                        last_port_hint: None,
                        port_config: serde_json::json!({}),
                        document: serde_json::json!({}),
                    },
                }],
            })
            .unwrap()
            .committed_revision;

        let payloads: Vec<WorkspaceFramePayload> = (0..TOTAL_FRAMES)
            .map(|index| WorkspaceFramePayload {
                id: format!("parity-{index}"),
                direction: if index % 3 == 0 {
                    bbcom_contracts::Direction::Tx
                } else {
                    bbcom_contracts::Direction::Rx
                },
                timestamp_ms: 1_747_000_000_000 + index as u64,
                data: vec![(index % 251) as u8; (index % 11) + 1],
                data_b64: None,
                tx_status: if index % 3 == 0 {
                    Some("complete".to_owned())
                } else {
                    None
                },
                requested_bytes: None,
                omitted_bytes: None,
            })
            .collect();
        // Seed through the public mutation API in capture-sized batches
        // (MAX_WORKSPACE_FRAMES_PER_BATCH is 256, like the save queue).
        let mut start_seq = 0_u64;
        let mut seed_batch = 0_u64;
        for chunk in payloads.chunks(256) {
            seed_batch += 1;
            let batch_start_seq = start_seq;
            start_seq += chunk.len() as u64;
            revision = service
                .apply_batch(ApplyWorkspaceBatchRequest {
                    workspace_id: SOURCE_WORKSPACE_ID.to_owned(),
                    client_batch_id: format!("parity-frames-{seed_batch}"),
                    base_revision: revision,
                    mutations: vec![WorkspaceMutation::AppendFrames {
                        sequence: 0,
                        session_id: SOURCE_SESSION_ID.to_owned(),
                        payload: WorkspaceAppendFramesPayload {
                            start_seq: batch_start_seq,
                            frames: chunk.to_vec(),
                        },
                    }],
                })
                .unwrap()
                .committed_revision;
        }
        assert!(revision > 0);

        // Renderer path: hydrate the same frames back and stream them through
        // the public begin/append/finish flow.
        let mut hydrated = Vec::new();
        let mut cursor = 0_u64;
        loop {
            let page = service
                .hydrate_frames(SOURCE_SESSION_ID, cursor, 128)
                .unwrap();
            if page.frames.is_empty() {
                break;
            }
            for frame in page.frames {
                if frame.seq >= CEILING {
                    break;
                }
                hydrated.push(DataFrame {
                    id: frame.id,
                    direction: match frame.direction.as_str() {
                        "TX" => Direction::Tx,
                        _ => Direction::Rx,
                    },
                    timestamp: frame.timestamp_ms as f64,
                    data: frame.data,
                    data_b64: None,
                });
            }
            let Some(next) = page.next_seq else { break };
            if next >= CEILING {
                break;
            }
            cursor = next;
        }
        assert_eq!(hydrated.len(), CEILING as usize);

        let manager = ExportSessionManager::default();
        let renderer_target = root.join("renderer.jsonl");
        let renderer_id = manager
            .begin(ExportFormat::Jsonl, renderer_target.clone())
            .await
            .unwrap();
        for batch in hydrated.chunks(64) {
            manager.append(&renderer_id, batch).await.unwrap();
        }
        manager.finish(&renderer_id).await.unwrap();

        // Backend path: the real managed-library adapter over the same file.
        let adapter =
            crate::commands::export::ManagedWorkspaceFrameSource::open(&root, SOURCE_WORKSPACE_ID)
                .unwrap();
        let backend_target = root.join("backend.jsonl");
        let begin = manager
            .begin_backend_sourced(
                ExportFormat::Jsonl,
                backend_target.clone(),
                std::sync::Arc::new(adapter),
                source_query(CEILING),
            )
            .await
            .unwrap();
        assert_eq!(begin.expected_frames, CEILING as usize);
        manager.finish(&begin.export_id).await.unwrap();

        let renderer_bytes = std::fs::read(&renderer_target).unwrap();
        let backend_bytes = std::fs::read(&backend_target).unwrap();
        assert_eq!(
            renderer_bytes, backend_bytes,
            "backend-sourced export must be byte-identical to the renderer-streamed export"
        );
        let line_count = backend_bytes.iter().filter(|byte| **byte == b'\n').count();
        assert_eq!(line_count, CEILING as usize);
        assert!(
            !String::from_utf8_lossy(&backend_bytes).contains("parity-650"),
            "frames at/above the seq ceiling are excluded"
        );
    }
}
