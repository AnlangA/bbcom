use bbcom_contracts::{
    ApplyWorkspaceBatchRequest, MAX_WORKSPACE_AI_BYTES, MAX_WORKSPACE_AI_MESSAGE_BYTES,
    MAX_WORKSPACE_AI_MESSAGES, MAX_WORKSPACE_BATCH_BYTES, MAX_WORKSPACE_CAPTURE_BYTES,
    MAX_WORKSPACE_FRAME_BYTES, MAX_WORKSPACE_FRAMES, MAX_WORKSPACE_FRAMES_PER_SESSION,
    MAX_WORKSPACE_SESSIONS, WorkspaceAiMessagesPayload, WorkspaceAiRole, WorkspaceConfigRow,
    WorkspaceFeatureKind, WorkspaceFeatureStatePayload, WorkspaceFramePayload,
    WorkspaceMetadataPayload, WorkspaceMutation, WorkspaceSessionCollectionsPayload,
    WorkspaceSessionKind, WorkspaceSessionUpsertPayload, WorkspaceWaveformChannelsPayload,
    WorkspaceWaveformSamplesPayload,
};
use rusqlite::{Connection, Statement, params};
use std::collections::BTreeSet;

use crate::model::{
    ensure_session_exists, reject_forbidden_keys, validate_frame_payload, validate_identifier,
    validate_session_upsert_payload,
};
use crate::{Result, WorkspaceError};

/// One sequence is one plotted row; this matches the renderer's bounded cache.
const MAX_WAVEFORM_SAMPLE_GROUPS: usize = 600;
const MAX_PLUGIN_STATE_BYTES: usize = 16 * 1024 * 1024;
const MAX_WORKSPACE_PLUGIN_STATE_BYTES: usize = 64 * 1024 * 1024;

const INSERT_FRAME_SQL: &str = "INSERT INTO frames (
   session_id, seq, id, direction, timestamp_ms, data, tx_status, requested_bytes,
   omitted_bytes
 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)";

pub(crate) fn apply_mutations(
    connection: &Connection,
    request: &ApplyWorkspaceBatchRequest,
) -> Result<()> {
    for mutation in &request.mutations {
        apply_mutation(connection, mutation)?;
    }
    validate_workspace_limits(connection)?;
    Ok(())
}

