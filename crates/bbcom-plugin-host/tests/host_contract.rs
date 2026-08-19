use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use bbcom_plugin_contracts::generated::{
    CancelRequest, CompleteShutdownRequest, Envelope, Event, GetStateChunkRequest, HostHello,
    InitializeRequest, InvokeRequest, OpaqueStateKind, PutStateChunkRequest, ShutdownRequest,
    envelope,
};
use bbcom_plugin_contracts::{
    HOST_PROCESS_MEMORY_LIMIT_BYTES, MAX_FRAME_BYTES, MAX_QUEUE_BYTES, PLUGIN_STATE_SCHEMA_VERSION,
    PROTOCOL_MAJOR, PROTOCOL_MINOR, Permission, WIT_PACKAGE, encode_frame, parse_permission,
};
use bbcom_plugin_host::transport::{BoundedFrameQueue, FrameReader, FrameWriter};
use bbcom_plugin_host::{
    AmbientAuthorityPolicy, CallKind, HandshakeExpectation, HandshakeMachine, HostError,
    HostPlatform, HostPolicy, PluginEngineFactory, PluginExecutor, PluginInterrupt,
    ProcessLimitPolicy, Sidecar, SidecarExit, TrustedPluginArtifact,
};
use sha2::{Digest, Sha256};

fn envelope(request_id: u64, payload: envelope::Payload) -> Envelope {
    Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        request_id,
        payload: Some(payload),
    }
}

fn host_hello(request_id: u64, plugin_id: &str, capabilities: &[&str]) -> Envelope {
    envelope(
        request_id,
        envelope::Payload::HostHello(HostHello {
            wit_package: WIT_PACKAGE.to_owned(),
            plugin_id: plugin_id.to_owned(),
            plugin_version: "1.2.3".to_owned(),
            granted_capabilities: capabilities
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        }),
    )
}

#[test]
fn strict_handshake_rejects_wrong_first_frame_deadline_and_grants() {
    let granted = [Permission::UiPanel, Permission::PluginStorage];
    let expectation = HandshakeExpectation::new("com.example.plugin", "1.2.3", granted);
    let start = Instant::now();
    let mut machine = HandshakeMachine::started(expectation.clone(), start);
    let wrong_first = envelope(
        1,
        envelope::Payload::InvokeRequest(InvokeRequest {
            method: "initialize".to_owned(),
            body: Vec::new(),
            long_running: false,
        }),
    );
    assert!(matches!(
        machine.accept(wrong_first, start),
        Err(HostError::InvalidHandshake)
    ));

    let mut machine = HandshakeMachine::started(expectation.clone(), start);
    assert!(matches!(
        machine.accept(host_hello(2, "com.example.plugin", &["ui.panel"]), start),
        Err(HostError::InvalidHandshake)
    ));

    let mut machine = HandshakeMachine::started(expectation, start);
    assert!(matches!(
        machine.accept(
            host_hello(3, "com.example.plugin", &["ui.panel", "plugin.storage"]),
            start + Duration::from_millis(5_001)
        ),
        Err(HostError::HandshakeTimeout)
    ));
}

#[test]
fn handshake_response_is_bound_to_the_expected_component() {
    let start = Instant::now();
    let mut machine = HandshakeMachine::started(
        HandshakeExpectation::new(
            "com.example.plugin",
            "1.2.3",
            [Permission::UiPanel, Permission::PluginStorage],
        ),
        start,
    );
    let response = machine
        .accept(
            host_hello(42, "com.example.plugin", &["plugin.storage", "ui.panel"]),
            start,
        )
        .expect("valid hello");
    let envelope::Payload::PluginHello(hello) = response.payload.expect("payload") else {
        panic!("expected plugin hello")
    };
    assert_eq!(response.request_id, 42);
    assert_eq!(hello.plugin_id, "com.example.plugin");
    assert_eq!(hello.wit_package, WIT_PACKAGE);
    assert!(machine.is_established());
}

