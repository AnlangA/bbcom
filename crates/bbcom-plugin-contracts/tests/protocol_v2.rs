use std::fs;
use std::path::PathBuf;

use bbcom_plugin_contracts::ContractError;
use bbcom_plugin_contracts::PluginManifest;
use bbcom_plugin_contracts::generated_v2::{
    ButtonNode, Capability, EmptyNode, Envelope, ErrorCode, ListPortsRequest, MacroContribution,
    OperationAck, QuickCommand, Request, Response, SurfaceSnapshot, UiNode, envelope, request,
    response, ui_node,
};
use bbcom_plugin_contracts::v2::{
    ACTIVITY_TIMEOUT_MS, CALL_TIMEOUT_MS, LONG_TASK_TIMEOUT_MS, MAX_CONCURRENT_STREAMS,
    MAX_FRAME_BYTES, MAX_PENDING_HOST_REQUESTS, MAX_PROTOCOL_MINOR, MAX_QUEUE_BYTES,
    MAX_STREAM_CHUNK_BYTES, MAX_UI_DOCUMENT_BYTES, MAX_UI_NODES, MIN_PROTOCOL_MINOR,
    PROTOCOL_MAJOR, SERIAL_READ_TIMEOUT_MS, WASM_MEMORY_LIMIT_BYTES, WIT_PACKAGE,
    validate_envelope, validate_surface_snapshot,
};

#[test]
fn capability_and_error_taxonomies_are_closed_and_stable() {
    let capabilities = [
        Capability::UiWorkspace,
        Capability::UiDetachedWindow,
        Capability::SerialPortsRead,
        Capability::SerialSessionsManage,
        Capability::SerialIo,
        Capability::SerialControlLines,
        Capability::SessionCaptureRead,
        Capability::SessionCommandsReadWrite,
        Capability::FileOpenRead,
        Capability::FileSaveWrite,
        Capability::PluginStorage,
        Capability::ProjectStateReadWrite,
    ]
    .into_iter()
    .map(|value| value.as_str_name())
    .collect::<Vec<_>>();
    assert_eq!(
        capabilities,
        [
            "CAPABILITY_UI_WORKSPACE",
            "CAPABILITY_UI_DETACHED_WINDOW",
            "CAPABILITY_SERIAL_PORTS_READ",
            "CAPABILITY_SERIAL_SESSIONS_MANAGE",
            "CAPABILITY_SERIAL_IO",
            "CAPABILITY_SERIAL_CONTROL_LINES",
            "CAPABILITY_SESSION_CAPTURE_READ",
            "CAPABILITY_SESSION_COMMANDS_READ_WRITE",
            "CAPABILITY_FILE_OPEN_READ",
            "CAPABILITY_FILE_SAVE_WRITE",
            "CAPABILITY_PLUGIN_STORAGE",
            "CAPABILITY_PROJECT_STATE_READ_WRITE",
        ]
    );

    let errors = [
        ErrorCode::InvalidInput,
        ErrorCode::PermissionDenied,
        ErrorCode::Unavailable,
        ErrorCode::Busy,
        ErrorCode::NotFound,
        ErrorCode::StaleHandle,
        ErrorCode::Disconnected,
        ErrorCode::Timeout,
        ErrorCode::Cancelled,
        ErrorCode::LimitExceeded,
        ErrorCode::PartialWrite,
        ErrorCode::UnknownOutcome,
        ErrorCode::ProtocolError,
        ErrorCode::IoError,
    ]
    .into_iter()
    .map(|value| value.as_str_name())
    .collect::<Vec<_>>();
    assert_eq!(errors.len(), 14);
    assert!(errors.contains(&"ERROR_CODE_STALE_HANDLE"));
    assert!(errors.contains(&"ERROR_CODE_PARTIAL_WRITE"));
    assert!(errors.contains(&"ERROR_CODE_UNKNOWN_OUTCOME"));
}

#[test]
fn envelope_categories_enforce_reply_direction() {
    let request = Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: MAX_PROTOCOL_MINOR,
        message_id: 10,
        reply_to: None,
        payload: Some(envelope::Payload::Request(Request {
            operation: Some(request::Operation::ListPorts(ListPortsRequest {})),
        })),
    };
    assert_eq!(validate_envelope(&request), Ok(()));

    let mut invalid_request = request.clone();
    invalid_request.reply_to = Some(9);
    assert_eq!(
        validate_envelope(&invalid_request),
        Err(ContractError::InvalidField { field: "replyTo" })
    );

    let response = Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: MAX_PROTOCOL_MINOR,
        message_id: 11,
        reply_to: Some(10),
        payload: Some(envelope::Payload::Response(Response {
            result: Some(response::Result::Shutdown(OperationAck {})),
        })),
    };
    assert_eq!(validate_envelope(&response), Ok(()));

    let mut orphan = response;
    orphan.reply_to = None;
    assert_eq!(
        validate_envelope(&orphan),
        Err(ContractError::InvalidField { field: "replyTo" })
    );
}

