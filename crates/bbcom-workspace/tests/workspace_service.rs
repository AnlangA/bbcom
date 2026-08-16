use std::fs::OpenOptions;

use bbcom_contracts::{
    ApplyWorkspaceBatchRequest, MAX_WORKSPACE_AI_MESSAGE_BYTES, MAX_WORKSPACE_BATCH_BYTES,
    MAX_WORKSPACE_DATABASE_BYTES, MAX_WORKSPACE_FRAME_BYTES, MAX_WORKSPACE_MUTATIONS_PER_BATCH,
    MAX_WORKSPACE_SESSIONS, WorkspaceMutation, WorkspaceMutationKind,
};
use bbcom_workspace::{
    CreateWorkspaceRequest, WORKSPACE_APPLICATION_ID, WORKSPACE_SCHEMA_VERSION, WorkspaceError,
    WorkspaceService,
};
use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

fn create(temp: &TempDir) -> (std::path::PathBuf, WorkspaceService) {
    let path = temp.path().join("project.bbcom");
    let service = WorkspaceService::create(
        &path,
        CreateWorkspaceRequest {
            workspace_id: "workspace-1".to_owned(),
            name: "Project".to_owned(),
            created_at_ms: 1_700_000_000_000,
        },
    )
    .unwrap();
    (path, service)
}

#[test]
fn native_plugin_binding_intent_round_trips_without_document_revision_change() {
    let temp = tempfile::tempdir().unwrap();
    let (_path, mut service) = create(&temp);
    let before = service.header().unwrap().revision;
    service
        .set_plugin_expected_enabled("dev.bbcom.fixture", true)
        .unwrap();
    let bindings = service.plugin_bindings().unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].plugin_id, "dev.bbcom.fixture");
    assert!(bindings[0].expected_enabled);
    assert_eq!(service.header().unwrap().revision, before);

    service
        .set_plugin_expected_enabled("dev.bbcom.fixture", false)
        .unwrap();
    assert!(!service.plugin_bindings().unwrap()[0].expected_enabled);
}

fn mutation(
    sequence: u32,
    kind: WorkspaceMutationKind,
    entity_id: Option<&str>,
    mut payload: serde_json::Value,
) -> WorkspaceMutation {
    if kind == WorkspaceMutationKind::UpsertSession {
        let object = payload.as_object_mut().expect("session payload object");
        object
            .entry("kind")
            .or_insert_with(|| serde_json::Value::String("live".to_owned()));
        object
            .entry("portConfig")
            .or_insert_with(|| serde_json::json!({}));
        object
            .entry("document")
            .or_insert_with(|| serde_json::json!({}));
    }
    let kind_name = match kind {
        WorkspaceMutationKind::SetMetadata => "set-metadata",
        WorkspaceMutationKind::SetActiveSession => "set-active-session",
        WorkspaceMutationKind::UpsertSession => "upsert-session",
        WorkspaceMutationKind::RemoveSession => "remove-session",
        WorkspaceMutationKind::AppendFrames => "append-frames",
        WorkspaceMutationKind::ReplaceCapture => "replace-capture",
        WorkspaceMutationKind::TrimCapture => "trim-capture",
        WorkspaceMutationKind::UpsertFeatureState => "upsert-feature-state",
        WorkspaceMutationKind::ReplaceSessionCollections => "replace-session-collections",
        WorkspaceMutationKind::AppendAiMessages => "append-ai-messages",
        WorkspaceMutationKind::ClearAiMessages => "clear-ai-messages",
        WorkspaceMutationKind::ReplaceWaveformChannels => "replace-waveform-channels",
        WorkspaceMutationKind::AppendWaveformSamples => "append-waveform-samples",
    };
    let mut value = serde_json::json!({ "kind": kind_name, "sequence": sequence });
    let object = value.as_object_mut().expect("mutation object");
    match kind {
        WorkspaceMutationKind::SetMetadata
        | WorkspaceMutationKind::UpsertSession
        | WorkspaceMutationKind::AppendFrames
        | WorkspaceMutationKind::ReplaceCapture
        | WorkspaceMutationKind::TrimCapture
        | WorkspaceMutationKind::UpsertFeatureState
        | WorkspaceMutationKind::ReplaceSessionCollections
        | WorkspaceMutationKind::AppendAiMessages
        | WorkspaceMutationKind::ReplaceWaveformChannels
        | WorkspaceMutationKind::AppendWaveformSamples => {
            object.insert("payload".to_owned(), payload);
        }
        WorkspaceMutationKind::SetActiveSession
        | WorkspaceMutationKind::RemoveSession
        | WorkspaceMutationKind::ClearAiMessages => {}
    }
    if let Some(entity_id) = entity_id {
        let key = if kind == WorkspaceMutationKind::UpsertFeatureState {
            "entityId"
        } else {
            "sessionId"
        };
        object.insert(
            key.to_owned(),
            serde_json::Value::String(entity_id.to_owned()),
        );
    } else if kind == WorkspaceMutationKind::SetActiveSession {
        object.insert("sessionId".to_owned(), serde_json::Value::Null);
    }
    serde_json::from_value(value).expect("typed workspace mutation fixture")
}

fn batch(
    client_batch_id: &str,
    base_revision: u64,
    mutations: Vec<WorkspaceMutation>,
) -> ApplyWorkspaceBatchRequest {
    ApplyWorkspaceBatchRequest {
        workspace_id: "workspace-1".to_owned(),
        client_batch_id: client_batch_id.to_owned(),
        base_revision,
        mutations,
    }
}

fn upsert_session(sequence: u32, id: &str, sort_order: u32) -> WorkspaceMutation {
    mutation(
        sequence,
        WorkspaceMutationKind::UpsertSession,
        Some(id),
        json!({
            "name": format!("Session {id}"),
            "sortOrder": sort_order,
            "kind": "live",
            "lastPortHint": {
                "displayName": "USB UART",
                "vendorId": 1155,
                "productId": 22336,
                "usbSerial": "ABC123"
            },
            "portConfig": { "baudRate": 115200 },
            "document": { "sendDraft": "AT" }
        }),
    )
}

