use std::time::Duration;

use bbcom_contracts::MAX_WORKSPACE_DATABASE_BYTES;
use rusqlite::{Connection, OpenFlags};

use crate::{Result, WorkspaceError};

pub const WORKSPACE_APPLICATION_ID: i32 = 0x4242_434d;
pub const WORKSPACE_SCHEMA_VERSION: i32 = 4;
pub const WORKSPACE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) const READ_WRITE_FLAGS: OpenFlags = OpenFlags::SQLITE_OPEN_READ_WRITE
    .union(OpenFlags::SQLITE_OPEN_NO_MUTEX)
    .union(OpenFlags::SQLITE_OPEN_EXRESCODE);
pub(crate) const CREATE_FLAGS: OpenFlags = READ_WRITE_FLAGS.union(OpenFlags::SQLITE_OPEN_CREATE);
pub(crate) const READ_ONLY_FLAGS: OpenFlags = OpenFlags::SQLITE_OPEN_READ_ONLY
    .union(OpenFlags::SQLITE_OPEN_NO_MUTEX)
    .union(OpenFlags::SQLITE_OPEN_EXRESCODE);

pub(crate) fn configure_connection(connection: &Connection, writable: bool) -> Result<()> {
    connection.busy_timeout(WORKSPACE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    if writable {
        let journal_mode: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            connection.pragma_update(None, "journal_mode", "WAL")?;
        }
        // Paired with WAL above: NORMAL lets SQLite skip the commit-time fsync
        // of the database file (the WAL is still synced). A power loss may
        // lose the last committed transaction, but the database cannot be
        // corrupted — the standard durability trade-off for a WAL journal.
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "wal_autocheckpoint", 4096_i64)?;
        connection.pragma_update(None, "journal_size_limit", 16_i64 * 1024 * 1024)?;
        let page_size: i64 = connection.pragma_query_value(None, "page_size", |row| row.get(0))?;
        if page_size <= 0 {
            return Err(WorkspaceError::Corrupt {
                reason: "page_size",
            });
        }
        let database_limit =
            i64::try_from(MAX_WORKSPACE_DATABASE_BYTES).map_err(|_| WorkspaceError::Corrupt {
                reason: "database limit",
            })?;
        let max_pages = database_limit / page_size;
        connection.pragma_update(None, "max_page_count", max_pages)?;
    } else {
        connection.pragma_update(None, "query_only", "ON")?;
    }
    Ok(())
}

pub(crate) fn create_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA_SQL)?;
    connection.pragma_update(None, "application_id", WORKSPACE_APPLICATION_ID)?;
    connection.pragma_update(None, "user_version", WORKSPACE_SCHEMA_VERSION)?;
    Ok(())
}

pub(crate) fn validate_header(connection: &Connection) -> Result<()> {
    let application_id: i32 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != WORKSPACE_APPLICATION_ID {
        return Err(WorkspaceError::Corrupt {
            reason: "application_id",
        });
    }

    let user_version: i32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version > WORKSPACE_SCHEMA_VERSION {
        return Err(WorkspaceError::FutureSchema {
            found: user_version,
            supported: WORKSPACE_SCHEMA_VERSION,
        });
    }
    if user_version != WORKSPACE_SCHEMA_VERSION {
        return Err(WorkspaceError::Corrupt {
            reason: "user_version",
        });
    }
    Ok(())
}