pub(crate) fn validate_mutation_payload_limits(request: &ApplyWorkspaceBatchRequest) -> Result<()> {
    for mutation in &request.mutations {
        match mutation {
            WorkspaceMutation::AppendFrames { payload, .. } => {
                for frame in &payload.frames {
                    validate_frame_payload_limit(frame.data.len())?;
                }
            }
            WorkspaceMutation::ReplaceCapture { payload, .. } => {
                for frame in &payload.frames {
                    validate_frame_payload_limit(frame.data.len())?;
                }
            }
            WorkspaceMutation::UpsertFeatureState { payload, .. } => {
                if payload.feature == WorkspaceFeatureKind::Plugin {
                    let bytes = serde_json::to_vec(&payload.state)?.len();
                    ensure_limit("pluginState", bytes, MAX_PLUGIN_STATE_BYTES)?;
                }
            }
            WorkspaceMutation::ReplaceSessionCollections { payload, .. } => {
                validate_session_collections(payload)?;
            }
            WorkspaceMutation::AppendAiMessages { payload, .. } => {
                if payload.messages.is_empty() {
                    return Err(WorkspaceError::InvalidInput {
                        field: "aiMessages",
                    });
                }
                let mut ids = BTreeSet::new();
                for message in &payload.messages {
                    validate_identifier(&message.id, "aiMessage.id")?;
                    ensure_limit(
                        "aiMessageBytes",
                        message.content.len(),
                        MAX_WORKSPACE_AI_MESSAGE_BYTES,
                    )?;
                    if !ids.insert(message.id.as_str()) {
                        return Err(WorkspaceError::InvalidInput {
                            field: "aiMessage.id",
                        });
                    }
                    i64::try_from(message.timestamp_ms).map_err(|_| {
                        WorkspaceError::InvalidInput {
                            field: "aiMessage.timestampMs",
                        }
                    })?;
                }
            }
            WorkspaceMutation::ReplaceWaveformChannels { payload, .. } => {
                validate_waveform_channels(payload)?;
            }
            WorkspaceMutation::AppendWaveformSamples { payload, .. } => {
                validate_waveform_samples(payload)?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply_mutation(connection: &Connection, mutation: &WorkspaceMutation) -> Result<()> {
    match mutation {
        WorkspaceMutation::SetMetadata { payload, .. } => set_metadata(connection, payload),
        WorkspaceMutation::SetActiveSession { session_id, .. } => {
            set_active_session(connection, session_id.as_deref())
        }
        WorkspaceMutation::UpsertSession {
            session_id,
            payload,
            ..
        } => upsert_session(connection, session_id, payload),
        WorkspaceMutation::RemoveSession { session_id, .. } => {
            remove_session(connection, session_id)
        }
        WorkspaceMutation::AppendFrames {
            session_id,
            payload,
            ..
        } => append_frames(connection, session_id, payload),
        WorkspaceMutation::ReplaceCapture {
            session_id,
            payload,
            ..
        } => replace_capture(connection, session_id, payload),
        WorkspaceMutation::TrimCapture {
            session_id,
            payload,
            ..
        } => trim_capture(connection, session_id, payload.frame_count),
        WorkspaceMutation::UpsertFeatureState {
            entity_id, payload, ..
        } => upsert_feature_state(connection, entity_id, payload),
        WorkspaceMutation::ReplaceSessionCollections {
            session_id,
            payload,
            ..
        } => replace_session_collections(connection, session_id, payload),
        WorkspaceMutation::AppendAiMessages {
            session_id,
            payload,
            ..
        } => append_ai_messages(connection, session_id, payload),
        WorkspaceMutation::ClearAiMessages { session_id, .. } => {
            clear_ai_messages(connection, session_id)
        }
        WorkspaceMutation::ReplaceWaveformChannels {
            session_id,
            payload,
            ..
        } => replace_waveform_channels(connection, session_id, payload),
        WorkspaceMutation::AppendWaveformSamples {
            session_id,
            payload,
            ..
        } => append_waveform_samples(connection, session_id, payload),
    }
}

fn set_metadata(connection: &Connection, payload: &WorkspaceMetadataPayload) -> Result<()> {
    if let Some(name) = &payload.name {
        if name.is_empty() || name.len() > 256 {
            return Err(WorkspaceError::InvalidInput { field: "name" });
        }
        connection.execute(
            "UPDATE workspace_meta SET name = ?1 WHERE singleton = 1",
            [name.as_str()],
        )?;
    }
    if let Some(layout) = &payload.layout {
        reject_forbidden_keys(layout)?;
        connection.execute(
            "UPDATE workspace_meta SET layout_json = ?1 WHERE singleton = 1",
            [serde_json::to_string(&layout)?],
        )?;
    }
    if let Some(updated_at_ms) = payload.updated_at_ms {
        let updated_at_ms =
            i64::try_from(updated_at_ms).map_err(|_| WorkspaceError::InvalidInput {
                field: "updatedAtMs",
            })?;
        connection.execute(
            "UPDATE workspace_meta SET updated_at_ms = ?1 WHERE singleton = 1",
            [updated_at_ms],
        )?;
    }
    Ok(())
}

fn set_active_session(connection: &Connection, session_id: Option<&str>) -> Result<()> {
    if let Some(session_id) = session_id {
        validate_identifier(session_id, "sessionId")?;
        ensure_session_exists(connection, session_id)?;
        connection.execute(
            "UPDATE workspace_meta SET active_session_id = ?1 WHERE singleton = 1",
            [session_id],
        )?;
    } else {
        connection.execute(
            "UPDATE workspace_meta SET active_session_id = NULL WHERE singleton = 1",
            [],
        )?;
    }
    Ok(())
}

fn upsert_session(
    connection: &Connection,
    session_id: &str,
    payload: &WorkspaceSessionUpsertPayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    validate_session_upsert_payload(payload)?;
    let last_port_hint = payload
        .last_port_hint
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let kind = match payload.kind {
        WorkspaceSessionKind::Live => "live",
        WorkspaceSessionKind::Offline => "offline",
    };
    connection.execute(
        "INSERT INTO sessions (
           id, sort_order, kind, name, last_port_hint_json, port_config_json, needs_rebind,
           document_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
         ON CONFLICT(id) DO UPDATE SET
           sort_order = excluded.sort_order,
           kind = excluded.kind,
           name = excluded.name,
           last_port_hint_json = excluded.last_port_hint_json,
           port_config_json = excluded.port_config_json,
           needs_rebind = 1,
           document_json = excluded.document_json,
           undo_pending = 0",
        params![
            session_id,
            i64::from(payload.sort_order),
            kind,
            payload.name.as_str(),
            last_port_hint,
            serde_json::to_string(&payload.port_config)?,
            serde_json::to_string(&payload.document)?,
        ],
    )?;
    connection.execute(
        "INSERT INTO session_preferences(session_id) VALUES (?1)
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )?;
    connection.execute(
        "INSERT INTO capture_stats(session_id) VALUES (?1)
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )?;
    connection.execute(
        "INSERT INTO modbus_config(session_id) VALUES (?1)
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )?;
    connection.execute(
        "INSERT INTO mcumgr_config(session_id) VALUES (?1)
         ON CONFLICT(session_id) DO NOTHING",
        [session_id],
    )?;
    Ok(())
}

fn remove_session(connection: &Connection, session_id: &str) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;

    // The renderer exposes one durable undo slot. Purge the older slot only
    // when a new session is removed, then archive the current aggregate in
    // place. Frames, AI, waveform and collection rows therefore survive an
    // undo without being copied through the bounded IPC batch protocol.
    connection.execute(
        "DELETE FROM sessions WHERE undo_pending = 1 AND id <> ?1",
        [session_id],
    )?;
    connection.execute(
        "UPDATE workspace_meta SET active_session_id = NULL
         WHERE singleton = 1 AND active_session_id = ?1",
        [session_id],
    )?;
    let changed = connection.execute(
        "UPDATE sessions SET undo_pending = 1 WHERE id = ?1 AND undo_pending = 0",
        [session_id],
    )?;
    if changed != 1 {
        return Err(WorkspaceError::InvalidInput { field: "sessionId" });
    }
    Ok(())
}

fn append_frames(
    connection: &Connection,
    session_id: &str,
    payload: &bbcom_contracts::WorkspaceAppendFramesPayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    if payload.frames.is_empty() {
        return Err(WorkspaceError::InvalidInput { field: "frames" });
    }
    // Prepare the per-frame INSERT once per batch (the connection's statement
    // cache keeps it warm across batches) instead of re-preparing it for every
    // frame on the capture hot path.
    let mut insert = connection.prepare_cached(INSERT_FRAME_SQL)?;
    for (offset, frame) in payload.frames.iter().enumerate() {
        validate_frame_payload(frame)?;
        let sequence = payload
            .start_seq
            .checked_add(u64::try_from(offset).expect("usize always fits u64"))
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(WorkspaceError::InvalidInput { field: "sequence" })?;
        execute_frame_insert(&mut insert, session_id, sequence, frame)?;
    }
    Ok(())
}

fn replace_capture(
    connection: &Connection,
    session_id: &str,
    payload: &bbcom_contracts::WorkspaceReplaceCapturePayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    connection.execute("DELETE FROM frames WHERE session_id = ?1", [session_id])?;
    let mut insert = connection.prepare_cached(INSERT_FRAME_SQL)?;
    for (sequence, frame) in payload.frames.iter().enumerate() {
        validate_frame_payload(frame)?;
        execute_frame_insert(
            &mut insert,
            session_id,
            i64::try_from(sequence).expect("usize always fits i64"),
            frame,
        )?;
    }
    Ok(())
}

fn trim_capture(connection: &Connection, session_id: &str, frame_count: u32) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    if frame_count == 0 {
        return Err(WorkspaceError::InvalidInput {
            field: "frameCount",
        });
    }
    connection.execute(
        "DELETE FROM frames
         WHERE session_id = ?1 AND seq IN (
           SELECT seq FROM frames
           WHERE session_id = ?1
           ORDER BY seq
           LIMIT ?2
         )",
        params![session_id, i64::from(frame_count)],
    )?;
    Ok(())
}

fn execute_frame_insert(
    statement: &mut Statement<'_>,
    session_id: &str,
    sequence: i64,
    frame: &WorkspaceFramePayload,
) -> Result<()> {
    validate_frame_payload_limit(frame.data.len())?;
    statement.execute(params![
        session_id,
        sequence,
        frame.id,
        match frame.direction {
            bbcom_contracts::Direction::Tx => "TX",
            bbcom_contracts::Direction::Rx => "RX",
        },
        i64::try_from(frame.timestamp_ms).map_err(|_| WorkspaceError::InvalidInput {
            field: "timestampMs"
        })?,
        frame.data,
        frame.tx_status,
        optional_u64_to_i64(frame.requested_bytes, "requestedBytes")?,
        optional_u64_to_i64(frame.omitted_bytes, "omittedBytes")?,
    ])?;
    Ok(())
}

fn upsert_feature_state(
    connection: &Connection,
    entity_id: &str,
    payload: &WorkspaceFeatureStatePayload,
) -> Result<()> {
    validate_identifier(entity_id, "entityId")?;
    reject_forbidden_keys(&payload.state)?;
    match payload.feature {
        WorkspaceFeatureKind::Preferences
        | WorkspaceFeatureKind::Parser
        | WorkspaceFeatureKind::Modbus
        | WorkspaceFeatureKind::Waveform
        | WorkspaceFeatureKind::Shell
        | WorkspaceFeatureKind::Mcumgr => {
            ensure_session_exists(connection, entity_id)?;
            let state = serde_json::to_string(&payload.state)?;
            match payload.feature {
                WorkspaceFeatureKind::Preferences => connection.execute(
                    "UPDATE session_preferences SET feature_state_json = ?2 WHERE session_id = ?1",
                    params![entity_id, state],
                )?,
                WorkspaceFeatureKind::Parser => connection.execute(
                    "UPDATE session_preferences SET parser_json = ?2 WHERE session_id = ?1",
                    params![entity_id, state],
                )?,
                WorkspaceFeatureKind::Modbus => connection.execute(
                    "UPDATE modbus_config SET config_json = ?2 WHERE session_id = ?1",
                    params![entity_id, state],
                )?,
                WorkspaceFeatureKind::Waveform => connection.execute(
                    "UPDATE session_preferences SET display_json = ?2 WHERE session_id = ?1",
                    params![entity_id, state],
                )?,
                WorkspaceFeatureKind::Shell => connection.execute(
                    "UPDATE session_preferences SET send_json = ?2 WHERE session_id = ?1",
                    params![entity_id, state],
                )?,
                WorkspaceFeatureKind::Mcumgr => connection.execute(
                    "UPDATE mcumgr_config SET config_json = ?2 WHERE session_id = ?1",
                    params![entity_id, state],
                )?,
                _ => unreachable!(),
            };
        }
        WorkspaceFeatureKind::Plugin => {
            let state = serde_json::to_vec(&payload.state)?;
            if state.len() > MAX_PLUGIN_STATE_BYTES {
                return Err(WorkspaceError::LimitExceeded {
                    field: "pluginState",
                    limit: MAX_PLUGIN_STATE_BYTES,
                    actual: state.len(),
                });
            }
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM plugin_bindings WHERE plugin_id = ?1)",
                [entity_id],
                |row| row.get(0),
            )?;
            if !exists {
                connection.execute(
                    "INSERT INTO plugin_bindings (
                       plugin_id, repository_origin, version_requirement, expected_enabled
                     ) VALUES (?1, 'project-unresolved', '*', 0)",
                    [entity_id],
                )?;
            }
            connection.execute(
                "INSERT INTO plugin_project_state(plugin_id, state, state_version, schema_version)
                 VALUES (?1, ?2, 1, NULL)
                 ON CONFLICT(plugin_id) DO UPDATE SET state = excluded.state,
                                                      state_version = 1,
                                                      schema_version = NULL",
                params![entity_id, state],
            )?;
        }
    }
    Ok(())
}