#[test]
fn schema_header_and_safe_hydration_are_complete() {
    let temp = tempfile::tempdir().unwrap();
    let (path, mut service) = create(&temp);
    let header = service.header().unwrap();
    assert_eq!(header.workspace_id, "workspace-1");
    assert_eq!(header.revision, 0);

    service
        .apply_batch(batch("create-session", 0, vec![upsert_session(7, "s1", 0)]))
        .unwrap();
    let page = service.hydrate_sessions(0, 64).unwrap();
    assert_eq!(page.sessions.len(), 1);
    assert!(page.sessions[0].needs_rebind);
    assert_eq!(page.sessions[0].port_config, json!({ "baudRate": 115200 }));
    let hint = page.sessions[0].last_port_hint.as_ref().unwrap();
    assert_eq!(hint.display_name, "USB UART");
    assert_eq!(hint.usb_serial.as_deref(), Some("ABC123"));
    assert!(!format!("{page:?}").contains("/dev/"));
    drop(service);

    let connection = Connection::open(path).unwrap();
    let application_id: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .unwrap();
    let user_version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(application_id, WORKSPACE_APPLICATION_ID);
    assert_eq!(user_version, WORKSPACE_SCHEMA_VERSION);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            connection
                .path()
                .and_then(|path| std::fs::metadata(path).ok())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let expected = [
        "workspace_meta",
        "sessions",
        "session_preferences",
        "frames",
        "capture_stats",
        "send_history",
        "quick_commands",
        "macros",
        "macro_steps",
        "triggers",
        "highlights",
        "modbus_config",
        "modbus_registers",
        "waveform_channels",
        "waveform_samples",
        "ai_messages",
        "operation_history",
        "plugin_bindings",
        "plugin_project_state",
        "committed_batches",
    ];
    for table in expected {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists, "missing schema table {table}");
    }
}

#[test]
fn batch_is_transactional_revisioned_and_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    let request = batch("batch-1", 0, vec![upsert_session(10, "s1", 0)]);
    let applied = service.apply_batch(request.clone()).unwrap();
    assert_eq!(applied.committed_revision, 1);

    let retried = service.apply_batch(request).unwrap();
    assert_eq!(retried.committed_revision, 1);
    assert_eq!(service.header().unwrap().revision, 1);

    let reuse = service
        .apply_batch(batch(
            "batch-1",
            1,
            vec![mutation(
                10,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({ "name": "Different" }),
            )],
        ))
        .unwrap_err();
    assert!(matches!(reuse, WorkspaceError::BatchIdReuse));

    let conflict = service
        .apply_batch(batch(
            "stale",
            0,
            vec![mutation(
                11,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({ "name": "Stale" }),
            )],
        ))
        .unwrap_err();
    assert!(matches!(
        conflict,
        WorkspaceError::RevisionConflict {
            expected: 0,
            actual: 1
        }
    ));

    let rollback = service
        .apply_batch(batch(
            "rollback",
            1,
            vec![
                upsert_session(20, "rolled-back", 1),
                mutation(
                    21,
                    WorkspaceMutationKind::SetActiveSession,
                    Some("missing"),
                    serde_json::Value::Null,
                ),
            ],
        ))
        .unwrap_err();
    assert!(matches!(
        rollback,
        WorkspaceError::InvalidInput { field: "sessionId" }
    ));
    let header = service.header().unwrap();
    assert_eq!(header.revision, 1);
    assert_eq!(header.session_ids, ["s1"]);
}

#[test]
fn frames_are_bounded_and_hydrated_in_stable_pages() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();

    let frames = (0..4)
        .map(|index| {
            json!({
                "id": format!("f{index}"),
                "direction": if index % 2 == 0 { "RX" } else { "TX" },
                "timestampMs": 100 + index,
                "data": [index, index + 1]
            })
        })
        .collect::<Vec<_>>();
    service
        .apply_batch(batch(
            "frames",
            1,
            vec![mutation(
                2,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({ "startSeq": 5, "frames": frames }),
            )],
        ))
        .unwrap();
    let first = service.hydrate_frames("s1", 5, 2).unwrap();
    assert_eq!(
        first
            .frames
            .iter()
            .map(|frame| frame.seq)
            .collect::<Vec<_>>(),
        [5, 6]
    );
    assert_eq!(first.next_seq, Some(7));
    let second = service
        .hydrate_frames("s1", first.next_seq.unwrap(), 2)
        .unwrap();
    assert_eq!(
        second
            .frames
            .iter()
            .map(|frame| frame.seq)
            .collect::<Vec<_>>(),
        [7, 8]
    );
    assert_eq!(second.next_seq, None);

    let oversized = service
        .apply_batch(batch(
            "oversized-frame",
            2,
            vec![mutation(
                3,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 9,
                    "frames": [{
                        "id": "too-large",
                        "direction": "RX",
                        "timestampMs": 200,
                        "data": vec![0_u8; MAX_WORKSPACE_FRAME_BYTES + 1]
                    }]
                }),
            )],
        ))
        .unwrap_err();
    assert!(matches!(
        oversized,
        WorkspaceError::LimitExceeded {
            field: "frame.data",
            limit: MAX_WORKSPACE_FRAME_BYTES,
            actual
        } if actual == MAX_WORKSPACE_FRAME_BYTES + 1
    ));
    assert_eq!(service.header().unwrap().revision, 2);
}

#[test]
fn one_slot_session_undo_preserves_capture_and_next_delete_purges_the_old_slot() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();
    service
        .apply_batch(batch(
            "frame",
            1,
            vec![mutation(
                2,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 5,
                    "frames": [{
                        "id": "retained",
                        "direction": "RX",
                        "timestampMs": 100,
                        "data": [1, 2, 3]
                    }]
                }),
            )],
        ))
        .unwrap();
    service
        .apply_batch(batch(
            "remove-s1",
            2,
            vec![mutation(
                3,
                WorkspaceMutationKind::RemoveSession,
                Some("s1"),
                serde_json::Value::Null,
            )],
        ))
        .unwrap();
    assert!(service.header().unwrap().session_ids.is_empty());
    assert!(matches!(
        service.hydrate_frames("s1", 0, 8),
        Err(WorkspaceError::InvalidInput { field: "sessionId" })
    ));

    service
        .apply_batch(batch("undo-s1", 3, vec![upsert_session(4, "s1", 0)]))
        .unwrap();
    let restored = service.hydrate_frames("s1", 0, 8).unwrap();
    assert_eq!(restored.frames.len(), 1);
    assert_eq!(restored.frames[0].id, "retained");
    assert_eq!(restored.frames[0].seq, 5);

    service
        .apply_batch(batch("session-s2", 4, vec![upsert_session(5, "s2", 1)]))
        .unwrap();
    service
        .apply_batch(batch(
            "archive-s1",
            5,
            vec![mutation(
                6,
                WorkspaceMutationKind::RemoveSession,
                Some("s1"),
                serde_json::Value::Null,
            )],
        ))
        .unwrap();
    service
        .apply_batch(batch(
            "archive-s2",
            6,
            vec![mutation(
                7,
                WorkspaceMutationKind::RemoveSession,
                Some("s2"),
                serde_json::Value::Null,
            )],
        ))
        .unwrap();
    service
        .apply_batch(batch("recreate-s1", 7, vec![upsert_session(8, "s1", 0)]))
        .unwrap();
    assert!(
        service
            .hydrate_frames("s1", 0, 8)
            .unwrap()
            .frames
            .is_empty()
    );
}

