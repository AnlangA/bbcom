//! Stable, non-sensitive contracts shared by bbcom's Rust and TypeScript code.
//!
//! The generated TypeScript represents the JSON wire format, not Rust's
//! internal domain model. Keep secrets, native paths, handles, and runtime
//! tokens out of this crate.

mod bindings;
mod current;
mod error;
mod limits;
mod operation;
mod plugin;
mod plugin_v2;
mod serial;
mod shutdown;
mod state;
mod workspace;

pub use bindings::render_typescript;
pub use current::*;
pub use error::*;
pub use limits::*;
pub use operation::*;
pub use plugin::*;
pub use plugin_v2::*;
pub use serial::*;
pub use shutdown::*;
pub use state::*;
pub use workspace::*;

/// Schema version of the generated IPC declarations themselves.
pub const CONTRACT_SCHEMA_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_and_foundation_wire_shapes_are_stable_and_generation_is_reproducible() {
        let error = IpcError {
            code: AppErrorCode::RevisionConflict,
            message_key: "error.revision_conflict",
            retryable: false,
            operation: "workspace_apply_batch",
            request_id: Some("req-1".into()),
            field: None,
            limit: None,
            actual: None,
            retry_after_ms: None,
        };
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "code": "REVISION_CONFLICT",
                "messageKey": "error.revision_conflict",
                "retryable": false,
                "operation": "workspace_apply_batch",
                "requestId": "req-1"
            })
        );
        let rate_limited = IpcError::new(
            AppErrorCode::RateLimited,
            "error.rate_limited",
            true,
            "run_ai_request",
        )
        .with_retry_after(750);
        assert_eq!(rate_limited.retry_after_ms, Some(750));

        let export = BeginExportRequest {
            format: ExportFormat::Jsonl,
            token: "opaque-grant".to_owned(),
            expected_frames: 2,
            expected_raw_bytes: 3,
            source: None,
        };
        assert_eq!(
            serde_json::to_value(&export).unwrap(),
            serde_json::json!({
                "format": "jsonl",
                "token": "opaque-grant",
                "expectedFrames": 2,
                "expectedRawBytes": 3
            })
        );

        // Backend-source mode is additive: the optional selector round-trips
        // and the renderer-source request stays byte-compatible.
        let backend = serde_json::to_value(BeginExportRequest {
            source: Some(ExportSource::WorkspaceFrames {
                workspace_id: "01234567-89ab-cdef-0123-456789abcdef".to_owned(),
                session_id: "session-1".to_owned(),
                to_seq_exclusive: 42,
            }),
            ..export
        })
        .unwrap();
        assert_eq!(
            backend,
            serde_json::json!({
                "format": "jsonl",
                "token": "opaque-grant",
                "expectedFrames": 2,
                "expectedRawBytes": 3,
                "source": {
                    "kind": "workspace-frames",
                    "workspaceId": "01234567-89ab-cdef-0123-456789abcdef",
                    "sessionId": "session-1",
                    "toSeqExclusive": 42,
                }
            })
        );

        let send = SerialSendResult {
            outcome: SerialSendOutcome::Partial,
            requested_bytes: 8,
            sent_bytes: 3,
            error: Some(IpcError::new(
                AppErrorCode::SerialPartialWrite,
                "error.serial_partial_write",
                false,
                "serial_send",
            )),
        };
        assert_eq!(
            serde_json::to_value(send).unwrap(),
            serde_json::json!({
                "outcome": "partial",
                "requestedBytes": 8,
                "sentBytes": 3,
                "error": {
                    "code": "SERIAL_PARTIAL_WRITE",
                    "messageKey": "error.serial_partial_write",
                    "retryable": false,
                    "operation": "serial_send"
                }
            })
        );

        let envelope = StateEnvelope {
            schema_version: 1,
            workspace_id: "workspace-1".to_owned(),
            revision: 9,
            origin: StateOrigin::Main,
            request_id: Some("req-2".to_owned()),
            session_id: None,
            payload: AiWindowState { visible: true },
        };
        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            serde_json::json!({
                "schemaVersion": 1,
                "workspaceId": "workspace-1",
                "revision": 9,
                "origin": "main",
                "requestId": "req-2",
                "payload": { "visible": true }
            })
        );

        let first = render_typescript();
        let second = render_typescript();
        assert_eq!(first, second);
        for required in [
            "export type IpcError",
            "export type BeginExportRequest",
            "export type StateEnvelope",
            "export type OperationRecord",
            "export type PluginCommandResponse",
            "export type PluginCenterData",
            "export type InstalledPluginView",
            "export type SerialSendResult",
            "export type PortLeaseConflict",
            "export const IPC_LIMITS",
        ] {
            assert!(
                first.contains(required),
                "missing generated declaration: {required}"
            );
        }
        assert!(
            !first.contains("apiKey"),
            "credentials must never enter bindings"
        );
        assert!(first.ends_with('\n'));
    }
}
