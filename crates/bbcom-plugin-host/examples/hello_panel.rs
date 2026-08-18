//! End-to-end usage example for the `examples/plugins/hello-panel` plugin.
//!
//! Stage 1 assembles the reviewed WAT source into a real package layout
//! (`plugin.toml` + `component/plugin.wasm`), then proves the trust boundary by
//! loading a tampered copy and expecting the digest rejection.
//!
//! Stage 2 loads the verified artifact through the production in-process
//! engine (`PluginEngineFactory`) — the same code the sidecar uses — restores
//! empty persisted state, runs `initialize` (the guest calls the
//! `storage-set` host import), prints the persisted storage the call produced,
//! and shuts down.
//!
//! Stage 3 repeats the lifecycle against the real sandboxed sidecar binary,
//! speaking the framed protobuf protocol over stdin/stdout: handshake, state
//! upload, initialize, state download, two-phase shutdown.
//!
//! Run with:
//! `cargo build -p bbcom-plugin-host --example hello_panel --bin bbcom-plugin-host`
//! then `cargo run -p bbcom-plugin-host --example hello_panel`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use bbcom_plugin_contracts::generated::{
    CompleteShutdownRequest, Envelope, GetStateChunkRequest, HostHello, InitializeRequest,
    OpaqueStateKind, PluginStorageSnapshot, PutStateChunkRequest, ShutdownRequest, envelope,
};
use bbcom_plugin_contracts::{
    HOST_PROCESS_MEMORY_LIMIT_BYTES, MAX_PLUGIN_STATE_CHUNK_BYTES, PLUGIN_STATE_SCHEMA_VERSION,
    PROTOCOL_MAJOR, PROTOCOL_MINOR, Permission, WIT_PACKAGE,
};
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};
use bbcom_plugin_host::{PluginEngineFactory, TrustedPluginArtifact};
use prost::Message;
use sha2::{Digest, Sha256};

const PLUGIN_WAT: &[u8] = include_bytes!("../../../examples/plugins/hello-panel/plugin.wat");
const PLUGIN_ID: &str = "dev.bbcom.hello-panel";
const PLUGIN_VERSION: &str = "1.0.0";
const SIDECAR_BASENAME: &str = "bbcom-plugin-host";

#[cfg(target_os = "linux")]
const PLATFORM: &str = "linux";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";

fn main() {
    let package_root = tempfile::tempdir().expect("package root");
    let manifest_text = stage1_assemble_package(package_root.path());
    stage1_reject_tampered_component(package_root.path(), &manifest_text);
    stage2_run_in_process_engine(package_root.path(), &manifest_text);
    stage3_run_sidecar_process(package_root.path());
}

/// Compiles the reviewed WAT source and materializes the exact on-disk package
/// layout the installer produces: a `plugin.toml` manifest whose
/// `component.sha256` pins the compiled component.
fn stage1_assemble_package(package_root: &Path) -> String {
    println!("== stage 1: package assembly ==");
    let component = wat::parse_bytes(PLUGIN_WAT).expect("reviewed component text compiles");
    let digest: String = Sha256::digest(&component)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!(
        "compiled component: {} bytes, sha256 {digest}",
        component.len()
    );
    fs::create_dir_all(package_root.join("component")).expect("component directory");
    fs::write(package_root.join("component/plugin.wasm"), &component).expect("component binary");
    let manifest = format!(
        "id = \"{PLUGIN_ID}\"\n\
         name = \"Hello Panel Example\"\n\
         version = \"{PLUGIN_VERSION}\"\n\
         api = \"^1.0\"\n\
         requested-capabilities = [\"ui.panel\", \"plugin.storage\"]\n\
         \n\
         [component]\n\
         path = \"component/plugin.wasm\"\n\
         sha256 = \"{digest}\"\n\
         \n\
         [publisher]\n\
         name = \"bbcom Examples\"\n\
         identity = \"publisher:bbcom-examples\"\n\
         website = \"https://example.invalid\"\n"
    );
    fs::write(package_root.join("plugin.toml"), &manifest).expect("manifest");
    println!(
        "wrote plugin.toml + component/plugin.wasm under {}",
        package_root.display()
    );
    manifest
}