#[test]
fn backup_physically_removes_undo_content_and_historical_freelist_bytes() {
    const HIDDEN_MARKER: &[u8] = b"bbcom-hidden-undo-payload-7d5ce8d8";
    const FREELIST_MARKER: &str = "bbcom-historical-freelist-payload-138fc19a";

    let temp = tempfile::tempdir().unwrap();
    let (source_path, mut source) = create(&temp);
    source
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();
    source
        .apply_batch(batch(
            "hidden-frame",
            1,
            vec![mutation(
                2,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 7,
                    "frames": [{
                        "id": "hidden-frame",
                        "direction": "RX",
                        "timestampMs": 100,
                        "data": HIDDEN_MARKER
                    }]
                }),
            )],
        ))
        .unwrap();
    source
        .apply_batch(batch(
            "hide-session",
            2,
            vec![mutation(
                3,
                WorkspaceMutationKind::RemoveSession,
                Some("s1"),
                serde_json::Value::Null,
            )],
        ))
        .unwrap();
    drop(source);

    // Build a deterministic historical freelist fixture independently of the
    // undo row. Merely deleting the current undo slot is insufficient: export
    // must rebuild the staging database so bytes from older hard deletes are
    // not recoverable from free pages either.
    let deleted_payload = FREELIST_MARKER.repeat(2_048);
    let connection = Connection::open(&source_path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .pragma_update(None, "secure_delete", "OFF")
        .unwrap();
    connection
        .execute(
            "INSERT INTO operation_history (
               id, session_id, kind, status, progress_json, created_at_ms, updated_at_ms
             ) VALUES ('freelist-probe', NULL, ?1, 'completed', '{}', 1, 1)",
            [deleted_payload],
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM operation_history WHERE id = 'freelist-probe'",
            [],
        )
        .unwrap();
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(connection);
    assert!(file_contains_bytes(
        &source_path,
        FREELIST_MARKER.as_bytes()
    ));

    let mut source = WorkspaceService::open(&source_path).unwrap();
    let backup_path = temp.path().join("sanitized.bbcom");
    source.backup_to(&backup_path).unwrap();

    let backup = WorkspaceService::open_read_only(&backup_path).unwrap();
    assert!(backup.header().unwrap().session_ids.is_empty());
    assert!(backup.integrity_check().unwrap().ok);
    drop(backup);
    assert!(!file_contains_bytes(&backup_path, HIDDEN_MARKER));
    assert!(!file_contains_bytes(
        &backup_path,
        FREELIST_MARKER.as_bytes()
    ));
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !temp
                .path()
                .join(format!("sanitized.bbcom{suffix}"))
                .exists()
        );
    }

    // Sanitizing a private backup copy must not consume the source's durable
    // one-slot undo aggregate.
    source
        .apply_batch(batch("restore-source", 3, vec![upsert_session(4, "s1", 0)]))
        .unwrap();
    assert_eq!(
        source.hydrate_frames("s1", 0, 8).unwrap().frames[0].data,
        HIDDEN_MARKER
    );
}

fn file_contains_bytes(path: &std::path::Path, needle: &[u8]) -> bool {
    std::fs::read(path)
        .unwrap()
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn capture_trim_removes_only_the_oldest_persisted_rows() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();
    service
        .apply_batch(batch(
            "frames",
            1,
            vec![mutation(
                2,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 5,
                    "frames": [
                        { "id": "f5", "direction": "RX", "timestampMs": 5, "data": [5] },
                        { "id": "f6", "direction": "RX", "timestampMs": 6, "data": [6] },
                        { "id": "f7", "direction": "RX", "timestampMs": 7, "data": [7] }
                    ]
                }),
            )],
        ))
        .unwrap();
    service
        .apply_batch(batch(
            "trim",
            2,
            vec![mutation(
                3,
                WorkspaceMutationKind::TrimCapture,
                Some("s1"),
                json!({ "frameCount": 2 }),
            )],
        ))
        .unwrap();
    let retained = service.hydrate_frames("s1", 0, 8).unwrap();
    assert_eq!(
        retained
            .frames
            .iter()
            .map(|frame| (frame.seq, frame.id.as_str()))
            .collect::<Vec<_>>(),
        [(7, "f7")]
    );

    let empty_trim = service
        .apply_batch(batch(
            "empty-trim",
            3,
            vec![mutation(
                4,
                WorkspaceMutationKind::TrimCapture,
                Some("s1"),
                json!({ "frameCount": 0 }),
            )],
        ))
        .unwrap_err();
    assert!(matches!(
        empty_trim,
        WorkspaceError::InvalidInput {
            field: "frameCount"
        }
    ));
    assert_eq!(service.header().unwrap().revision, 3);
}

#[test]
fn row_collections_ai_and_waveform_round_trip_without_runtime_state() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();
    service
        .apply_batch(batch(
            "session-rows",
            1,
            vec![
                mutation(
                    10,
                    WorkspaceMutationKind::ReplaceSessionCollections,
                    Some("s1"),
                    json!({
                        "sendHistory": [{ "data": "/preserve/as/serial-text", "isHex": false }],
                        "quickCommands": [{
                            "id": "quick-1", "name": "Query", "data": "AT?", "isHex": false
                        }],
                        "macros": [{
                            "id": "macro-1", "name": "Boot",
                            "steps": [{ "data": "AA", "isHex": true, "delayMs": 25 }]
                        }],
                        "triggers": [{ "id": "trigger-1", "config": { "enabled": true } }],
                        "highlights": [{ "id": "highlight-1", "config": { "color": "amber" } }],
                        "modbusRegisters": [{ "id": "register-1", "config": { "address": 4 } }]
                    }),
                ),
                mutation(
                    11,
                    WorkspaceMutationKind::AppendAiMessages,
                    Some("s1"),
                    json!({
                        "startPosition": 0,
                        "messages": [{
                            "id": "ai-1", "role": "user",
                            "content": "/preserve/as/ai-text", "timestampMs": 42
                        }]
                    }),
                ),
                mutation(
                    12,
                    WorkspaceMutationKind::ReplaceWaveformChannels,
                    Some("s1"),
                    json!({ "channels": [{ "channelIndex": 0, "config": { "name": "CH0" } }] }),
                ),
                mutation(
                    13,
                    WorkspaceMutationKind::AppendWaveformSamples,
                    Some("s1"),
                    json!({
                        "samples": [{
                            "channelIndex": 0, "seq": 7, "timestampMs": 43, "value": 12.5
                        }]
                    }),
                ),
            ],
        ))
        .unwrap();

    let collections = service.hydrate_session_collections("s1").unwrap();
    assert_eq!(collections.send_history[0].data, "/preserve/as/serial-text");
    assert_eq!(collections.macros[0].steps[0].delay_ms, 25);
    assert_eq!(
        collections.modbus_registers[0].config,
        json!({ "address": 4 })
    );

    let ai = service.hydrate_ai_messages("s1", 0, 256).unwrap();
    assert_eq!(ai.messages[0].content, "/preserve/as/ai-text");
    assert_eq!(ai.next_offset, None);

    let waveform = service.hydrate_waveform("s1", 0, 4_096).unwrap();
    assert_eq!(waveform.channels[0].channel_index, 0);
    assert_eq!(waveform.samples[0].seq, 7);
    assert_eq!(waveform.samples[0].value, 12.5);
    assert_eq!(waveform.next_offset, None);
}