fn validate_session_collections(payload: &WorkspaceSessionCollectionsPayload) -> Result<()> {
    for entry in &payload.send_history {
        validate_bounded_text(&entry.data, "sendHistory.data", MAX_WORKSPACE_BATCH_BYTES)?;
    }

    let mut quick_ids = BTreeSet::new();
    for command in &payload.quick_commands {
        validate_identifier(&command.id, "quickCommand.id")?;
        validate_named_value(&command.name, "quickCommand.name")?;
        validate_bounded_text(
            &command.data,
            "quickCommand.data",
            MAX_WORKSPACE_BATCH_BYTES,
        )?;
        ensure_unique_id(&mut quick_ids, &command.id, "quickCommand.id")?;
        validate_plugin_owner(
            command.owner_plugin_id.as_deref(),
            &command.id,
            "quickCommand.ownerPluginId",
        )?;
    }

    let mut macro_ids = BTreeSet::new();
    for macro_item in &payload.macros {
        validate_identifier(&macro_item.id, "macro.id")?;
        validate_named_value(&macro_item.name, "macro.name")?;
        ensure_unique_id(&mut macro_ids, &macro_item.id, "macro.id")?;
        validate_plugin_owner(
            macro_item.owner_plugin_id.as_deref(),
            &macro_item.id,
            "macro.ownerPluginId",
        )?;
        for step in &macro_item.steps {
            validate_bounded_text(&step.data, "macroStep.data", MAX_WORKSPACE_BATCH_BYTES)?;
        }
    }

    validate_config_rows(&payload.triggers, "trigger.id")?;
    validate_config_rows(&payload.highlights, "highlight.id")?;
    validate_config_rows(&payload.modbus_registers, "modbusRegister.id")?;
    Ok(())
}