/// Upgrade an already validated workspace before any query depends on the
/// current schema. Read-only opens cannot safely mutate an older file and
/// therefore fail closed until it is opened once in writable mode.
pub(crate) fn migrate_schema(connection: &Connection, writable: bool) -> Result<()> {
    let application_id: i32 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != WORKSPACE_APPLICATION_ID {
        return Err(WorkspaceError::Corrupt {
            reason: "application_id",
        });
    }
    let user_version: i32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version > WORKSPACE_SCHEMA_VERSION {
        return Err(WorkspaceError::FutureSchema {
            found: user_version,
            supported: WORKSPACE_SCHEMA_VERSION,
        });
    }
    if user_version == WORKSPACE_SCHEMA_VERSION {
        return Ok(());
    }
    if !writable || !matches!(user_version, 1..=3) {
        return Err(WorkspaceError::Corrupt {
            reason: "user_version",
        });
    }

    if user_version == 1 {
        let migration = connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE quick_commands ADD COLUMN owner_plugin_id TEXT
               CHECK (owner_plugin_id IS NULL OR length(owner_plugin_id) BETWEEN 1 AND 128);
             ALTER TABLE macros ADD COLUMN owner_plugin_id TEXT
               CHECK (owner_plugin_id IS NULL OR length(owner_plugin_id) BETWEEN 1 AND 128);
             PRAGMA user_version = 2;
             COMMIT;",
        );
        if let Err(error) = migration {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error.into());
        }
    }

    let add_schema_column =
        !table_has_column(connection, "plugin_project_state", "schema_version")?;
    let migration = if add_schema_column {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE plugin_project_state ADD COLUMN schema_version INTEGER
               CHECK (schema_version IS NULL OR schema_version >= 1);
             UPDATE plugin_project_state
                SET schema_version = 1
              WHERE state_version = 2;
             PRAGMA user_version = 3;
             COMMIT;",
        )
    } else {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             UPDATE plugin_project_state
                SET schema_version = 1
              WHERE state_version = 2 AND schema_version IS NULL;
             PRAGMA user_version = 3;
             COMMIT;",
        )
    };
    if let Err(error) = migration {
        let _ = connection.execute_batch("ROLLBACK;");
        return Err(error.into());
    }

    let mcumgr_migration = connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS mcumgr_config (
           session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
           config_json TEXT NOT NULL DEFAULT '{}'
         ) STRICT;
         INSERT OR IGNORE INTO mcumgr_config(session_id) SELECT id FROM sessions;
         PRAGMA user_version = 4;
         COMMIT;",
    );
    if let Err(error) = mcumgr_migration {
        let _ = connection.execute_batch("ROLLBACK;");
        return Err(error.into());
    }
    Ok(())
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

const SCHEMA_SQL: &str = r#"
BEGIN IMMEDIATE;

CREATE TABLE workspace_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  workspace_id TEXT NOT NULL UNIQUE CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  layout_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  kind TEXT NOT NULL DEFAULT 'live' CHECK (kind IN ('live', 'offline')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  last_port_hint_json TEXT,
  port_config_json TEXT NOT NULL DEFAULT '{}',
  needs_rebind INTEGER NOT NULL DEFAULT 1 CHECK (needs_rebind = 1),
  document_json TEXT NOT NULL DEFAULT '{}',
  undo_pending INTEGER NOT NULL DEFAULT 0 CHECK (undo_pending IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX sessions_sort_order_idx ON sessions(sort_order, id);
CREATE UNIQUE INDEX sessions_single_undo_slot_idx ON sessions(undo_pending) WHERE undo_pending = 1;

CREATE TABLE session_preferences (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  display_json TEXT NOT NULL DEFAULT '{}',
  send_json TEXT NOT NULL DEFAULT '{}',
  parser_json TEXT NOT NULL DEFAULT '{}',
  feature_state_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE frames (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  direction TEXT NOT NULL CHECK (direction IN ('TX', 'RX')),
  timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
  data BLOB NOT NULL CHECK (length(data) <= 2097152),
  tx_status TEXT CHECK (tx_status IS NULL OR tx_status IN ('complete', 'partial-unknown')),
  requested_bytes INTEGER CHECK (requested_bytes IS NULL OR requested_bytes >= 0),
  omitted_bytes INTEGER CHECK (omitted_bytes IS NULL OR omitted_bytes >= 0),
  PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, id)
) STRICT;
CREATE INDEX frames_timestamp_idx ON frames(session_id, timestamp_ms, seq);

CREATE TABLE capture_stats (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  tx_bytes INTEGER NOT NULL DEFAULT 0 CHECK (tx_bytes >= 0),
  rx_bytes INTEGER NOT NULL DEFAULT 0 CHECK (rx_bytes >= 0),
  tx_frames INTEGER NOT NULL DEFAULT 0 CHECK (tx_frames >= 0),
  rx_frames INTEGER NOT NULL DEFAULT 0 CHECK (rx_frames >= 0),
  dropped_bytes INTEGER NOT NULL DEFAULT 0 CHECK (dropped_bytes >= 0),
  started_at_ms INTEGER,
  last_seq INTEGER
) STRICT;

CREATE TABLE send_history (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  data TEXT NOT NULL,
  is_hex INTEGER NOT NULL CHECK (is_hex IN (0, 1)),
  PRIMARY KEY (session_id, position)
) STRICT;

CREATE TABLE quick_commands (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  is_hex INTEGER NOT NULL CHECK (is_hex IN (0, 1)),
  owner_plugin_id TEXT CHECK (
    owner_plugin_id IS NULL OR length(owner_plugin_id) BETWEEN 1 AND 128
  ),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, position)
) STRICT;

CREATE TABLE macros (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  owner_plugin_id TEXT CHECK (
    owner_plugin_id IS NULL OR length(owner_plugin_id) BETWEEN 1 AND 128
  ),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, position)
) STRICT;