#[test]
fn waveform_append_atomically_retains_the_latest_six_hundred_groups() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();
    service
        .apply_batch(batch(
            "waveform-channel",
            1,
            vec![mutation(
                2,
                WorkspaceMutationKind::ReplaceWaveformChannels,
                Some("s1"),
                json!({ "channels": [{ "channelIndex": 0, "config": {} }] }),
            )],
        ))
        .unwrap();
    let samples = (0..=600)
        .map(|seq| {
            json!({
                "channelIndex": 0,
                "seq": seq,
                "timestampMs": seq,
                "value": seq as f64
            })
        })
        .collect::<Vec<_>>();
    service
        .apply_batch(batch(
            "waveform-samples",
            2,
            vec![mutation(
                3,
                WorkspaceMutationKind::AppendWaveformSamples,
                Some("s1"),
                json!({ "samples": samples }),
            )],
        ))
        .unwrap();

    let waveform = service.hydrate_waveform("s1", 0, 4_096).unwrap();
    assert_eq!(waveform.samples.len(), 600);
    assert_eq!(waveform.samples.first().unwrap().seq, 1);
    assert_eq!(waveform.samples.last().unwrap().seq, 600);
    assert_eq!(waveform.next_offset, None);
}

#[test]
fn session_and_batch_limits_reject_whole_mutations_without_truncation() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    let mutations = (0..MAX_WORKSPACE_SESSIONS)
        .map(|index| upsert_session(index as u32, &format!("s{index}"), index as u32))
        .collect();
    service
        .apply_batch(batch("sixty-four", 0, mutations))
        .unwrap();
    assert_eq!(
        service.header().unwrap().session_ids.len(),
        MAX_WORKSPACE_SESSIONS
    );

    let overflow = service
        .apply_batch(batch("sixty-five", 1, vec![upsert_session(100, "s64", 64)]))
        .unwrap_err();
    assert!(matches!(
        overflow,
        WorkspaceError::LimitExceeded {
            field: "sessions",
            limit: MAX_WORKSPACE_SESSIONS,
            actual
        } if actual == MAX_WORKSPACE_SESSIONS + 1
    ));
    assert_eq!(
        service.header().unwrap().session_ids.len(),
        MAX_WORKSPACE_SESSIONS
    );
    assert_eq!(service.header().unwrap().revision, 1);

    let huge_document = "x".repeat(600 * 1024);
    let batch_too_large = service
        .apply_batch(batch(
            "batch-too-large",
            1,
            vec![mutation(
                101,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({ "layout": { "content": huge_document } }),
            )],
        ))
        .unwrap_err();
    assert!(matches!(
        batch_too_large,
        WorkspaceError::LimitExceeded {
            field: "batchBytes",
            ..
        }
    ));

    // The 512 KiB autosave threshold counts raw payload bytes. JSON expands a
    // byte vector to decimal numbers, so a valid larger frame must still be
    // accepted when it is the only frame in the batch.
    let large_frame_bytes = MAX_WORKSPACE_BATCH_BYTES + 1;
    service
        .apply_batch(batch(
            "single-large-frame",
            1,
            vec![mutation(
                102,
                WorkspaceMutationKind::AppendFrames,
                Some("s0"),
                json!({
                    "startSeq": 0,
                    "frames": [{
                        "id": "large-frame",
                        "direction": "RX",
                        "timestampMs": 42,
                        "data": vec![0xA5_u8; large_frame_bytes]
                    }]
                }),
            )],
        ))
        .unwrap();
    let page = service.hydrate_frames("s0", 0, 1).unwrap();
    assert_eq!(page.frames.len(), 1);
    assert_eq!(page.frames[0].data.len(), large_frame_bytes);

    let oversized_multi_frame_batch = service
        .apply_batch(batch(
            "oversized-multi-frame",
            2,
            vec![mutation(
                103,
                WorkspaceMutationKind::AppendFrames,
                Some("s0"),
                json!({
                    "startSeq": 1,
                    "frames": [
                        {
                            "id": "frame-a",
                            "direction": "RX",
                            "timestampMs": 43,
                            "data": vec![0_u8; MAX_WORKSPACE_BATCH_BYTES / 2 + 1]
                        },
                        {
                            "id": "frame-b",
                            "direction": "RX",
                            "timestampMs": 44,
                            "data": vec![0_u8; MAX_WORKSPACE_BATCH_BYTES / 2]
                        }
                    ]
                }),
            )],
        ))
        .unwrap_err();
    assert!(matches!(
        oversized_multi_frame_batch,
        WorkspaceError::LimitExceeded {
            field: "batchBytes",
            ..
        }
    ));
    assert_eq!(service.header().unwrap().revision, 2);
}

#[test]
fn port_paths_and_runtime_capabilities_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    for (batch_id, forbidden_payload) in [
        (
            "physical-port",
            json!({
                "name": "Session",
                "sortOrder": 0,
                "lastPortHint": { "displayName": "/dev/ttyUSB0" }
            }),
        ),
        (
            "grant",
            json!({
                "name": "Session",
                "sortOrder": 0,
                "document": { "fileGrant": "opaque" }
            }),
        ),
        (
            "key",
            json!({
                "name": "Session",
                "sortOrder": 0,
                "document": { "apiKey": "secret" }
            }),
        ),
        (
            "absolute-path-value",
            json!({
                "name": "Session",
                "sortOrder": 0,
                "document": { "value": "/tmp/secret.log" }
            }),
        ),
    ] {
        let error = service
            .apply_batch(batch(
                batch_id,
                0,
                vec![mutation(
                    1,
                    WorkspaceMutationKind::UpsertSession,
                    Some("s1"),
                    forbidden_payload,
                )],
            ))
            .unwrap_err();
        assert!(matches!(error, WorkspaceError::InvalidInput { .. }));
    }
    assert!(service.header().unwrap().session_ids.is_empty());
}