#[test]
fn frame_transport_is_little_endian_bounded_and_exact() {
    let hello = host_hello(7, "com.example.plugin", &["ui.panel", "plugin.storage"]);
    let mut encoded = Vec::new();
    FrameWriter::new(&mut encoded)
        .write_envelope(&hello)
        .expect("write frame");
    let announced = u32::from_le_bytes(encoded[..4].try_into().expect("prefix")) as usize;
    assert_eq!(announced, encoded.len() - 4);
    let decoded = FrameReader::new(Cursor::new(encoded))
        .read_envelope()
        .expect("read")
        .expect("frame");
    assert_eq!(decoded, hello);

    let mut oversize = Vec::from(((MAX_FRAME_BYTES + 1) as u32).to_le_bytes());
    oversize.extend_from_slice(&[0; 4]);
    assert!(matches!(
        FrameReader::new(Cursor::new(oversize)).read_envelope(),
        Err(HostError::Contract(_))
    ));
    assert!(matches!(
        FrameReader::new(Cursor::new(vec![1, 0])).read_envelope(),
        Err(HostError::TruncatedTransport)
    ));

    let mut queue = BoundedFrameQueue::default();
    for _ in 0..16 {
        queue.push(vec![0; 1024 * 1024]).expect("within queue");
    }
    assert_eq!(queue.queued_bytes(), MAX_QUEUE_BYTES);
    assert!(matches!(queue.push(vec![0]), Err(HostError::Contract(_))));
    queue.pop();
    queue.push(vec![0]).expect("space released on pop");
}

#[derive(Clone)]
struct MockExecutor {
    calls: Arc<Mutex<Vec<CallKind>>>,
    shutdowns: Arc<Mutex<u32>>,
}

impl PluginExecutor for MockExecutor {
    fn initialize_with_kind(&mut self, kind: CallKind) -> bbcom_plugin_host::error::Result<()> {
        self.calls.lock().expect("calls").push(kind);
        Ok(())
    }

    fn shutdown(&mut self) -> bbcom_plugin_host::error::Result<()> {
        *self.shutdowns.lock().expect("shutdowns") += 1;
        Ok(())
    }

    fn restore_persisted_state(
        &mut self,
        _plugin_storage: &[u8],
        _project_state: Option<Vec<u8>>,
    ) -> bbcom_plugin_host::error::Result<()> {
        Ok(())
    }

    fn handle_panel_event(
        &mut self,
        _event: bbcom_plugin_host::bindings::PanelEvent,
    ) -> bbcom_plugin_host::error::Result<()> {
        Ok(())
    }

    fn take_published_panel(&mut self) -> Option<bbcom_plugin_host::bindings::DeclarativePanel> {
        None
    }
    fn persisted_state(&self) -> (Vec<u8>, Option<Vec<u8>>) {
        (bbcom_plugin_contracts::empty_plugin_storage_payload(), None)
    }
}

type MockSidecar = (
    Sidecar<MockExecutor>,
    Arc<Mutex<Vec<CallKind>>>,
    Arc<Mutex<u32>>,
);

fn mock_sidecar() -> MockSidecar {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shutdowns = Arc::new(Mutex::new(0));
    let executor = MockExecutor {
        calls: Arc::clone(&calls),
        shutdowns: Arc::clone(&shutdowns),
    };
    let expectation = HandshakeExpectation::new(
        "com.example.plugin",
        "1.2.3",
        [Permission::UiPanel, Permission::PluginStorage],
    );
    (Sidecar::new(executor, expectation), calls, shutdowns)
}