CREATE TABLE macro_steps (
  session_id TEXT NOT NULL,
  macro_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  data TEXT NOT NULL,
  is_hex INTEGER NOT NULL CHECK (is_hex IN (0, 1)),
  delay_ms INTEGER NOT NULL CHECK (delay_ms >= 0),
  PRIMARY KEY (session_id, macro_id, position),
  FOREIGN KEY (session_id, macro_id) REFERENCES macros(session_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE triggers (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  config_json TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, position)
) STRICT;

CREATE TABLE highlights (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  config_json TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, position)
) STRICT;

CREATE TABLE modbus_config (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE mcumgr_config (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE modbus_registers (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  config_json TEXT NOT NULL,
  runtime_json TEXT,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, position)
) STRICT;

CREATE TABLE waveform_channels (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL CHECK (channel_index BETWEEN 0 AND 7),
  config_json TEXT NOT NULL,
  PRIMARY KEY (session_id, channel_index)
) STRICT;

CREATE TABLE waveform_samples (
  session_id TEXT NOT NULL,
  channel_index INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
  value REAL NOT NULL,
  PRIMARY KEY (session_id, channel_index, seq),
  FOREIGN KEY (session_id, channel_index)
    REFERENCES waveform_channels(session_id, channel_index) ON DELETE CASCADE
) STRICT;

CREATE TABLE ai_messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 262144),
  timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
  PRIMARY KEY (session_id, position),
  UNIQUE (session_id, id)
) STRICT;

CREATE TABLE operation_history (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted')
  ),
  progress_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE plugin_bindings (
  plugin_id TEXT PRIMARY KEY,
  repository_origin TEXT NOT NULL,
  version_requirement TEXT NOT NULL,
  expected_enabled INTEGER NOT NULL DEFAULT 0 CHECK (expected_enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE plugin_project_state (
  plugin_id TEXT PRIMARY KEY REFERENCES plugin_bindings(plugin_id) ON DELETE CASCADE,
  state BLOB NOT NULL CHECK (length(state) <= 16777216),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version IN (1, 2)),
  schema_version INTEGER CHECK (schema_version IS NULL OR schema_version >= 1),
  CHECK ((state_version = 1 AND schema_version IS NULL) OR
         (state_version = 2 AND schema_version IS NOT NULL))
) STRICT;

CREATE TABLE committed_batches (
  client_batch_id TEXT PRIMARY KEY CHECK (length(client_batch_id) BETWEEN 1 AND 128),
  request_hash BLOB NOT NULL CHECK (length(request_hash) = 32),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  committed_revision INTEGER NOT NULL CHECK (committed_revision >= 1),
  mutation_count INTEGER NOT NULL CHECK (mutation_count > 0),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0)
) STRICT;

COMMIT;
"#;