#[test]
fn wal_reopen_backup_and_integrity_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let (path, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();
    drop(service);

    let writer = Connection::open(&path).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    writer
        .execute(
            "UPDATE workspace_meta SET name = ?1 WHERE singleton = 1",
            ["Recovered from WAL"],
        )
        .unwrap();
    let mut reopened = WorkspaceService::open(&path).unwrap();
    assert_eq!(reopened.header().unwrap().name, "Recovered from WAL");
    assert_eq!(reopened.flush(1).unwrap().0, 1);

    let backup_path = temp.path().join("backup.bbcom");
    reopened.backup_to(&backup_path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&backup_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let mut backup = WorkspaceService::open_read_only(&backup_path).unwrap();
    assert_eq!(backup.header().unwrap(), reopened.header().unwrap());
    assert!(backup.integrity_check().unwrap().ok);
    assert!(matches!(
        backup
            .apply_batch(batch("read-only", 1, vec![upsert_session(2, "s2", 1)]))
            .unwrap_err(),
        WorkspaceError::ReadOnly
    ));
    drop(writer);
}

#[test]
fn invalid_and_future_headers_and_oversized_files_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let (path, service) = create(&temp);
    drop(service);

    let connection = Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert!(matches!(
        WorkspaceService::open(&path).unwrap_err(),
        WorkspaceError::FutureSchema {
            found: 99,
            supported: WORKSPACE_SCHEMA_VERSION
        }
    ));

    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "user_version", WORKSPACE_SCHEMA_VERSION)
        .unwrap();
    connection.pragma_update(None, "application_id", 1).unwrap();
    drop(connection);
    assert!(matches!(
        WorkspaceService::open(&path).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "application_id"
        }
    ));

    let oversized = temp.path().join("oversized.bbcom");
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&oversized)
        .unwrap();
    file.set_len((MAX_WORKSPACE_DATABASE_BYTES as u64) + 1)
        .unwrap();
    assert!(matches!(
        WorkspaceService::open(&oversized).unwrap_err(),
        WorkspaceError::LimitExceeded {
            field: "databaseBytes",
            limit: MAX_WORKSPACE_DATABASE_BYTES,
            ..
        }
    ));
}

#[test]
fn every_mutation_kind_round_trips_or_removes_its_owned_projection() {
    let temp = tempfile::tempdir().unwrap();
    let (path, mut service) = create(&temp);
    let mutations = vec![
        mutation(
            0,
            WorkspaceMutationKind::UpsertSession,
            Some("offline"),
            json!({
                "name": "Offline capture",
                "sortOrder": 0,
                "kind": "offline",
                "lastPortHint": {
                    "displayName": "USB UART",
                    "manufacturer": "Acme",
                    "product": "Bridge",
                    "interfaceType": "serial"
                },
                "portConfig": { "baudRate": 9600 },
                "document": { "sendDraft": "PING" }
            }),
        ),
        mutation(
            1,
            WorkspaceMutationKind::SetMetadata,
            None,
            json!({
                "name": "Renamed project",
                "layout": { "sidebar": "closed" },
                "updatedAtMs": 1_700_000_000_123_u64
            }),
        ),
        mutation(
            2,
            WorkspaceMutationKind::SetActiveSession,
            Some("offline"),
            serde_json::Value::Null,
        ),
        mutation(
            3,
            WorkspaceMutationKind::ReplaceCapture,
            Some("offline"),
            json!({
                "frames": [
                    {
                        "id": "tx-complete",
                        "direction": "TX",
                        "timestampMs": 11,
                        "data": [1, 2],
                        "txStatus": "complete",
                        "requestedBytes": 2,
                        "omittedBytes": 0
                    },
                    {
                        "id": "rx",
                        "direction": "RX",
                        "timestampMs": 12,
                        "data": [3]
                    }
                ]
            }),
        ),
        mutation(
            4,
            WorkspaceMutationKind::UpsertFeatureState,
            Some("offline"),
            json!({ "feature": "preferences", "state": { "encoding": "utf8" } }),
        ),
        mutation(
            5,
            WorkspaceMutationKind::UpsertFeatureState,
            Some("offline"),
            json!({ "feature": "parser", "state": { "mode": "line" } }),
        ),
        mutation(
            6,
            WorkspaceMutationKind::UpsertFeatureState,
            Some("offline"),
            json!({ "feature": "modbus", "state": { "unitId": 7 } }),
        ),
        mutation(
            7,
            WorkspaceMutationKind::UpsertFeatureState,
            Some("offline"),
            json!({ "feature": "waveform", "state": { "grid": true } }),
        ),
        mutation(
            8,
            WorkspaceMutationKind::UpsertFeatureState,
            Some("plugin.example"),
            json!({ "feature": "plugin", "state": { "enabled": true } }),
        ),
        mutation(
            9,
            WorkspaceMutationKind::ReplaceSessionCollections,
            Some("offline"),
            json!({
                "sendHistory": [{ "data": "PING", "isHex": false }],
                "quickCommands": [{
                    "id": "quick", "name": "Ping", "data": "50 49", "isHex": true
                }],
                "macros": [{
                    "id": "macro", "name": "Handshake",
                    "steps": [{ "data": "PING", "isHex": false, "delayMs": 10 }]
                }],
                "triggers": [{ "id": "trigger", "config": { "pattern": "OK" } }],
                "highlights": [{ "id": "highlight", "config": { "color": "green" } }],
                "modbusRegisters": [{ "id": "register", "config": { "address": 1 } }]
            }),
        ),
        mutation(
            10,
            WorkspaceMutationKind::AppendAiMessages,
            Some("offline"),
            json!({
                "startPosition": 0,
                "messages": [
                    { "id": "question", "role": "user", "content": "Q", "timestampMs": 20 },
                    {
                        "id": "answer", "role": "assistant", "content": "A", "timestampMs": 21
                    }
                ]
            }),
        ),
        mutation(
            11,
            WorkspaceMutationKind::ReplaceWaveformChannels,
            Some("offline"),
            json!({
                "channels": [
                    { "channelIndex": 0, "config": { "name": "A" } },
                    { "channelIndex": 1, "config": { "name": "B" } }
                ]
            }),
        ),
        mutation(
            12,
            WorkspaceMutationKind::AppendWaveformSamples,
            Some("offline"),
            json!({
                "samples": [
                    { "channelIndex": 0, "seq": 4, "timestampMs": 22, "value": 1.5 },
                    { "channelIndex": 1, "seq": 4, "timestampMs": 22, "value": -2.5 }
                ]
            }),
        ),
    ];
    service
        .apply_batch(batch("all-mutations", 0, mutations))
        .unwrap();

    let header = service.header().unwrap();
    assert_eq!(header.name, "Renamed project");
    assert_eq!(header.layout, json!({ "sidebar": "closed" }));
    assert_eq!(header.active_session_id.as_deref(), Some("offline"));
    let summary = service.summary().unwrap();
    assert_eq!(summary.name, "Renamed project");
    assert_eq!(summary.revision, 1);
    assert_eq!(service.path(), path);
    assert!(!service.is_read_only());

    let sessions = service.hydrate_sessions(0, 1).unwrap();
    assert_eq!(sessions.sessions[0].kind, "offline");
    assert_eq!(
        sessions.sessions[0].feature_state,
        json!({ "encoding": "utf8" })
    );
    assert_eq!(sessions.sessions[0].parser_state, json!({ "mode": "line" }));
    assert_eq!(sessions.sessions[0].modbus_config, json!({ "unitId": 7 }));
    assert_eq!(
        sessions.sessions[0].display_preferences,
        json!({ "grid": true })
    );

    let frames = service.hydrate_frames("offline", 0, 8).unwrap();
    assert_eq!(frames.frames.len(), 2);
    assert_eq!(frames.frames[0].direction, "TX");
    assert_eq!(frames.frames[0].tx_status.as_deref(), Some("complete"));
    assert_eq!(frames.frames[0].requested_bytes, Some(2));
    assert_eq!(frames.frames[0].omitted_bytes, Some(0));
    let collections = service.hydrate_session_collections("offline").unwrap();
    assert_eq!(collections.quick_commands[0].name, "Ping");
    assert_eq!(collections.triggers[0].config, json!({ "pattern": "OK" }));
    let ai = service.hydrate_ai_messages("offline", 0, 1).unwrap();
    assert_eq!(ai.messages[0].content, "Q");
    assert_eq!(ai.next_offset, Some(1));
    let ai_tail = service
        .hydrate_ai_messages("offline", ai.next_offset.unwrap(), 2)
        .unwrap();
    assert_eq!(ai_tail.messages[0].content, "A");
    let waveform = service.hydrate_waveform("offline", 0, 1).unwrap();
    assert_eq!(waveform.channels.len(), 2);
    assert_eq!(waveform.samples[0].value, 1.5);
    assert_eq!(waveform.next_offset, Some(1));

    service
        .apply_batch(batch(
            "clear-owned-data",
            1,
            vec![
                mutation(
                    20,
                    WorkspaceMutationKind::ClearAiMessages,
                    Some("offline"),
                    serde_json::Value::Null,
                ),
                mutation(
                    21,
                    WorkspaceMutationKind::SetActiveSession,
                    None,
                    serde_json::Value::Null,
                ),
                mutation(
                    22,
                    WorkspaceMutationKind::ReplaceCapture,
                    Some("offline"),
                    json!({ "frames": [] }),
                ),
                mutation(
                    23,
                    WorkspaceMutationKind::ReplaceSessionCollections,
                    Some("offline"),
                    json!({
                        "sendHistory": [], "quickCommands": [], "macros": [],
                        "triggers": [], "highlights": [], "modbusRegisters": []
                    }),
                ),
                mutation(
                    24,
                    WorkspaceMutationKind::ReplaceWaveformChannels,
                    Some("offline"),
                    json!({ "channels": [] }),
                ),
            ],
        ))
        .unwrap();
    assert_eq!(service.header().unwrap().active_session_id, None);
    assert!(
        service
            .hydrate_frames("offline", 0, 8)
            .unwrap()
            .frames
            .is_empty()
    );
    assert!(
        service
            .hydrate_ai_messages("offline", 0, 8)
            .unwrap()
            .messages
            .is_empty()
    );
    assert!(
        service
            .hydrate_waveform("offline", 0, 8)
            .unwrap()
            .channels
            .is_empty()
    );

    drop(service);
    let connection = Connection::open(path).unwrap();
    let plugin_state: Vec<u8> = connection
        .query_row(
            "SELECT state FROM plugin_project_state WHERE plugin_id = 'plugin.example'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&plugin_state).unwrap(),
        json!({ "enabled": true })
    );
}