#[test]
fn sidecar_dispatches_one_component_and_cleanly_shuts_down() {
    let storage = bbcom_plugin_contracts::empty_plugin_storage_payload();
    let mut input = encode_frame(&host_hello(
        1,
        "com.example.plugin",
        &["ui.panel", "plugin.storage"],
    ))
    .expect("hello");
    input.extend_from_slice(
        &encode_frame(&envelope(
            2,
            envelope::Payload::PutStateChunkRequest(PutStateChunkRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                kind: OpaqueStateKind::PluginStorage as i32,
                total_bytes: storage.len() as u64,
                offset: 0,
                payload: storage.clone(),
                final_chunk: true,
            }),
        ))
        .expect("state upload"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            3,
            envelope::Payload::InitializeRequest(InitializeRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                has_plugin_storage: true,
                has_project_state: false,
            }),
        ))
        .expect("initialize"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            4,
            envelope::Payload::GetStateChunkRequest(GetStateChunkRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                revision: 1,
                kind: OpaqueStateKind::PluginStorage as i32,
                offset: 0,
                max_bytes: 1024,
            }),
        ))
        .expect("state read"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            5,
            envelope::Payload::InvokeRequest(InvokeRequest {
                method: "initialize".to_owned(),
                body: Vec::new(),
                long_running: false,
            }),
        ))
        .expect("legacy initialize"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            6,
            envelope::Payload::CancelRequest(CancelRequest {
                target_request_id: 2,
            }),
        ))
        .expect("cancel"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            7,
            envelope::Payload::Event(Event {
                topic: "invalid-direction".to_owned(),
                body: Vec::new(),
            }),
        ))
        .expect("invalid payload"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            8,
            envelope::Payload::ShutdownRequest(ShutdownRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            }),
        ))
        .expect("shutdown"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            9,
            envelope::Payload::GetStateChunkRequest(GetStateChunkRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                revision: 2,
                kind: OpaqueStateKind::PluginStorage as i32,
                offset: 0,
                max_bytes: 1024,
            }),
        ))
        .expect("final state read"),
    );
    input.extend_from_slice(
        &encode_frame(&envelope(
            10,
            envelope::Payload::CompleteShutdownRequest(CompleteShutdownRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                revision: 2,
            }),
        ))
        .expect("complete shutdown"),
    );
    let (mut sidecar, calls, shutdowns) = mock_sidecar();
    let mut output = Vec::new();
    let exit = sidecar
        .run(Cursor::new(input), &mut output)
        .expect("sidecar run");
    assert_eq!(exit, SidecarExit::ShutdownRequested);
    assert_eq!(*calls.lock().expect("calls"), [CallKind::Normal]);
    assert_eq!(*shutdowns.lock().expect("shutdowns"), 1);
    let mut frames = FrameReader::new(Cursor::new(output));
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::PluginHello(_))
    ));
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::PutStateChunkResponse(_))
    ));
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::InitializeResponse(_))
    ));
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::GetStateChunkResponse(_))
    ));
    for expected_code in [
        "PLUGIN_PROTOCOL_VERSION_UNSUPPORTED",
        "PLUGIN_OPERATION_NOT_FOUND",
        "PLUGIN_PROTOCOL_INVALID",
    ] {
        let Some(envelope::Payload::Error(error)) =
            frames.read_envelope().unwrap().unwrap().payload
        else {
            panic!("expected protocol error")
        };
        assert_eq!(error.code, expected_code);
    }
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::ShutdownResponse(_))
    ));
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::GetStateChunkResponse(_))
    ));
    assert!(matches!(
        frames.read_envelope().unwrap().unwrap().payload,
        Some(envelope::Payload::CompleteShutdownResponse(_))
    ));
    assert!(frames.read_envelope().unwrap().is_none());
}

#[test]
fn sidecar_eof_runs_clean_shutdown() {
    let input = encode_frame(&host_hello(
        1,
        "com.example.plugin",
        &["ui.panel", "plugin.storage"],
    ))
    .expect("hello");
    let (mut sidecar, _, shutdowns) = mock_sidecar();
    let exit = sidecar
        .run(Cursor::new(input), Vec::new())
        .expect("sidecar run");
    assert_eq!(exit, SidecarExit::PeerClosed);
    assert_eq!(*shutdowns.lock().expect("shutdowns"), 1);
}

#[derive(Default)]
struct BlockingCallState {
    entered: bool,
    interrupted: bool,
}

#[derive(Clone)]
struct BlockingInterrupt {
    state: Arc<(Mutex<BlockingCallState>, Condvar)>,
}

impl PluginInterrupt for BlockingInterrupt {
    fn interrupt(&self) {
        let (lock, condition) = &*self.state;
        lock.lock().expect("blocking state").interrupted = true;
        condition.notify_all();
    }
}

struct BlockingExecutor {
    state: Arc<(Mutex<BlockingCallState>, Condvar)>,
}

impl PluginExecutor for BlockingExecutor {
    fn handle_panel_event(
        &mut self,
        _event: bbcom_plugin_host::bindings::PanelEvent,
    ) -> bbcom_plugin_host::error::Result<()> {
        Ok(())
    }

    fn take_published_panel(&mut self) -> Option<bbcom_plugin_host::bindings::DeclarativePanel> {
        None
    }

    fn initialize_with_kind(&mut self, _kind: CallKind) -> bbcom_plugin_host::error::Result<()> {
        let (lock, condition) = &*self.state;
        let mut state = lock.lock().expect("blocking state");
        state.entered = true;
        condition.notify_all();
        while !state.interrupted {
            state = condition.wait(state).expect("blocking wait");
        }
        Err(bbcom_plugin_host::ExecutionFailure {
            kind: bbcom_plugin_host::ExecutionFailureKind::Timeout,
        }
        .into())
    }

    fn shutdown(&mut self) -> bbcom_plugin_host::error::Result<()> {
        Ok(())
    }

    fn restore_persisted_state(
        &mut self,
        _plugin_storage: &[u8],
        _project_state: Option<Vec<u8>>,
    ) -> bbcom_plugin_host::error::Result<()> {
        Ok(())
    }

    fn persisted_state(&self) -> (Vec<u8>, Option<Vec<u8>>) {
        (bbcom_plugin_contracts::empty_plugin_storage_payload(), None)
    }