/// The artifact loader is the first trust gate: a single flipped byte must fail
/// closed with the stable digest-mismatch code before any engine sees it.
fn stage1_reject_tampered_component(package_root: &Path, manifest_text: &str) {
    println!("== stage 1: tamper rejection ==");
    let tampered_root = tempfile::tempdir().expect("tampered package root");
    fs::create_dir_all(tampered_root.path().join("component")).expect("component directory");
    let mut component =
        fs::read(package_root.join("component/plugin.wasm")).expect("component binary");
    let last = component.len() - 1;
    component[last] ^= 0xff;
    fs::write(
        tampered_root.path().join("component/plugin.wasm"),
        &component,
    )
    .expect("tampered component");
    let error = TrustedPluginArtifact::load(tampered_root.path(), manifest_text)
        .expect_err("tampered component must be rejected");
    assert_eq!(error.code(), "PLUGIN_COMPONENT_HASH_MISMATCH");
    println!("flipped byte rejected with {}", error.code());
}

/// The in-process path the sidecar itself uses: digest-verified load, empty
/// persisted state restored, initialize, persisted storage observed, shutdown.
fn stage2_run_in_process_engine(package_root: &Path, manifest_text: &str) {
    println!("== stage 2: in-process engine ==");
    let artifact =
        TrustedPluginArtifact::load(package_root, manifest_text).expect("verified artifact");
    let factory = PluginEngineFactory::new().expect("fixed engine policy");
    let mut runtime = factory
        .load(&artifact, [Permission::UiPanel, Permission::PluginStorage])
        .expect("component matches bbcom:plugin/plugin@1.0.0");
    let empty_storage = PluginStorageSnapshot {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        entries: Vec::new(),
    }
    .encode_to_vec();
    runtime
        .restore_persisted_state(&empty_storage, None)
        .expect("empty persisted state");
    runtime.initialize().expect("initialize returns the panel");
    println!("initialize: panel published, guest called the storage-set host import");
    let (storage, _project_state) = runtime.persisted_state();
    print_persisted_storage(&storage);
    runtime.shutdown().expect("clean shutdown");
    drop(runtime);
    println!("shutdown: clean");
}

/// The production topology: the sidecar binary runs the same engine inside its
/// own process and we drive it over the length-prefixed protobuf protocol.
fn stage3_run_sidecar_process(package_root: &Path) {
    println!("== stage 3: sidecar process ==");
    let Some(sidecar_path) = locate_sidecar_binary() else {
        println!("skipped: build the sidecar first with");
        println!(
            "  cargo build -p bbcom-plugin-host --example hello_panel --bin bbcom-plugin-host"
        );
        return;
    };
    println!("sidecar binary: {}", sidecar_path.display());
    let mut child = Command::new(&sidecar_path)
        .arg("--package-root")
        .arg(package_root)
        .arg("--platform")
        .arg(PLATFORM)
        .arg("--memory-limit-bytes")
        .arg(HOST_PROCESS_MEMORY_LIMIT_BYTES.to_string())
        .arg("--sandbox-no-children")
        .arg("--sandbox-no-network")
        .arg("--sandbox-private-fs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn bbcom-plugin-host sidecar");
    let mut client = SidecarClient::new(&mut child);

    client.send(envelope::Payload::HostHello(HostHello {
        wit_package: WIT_PACKAGE.to_owned(),
        plugin_id: PLUGIN_ID.to_owned(),
        plugin_version: PLUGIN_VERSION.to_owned(),
        granted_capabilities: vec![
            Permission::UiPanel.to_string(),
            Permission::PluginStorage.to_string(),
        ],
    }));
    let hello = client.receive("plugin hello");
    match hello.payload {
        Some(envelope::Payload::PluginHello(message)) => println!(
            "handshake: plugin {} {} ({})",
            message.plugin_id, message.plugin_version, message.wit_package
        ),
        other => panic!("expected PluginHello, got {other:?}"),
    }

    let empty_storage = PluginStorageSnapshot {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        entries: Vec::new(),
    }
    .encode_to_vec();
    client.send(envelope::Payload::PutStateChunkRequest(
        PutStateChunkRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            kind: OpaqueStateKind::PluginStorage as i32,
            total_bytes: empty_storage.len() as u64,
            offset: 0,
            payload: empty_storage,
            final_chunk: true,
        },
    ));
    match client.receive("state upload").payload {
        Some(envelope::Payload::PutStateChunkResponse(response)) => {
            println!("state upload: {} bytes accepted", response.accepted_bytes);
        }
        other => panic!("expected PutStateChunkResponse, got {other:?}"),
    }

    client.send(envelope::Payload::InitializeRequest(InitializeRequest {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        has_plugin_storage: true,
        has_project_state: false,
    }));
    let initialized = match client.receive("initialize").payload {
        Some(envelope::Payload::InitializeResponse(response)) => response,
        other => panic!("expected InitializeResponse, got {other:?}"),
    };
    let descriptor = initialized.state.expect("state descriptor");
    println!(
        "initialize: revision {}, plugin storage {} bytes",
        descriptor.revision, descriptor.plugin_storage_bytes
    );

    client.send(envelope::Payload::GetStateChunkRequest(
        GetStateChunkRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            revision: descriptor.revision,
            kind: OpaqueStateKind::PluginStorage as i32,
            offset: 0,
            max_bytes: MAX_PLUGIN_STATE_CHUNK_BYTES.min(u32::MAX as usize) as u32,
        },
    ));
    match client.receive("state download").payload {
        Some(envelope::Payload::GetStateChunkResponse(response)) => {
            print_persisted_storage(&response.payload);
        }
        other => panic!("expected GetStateChunkResponse, got {other:?}"),
    }

    client.send(envelope::Payload::ShutdownRequest(ShutdownRequest {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
    }));
    let shutdown = match client.receive("shutdown").payload {
        Some(envelope::Payload::ShutdownResponse(response)) => response,
        other => panic!("expected ShutdownResponse, got {other:?}"),
    };
    let descriptor = shutdown.state.expect("state descriptor");
    println!(
        "shutdown prepared: revision {}, plugin storage {} bytes",
        descriptor.revision, descriptor.plugin_storage_bytes
    );

    client.send(envelope::Payload::CompleteShutdownRequest(
        CompleteShutdownRequest {
            state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
            revision: descriptor.revision,
        },
    ));
    match client.receive("complete shutdown").payload {
        Some(envelope::Payload::CompleteShutdownResponse(_)) => {
            println!("complete shutdown: sidecar state persisted, process exiting");
        }
        other => panic!("expected CompleteShutdownResponse, got {other:?}"),
    }

    client.finish();
    let status = child.wait().expect("sidecar exit status");
    println!("sidecar exited with {}", status.code().unwrap_or(-1));
}

