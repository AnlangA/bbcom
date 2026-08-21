use bbcom_contracts::{
    WorkspaceDocumentHeader, WorkspaceFramePayload, WorkspacePortHint,
    WorkspaceSessionUpsertPayload,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{Result, WorkspaceError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateWorkspaceRequest {
    pub workspace_id: String,
    pub name: String,
    pub created_at_ms: u64,
}

impl CreateWorkspaceRequest {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_identifier(&self.workspace_id, "workspaceId")?;
        if self.name.is_empty() || self.name.len() > 256 {
            return Err(WorkspaceError::InvalidInput { field: "name" });
        }
        i64::try_from(self.created_at_ms).map_err(|_| WorkspaceError::InvalidInput {
            field: "createdAtMs",
        })?;
        Ok(())
    }
}

pub(crate) fn validate_session_upsert_payload(
    payload: &WorkspaceSessionUpsertPayload,
) -> Result<()> {
    if payload.name.is_empty() || payload.name.len() > 256 {
        return Err(WorkspaceError::InvalidInput {
            field: "session.name",
        });
    }
    reject_forbidden_keys(&payload.port_config)?;
    reject_forbidden_keys(&payload.document)?;
    if let Some(value) = &payload.last_port_hint {
        validate_port_hint(value)?;
    }
    Ok(())
}

pub(crate) fn validate_frame_payload(payload: &WorkspaceFramePayload) -> Result<()> {
    validate_identifier(&payload.id, "frame.id")?;
    if !matches!(
        payload.tx_status.as_deref(),
        None | Some("complete" | "partial-unknown")
    ) {
        return Err(WorkspaceError::InvalidInput {
            field: "frame.txStatus",
        });
    }
    i64::try_from(payload.timestamp_ms).map_err(|_| WorkspaceError::InvalidInput {
        field: "timestampMs",
    })?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceFramePage {
    pub session_id: String,
    pub frames: Vec<WorkspaceFrame>,
    pub next_seq: Option<u64>,
}

/// Safe persisted document projection. Physical port bindings are never
/// hydrated; every restored session explicitly requires rebinding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceSessionSnapshot {
    pub id: String,
    pub sort_order: u32,
    pub kind: String,
    pub name: String,
    pub needs_rebind: bool,
    pub last_port_hint: Option<WorkspacePortHint>,
    pub port_config: serde_json::Value,
    pub document: serde_json::Value,
    pub display_preferences: serde_json::Value,
    pub send_preferences: serde_json::Value,
    pub parser_state: serde_json::Value,
    pub feature_state: serde_json::Value,
    pub modbus_config: serde_json::Value,
    pub mcumgr_config: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceSessionPage {
    pub sessions: Vec<WorkspaceSessionSnapshot>,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceFrame {
    pub seq: u64,
    pub id: String,
    pub direction: String,
    pub timestamp_ms: u64,
    pub data: Vec<u8>,
    pub tx_status: Option<String>,
    pub requested_bytes: Option<u64>,
    pub omitted_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceIntegrityReport {
    pub ok: bool,
    pub message: String,
}

pub(crate) fn read_header(connection: &Connection) -> Result<WorkspaceDocumentHeader> {
    let (workspace_id, name, revision, active_session_id, layout_json): (
        String,
        String,
        i64,
        Option<String>,
        String,
    ) = connection
            .query_row(
                "SELECT workspace_id, name, revision, active_session_id, layout_json FROM workspace_meta WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?
            .ok_or(WorkspaceError::Corrupt {
                reason: "workspace_meta",
            })?;

    let mut statement = connection
        .prepare("SELECT id FROM sessions WHERE undo_pending = 0 ORDER BY sort_order, id")?;
    let session_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if active_session_id
        .as_ref()
        .is_some_and(|active| !session_ids.contains(active))
    {
        return Err(WorkspaceError::Corrupt {
            reason: "active_session_id",
        });
    }

    Ok(WorkspaceDocumentHeader {
        workspace_id,
        name,
        revision: u64::try_from(revision)
            .map_err(|_| WorkspaceError::Corrupt { reason: "revision" })?,
        active_session_id,
        session_ids,
        layout: serde_json::from_str(&layout_json).map_err(|_| WorkspaceError::Corrupt {
            reason: "layout_json",
        })?,
    })
}

pub(crate) fn insert_workspace_meta(
    connection: &Connection,
    request: &CreateWorkspaceRequest,
) -> Result<()> {
    let created_at_ms =
        i64::try_from(request.created_at_ms).map_err(|_| WorkspaceError::InvalidInput {
            field: "createdAtMs",
        })?;
    connection.execute(
        "INSERT INTO workspace_meta (
           singleton, workspace_id, name, created_at_ms, updated_at_ms, revision, layout_json
         ) VALUES (1, ?1, ?2, ?3, ?3, 0, '{}')",
        params![request.workspace_id, request.name, created_at_ms],
    )?;
    Ok(())
}

pub(crate) fn validate_identifier(value: &str, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(WorkspaceError::InvalidInput { field });
    }
    Ok(())
}

pub(crate) fn reject_forbidden_keys(value: &serde_json::Value) -> Result<()> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase();
                if normalized.contains("path")
                    || normalized.contains("handle")
                    || normalized.contains("token")
                    || normalized.contains("grant")
                    || normalized == "key"
                    || normalized.ends_with("_key")
                    || normalized.ends_with("-key")
                    || normalized.ends_with("apikey")
                    || normalized.contains("secret")
                {
                    return Err(WorkspaceError::InvalidInput { field: "payload" });
                }
                reject_forbidden_keys(child)?;
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                reject_forbidden_keys(child)?;
            }
        }
        serde_json::Value::String(text) if looks_like_absolute_path(text) => {
            return Err(WorkspaceError::InvalidInput { field: "payload" });
        }
        _ => {}
    }
    Ok(())
}

fn looks_like_absolute_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.starts_with('/')
        || text.starts_with("\\\\")
        || text.to_ascii_lowercase().starts_with("file:")
        || bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\')
}

pub(crate) fn validate_port_hint(value: &WorkspacePortHint) -> Result<()> {
    for text in [
        Some(value.display_name.as_str()),
        value.usb_serial.as_deref(),
        value.manufacturer.as_deref(),
        value.product.as_deref(),
        value.interface_type.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if text.len() > 256
            || text.contains('/')
            || text.contains('\\')
            || text.to_ascii_lowercase().contains("file:")
            || looks_like_absolute_path(text)
        {
            return Err(WorkspaceError::InvalidInput {
                field: "lastPortHint",
            });
        }
    }
    Ok(())
}

pub(crate) fn ensure_session_exists(connection: &Connection, session_id: &str) -> Result<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1 AND undo_pending = 0)",
        [session_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(WorkspaceError::InvalidInput { field: "sessionId" });
    }
    Ok(())
}
