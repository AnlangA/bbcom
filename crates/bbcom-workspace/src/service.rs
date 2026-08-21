use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use bbcom_contracts::{
    ApplyWorkspaceBatchRequest, ApplyWorkspaceBatchResponse, MAX_WORKSPACE_BATCH_BYTES,
    MAX_WORKSPACE_DATABASE_BYTES, MAX_WORKSPACE_FRAME_BYTES, MAX_WORKSPACE_FRAMES_PER_BATCH,
    MAX_WORKSPACE_MUTATIONS_PER_BATCH, WorkspaceAiMessage, WorkspaceAiRole, WorkspaceConfigRow,
    WorkspaceDocumentHeader, WorkspaceMacro, WorkspaceMacroStep, WorkspaceMutation,
    WorkspacePortHint, WorkspaceQuickCommand, WorkspaceSaveHealth, WorkspaceSendHistoryEntry,
    WorkspaceSessionCollectionsPayload, WorkspaceWaveformChannel, WorkspaceWaveformSample,
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::error::map_database_error;
use crate::model::{
    CreateWorkspaceRequest, WorkspaceFrame, WorkspaceFramePage, WorkspaceIntegrityReport,
    WorkspaceSessionPage, WorkspaceSessionSnapshot, read_header, reject_forbidden_keys,
    validate_identifier,
};
use crate::mutation::{apply_mutations, validate_mutation_payload_limits};
use crate::schema::{
    CREATE_FLAGS, READ_ONLY_FLAGS, READ_WRITE_FLAGS, configure_connection, create_schema,
    migrate_schema, validate_header,
};
use crate::{Result, WorkspaceError};

const MAX_HYDRATE_PAGE_FRAMES: usize = 2048;
const MAX_HYDRATE_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_HYDRATE_PAGE_AI_MESSAGES: usize = 256;
const MAX_HYDRATE_PAGE_WAVEFORM_SAMPLES: usize = 4_096;
const MAX_WAVEFORM_SAMPLE_GROUPS: usize = 600;
// Idempotency only needs to cover response loss/retry around recent commits.
// Keeping a fixed row window prevents this internal ledger from growing
// without bound; a retry older than the window still fails safely because its
// stale base revision cannot be committed again. Pruning only on every 64th
// revision keeps the DELETE statement off the per-batch hot path.
const COMMITTED_BATCH_RETENTION_ROWS: i64 = 1024;
const COMMITTED_BATCH_PRUNE_INTERVAL: i64 = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceAiMessagePage {
    pub messages: Vec<WorkspaceAiMessage>,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceWaveformPage {
    pub channels: Vec<WorkspaceWaveformChannel>,
    pub samples: Vec<WorkspaceWaveformSample>,
    pub next_offset: Option<usize>,
}

#[derive(Debug)]
pub struct WorkspaceService {
    path: PathBuf,
    connection: Connection,
    read_only: bool,
    save_health: WorkspaceSaveHealth,
}

impl WorkspaceService {
    pub fn create(path: impl AsRef<Path>, request: CreateWorkspaceRequest) -> Result<Self> {
        request.validate()?;
        let path = path.as_ref().to_path_buf();
        if path.exists() {
            return Err(WorkspaceError::AlreadyExists);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let reservation = options.open(&path)?;
        drop(reservation);

        let result = (|| {
            let connection =
                Connection::open_with_flags(&path, CREATE_FLAGS).map_err(map_database_error)?;
            configure_connection(&connection, true)?;
            create_schema(&connection)?;
            crate::model::insert_workspace_meta(&connection, &request)?;
            validate_database_size(&path)?;
            Ok(Self {
                path: path.clone(),
                connection,
                read_only: false,
                save_health: WorkspaceSaveHealth::Clean,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(sidecar_path(&path, "-wal"));
            let _ = fs::remove_file(sidecar_path(&path, "-shm"));
        }
        result
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_mode(path, false)
    }

    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_mode(path, true)
    }

    fn open_with_mode(path: impl AsRef<Path>, read_only: bool) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.is_file() {
            return Err(WorkspaceError::NotFound);
        }
        validate_database_size(&path)?;
        let flags = if read_only {
            READ_ONLY_FLAGS
        } else {
            READ_WRITE_FLAGS
        };
        let connection = Connection::open_with_flags(&path, flags).map_err(map_database_error)?;
        configure_connection(&connection, !read_only)?;
        migrate_schema(&connection, !read_only)?;
        validate_header(&connection)?;
        validate_database_size(&path)?;
        read_header(&connection)?;
        Ok(Self {
            path,
            connection,
            read_only,
            save_health: if read_only {
                WorkspaceSaveHealth::ReadOnly
            } else {
                WorkspaceSaveHealth::Clean
            },
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn header(&self) -> Result<WorkspaceDocumentHeader> {
        read_header(&self.connection)
    }

    pub fn summary(&self) -> Result<bbcom_contracts::WorkspaceSummary> {
        let (workspace_id, name, revision, updated_at_ms): (String, String, i64, i64) =
            self.connection.query_row(
                "SELECT workspace_id, name, revision, updated_at_ms
                 FROM workspace_meta WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        Ok(bbcom_contracts::WorkspaceSummary {
            workspace_id,
            name,
            revision: nonnegative_u64(revision, "revision")?,
            updated_at_ms: nonnegative_u64(updated_at_ms, "updated timestamp")? as f64,
            save_health: self.save_health,
        })
    }

    pub fn hydrate_frames(
        &self,
        session_id: &str,
        from_seq: u64,
        requested_limit: usize,
    ) -> Result<WorkspaceFramePage> {
        validate_identifier(session_id, "sessionId")?;
        crate::model::ensure_session_exists(&self.connection, session_id)?;
        if requested_limit == 0 || requested_limit > MAX_HYDRATE_PAGE_FRAMES {
            return Err(WorkspaceError::LimitExceeded {
                field: "pageFrames",
                limit: MAX_HYDRATE_PAGE_FRAMES,
                actual: requested_limit,
            });
        }
        let from_seq = i64::try_from(from_seq)
            .map_err(|_| WorkspaceError::InvalidInput { field: "fromSeq" })?;
        let fetch_limit = i64::try_from(requested_limit + 1).expect("page limit fits i64");
        let mut statement = self.connection.prepare(
            "SELECT seq, id, direction, timestamp_ms, data, tx_status, requested_bytes,
                    omitted_bytes
             FROM frames
             WHERE session_id = ?1 AND seq >= ?2
             ORDER BY seq
             LIMIT ?3",
        )?;
        let rows = statement.query_map(params![session_id, from_seq, fetch_limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })?;

        let mut frames = Vec::with_capacity(requested_limit);
        let mut page_bytes = 0usize;
        let mut next_seq = None;
        for row in rows {
            let (
                sequence,
                id,
                direction,
                timestamp_ms,
                data,
                tx_status,
                requested_bytes,
                omitted_bytes,
            ) = row?;
            let sequence = nonnegative_u64(sequence, "frame sequence")?;
            if frames.len() == requested_limit
                || (!frames.is_empty()
                    && page_bytes.saturating_add(data.len()) > MAX_HYDRATE_PAGE_BYTES)
            {
                next_seq = Some(sequence);
                break;
            }
            page_bytes += data.len();
            frames.push(WorkspaceFrame {
                seq: sequence,
                id,
                direction,
                timestamp_ms: nonnegative_u64(timestamp_ms, "frame timestamp")?,
                data,
                tx_status,
                requested_bytes: optional_nonnegative_u64(requested_bytes, "requested bytes")?,
                omitted_bytes: optional_nonnegative_u64(omitted_bytes, "omitted bytes")?,
            });
        }
        Ok(WorkspaceFramePage {
            session_id: session_id.to_owned(),
            frames,
            next_seq,
        })
    }

    pub fn hydrate_sessions(
        &self,
        offset: usize,
        requested_limit: usize,
    ) -> Result<WorkspaceSessionPage> {
        if requested_limit == 0 || requested_limit > 64 {
            return Err(WorkspaceError::LimitExceeded {
                field: "pageSessions",
                limit: 64,
                actual: requested_limit,
            });
        }
        let mut statement = self.connection.prepare(
            "SELECT s.id, s.sort_order, s.kind, s.name, s.last_port_hint_json,
                    s.port_config_json, s.document_json, p.display_json, p.send_json,
                    p.parser_json, p.feature_state_json, m.config_json
             FROM sessions s
             JOIN session_preferences p ON p.session_id = s.id
             JOIN modbus_config m ON m.session_id = s.id
             WHERE s.undo_pending = 0
             ORDER BY s.sort_order, s.id
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(
            params![
                i64::try_from(requested_limit + 1).expect("session page limit fits i64"),
                i64::try_from(offset)
                    .map_err(|_| WorkspaceError::InvalidInput { field: "offset" })?,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )?;
        let mut sessions = Vec::with_capacity(requested_limit);
        let mut has_more = false;
        for row in rows {
            if sessions.len() == requested_limit {
                has_more = true;
                break;
            }
            let (
                id,
                sort_order,
                kind,
                name,
                last_port_hint,
                port_config,
                document,
                display,
                send,
                parser,
                feature,
                modbus,
            ) = row?;
            sessions.push(WorkspaceSessionSnapshot {
                id,
                sort_order: u32::try_from(sort_order).map_err(|_| WorkspaceError::Corrupt {
                    reason: "session_sort_order",
                })?,
                kind,
                name,
                needs_rebind: true,
                last_port_hint: last_port_hint
                    .as_deref()
                    .map(parse_port_hint_json)
                    .transpose()?,
                port_config: parse_document_json(&port_config)?,
                document: parse_document_json(&document)?,
                display_preferences: parse_document_json(&display)?,
                send_preferences: parse_document_json(&send)?,
                parser_state: parse_document_json(&parser)?,
                feature_state: parse_document_json(&feature)?,
                modbus_config: parse_document_json(&modbus)?,
            });
        }
        Ok(WorkspaceSessionPage {
            next_offset: has_more.then_some(offset.saturating_add(requested_limit)),
            sessions,
        })
    }

    pub fn hydrate_session_collections(
        &self,
        session_id: &str,
    ) -> Result<WorkspaceSessionCollectionsPayload> {
        validate_identifier(session_id, "sessionId")?;
        crate::model::ensure_session_exists(&self.connection, session_id)?;

        let send_history = query_send_history(&self.connection, session_id)?;
        let quick_commands = query_quick_commands(&self.connection, session_id)?;
        let macros = query_macros(&self.connection, session_id)?;
        let triggers = query_config_rows(&self.connection, "triggers", session_id)?;
        let highlights = query_config_rows(&self.connection, "highlights", session_id)?;
        let modbus_registers = query_config_rows(&self.connection, "modbus_registers", session_id)?;
        Ok(WorkspaceSessionCollectionsPayload {
            send_history,
            quick_commands,
            macros,
            triggers,
            highlights,
            modbus_registers,
        })
    }

    pub fn hydrate_ai_messages(
        &self,
        session_id: &str,
        offset: usize,
        requested_limit: usize,
    ) -> Result<WorkspaceAiMessagePage> {
        validate_identifier(session_id, "sessionId")?;
        crate::model::ensure_session_exists(&self.connection, session_id)?;
        if requested_limit == 0 || requested_limit > MAX_HYDRATE_PAGE_AI_MESSAGES {
            return Err(WorkspaceError::LimitExceeded {
                field: "pageAiMessages",
                limit: MAX_HYDRATE_PAGE_AI_MESSAGES,
                actual: requested_limit,
            });
        }
        let mut statement = self.connection.prepare(
            "SELECT id, role, content, timestamp_ms
             FROM ai_messages WHERE session_id = ?1
             ORDER BY position LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                usize_to_i64(requested_limit + 1, "limit")?,
                usize_to_i64(offset, "offset")?
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?;
        let mut messages = Vec::with_capacity(requested_limit);
        let mut page_bytes = 0usize;
        let mut has_more = false;
        for row in rows {
            let (id, role, content, timestamp_ms) = row?;
            if messages.len() == requested_limit
                || page_bytes.saturating_add(content.len()) > MAX_HYDRATE_PAGE_BYTES
            {
                has_more = true;
                break;
            }
            page_bytes += content.len();
            messages.push(WorkspaceAiMessage {
                id,
                role: match role.as_str() {
                    "user" => WorkspaceAiRole::User,
                    "assistant" => WorkspaceAiRole::Assistant,
                    _ => return Err(WorkspaceError::Corrupt { reason: "ai_role" }),
                },
                content,
                timestamp_ms: nonnegative_u64(timestamp_ms, "ai timestamp")?,
            });
        }
        Ok(WorkspaceAiMessagePage {
            next_offset: has_more.then_some(offset.saturating_add(messages.len())),
            messages,
        })
    }

    pub fn hydrate_waveform(
        &self,
        session_id: &str,
        offset: usize,
        requested_limit: usize,
    ) -> Result<WorkspaceWaveformPage> {
        validate_identifier(session_id, "sessionId")?;
        crate::model::ensure_session_exists(&self.connection, session_id)?;
        if requested_limit == 0 || requested_limit > MAX_HYDRATE_PAGE_WAVEFORM_SAMPLES {
            return Err(WorkspaceError::LimitExceeded {
                field: "pageWaveformSamples",
                limit: MAX_HYDRATE_PAGE_WAVEFORM_SAMPLES,
                actual: requested_limit,
            });
        }
        let channels = query_waveform_channels(&self.connection, session_id)?;
        let mut statement = self.connection.prepare(
            "SELECT channel_index, seq, timestamp_ms, value
             FROM waveform_samples
             WHERE session_id = ?1
               AND seq IN (
                 SELECT seq FROM waveform_samples
                 WHERE session_id = ?1
                 GROUP BY seq ORDER BY seq DESC LIMIT ?4
               )
             ORDER BY seq, channel_index LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                usize_to_i64(requested_limit + 1, "limit")?,
                usize_to_i64(offset, "offset")?,
                usize_to_i64(MAX_WAVEFORM_SAMPLE_GROUPS, "waveform groups")?
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )?;
        let mut samples = Vec::with_capacity(requested_limit);
        let mut has_more = false;
        for row in rows {
            if samples.len() == requested_limit {
                has_more = true;
                break;
            }
            let (channel_index, seq, timestamp_ms, value) = row?;
            if !value.is_finite() {
                return Err(WorkspaceError::Corrupt {
                    reason: "waveform_value",
                });
            }
            samples.push(WorkspaceWaveformSample {
                channel_index: waveform_channel_index(channel_index)?,
                seq: nonnegative_u64(seq, "waveform sequence")?,
                timestamp_ms: nonnegative_u64(timestamp_ms, "waveform timestamp")?,
                value,
            });
        }
        Ok(WorkspaceWaveformPage {
            channels,
            next_offset: has_more.then_some(offset.saturating_add(samples.len())),
            samples,
        })
    }

    pub fn apply_batch(
        &mut self,
        request: ApplyWorkspaceBatchRequest,
    ) -> Result<ApplyWorkspaceBatchResponse> {
        if self.read_only {
            return Err(WorkspaceError::ReadOnly);
        }
        validate_batch_envelope(&request)?;
        validate_mutation_payload_limits(&request)?;
        validate_logical_batch_size(&request)?;
        let canonical_request = serde_json::to_vec(&request)?;
        let request_hash: [u8; 32] = Sha256::digest(&canonical_request).into();
        let transaction = self.connection.transaction().map_err(map_database_error)?;

        let current_workspace_id: String = transaction.query_row(
            "SELECT workspace_id FROM workspace_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        if request.workspace_id != current_workspace_id {
            return Err(WorkspaceError::InvalidInput {
                field: "workspaceId",
            });
        }

        let existing: Option<(Vec<u8>, i64)> = transaction
            .query_row(
                "SELECT request_hash, committed_revision FROM committed_batches
                 WHERE client_batch_id = ?1",
                [request.client_batch_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored_hash, committed_revision)) = existing {
            if stored_hash.as_slice() != request_hash {
                return Err(WorkspaceError::BatchIdReuse);
            }
            return Ok(ApplyWorkspaceBatchResponse {
                client_batch_id: request.client_batch_id,
                committed_revision: nonnegative_u64(committed_revision, "batch revision")?,
            });
        }

        let current_revision_i64: i64 = transaction.query_row(
            "SELECT revision FROM workspace_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let current_revision = nonnegative_u64(current_revision_i64, "revision")?;
        if request.base_revision != current_revision {
            return Err(WorkspaceError::RevisionConflict {
                expected: request.base_revision,
                actual: current_revision,
            });
        }
        apply_mutations(&transaction, &request)?;
        let committed_revision = current_revision
            .checked_add(1)
            .ok_or(WorkspaceError::Corrupt { reason: "revision" })?;
        let committed_revision_i64 = i64::try_from(committed_revision)
            .map_err(|_| WorkspaceError::Corrupt { reason: "revision" })?;
        let committed_at_ms = current_time_millis()?;
        transaction.execute(
            "UPDATE workspace_meta SET revision = ?1, updated_at_ms = ?2 WHERE singleton = 1",
            params![committed_revision_i64, committed_at_ms],
        )?;
        transaction.execute(
            "INSERT INTO committed_batches (
               client_batch_id, request_hash, base_revision, committed_revision, mutation_count,
               committed_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                request.client_batch_id,
                request_hash.as_slice(),
                i64::try_from(request.base_revision).map_err(|_| WorkspaceError::InvalidInput {
                    field: "baseRevision"
                })?,
                committed_revision_i64,
                i64::try_from(request.mutations.len()).expect("mutation limit fits i64"),
                committed_at_ms,
            ],
        )?;
        if committed_revision_i64 % COMMITTED_BATCH_PRUNE_INTERVAL == 0 {
            transaction.execute(
                "DELETE FROM committed_batches WHERE rowid NOT IN (
                   SELECT rowid FROM committed_batches ORDER BY rowid DESC LIMIT ?1
                 )",
                params![COMMITTED_BATCH_RETENTION_ROWS],
            )?;
        }

        let projected_pages: i64 =
            transaction.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: i64 = transaction.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let projected_size = projected_pages
            .checked_mul(page_size)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(WorkspaceError::Corrupt {
                reason: "database_size",
            })?;
        if projected_size > MAX_WORKSPACE_DATABASE_BYTES {
            return Err(WorkspaceError::LimitExceeded {
                field: "databaseBytes",
                limit: MAX_WORKSPACE_DATABASE_BYTES,
                actual: projected_size,
            });
        }
        // SQLite may spill dirty pages into WAL before COMMIT. Measuring while
        // the transaction is still rollback-capable keeps the size limit an
        // all-or-nothing operation boundary.
        if let Err(limit_error) = validate_database_size(&self.path) {
            transaction.rollback().map_err(map_database_error)?;
            self.connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .map_err(map_database_error)?;
            return Err(limit_error);
        }
        transaction.commit().map_err(map_database_error)?;
        // COMMIT is authoritative once it succeeds. A transient checkpoint or
        // sidecar-size problem is reported through save health; it must not
        // make the caller retry an already-committed batch under a new ID.
        let checkpoint_ok = self
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .is_ok();
        self.save_health = if checkpoint_ok && validate_database_size(&self.path).is_ok() {
            WorkspaceSaveHealth::Clean
        } else {
            WorkspaceSaveHealth::Degraded
        };
        Ok(ApplyWorkspaceBatchResponse {
            client_batch_id: request.client_batch_id,
            committed_revision,
        })
    }

    pub fn flush(&mut self, target_revision: u64) -> Result<(u64, WorkspaceSaveHealth)> {
        let header = self.header()?;
        if target_revision > header.revision {
            return Err(WorkspaceError::RevisionConflict {
                expected: target_revision,
                actual: header.revision,
            });
        }
        if self.read_only {
            return Ok((header.revision, WorkspaceSaveHealth::ReadOnly));
        }
        let checkpoint_ok = self
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .is_ok();
        self.save_health = if checkpoint_ok && validate_database_size(&self.path).is_ok() {
            WorkspaceSaveHealth::Clean
        } else {
            WorkspaceSaveHealth::Degraded
        };
        Ok((header.revision, self.save_health))
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<()> {
        let destination = destination.as_ref();
        if destination.exists() {
            return Err(WorkspaceError::AlreadyExists);
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        create_private_destination(destination)?;
        let result = (|| {
            self.connection
                .backup(rusqlite::MAIN_DB, destination, None)
                .map_err(map_database_error)?;
            // The one-slot renderer undo record is an application recovery
            // affordance, not project content. Never disclose a deleted
            // aggregate in a plaintext or encrypted project copy.
            purge_undo_slot_from_copy(destination)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(destination)?
                .sync_all()?;
            validate_database_size(destination)?;
            let backup = Self::open_read_only(destination)?;
            if !backup.integrity_check()?.ok {
                return Err(WorkspaceError::Corrupt {
                    reason: "backup_integrity",
                });
            }
            drop(backup);
            validate_database_size(destination)?;
            Ok(())
        })();
        if result.is_err() {
            remove_database_artifacts_best_effort(destination);
        }
        result
    }

    pub fn integrity_check(&self) -> Result<WorkspaceIntegrityReport> {
        validate_header(&self.connection)?;
        let message: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let foreign_key_violation: Option<String> = self
            .connection
            .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
            .optional()?;
        Ok(WorkspaceIntegrityReport {
            ok: message == "ok" && foreign_key_violation.is_none(),
            message,
        })
    }
}

pub(crate) fn purge_undo_slot_from_copy(path: &Path) -> Result<()> {
    let connection =
        Connection::open_with_flags(path, READ_WRITE_FLAGS).map_err(map_database_error)?;
    let purge: Result<()> = (|| {
        validate_header(&connection)?;
        configure_connection(&connection, true)?;
        connection.execute_batch(
            "PRAGMA secure_delete = ON;
             DELETE FROM sessions WHERE undo_pending = 1;
             PRAGMA wal_checkpoint(TRUNCATE);
             VACUUM;
             PRAGMA wal_checkpoint(TRUNCATE);",
        )?;
        // An exported snapshot is a self-contained transfer artifact. Leaving
        // its header in WAL mode lets a later read-only integrity check create
        // a neighbouring `-shm` file, so finalize the private copy in the
        // single-file rollback journal mode. Managed writable projects switch
        // back to WAL when opened by `WorkspaceService::open`.
        connection.pragma_update(None, "journal_mode", "DELETE")?;
        let journal_mode: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !journal_mode.eq_ignore_ascii_case("delete") {
            return Err(WorkspaceError::Corrupt {
                reason: "backup_journal_mode",
            });
        }
        Ok(())
    })();
    drop(connection);

    // The snapshot is private staging, so a failed purge may be discarded in
    // full. Always remove SQLite sidecars after closing the only connection:
    // a successful final artifact must be self-contained, and a failed one
    // must not leave deleted aggregate bytes in a neighbouring WAL/journal.
    let sidecar_cleanup = remove_database_sidecars(path);
    purge?;
    sidecar_cleanup?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    Ok(())
}

fn remove_database_sidecars(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        match fs::remove_file(sidecar_path(path, suffix)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn remove_database_artifacts_best_effort(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(sidecar_path(path, suffix));
    }
}

fn query_send_history(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<WorkspaceSendHistoryEntry>> {
    let mut statement = connection.prepare(
        "SELECT data, is_hex FROM send_history
         WHERE session_id = ?1 ORDER BY position",
    )?;
    statement
        .query_map([session_id], |row| {
            Ok(WorkspaceSendHistoryEntry {
                data: row.get(0)?,
                is_hex: row.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn query_quick_commands(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<WorkspaceQuickCommand>> {
    let mut statement = connection.prepare(
        "SELECT id, name, data, is_hex, owner_plugin_id FROM quick_commands
         WHERE session_id = ?1 ORDER BY position",
    )?;
    statement
        .query_map([session_id], |row| {
            Ok(WorkspaceQuickCommand {
                id: row.get(0)?,
                name: row.get(1)?,
                data: row.get(2)?,
                is_hex: row.get(3)?,
                owner_plugin_id: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn query_macros(connection: &Connection, session_id: &str) -> Result<Vec<WorkspaceMacro>> {
    let mut statement = connection.prepare(
        "SELECT id, name, owner_plugin_id FROM macros
             WHERE session_id = ?1 ORDER BY position",
    )?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, name, owner_plugin_id)| {
            let mut steps_statement = connection.prepare(
                "SELECT data, is_hex, delay_ms FROM macro_steps
                 WHERE session_id = ?1 AND macro_id = ?2 ORDER BY position",
            )?;
            let steps = steps_statement
                .query_map(params![session_id, id.as_str()], |row| {
                    let delay_ms = row.get::<_, i64>(2)?;
                    Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?, delay_ms))
                })?
                .map(|row| {
                    let (data, is_hex, delay_ms) = row?;
                    Ok(WorkspaceMacroStep {
                        data,
                        is_hex,
                        delay_ms: u32::try_from(delay_ms).map_err(|_| WorkspaceError::Corrupt {
                            reason: "macro_delay",
                        })?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(WorkspaceMacro {
                id,
                name,
                steps,
                owner_plugin_id,
            })
        })
        .collect()
}

fn query_config_rows(
    connection: &Connection,
    table: &'static str,
    session_id: &str,
) -> Result<Vec<WorkspaceConfigRow>> {
    let sql =
        format!("SELECT id, config_json FROM {table} WHERE session_id = ?1 ORDER BY position");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, config)| {
            Ok(WorkspaceConfigRow {
                id,
                config: parse_document_json(&config)?,
            })
        })
        .collect()
}

fn query_waveform_channels(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<WorkspaceWaveformChannel>> {
    let mut statement = connection.prepare(
        "SELECT channel_index, config_json FROM waveform_channels
         WHERE session_id = ?1 ORDER BY channel_index",
    )?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(channel_index, config)| {
            Ok(WorkspaceWaveformChannel {
                channel_index: waveform_channel_index(channel_index)?,
                config: parse_document_json(&config)?,
            })
        })
        .collect()
}

fn validate_batch_envelope(request: &ApplyWorkspaceBatchRequest) -> Result<()> {
    validate_identifier(&request.workspace_id, "workspaceId")?;
    validate_identifier(&request.client_batch_id, "clientBatchId")?;
    if request.mutations.is_empty() {
        return Err(WorkspaceError::InvalidInput { field: "mutations" });
    }
    if request.mutations.len() > MAX_WORKSPACE_MUTATIONS_PER_BATCH {
        return Err(WorkspaceError::LimitExceeded {
            field: "mutations",
            limit: MAX_WORKSPACE_MUTATIONS_PER_BATCH,
            actual: request.mutations.len(),
        });
    }
    for pair in request.mutations.windows(2) {
        if pair[1].sequence()
            != pair[0]
                .sequence()
                .checked_add(1)
                .ok_or(WorkspaceError::InvalidInput { field: "sequence" })?
        {
            return Err(WorkspaceError::InvalidInput { field: "sequence" });
        }
    }
    Ok(())
}

/// Enforce the public 512 KiB batch budget in domain bytes, not in JSON wire
/// bytes. JSON represents every `u8` as a decimal number, so measuring the
/// serialized request would reject a valid raw frame at roughly one quarter
/// of the documented limit. A single frame may exceed the normal flush budget
/// up to the fixed 2 MiB per-frame limit and must be committed alone.
fn validate_logical_batch_size(request: &ApplyWorkspaceBatchRequest) -> Result<()> {
    let mut frame_count = 0usize;
    let mut frame_bytes = 0usize;
    let mut structured_bytes = 0usize;

    for mutation in &request.mutations {
        let frames = match mutation {
            WorkspaceMutation::AppendFrames { payload, .. } => Some(payload.frames.as_slice()),
            WorkspaceMutation::ReplaceCapture { payload, .. } => Some(payload.frames.as_slice()),
            _ => None,
        };
        if let Some(frames) = frames {
            frame_count = frame_count.saturating_add(frames.len());
            for frame in frames {
                frame_bytes = frame_bytes.saturating_add(frame.data.len());
            }
        } else {
            structured_bytes = structured_bytes.saturating_add(serde_json::to_vec(mutation)?.len());
        }
    }

    if frame_count > MAX_WORKSPACE_FRAMES_PER_BATCH {
        return Err(WorkspaceError::LimitExceeded {
            field: "batchFrames",
            limit: MAX_WORKSPACE_FRAMES_PER_BATCH,
            actual: frame_count,
        });
    }

    let logical_bytes = structured_bytes.saturating_add(frame_bytes);
    if logical_bytes <= MAX_WORKSPACE_BATCH_BYTES {
        return Ok(());
    }

    let is_single_large_frame = request.mutations.len() == 1
        && frame_count == 1
        && structured_bytes == 0
        && frame_bytes <= MAX_WORKSPACE_FRAME_BYTES;
    if is_single_large_frame {
        return Ok(());
    }

    Err(WorkspaceError::LimitExceeded {
        field: "batchBytes",
        limit: MAX_WORKSPACE_BATCH_BYTES,
        actual: logical_bytes,
    })
}

fn validate_database_size(path: &Path) -> Result<()> {
    let actual = physical_database_size(path)?;
    if actual > MAX_WORKSPACE_DATABASE_BYTES {
        return Err(WorkspaceError::LimitExceeded {
            field: "databaseBytes",
            limit: MAX_WORKSPACE_DATABASE_BYTES,
            actual,
        });
    }
    Ok(())
}

fn physical_database_size(path: &Path) -> Result<usize> {
    let mut total = file_len(path)?;
    for suffix in ["-wal", "-shm"] {
        total = total.saturating_add(file_len(&sidecar_path(path, suffix))?);
    }
    Ok(total)
}

fn file_len(path: &Path) -> Result<usize> {
    match fs::metadata(path) {
        Ok(metadata) => {
            usize::try_from(metadata.len()).map_err(|_| WorkspaceError::LimitExceeded {
                field: "databaseBytes",
                limit: MAX_WORKSPACE_DATABASE_BYTES,
                actual: usize::MAX,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn create_private_destination(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.sync_all()?;
    Ok(())
}

fn nonnegative_u64(value: i64, reason: &'static str) -> Result<u64> {
    u64::try_from(value).map_err(|_| WorkspaceError::Corrupt { reason })
}

fn waveform_channel_index(value: i64) -> Result<u8> {
    let channel_index = u8::try_from(value).map_err(|_| WorkspaceError::Corrupt {
        reason: "waveform_channel",
    })?;
    if channel_index > 7 {
        return Err(WorkspaceError::Corrupt {
            reason: "waveform_channel",
        });
    }
    Ok(channel_index)
}

fn optional_nonnegative_u64(value: Option<i64>, reason: &'static str) -> Result<Option<u64>> {
    value
        .map(|value| nonnegative_u64(value, reason))
        .transpose()
}

fn parse_document_json(value: &str) -> Result<serde_json::Value> {
    let parsed = serde_json::from_str(value).map_err(|_| WorkspaceError::Corrupt {
        reason: "document_json",
    })?;
    reject_forbidden_keys(&parsed).map_err(|_| WorkspaceError::Corrupt {
        reason: "forbidden_document_field",
    })?;
    Ok(parsed)
}

fn parse_port_hint_json(value: &str) -> Result<WorkspacePortHint> {
    let parsed = serde_json::from_str(value).map_err(|_| WorkspaceError::Corrupt {
        reason: "last_port_hint_json",
    })?;
    crate::model::validate_port_hint(&parsed).map_err(|_| WorkspaceError::Corrupt {
        reason: "last_port_hint",
    })?;
    Ok(parsed)
}

fn usize_to_i64(value: usize, field: &'static str) -> Result<i64> {
    i64::try_from(value).map_err(|_| WorkspaceError::InvalidInput { field })
}

fn current_time_millis() -> Result<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkspaceError::Corrupt { reason: "clock" })?;
    i64::try_from(duration.as_millis()).map_err(|_| WorkspaceError::Corrupt { reason: "clock" })
}