#[test]
fn protocol_v2_limits_match_the_frozen_contract() {
    assert_eq!(PROTOCOL_MAJOR, 2);
    assert_eq!(MIN_PROTOCOL_MINOR, 0);
    assert_eq!(MAX_PROTOCOL_MINOR, 0);
    assert_eq!(WIT_PACKAGE, "bbcom:plugin@2.0.0");
    assert_eq!(MAX_FRAME_BYTES, 1024 * 1024);
    assert_eq!(MAX_QUEUE_BYTES, 16 * 1024 * 1024);
    assert_eq!(MAX_STREAM_CHUNK_BYTES, 256 * 1024);
    assert_eq!(MAX_CONCURRENT_STREAMS, 4);
    assert_eq!(MAX_PENDING_HOST_REQUESTS, 32);
    assert_eq!(WASM_MEMORY_LIMIT_BYTES, 64 * 1024 * 1024);
    assert_eq!(CALL_TIMEOUT_MS, 2_000);
    assert_eq!(SERIAL_READ_TIMEOUT_MS, 10_000);
    assert_eq!(LONG_TASK_TIMEOUT_MS, 7_200_000);
    assert_eq!(ACTIVITY_TIMEOUT_MS, 30_000);
    assert_eq!(MAX_UI_DOCUMENT_BYTES, 512 * 1024);
    assert_eq!(MAX_UI_NODES, 1_024);
}

#[test]
fn v2_wit_exposes_only_typed_host_authority() {
    let wit = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../wit/bbcom-plugin-v2/plugin.wit"),
    )
    .unwrap();
    for required in [
        "package bbcom:plugin@2.0.0;",
        "resource serial-lease",
        "resource read-grant",
        "resource save-grant",
        "record project-state { schema-version: u32, value: list<u8> }",
        "publish-surface-snapshot",
        "acquire-serial-lease",
        "upsert-quick-command",
        "upsert-macro",
        "project-state-get: func() -> result<option<project-state>, contract-error>",
        "project-state-set: func(state: project-state) -> result<_, contract-error>",
        "export migrate-state",
        "export run-command",
    ] {
        assert!(
            wit.contains(required),
            "missing v2 WIT contract: {required}"
        );
    }
    for forbidden in [
        "wasi:",
        "tauri",
        "filesystem-path",
        "spawn-process",
        "get-environment",
        "network.http",
        "ambient.serial-handle",
    ] {
        assert!(
            !wit.contains(forbidden),
            "ambient authority leaked: {forbidden}"
        );
    }
    assert_eq!(wit.matches("  import host;").count(), 1);
}

#[test]
fn native_contributions_are_explicitly_session_bound() {
    let quick = QuickCommand {
        local_id: "echo".to_owned(),
        title: "Echo".to_owned(),
        payload: vec![1],
        append_newline: false,
        session_id: "session-1".to_owned(),
    };
    let macro_ = MacroContribution {
        local_id: "prepare".to_owned(),
        title: "Prepare".to_owned(),
        steps: Vec::new(),
        session_id: "session-1".to_owned(),
    };
    assert_eq!(quick.session_id, "session-1");
    assert_eq!(macro_.session_id, "session-1");
}

#[test]
fn manifest_parses_permissively_and_exposes_typed_capabilities() {
    let manifest = |api: &str, capabilities: &str| {
        format!(
            "id = \"dev.bbcom.fixture\"\nname = \"Fixture\"\nversion = \"2.0.0\"\napi = \"{api}\"\nrequested-capabilities = [{capabilities}]\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{}\"\n\n[publisher]\nname = \"Fixture\"\nwebsite = \"https://example.invalid\"\n",
            "0".repeat(64)
        )
    };
    let v2 = PluginManifest::parse(&manifest("^2.0", "\"serial.io\", \"ui.workspace\"")).unwrap();
    v2.require_v2().unwrap();
    assert_eq!(
        v2.v2_capabilities().unwrap(),
        vec![Capability::UiWorkspace, Capability::SerialIo]
    );
    // Unrecognized capabilities are dropped and any api requirement parses.
    assert!(
        PluginManifest::parse(&manifest("^2.0", "\"unknown.capability\""))
            .unwrap()
            .v2_capabilities()
            .unwrap()
            .is_empty()
    );
    assert!(PluginManifest::parse(&manifest("^3.0", "\"ui.workspace\"")).is_ok());
    assert!(PluginManifest::parse(&manifest(">=1,<3", "")).is_ok());
}

#[test]
fn dangerous_buttons_require_host_rendered_confirmation_text() {
    let snapshot = |confirmation: Option<&str>| SurfaceSnapshot {
        surface_id: "surface".to_owned(),
        revision: 1,
        root_node_id: "root".to_owned(),
        nodes: vec![
            UiNode {
                id: "root".to_owned(),
                parent_id: None,
                order: 0,
                kind: Some(ui_node::Kind::Column(EmptyNode {})),
            },
            UiNode {
                id: "erase".to_owned(),
                parent_id: Some("root".to_owned()),
                order: 0,
                kind: Some(ui_node::Kind::DangerousButton(ButtonNode {
                    label: "Erase".to_owned(),
                    disabled: false,
                    confirmation: confirmation.map(str::to_owned),
                })),
            },
        ],
    };
    assert!(validate_surface_snapshot(&snapshot(Some("Erase device storage?"))).is_ok());
    assert_eq!(
        validate_surface_snapshot(&snapshot(None)),
        Err(ContractError::InvalidField {
            field: "dangerousConfirmation"
        })
    );
}