#[test]
fn mutation_validation_rejects_each_invalid_domain_without_advancing_revision() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut service) = create(&temp);
    service
        .apply_batch(batch("session", 0, vec![upsert_session(1, "s1", 0)]))
        .unwrap();

    let invalid_cases = [
        (
            "metadata-name",
            mutation(
                10,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({ "name": "" }),
            ),
            "name",
        ),
        (
            "metadata-time",
            mutation(
                10,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({ "updatedAtMs": u64::MAX }),
            ),
            "updatedAtMs",
        ),
        (
            "missing-active",
            mutation(
                10,
                WorkspaceMutationKind::SetActiveSession,
                Some("missing"),
                serde_json::Value::Null,
            ),
            "sessionId",
        ),
        (
            "missing-remove",
            mutation(
                10,
                WorkspaceMutationKind::RemoveSession,
                Some("missing"),
                serde_json::Value::Null,
            ),
            "sessionId",
        ),
        (
            "empty-frames",
            mutation(
                10,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({ "startSeq": 0, "frames": [] }),
            ),
            "frames",
        ),
        (
            "bad-frame-status",
            mutation(
                10,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 0,
                    "frames": [{
                        "id": "f", "direction": "TX", "timestampMs": 1, "data": [],
                        "txStatus": "failed"
                    }]
                }),
            ),
            "frame.txStatus",
        ),
        (
            "bad-frame-time",
            mutation(
                10,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 0,
                    "frames": [{
                        "id": "f", "direction": "RX", "timestampMs": u64::MAX, "data": []
                    }]
                }),
            ),
            "timestampMs",
        ),
        (
            "bad-requested-bytes",
            mutation(
                10,
                WorkspaceMutationKind::AppendFrames,
                Some("s1"),
                json!({
                    "startSeq": 0,
                    "frames": [{
                        "id": "f", "direction": "TX", "timestampMs": 1, "data": [],
                        "requestedBytes": u64::MAX
                    }]
                }),
            ),
            "requestedBytes",
        ),
        (
            "zero-trim",
            mutation(
                10,
                WorkspaceMutationKind::TrimCapture,
                Some("s1"),
                json!({ "frameCount": 0 }),
            ),
            "frameCount",
        ),
        (
            "forbidden-feature",
            mutation(
                10,
                WorkspaceMutationKind::UpsertFeatureState,
                Some("s1"),
                json!({ "feature": "parser", "state": { "authToken": "secret" } }),
            ),
            "payload",
        ),
        (
            "duplicate-command",
            mutation(
                10,
                WorkspaceMutationKind::ReplaceSessionCollections,
                Some("s1"),
                json!({
                    "sendHistory": [],
                    "quickCommands": [
                        { "id": "q", "name": "One", "data": "", "isHex": false },
                        { "id": "q", "name": "Two", "data": "", "isHex": false }
                    ],
                    "macros": [], "triggers": [], "highlights": [], "modbusRegisters": []
                }),
            ),
            "quickCommand.id",
        ),
        (
            "empty-ai",
            mutation(
                10,
                WorkspaceMutationKind::AppendAiMessages,
                Some("s1"),
                json!({ "startPosition": 0, "messages": [] }),
            ),
            "aiMessages",
        ),
        (
            "duplicate-ai",
            mutation(
                10,
                WorkspaceMutationKind::AppendAiMessages,
                Some("s1"),
                json!({
                    "startPosition": 0,
                    "messages": [
                        { "id": "a", "role": "user", "content": "1", "timestampMs": 1 },
                        { "id": "a", "role": "assistant", "content": "2", "timestampMs": 2 }
                    ]
                }),
            ),
            "aiMessage.id",
        ),
        (
            "empty-waveform",
            mutation(
                10,
                WorkspaceMutationKind::AppendWaveformSamples,
                Some("s1"),
                json!({ "samples": [] }),
            ),
            "waveformSamples",
        ),
        (
            "duplicate-waveform-channel",
            mutation(
                10,
                WorkspaceMutationKind::ReplaceWaveformChannels,
                Some("s1"),
                json!({
                    "channels": [
                        { "channelIndex": 0, "config": {} },
                        { "channelIndex": 0, "config": {} }
                    ]
                }),
            ),
            "waveform.channelIndex",
        ),
        (
            "missing-waveform-channel",
            mutation(
                10,
                WorkspaceMutationKind::AppendWaveformSamples,
                Some("s1"),
                json!({
                    "samples": [{
                        "channelIndex": 1, "seq": 0, "timestampMs": 1, "value": 1.0
                    }]
                }),
            ),
            "waveformSample.channelIndex",
        ),
    ];

    for (batch_id, mutation, field) in invalid_cases {
        assert!(matches!(
            service
                .apply_batch(batch(batch_id, 1, vec![mutation]))
                .unwrap_err(),
            WorkspaceError::InvalidInput { field: actual } if actual == field
        ));
    }

    let too_many = (0..=MAX_WORKSPACE_MUTATIONS_PER_BATCH)
        .map(|sequence| {
            mutation(
                sequence as u32,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({}),
            )
        })
        .collect();
    assert!(matches!(
        service
            .apply_batch(batch("too-many", 1, too_many))
            .unwrap_err(),
        WorkspaceError::LimitExceeded {
            field: "mutations",
            ..
        }
    ));
    assert!(matches!(
        service
            .apply_batch(batch(
                "sequence-gap",
                1,
                vec![
                    mutation(1, WorkspaceMutationKind::SetMetadata, None, json!({})),
                    mutation(3, WorkspaceMutationKind::SetMetadata, None, json!({})),
                ],
            ))
            .unwrap_err(),
        WorkspaceError::InvalidInput { field: "sequence" }
    ));
    assert!(matches!(
        service.apply_batch(batch("empty", 1, vec![])).unwrap_err(),
        WorkspaceError::InvalidInput { field: "mutations" }
    ));
    let mut wrong_workspace = batch(
        "wrong-workspace",
        1,
        vec![mutation(
            1,
            WorkspaceMutationKind::SetMetadata,
            None,
            json!({}),
        )],
    );
    wrong_workspace.workspace_id = "workspace-2".to_owned();
    assert!(matches!(
        service.apply_batch(wrong_workspace).unwrap_err(),
        WorkspaceError::InvalidInput {
            field: "workspaceId"
        }
    ));

    for (batch_id, payload, field) in [
        (
            "long-ai",
            json!({
                "startPosition": 0,
                "messages": [{
                    "id": "large", "role": "user",
                    "content": "x".repeat(MAX_WORKSPACE_AI_MESSAGE_BYTES + 1),
                    "timestampMs": 1
                }]
            }),
            "aiMessageBytes",
        ),
        (
            "bad-ai-time",
            json!({
                "startPosition": 0,
                "messages": [{
                    "id": "future", "role": "user", "content": "x", "timestampMs": u64::MAX
                }]
            }),
            "aiMessage.timestampMs",
        ),
    ] {
        let error = service
            .apply_batch(batch(
                batch_id,
                1,
                vec![mutation(
                    10,
                    WorkspaceMutationKind::AppendAiMessages,
                    Some("s1"),
                    payload,
                )],
            ))
            .unwrap_err();
        assert!(
            matches!(error, WorkspaceError::LimitExceeded { field: actual, .. } if actual == field)
                || matches!(error, WorkspaceError::InvalidInput { field: actual } if actual == field)
        );
    }
    assert_eq!(service.header().unwrap().revision, 1);
    assert_eq!(service.header().unwrap().session_ids, ["s1"]);
}

