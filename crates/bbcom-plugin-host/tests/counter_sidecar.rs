//! Drives the REAL sidecar binary against the bundled sample plugin
//! (`tests/fixtures/plugins/counter`): process-spawned, handshake, seeded
//! state upload, initialize, a panel event, shutdown, and a full storage
//! read-back through the wire protocol. This is the same protocol the
//! packaged application host uses.

use std::io::BufReader;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use prost::Message;
use serde_json::Value;

use bbcom_plugin_contracts::generated::{
    Envelope, GetStateChunkRequest, HostHello, InitializeRequest, InvokeRequest, InvokeResponse,
    PluginStorageEntry, PluginStorageSnapshot, PutStateChunkRequest, SessionQueryResponse,
    envelope,
};
use bbcom_plugin_contracts::{PLUGIN_STATE_SCHEMA_VERSION, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};

const PACKAGE_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/plugins/counter"
);
const STATE_KIND_PLUGIN_STORAGE: i32 = 1;

struct SidecarProcess {
    child: Option<Child>,
    writer: FrameWriter<ChildStdin>,
    reader: FrameReader<BufReader<ChildStdout>>,
    next_request_id: u64,
}

impl SidecarProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bbcom-plugin-host"))
            .arg("--package-root")
            .arg(PACKAGE_ROOT)
            .arg("--platform")
            .arg("linux")
            .arg("--memory-limit-bytes")
            .arg("33554432")
            .arg("--sandbox-no-children")
            .arg("--sandbox-no-network")
            .arg("--sandbox-private-fs")
            .arg("--grant")
            .arg("session.metadata.read")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("sidecar binary spawns");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        Self {
            child: Some(child),
            writer: FrameWriter::new(stdin),
            reader: FrameReader::new(BufReader::new(stdout)),
            next_request_id: 1,
        }
    }

    fn send(&mut self, payload: envelope::Payload) -> u64 {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        self.writer
            .write_envelope(&Envelope {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                request_id,
                payload: Some(payload),
            })
            .expect("write frame");
        request_id
    }

    fn receive(&mut self) -> Envelope {
        self.reader
            .read_envelope()
            .expect("read frame")
            .expect("stream stays open")
    }

    fn round_trip(&mut self, payload: envelope::Payload) -> Envelope {
        let request_id = self.send(payload);
        // While the guest executes it may push session/proposal requests
        // that the main process must answer before the actual response can
        // be produced — act as that main process here.
        loop {
            let response = self.receive();
            match response.payload {
                Some(envelope::Payload::SessionQueryRequest(query)) => {
                    let query_id = match &query.query {
                        Some(_) => query.query_id.clone(),
                        None => String::new(),
                    };
                    // Echo the push's request id: wire validation rejects 0.
                    let reply_request_id = response.request_id;
                    self.writer
                        .write_envelope(&Envelope {
                            protocol_major: PROTOCOL_MAJOR,
                            protocol_minor: PROTOCOL_MINOR,
                            request_id: reply_request_id,
                            payload: Some(envelope::Payload::SessionQueryResponse(
                                SessionQueryResponse {
                                    query_id,
                                    ok: true,
                                    error_code: String::new(),
                                    sessions: Vec::new(),
                                    frames: Vec::new(),
                                    next_sequence: 0,
                                    has_more: false,
                                },
                            )),
                        })
                        .expect("query reply frame");
                }
                _ => {
                    assert_eq!(response.request_id, request_id);
                    return response;
                }
            }
        }
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn seeded_storage(counter: &str) -> Vec<u8> {
    PluginStorageSnapshot {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        entries: vec![PluginStorageEntry {
            key: "counter".to_owned(),
            value: counter.as_bytes().to_vec(),
        }],
    }
    .encode_to_vec()
}

fn storage_counter(bytes: &[u8]) -> String {
    let snapshot = PluginStorageSnapshot::decode(bytes).expect("storage snapshot");
    snapshot
        .entries
        .iter()
        .find(|entry| entry.key == "counter")
        .map(|entry| String::from_utf8(entry.value.clone()).expect("utf8 counter"))
        .unwrap_or_default()
}

fn panel_field_value(panel: &Value, id: &str) -> String {
    panel["fields"]
        .as_array()
        .expect("panel fields")
        .iter()
        .find(|field| field["id"] == id)
        .unwrap_or_else(|| panic!("field {id} present"))
        .get("value")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn counter_plugin_runs_in_the_real_sidecar_process() {
    let mut sidecar = SidecarProcess::spawn();

    // Handshake: the app identity must match the manifest exactly.
    let response = sidecar.round_trip(envelope::Payload::HostHello(HostHello {
        wit_package: "bbcom:plugin@1.0.0".to_owned(),
        plugin_id: "dev.bbcom.counter-panel".to_owned(),
        plugin_version: "1.0.0".to_owned(),
        granted_capabilities: vec![
            "session.metadata.read".to_owned(),
            "ui.panel".to_owned(),
            "plugin.storage".to_owned(),
        ],
    }));
    match response.payload {
        Some(envelope::Payload::PluginHello(hello)) => {
            assert_eq!(hello.plugin_id, "dev.bbcom.counter-panel");
        }
        other => panic!("expected plugin hello, got {other:?}"),
    }

    // Seed the plugin with a persisted counter of 5.
    let seeded = seeded_storage("5");
    let response = sidecar.round_trip(envelope::Payload::PutStateChunkRequest(
        PutStateChunkRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            kind: STATE_KIND_PLUGIN_STORAGE,
            offset: 0,
            total_bytes: seeded.len() as u64,
            payload: seeded,
            final_chunk: true,
        },
    ));
    assert!(matches!(
        response.payload,
        Some(envelope::Payload::PutStateChunkResponse(_))
    ));

    // Initialize: the guest restores the seeded storage in its own process.
    let response = sidecar.round_trip(envelope::Payload::InitializeRequest(InitializeRequest {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        has_plugin_storage: true,
        has_project_state: false,
    }));
    let descriptor = match response.payload {
        Some(envelope::Payload::InitializeResponse(message)) => message.state,
        other => panic!("expected initialize response, got {other:?}"),
    }
    .expect("descriptor");
    assert!(descriptor.plugin_storage_bytes > 0);

    // A panel event bumps the persisted counter inside the sidecar process.
    let response = sidecar.round_trip(envelope::Payload::InvokeRequest(InvokeRequest {
        method: "panel-event".to_owned(),
        body: br#"{"fieldId":"bump","value":""}"#.to_vec(),
        long_running: false,
    }));
    let invoke = match response.payload {
        Some(envelope::Payload::InvokeResponse(InvokeResponse { body })) => body,
        other => panic!("expected invoke response, got {other:?}"),
    };
    let panel: Value = serde_json::from_slice(&invoke).expect("panel json");
    assert_eq!(panel["title"], "Serial counter");
    assert_eq!(panel_field_value(&panel, "count"), "6");
    assert_eq!(panel_field_value(&panel, "sessions"), "0");

    // Unknown fields leave state untouched but still republish the panel.
    let response = sidecar.round_trip(envelope::Payload::InvokeRequest(InvokeRequest {
        method: "panel-event".to_owned(),
        body: br#"{"fieldId":"unknown","value":"x"}"#.to_vec(),
        long_running: false,
    }));
    let invoke = match response.payload {
        Some(envelope::Payload::InvokeResponse(InvokeResponse { body })) => body,
        other => panic!("expected invoke response, got {other:?}"),
    };
    let panel: Value = serde_json::from_slice(&invoke).expect("panel json");
    assert_eq!(panel_field_value(&panel, "count"), "6");

    // Shutdown publishes the final state descriptor.
    let response = sidecar.round_trip(envelope::Payload::ShutdownRequest(
        bbcom_plugin_contracts::generated::ShutdownRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        },
    ));
    let final_state = match response.payload {
        Some(envelope::Payload::ShutdownResponse(message)) => message.state,
        other => panic!("expected shutdown response, got {other:?}"),
    }
    .expect("final descriptor");

    // Read the durable storage back through the wire: the counter the guest
    // wrote via its host import must be exactly what the app would persist.
    let response = sidecar.round_trip(envelope::Payload::GetStateChunkRequest(
        GetStateChunkRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            revision: final_state.revision,
            kind: STATE_KIND_PLUGIN_STORAGE,
            offset: 0,
            max_bytes: final_state.plugin_storage_bytes.clamp(1, 262_144) as u32,
        },
    ));
    let chunk = match response.payload {
        Some(envelope::Payload::GetStateChunkResponse(chunk)) => chunk,
        other => panic!("expected state chunk, got {other:?}"),
    };
    assert_eq!(storage_counter(&chunk.payload), "6");

    // Complete-shutdown closes the child cleanly with a zero exit code.
    let final_revision = final_state.revision;
    sidecar.round_trip(envelope::Payload::CompleteShutdownRequest(
        bbcom_plugin_contracts::generated::CompleteShutdownRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            revision: final_revision,
        },
    ));
    let mut child = sidecar.child.take().expect("child present");
    let status = child.wait().expect("sidecar exits");
    assert!(status.success(), "sidecar exited cleanly: {status:?}");
    drop(sidecar);
}