    fn interrupt_handle(&self) -> Option<Arc<dyn PluginInterrupt>> {
        Some(Arc::new(BlockingInterrupt {
            state: Arc::clone(&self.state),
        }))
    }
}

struct ChannelReader {
    receiver: Receiver<Vec<u8>>,
    pending: VecDeque<u8>,
}

impl Read for ChannelReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        while self.pending.is_empty() {
            match self.receiver.recv() {
                Ok(bytes) => self.pending.extend(bytes),
                Err(_) => return Ok(0),
            }
        }
        let count = output.len().min(self.pending.len());
        for slot in &mut output[..count] {
            *slot = self.pending.pop_front().expect("pending byte");
        }
        Ok(count)
    }
}

#[derive(Clone, Default)]
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("output").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn send_frame(sender: &Sender<Vec<u8>>, frame: Envelope) {
    sender
        .send(encode_frame(&frame).expect("encode input"))
        .expect("send input");
}

#[test]
fn active_guest_call_is_interrupted_by_exact_request_and_has_one_terminal() {
    let storage = bbcom_plugin_contracts::empty_plugin_storage_payload();
    let state = Arc::new((Mutex::new(BlockingCallState::default()), Condvar::new()));
    let executor = BlockingExecutor {
        state: Arc::clone(&state),
    };
    let expectation = HandshakeExpectation::new(
        "com.example.plugin",
        "1.2.3",
        [Permission::UiPanel, Permission::PluginStorage],
    );
    let mut sidecar = Sidecar::new(executor, expectation);
    let (sender, receiver) = channel();
    let output = SharedWriter::default();
    let output_bytes = Arc::clone(&output.0);
    let sidecar_thread = std::thread::spawn(move || {
        sidecar.run(
            ChannelReader {
                receiver,
                pending: VecDeque::new(),
            },
            output,
        )
    });

    send_frame(
        &sender,
        host_hello(1, "com.example.plugin", &["ui.panel", "plugin.storage"]),
    );
    send_frame(
        &sender,
        envelope(
            2,
            envelope::Payload::PutStateChunkRequest(PutStateChunkRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                kind: OpaqueStateKind::PluginStorage as i32,
                total_bytes: storage.len() as u64,
                offset: 0,
                payload: storage,
                final_chunk: true,
            }),
        ),
    );
    send_frame(
        &sender,
        envelope(
            3,
            envelope::Payload::InitializeRequest(InitializeRequest {
                state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
                has_plugin_storage: true,
                has_project_state: false,
            }),
        ),
    );

    {
        let (lock, condition) = &*state;
        let entered = lock.lock().expect("blocking state");
        let (entered, wait) = condition
            .wait_timeout_while(entered, Duration::from_secs(1), |state| !state.entered)
            .expect("wait for guest");
        assert!(!wait.timed_out() && entered.entered);
    }
    send_frame(
        &sender,
        envelope(
            4,
            envelope::Payload::CancelRequest(CancelRequest {
                target_request_id: 3,
            }),
        ),
    );
    send_frame(
        &sender,
        envelope(
            5,
            envelope::Payload::CancelRequest(CancelRequest {
                target_request_id: 3,
            }),
        ),
    );
    drop(sender);

    assert_eq!(
        sidecar_thread.join().expect("sidecar thread").expect("run"),
        SidecarExit::PeerClosed
    );
    let bytes = output_bytes.lock().expect("output").clone();
    let mut frames = FrameReader::new(Cursor::new(bytes));
    let mut terminals = Vec::new();
    while let Some(frame) = frames.read_envelope().expect("output frame") {
        if let Some(envelope::Payload::Error(error)) = frame.payload {
            terminals.push((frame.request_id, error.code));
        }
    }
    assert_eq!(
        terminals,
        [
            (3, "PLUGIN_CANCELLED".to_owned()),
            (4, "PLUGIN_CANCELLED".to_owned()),
            (5, "PLUGIN_OPERATION_NOT_FOUND".to_owned()),
        ]
    );
}