struct SidecarClient {
    reader: FrameReader<ChildStdout>,
    writer: FrameWriter<ChildStdin>,
    next_request_id: u64,
}

impl SidecarClient {
    fn new(child: &mut Child) -> Self {
        Self {
            reader: FrameReader::new(child.stdout.take().expect("sidecar stdout")),
            writer: FrameWriter::new(child.stdin.take().expect("sidecar stdin")),
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

    fn receive(&mut self, step: &str) -> Envelope {
        match self.reader.read_envelope() {
            Ok(Some(envelope)) => {
                if let Some(envelope::Payload::Error(error)) = envelope.payload.as_ref() {
                    panic!(
                        "{step}: sidecar returned {} ({})",
                        error.code, error.message_key
                    );
                }
                envelope
            }
            Ok(None) => panic!("{step}: sidecar closed the pipe (see its stderr above)"),
            Err(error) => panic!("{step}: frame error {}", error.code()),
        }
    }

    fn finish(mut self) {
        // Drain until the sidecar closes stdout after CompleteShutdown.
        let _ = self.reader.read_envelope();
    }
}

fn print_persisted_storage(storage: &[u8]) {
    let snapshot = PluginStorageSnapshot::decode(storage).expect("persisted storage snapshot");
    for entry in &snapshot.entries {
        println!(
            "persisted storage: {} = {}",
            entry.key,
            String::from_utf8_lossy(&entry.value)
        );
    }
}

fn locate_sidecar_binary() -> Option<PathBuf> {
    let executable_name = if cfg!(windows) {
        format!("{SIDECAR_BASENAME}.exe")
    } else {
        SIDECAR_BASENAME.to_owned()
    };
    let mut candidates = Vec::new();
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        candidates.push(Path::new(&target_dir).join("debug").join(&executable_name));
        candidates.push(
            Path::new(&target_dir)
                .join("release")
                .join(&executable_name),
        );
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(profile_dir) = executable.parent().and_then(Path::parent)
    {
        candidates.push(profile_dir.join(&executable_name));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}