#[test]
fn service_boundaries_and_idempotency_retention_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("missing.bbcom");
    assert!(matches!(
        WorkspaceService::open(&missing).unwrap_err(),
        WorkspaceError::NotFound
    ));
    for request in [
        CreateWorkspaceRequest {
            workspace_id: "".to_owned(),
            name: "Project".to_owned(),
            created_at_ms: 1,
        },
        CreateWorkspaceRequest {
            workspace_id: "workspace".to_owned(),
            name: "".to_owned(),
            created_at_ms: 1,
        },
        CreateWorkspaceRequest {
            workspace_id: "workspace".to_owned(),
            name: "Project".to_owned(),
            created_at_ms: u64::MAX,
        },
    ] {
        assert!(matches!(
            WorkspaceService::create(
                temp.path()
                    .join(format!("invalid-{}.bbcom", request.created_at_ms)),
                request
            )
            .unwrap_err(),
            WorkspaceError::InvalidInput { .. }
        ));
    }

    let (path, mut service) = create(&temp);
    assert!(matches!(
        WorkspaceService::create(
            &path,
            CreateWorkspaceRequest {
                workspace_id: "other".to_owned(),
                name: "Other".to_owned(),
                created_at_ms: 1,
            },
        )
        .unwrap_err(),
        WorkspaceError::AlreadyExists
    ));
    assert!(matches!(
        service.flush(1).unwrap_err(),
        WorkspaceError::RevisionConflict {
            expected: 1,
            actual: 0
        }
    ));
    for result in [
        service.hydrate_sessions(0, 0).map(|_| ()),
        service.hydrate_sessions(0, 65).map(|_| ()),
        service.hydrate_frames("missing", 0, 1).map(|_| ()),
        service.hydrate_ai_messages("missing", 0, 1).map(|_| ()),
        service.hydrate_waveform("missing", 0, 1).map(|_| ()),
    ] {
        assert!(result.is_err());
    }
    let existing_backup = temp.path().join("existing.bbcom");
    std::fs::write(&existing_backup, b"reserved").unwrap();
    assert!(matches!(
        service.backup_to(&existing_backup).unwrap_err(),
        WorkspaceError::AlreadyExists
    ));
    drop(service);

    let connection = Connection::open(&path).unwrap();
    // Position the workspace one revision below a 64-boundary so the next
    // commit triggers the ledger prune, then seed more ledger rows than the
    // retained window. `expired` is inserted first and therefore owns the
    // oldest rowid in the table.
    connection
        .execute(
            "UPDATE workspace_meta SET revision = 4159 WHERE singleton = 1",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO committed_batches (
               client_batch_id, request_hash, base_revision, committed_revision,
               mutation_count, committed_at_ms
             ) VALUES ('expired', zeroblob(32), 0, 1, 1, 1)",
            [],
        )
        .unwrap();
    {
        let mut filler = connection
            .prepare(
                "INSERT INTO committed_batches (
                   client_batch_id, request_hash, base_revision, committed_revision,
                   mutation_count, committed_at_ms
                 ) VALUES (?1, zeroblob(32), ?2, ?2, 1, ?2)",
            )
            .unwrap();
        for n in 2..=1025_i64 {
            filler
                .execute(rusqlite::params![format!("ledger-{n}"), n])
                .unwrap();
        }
    }
    drop(connection);

    let mut service = WorkspaceService::open(&path).unwrap();
    service
        .apply_batch(batch(
            "retention",
            4159,
            vec![mutation(
                0,
                WorkspaceMutationKind::SetMetadata,
                None,
                json!({ "name": "After retention" }),
            )],
        ))
        .unwrap();
    assert_eq!(service.summary().unwrap().revision, 4160);
    drop(service);
    let connection = Connection::open(&path).unwrap();
    let expired_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM committed_batches WHERE client_batch_id = 'expired')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!expired_exists);
    let retained_rows: i64 = connection
        .query_row("SELECT count(*) FROM committed_batches", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(retained_rows, 1024);
    drop(connection);

    let mut read_only = WorkspaceService::open_read_only(&path).unwrap();
    assert!(read_only.is_read_only());
    assert_eq!(
        read_only.flush(4160).unwrap().1,
        bbcom_contracts::WorkspaceSaveHealth::ReadOnly
    );
}