#[test]
fn artifact_loader_rejects_hash_native_payload_symlink_and_oversize() {
    let directory = tempfile::tempdir().expect("tempdir");
    let component_dir = directory.path().join("component");
    fs::create_dir(&component_dir).expect("component dir");
    let bytes = wat::parse_str(include_str!("fixtures/empty-component.wat")).expect("component");
    let digest = hex_digest(&bytes);
    fs::write(component_dir.join("plugin.wasm"), &bytes).expect("component write");
    fs::write(directory.path().join("plugin.toml"), b"fixture").expect("manifest marker");
    let manifest_text = manifest(&digest);
    let artifact = TrustedPluginArtifact::load(directory.path(), &manifest_text).expect("artifact");
    assert_eq!(artifact.component_bytes(), bytes);

    assert!(matches!(
        TrustedPluginArtifact::load(directory.path(), &manifest(&"0".repeat(64))),
        Err(HostError::ComponentDigestMismatch)
    ));

    fs::write(directory.path().join("payload.exe"), b"MZpayload").expect("native payload");
    assert!(matches!(
        TrustedPluginArtifact::load(directory.path(), &manifest_text),
        Err(HostError::NativeExecutableForbidden)
    ));
    fs::remove_file(directory.path().join("payload.exe")).expect("remove fixture");

    let oversized = component_dir.join("plugin.wasm");
    fs::OpenOptions::new()
        .write(true)
        .open(&oversized)
        .expect("open")
        .set_len(100 * 1024 * 1024 + 1)
        .expect("sparse oversize");
    assert!(matches!(
        TrustedPluginArtifact::load(directory.path(), &manifest_text),
        Err(HostError::ComponentLimitExceeded)
    ));
}

#[cfg(unix)]
#[test]
fn artifact_loader_rejects_component_symlink() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("tempdir");
    fs::create_dir(directory.path().join("component")).expect("component dir");
    fs::write(directory.path().join("target.wasm"), b"target").expect("target");
    symlink(
        directory.path().join("target.wasm"),
        directory.path().join("component/plugin.wasm"),
    )
    .expect("symlink");
    fs::write(directory.path().join("plugin.toml"), b"fixture").expect("manifest marker");
    assert!(matches!(
        TrustedPluginArtifact::load(directory.path(), &manifest(&hex_digest(b"target"))),
        Err(HostError::ArtifactSymlink)
    ));
}

#[test]
fn factory_accepts_only_components_and_exposes_no_ambient_authority() {
    let factory = PluginEngineFactory::new().expect("factory");
    assert_eq!(factory.ambient_authority(), AmbientAuthorityPolicy::NONE);

    let directory = tempfile::tempdir().expect("tempdir");
    fs::create_dir(directory.path().join("component")).expect("component dir");
    fs::write(directory.path().join("plugin.toml"), b"fixture").expect("manifest marker");
    let module = wat::parse_str(include_str!("fixtures/core-module.wat")).expect("core module");
    fs::write(directory.path().join("component/plugin.wasm"), &module).expect("module");
    let artifact = TrustedPluginArtifact::load(directory.path(), &manifest(&hex_digest(&module)))
        .expect("artifact");
    assert!(matches!(
        factory.load(&artifact, []),
        Err(HostError::InvalidComponent)
    ));

    let component =
        wat::parse_str(include_str!("fixtures/empty-component.wat")).expect("component");
    fs::write(directory.path().join("component/plugin.wasm"), &component).expect("component");
    let artifact =
        TrustedPluginArtifact::load(directory.path(), &manifest(&hex_digest(&component)))
            .expect("artifact");
    assert!(matches!(
        factory.load(&artifact, []),
        Err(HostError::ComponentInstantiation)
    ));
}

#[test]
fn process_limit_policy_requires_all_platform_controls() {
    assert_eq!(HostPolicy::default(), HostPolicy::fixed());
    let valid = ProcessLimitPolicy {
        platform: HostPlatform::Linux,
        memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
        blocks_child_processes: true,
        blocks_network: true,
        restricts_filesystem: true,
    };
    valid.validate().expect("valid platform policy");
    assert!(matches!(
        ProcessLimitPolicy {
            blocks_network: false,
            ..valid
        }
        .validate(),
        Err(HostError::IncompleteSandbox)
    ));
    assert!(matches!(
        ProcessLimitPolicy {
            memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES + 1,
            ..valid
        }
        .validate(),
        Err(HostError::InvalidProcessLimit)
    ));
}

#[test]
fn permission_names_used_by_launch_and_handshake_are_strict() {
    assert_eq!(
        parse_permission("serial.write-proposal").expect("permission"),
        Permission::SerialWriteProposal
    );
    assert!(parse_permission("network.http").is_err());
    let permissions: BTreeSet<_> = [Permission::UiPanel, Permission::PluginStorage]
        .into_iter()
        .collect();
    assert_eq!(permissions.len(), 2);
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn manifest(digest: &str) -> String {
    format!(
        r#"id = "com.example.plugin"
name = "Example"
version = "1.2.3"
api = "^1.0"
requested-capabilities = []

[component]
path = "component/plugin.wasm"
sha256 = "{digest}"

[publisher]
name = "Example"
identity = "publisher:example"
website = "https://example.invalid"
"#
    )
}