fn replace_session_collections(
    connection: &Connection,
    session_id: &str,
    payload: &WorkspaceSessionCollectionsPayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    validate_session_collections(payload)?;

    for table in [
        "send_history",
        "quick_commands",
        "macros",
        "triggers",
        "highlights",
        "modbus_registers",
    ] {
        connection.execute(
            &format!("DELETE FROM {table} WHERE session_id = ?1"),
            [session_id],
        )?;
    }
    let mut insert = connection.prepare_cached(
        "INSERT INTO send_history(session_id, position, data, is_hex)
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (position, entry) in payload.send_history.iter().enumerate() {
        insert.execute(params![
            session_id,
            usize_to_i64(position)?,
            entry.data,
            entry.is_hex
        ])?;
    }
    let mut insert = connection.prepare_cached(
        "INSERT INTO quick_commands(
           session_id, id, position, name, data, is_hex, owner_plugin_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for (position, command) in payload.quick_commands.iter().enumerate() {
        insert.execute(params![
            session_id,
            command.id,
            usize_to_i64(position)?,
            command.name,
            command.data,
            command.is_hex,
            command.owner_plugin_id,
        ])?;
    }
    let mut insert = connection.prepare_cached(
        "INSERT INTO macros(session_id, id, position, name, owner_plugin_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let mut insert_step = connection.prepare_cached(
        "INSERT INTO macro_steps(
           session_id, macro_id, position, data, is_hex, delay_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (position, macro_item) in payload.macros.iter().enumerate() {
        insert.execute(params![
            session_id,
            macro_item.id,
            usize_to_i64(position)?,
            macro_item.name,
            macro_item.owner_plugin_id,
        ])?;
        for (step_position, step) in macro_item.steps.iter().enumerate() {
            insert_step.execute(params![
                session_id,
                macro_item.id,
                usize_to_i64(step_position)?,
                step.data,
                step.is_hex,
                i64::from(step.delay_ms)
            ])?;
        }
    }
    insert_config_rows(connection, "triggers", session_id, &payload.triggers, false)?;
    insert_config_rows(
        connection,
        "highlights",
        session_id,
        &payload.highlights,
        false,
    )?;
    insert_config_rows(
        connection,
        "modbus_registers",
        session_id,
        &payload.modbus_registers,
        true,
    )?;
    Ok(())
}

fn validate_plugin_owner(
    owner_plugin_id: Option<&str>,
    item_id: &str,
    field: &'static str,
) -> Result<()> {
    let Some(owner_plugin_id) = owner_plugin_id else {
        return Ok(());
    };
    validate_identifier(owner_plugin_id, field)?;
    let prefix = format!("plugin:{owner_plugin_id}:");
    if item_id.len() <= prefix.len() || !item_id.starts_with(&prefix) {
        return Err(crate::WorkspaceError::InvalidInput { field });
    }
    Ok(())
}

fn append_ai_messages(
    connection: &Connection,
    session_id: &str,
    payload: &WorkspaceAiMessagesPayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    let current: i64 = connection.query_row(
        "SELECT count(*) FROM ai_messages WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;
    if current != i64::from(payload.start_position) {
        return Err(WorkspaceError::InvalidInput {
            field: "aiMessages.startPosition",
        });
    }
    let mut insert = connection.prepare_cached(
        "INSERT INTO ai_messages(session_id, position, id, role, content, timestamp_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (offset, message) in payload.messages.iter().enumerate() {
        let position = i64::from(payload.start_position)
            .checked_add(usize_to_i64(offset)?)
            .ok_or(WorkspaceError::InvalidInput {
                field: "aiMessages.position",
            })?;
        insert.execute(params![
            session_id,
            position,
            message.id,
            match message.role {
                WorkspaceAiRole::User => "user",
                WorkspaceAiRole::Assistant => "assistant",
            },
            message.content,
            u64_to_i64(message.timestamp_ms, "aiMessage.timestampMs")?
        ])?;
    }
    Ok(())
}

fn clear_ai_messages(connection: &Connection, session_id: &str) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    connection.execute(
        "DELETE FROM ai_messages WHERE session_id = ?1",
        [session_id],
    )?;
    Ok(())
}

fn validate_waveform_channels(payload: &WorkspaceWaveformChannelsPayload) -> Result<()> {
    if payload.channels.len() > 8 {
        return Err(WorkspaceError::LimitExceeded {
            field: "waveformChannels",
            limit: 8,
            actual: payload.channels.len(),
        });
    }
    let mut channels = BTreeSet::new();
    for channel in &payload.channels {
        if channel.channel_index > 7 || !channels.insert(channel.channel_index) {
            return Err(WorkspaceError::InvalidInput {
                field: "waveform.channelIndex",
            });
        }
        reject_forbidden_keys(&channel.config)?;
    }
    Ok(())
}

fn replace_waveform_channels(
    connection: &Connection,
    session_id: &str,
    payload: &WorkspaceWaveformChannelsPayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    validate_waveform_channels(payload)?;
    connection.execute(
        "DELETE FROM waveform_channels WHERE session_id = ?1",
        [session_id],
    )?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO waveform_channels(session_id, channel_index, config_json)
         VALUES (?1, ?2, ?3)",
    )?;
    for channel in &payload.channels {
        insert.execute(params![
            session_id,
            i64::from(channel.channel_index),
            serde_json::to_string(&channel.config)?
        ])?;
    }
    Ok(())
}

fn validate_waveform_samples(payload: &WorkspaceWaveformSamplesPayload) -> Result<()> {
    if payload.samples.is_empty() {
        return Err(WorkspaceError::InvalidInput {
            field: "waveformSamples",
        });
    }
    let mut keys = BTreeSet::new();
    for sample in &payload.samples {
        if sample.channel_index > 7
            || !sample.value.is_finite()
            || !keys.insert((sample.channel_index, sample.seq))
        {
            return Err(WorkspaceError::InvalidInput {
                field: "waveformSample",
            });
        }
        u64_to_i64(sample.seq, "waveformSample.seq")?;
        u64_to_i64(sample.timestamp_ms, "waveformSample.timestampMs")?;
    }
    Ok(())
}

fn append_waveform_samples(
    connection: &Connection,
    session_id: &str,
    payload: &WorkspaceWaveformSamplesPayload,
) -> Result<()> {
    validate_identifier(session_id, "sessionId")?;
    ensure_session_exists(connection, session_id)?;
    validate_waveform_samples(payload)?;
    let mut channel_exists = connection.prepare_cached(
        "SELECT 1 FROM waveform_channels WHERE session_id = ?1 AND channel_index = ?2",
    )?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO waveform_samples(session_id, channel_index, seq, timestamp_ms, value)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for sample in &payload.samples {
        if !channel_exists.exists(params![session_id, i64::from(sample.channel_index)])? {
            return Err(WorkspaceError::InvalidInput {
                field: "waveformSample.channelIndex",
            });
        }
        insert.execute(params![
            session_id,
            i64::from(sample.channel_index),
            u64_to_i64(sample.seq, "waveformSample.seq")?,
            u64_to_i64(sample.timestamp_ms, "waveformSample.timestampMs")?,
            sample.value
        ])?;
    }
    // The caller may append register samples or text-derived rows. Prune only
    // after the complete mutation has been inserted so every retained `seq`
    // remains a complete multi-channel group in this transaction.
    connection.execute(
        "DELETE FROM waveform_samples
         WHERE session_id = ?1
           AND seq NOT IN (
             SELECT seq FROM waveform_samples
             WHERE session_id = ?1
             GROUP BY seq ORDER BY seq DESC LIMIT ?2
           )",
        params![
            session_id,
            i64::try_from(MAX_WAVEFORM_SAMPLE_GROUPS).expect("waveform limit fits i64")
        ],
    )?;
    Ok(())
}

fn validate_config_rows(rows: &[WorkspaceConfigRow], field: &'static str) -> Result<()> {
    let mut ids = BTreeSet::new();
    for row in rows {
        validate_identifier(&row.id, field)?;
        ensure_unique_id(&mut ids, &row.id, field)?;
        reject_forbidden_keys(&row.config)?;
    }
    Ok(())
}

fn insert_config_rows(
    connection: &Connection,
    table: &'static str,
    session_id: &str,
    rows: &[WorkspaceConfigRow],
    has_runtime_column: bool,
) -> Result<()> {
    let sql = if has_runtime_column {
        format!(
            "INSERT INTO {table}(session_id, id, position, config_json, runtime_json)
             VALUES (?1, ?2, ?3, ?4, NULL)"
        )
    } else {
        format!(
            "INSERT INTO {table}(session_id, id, position, config_json)
             VALUES (?1, ?2, ?3, ?4)"
        )
    };
    let mut insert = connection.prepare_cached(&sql)?;
    for (position, row) in rows.iter().enumerate() {
        insert.execute(params![
            session_id,
            row.id,
            usize_to_i64(position)?,
            serde_json::to_string(&row.config)?
        ])?;
    }
    Ok(())
}

fn validate_named_value(value: &str, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(WorkspaceError::InvalidInput { field });
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &'static str, limit: usize) -> Result<()> {
    if value.len() > limit {
        return Err(WorkspaceError::LimitExceeded {
            field,
            limit,
            actual: value.len(),
        });
    }
    Ok(())
}

fn ensure_unique_id<'a>(
    ids: &mut BTreeSet<&'a str>,
    value: &'a str,
    field: &'static str,
) -> Result<()> {
    if !ids.insert(value) {
        return Err(WorkspaceError::InvalidInput { field });
    }
    Ok(())
}

fn usize_to_i64(value: usize) -> Result<i64> {
    i64::try_from(value).map_err(|_| WorkspaceError::InvalidInput { field: "position" })
}

fn u64_to_i64(value: u64, field: &'static str) -> Result<i64> {
    i64::try_from(value).map_err(|_| WorkspaceError::InvalidInput { field })
}

pub(crate) fn validate_workspace_limits(connection: &Connection) -> Result<()> {
    limit_count(
        connection,
        "SELECT count(*) FROM sessions WHERE undo_pending = 0",
        "sessions",
        MAX_WORKSPACE_SESSIONS,
    )?;
    limit_count(
        connection,
        "SELECT count(*) FROM frames f
         JOIN sessions s ON s.id = f.session_id
         WHERE s.undo_pending = 0",
        "frames",
        MAX_WORKSPACE_FRAMES,
    )?;
    let per_session = query_nonnegative_usize(
        connection,
        "SELECT coalesce(max(frame_count), 0) FROM (
           SELECT count(*) AS frame_count FROM frames f
           JOIN sessions s ON s.id = f.session_id
           WHERE s.undo_pending = 0
           GROUP BY f.session_id
         )",
    )?;
    ensure_limit(
        "framesPerSession",
        per_session,
        MAX_WORKSPACE_FRAMES_PER_SESSION,
    )?;
    let capture_bytes = query_nonnegative_usize(
        connection,
        "SELECT coalesce(sum(length(f.data)), 0) FROM frames f
         JOIN sessions s ON s.id = f.session_id
         WHERE s.undo_pending = 0",
    )?;
    ensure_limit("captureBytes", capture_bytes, MAX_WORKSPACE_CAPTURE_BYTES)?;
    limit_count(
        connection,
        "SELECT count(*) FROM ai_messages a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.undo_pending = 0",
        "aiMessages",
        MAX_WORKSPACE_AI_MESSAGES,
    )?;
    let max_ai_message = query_nonnegative_usize(
        connection,
        "SELECT coalesce(max(length(CAST(a.content AS BLOB))), 0) FROM ai_messages a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.undo_pending = 0",
    )?;
    ensure_limit(
        "aiMessageBytes",
        max_ai_message,
        MAX_WORKSPACE_AI_MESSAGE_BYTES,
    )?;
    let ai_bytes = query_nonnegative_usize(
        connection,
        "SELECT coalesce(sum(length(CAST(a.content AS BLOB))), 0) FROM ai_messages a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.undo_pending = 0",
    )?;
    ensure_limit("aiBytes", ai_bytes, MAX_WORKSPACE_AI_BYTES)?;
    let plugin_bytes = query_nonnegative_usize(
        connection,
        "SELECT coalesce(sum(length(state)), 0) FROM plugin_project_state",
    )?;
    ensure_limit(
        "pluginStateBytes",
        plugin_bytes,
        MAX_WORKSPACE_PLUGIN_STATE_BYTES,
    )?;
    Ok(())
}

fn limit_count(
    connection: &Connection,
    sql: &str,
    field: &'static str,
    limit: usize,
) -> Result<()> {
    let actual = query_nonnegative_usize(connection, sql)?;
    ensure_limit(field, actual, limit)
}

fn query_nonnegative_usize(connection: &Connection, sql: &str) -> Result<usize> {
    let value: i64 = connection.query_row(sql, [], |row| row.get(0))?;
    usize::try_from(value).map_err(|_| WorkspaceError::Corrupt {
        reason: "negative aggregate",
    })
}

fn ensure_limit(field: &'static str, actual: usize, limit: usize) -> Result<()> {
    if actual > limit {
        return Err(WorkspaceError::LimitExceeded {
            field,
            limit,
            actual,
        });
    }
    Ok(())
}

fn validate_frame_payload_limit(actual: usize) -> Result<()> {
    ensure_limit("frame.data", actual, MAX_WORKSPACE_FRAME_BYTES)
}

fn optional_u64_to_i64(value: Option<u64>, field: &'static str) -> Result<Option<i64>> {
    value
        .map(|number| i64::try_from(number).map_err(|_| WorkspaceError::InvalidInput { field }))
        .transpose()
}