#[test]
fn hydration_detects_semantically_corrupt_rows_instead_of_projecting_them() {
    let temp = tempfile::tempdir().unwrap();
    let (path, mut service) = create(&temp);
    service
        .apply_batch(batch(
            "seed",
            0,
            vec![
                upsert_session(0, "s1", 0),
                mutation(
                    1,
                    WorkspaceMutationKind::ReplaceCapture,
                    Some("s1"),
                    json!({
                        "frames": [{
                            "id": "frame", "direction": "RX", "timestampMs": 1, "data": [1],
                            "requestedBytes": 1, "omittedBytes": 0
                        }]
                    }),
                ),
                mutation(
                    2,
                    WorkspaceMutationKind::ReplaceSessionCollections,
                    Some("s1"),
                    json!({
                        "sendHistory": [], "quickCommands": [],
                        "macros": [{
                            "id": "macro", "name": "Macro",
                            "steps": [{ "data": "A", "isHex": false, "delayMs": 1 }]
                        }],
                        "triggers": [{ "id": "trigger", "config": {} }],
                        "highlights": [], "modbusRegisters": []
                    }),
                ),
                mutation(
                    3,
                    WorkspaceMutationKind::AppendAiMessages,
                    Some("s1"),
                    json!({
                        "startPosition": 0,
                        "messages": [{
                            "id": "ai", "role": "user", "content": "hello", "timestampMs": 1
                        }]
                    }),
                ),
                mutation(
                    4,
                    WorkspaceMutationKind::ReplaceWaveformChannels,
                    Some("s1"),
                    json!({ "channels": [{ "channelIndex": 0, "config": {} }] }),
                ),
                mutation(
                    5,
                    WorkspaceMutationKind::AppendWaveformSamples,
                    Some("s1"),
                    json!({
                        "samples": [{
                            "channelIndex": 0, "seq": 1, "timestampMs": 1, "value": 1.0
                        }]
                    }),
                ),
            ],
        ))
        .unwrap();

    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    connection
        .pragma_update(None, "ignore_check_constraints", "ON")
        .unwrap();

    connection
        .execute("UPDATE workspace_meta SET updated_at_ms = -1", [])
        .unwrap();
    assert!(matches!(
        service.summary().unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "updated timestamp"
        }
    ));
    connection
        .execute("UPDATE workspace_meta SET updated_at_ms = 1", [])
        .unwrap();
    connection
        .execute(
            "UPDATE workspace_meta SET active_session_id = 'missing'",
            [],
        )
        .unwrap();
    assert!(matches!(
        service.header().unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "active_session_id"
        }
    ));
    connection
        .execute("UPDATE workspace_meta SET active_session_id = NULL", [])
        .unwrap();
    connection
        .execute("UPDATE workspace_meta SET layout_json = 'not-json'", [])
        .unwrap();
    assert!(matches!(
        service.header().unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "layout_json"
        }
    ));
    connection
        .execute("UPDATE workspace_meta SET layout_json = '{}'", [])
        .unwrap();

    connection
        .execute("UPDATE sessions SET sort_order = -1 WHERE id = 's1'", [])
        .unwrap();
    assert!(matches!(
        service.hydrate_sessions(0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "session_sort_order"
        }
    ));
    connection
        .execute("UPDATE sessions SET sort_order = 0 WHERE id = 's1'", [])
        .unwrap();
    connection
        .execute(
            "UPDATE sessions SET last_port_hint_json = '{bad' WHERE id = 's1'",
            [],
        )
        .unwrap();
    assert!(matches!(
        service.hydrate_sessions(0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "last_port_hint_json"
        }
    ));
    connection
        .execute(
            "UPDATE sessions SET last_port_hint_json = NULL, port_config_json = '{\"apiKey\":\"x\"}' WHERE id = 's1'",
            [],
        )
        .unwrap();
    assert!(matches!(
        service.hydrate_sessions(0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "forbidden_document_field"
        }
    ));
    connection
        .execute(
            "UPDATE sessions SET port_config_json = '{}' WHERE id = 's1'",
            [],
        )
        .unwrap();

    connection
        .execute(
            "UPDATE frames SET timestamp_ms = -1 WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    assert!(matches!(
        service.hydrate_frames("s1", 0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "frame timestamp"
        }
    ));
    connection
        .execute(
            "UPDATE frames SET timestamp_ms = 1, requested_bytes = -1 WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    assert!(matches!(
        service.hydrate_frames("s1", 0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "requested bytes"
        }
    ));
    connection
        .execute(
            "UPDATE frames SET requested_bytes = 1 WHERE session_id = 's1'",
            [],
        )
        .unwrap();

    connection
        .execute("UPDATE ai_messages SET role = 'system'", [])
        .unwrap();
    assert!(matches!(
        service.hydrate_ai_messages("s1", 0, 1).unwrap_err(),
        WorkspaceError::Corrupt { reason: "ai_role" }
    ));
    connection
        .execute(
            "UPDATE ai_messages SET role = 'user', timestamp_ms = -1",
            [],
        )
        .unwrap();
    assert!(matches!(
        service.hydrate_ai_messages("s1", 0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "ai timestamp"
        }
    ));
    connection
        .execute("UPDATE ai_messages SET timestamp_ms = 1", [])
        .unwrap();

    connection
        .execute("UPDATE waveform_channels SET channel_index = 99", [])
        .unwrap();
    assert!(matches!(
        service.hydrate_waveform("s1", 0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "waveform_channel"
        }
    ));
    connection
        .execute("UPDATE waveform_channels SET channel_index = 0", [])
        .unwrap();
    connection
        .execute("UPDATE waveform_samples SET seq = -1", [])
        .unwrap();
    assert!(matches!(
        service.hydrate_waveform("s1", 0, 1).unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "waveform sequence"
        }
    ));
    connection
        .execute("UPDATE waveform_samples SET seq = 1", [])
        .unwrap();

    connection
        .execute("UPDATE macro_steps SET delay_ms = -1", [])
        .unwrap();
    assert!(matches!(
        service.hydrate_session_collections("s1").unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "macro_delay"
        }
    ));
    connection
        .execute("UPDATE macro_steps SET delay_ms = 1", [])
        .unwrap();
    connection
        .execute("UPDATE triggers SET config_json = '{bad'", [])
        .unwrap();
    assert!(matches!(
        service.hydrate_session_collections("s1").unwrap_err(),
        WorkspaceError::Corrupt {
            reason: "document_json"
        }
    ));
}
