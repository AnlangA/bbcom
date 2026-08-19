use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bbcom_plugin_contracts::generated_v2::Capability;
use bbcom_plugin_contracts::v2::default_resource_limits;
use bbcom_plugin_host::bindings::bbcom::plugin::types as wit;
use bbcom_plugin_host::{
    AuthorizationRequest, CapabilityRpc, MessageIdSequence, PluginAuthorizationGate,
    PluginEngineFactory, PluginLaunchContext, TrustedPluginArtifact,
};
use sha2::{Digest, Sha256};

const PRIMARY: &str = "g45-malicious.component.wasm";
const AMBIENT: &str = "g45-ambient-import.component.wat";
const TRAP: &str = "g45-trap.component.wat";
const RUNAWAY: &str = "g45-runaway.component.wat";
const MEMORY: &str = "g45-memory.component.wat";

// Production intentionally permits only one Wasmtime Store in a sidecar
// process. These integration cases share one test process, so serialize the
// cases that instantiate a guest instead of weakening that invariant.
static RUNTIME_TEST_LOCK: Mutex<()> = Mutex::new(());

struct Allow;

impl PluginAuthorizationGate for Allow {
    fn authorize(&self, _request: &AuthorizationRequest) -> bool {
        true
    }
}

#[test]
fn reviewed_g45_sources_are_protocol_v2_components() {
    for name in [PRIMARY, AMBIENT, TRAP, RUNAWAY, MEMORY] {
        let source = fs::read(fixture(name)).unwrap();
        let text = core::str::from_utf8(&source).unwrap();
        assert!(text.contains("bbcom:plugin/types@2.0.0"), "{name}");
        assert!(!text.contains("bbcom:plugin/types@1.0.0"), "{name}");
        for export in [
            "initialize",
            "handle-event",
            "run-command",
            "migrate-state",
            "shutdown",
        ] {
            assert!(text.contains(&format!("export \"{export}\"")), "{name}");
        }
        wat::parse_bytes(&source).unwrap();
    }
    assert!(
        fs::read_to_string(fixture(AMBIENT))
            .unwrap()
            .contains("wasi:sockets/network@0.2.0")
    );
}

#[test]
fn primary_fixture_executes_the_complete_v2_guest_contract() {
    let _runtime_test_guard = RUNTIME_TEST_LOCK.lock().unwrap();
    let mut runtime = load_runtime(PRIMARY).unwrap();
    let model = runtime.initialize_v2(context()).unwrap();
    assert!(model.surfaces.is_empty());
    assert!(model.commands.is_empty());
    assert!(
        runtime
            .handle_event(wit::PluginEvent::CancelTask("none".to_owned()))
            .unwrap()
            .accepted
    );
    assert_eq!(
        runtime
            .run_command(wit::CommandInvocation {
                command_id: "g45".to_owned(),
                invocation_id: "g45-1".to_owned(),
                arguments: Vec::new(),
            })
            .unwrap()
            .message,
        "G45"
    );
    let migrated = runtime.migrate_state("1.0.0", b"state").unwrap();
    assert_eq!(migrated.schema_version, 2);
    assert_eq!(migrated.state, b"state");
    runtime.shutdown().unwrap();
}

#[test]
fn malicious_v2_initialization_behaviors_keep_stable_classifications() {
    let _runtime_test_guard = RUNTIME_TEST_LOCK.lock().unwrap();
    assert_eq!(initialize_error(TRAP), "PLUGIN_TRAP");
    assert_eq!(initialize_error(RUNAWAY), "PLUGIN_FUEL_EXHAUSTED");
    assert_eq!(initialize_error(MEMORY), "PLUGIN_MEMORY_LIMIT");
    let ambient = match load_runtime(AMBIENT) {
        Ok(_) => panic!("ambient fixture unexpectedly linked"),
        Err(error) => error,
    };
    assert_eq!(ambient.code(), "PLUGIN_COMPONENT_INVALID");
}

fn initialize_error(name: &str) -> &'static str {
    let mut runtime = load_runtime(name).unwrap();
    runtime.initialize_v2(context()).unwrap_err().code()
}

fn load_runtime(
    name: &str,
) -> Result<bbcom_plugin_host::PluginRuntime, bbcom_plugin_host::HostError> {
    let source = fs::read(fixture(name)).unwrap();
    let component = wat::parse_bytes(&source).unwrap();
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("component")).unwrap();
    fs::write(directory.path().join("component/plugin.wasm"), &component).unwrap();
    let digest = format!("{:x}", Sha256::digest(&component));
    let manifest = format!(
        "id = \"dev.bbcom.g45-fixture\"\nname = \"G45 v2 Fixture\"\nversion = \"2.0.0\"\napi = \"^2.0\"\nrequested-capabilities = []\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{digest}\"\n\n[publisher]\nname = \"BBCOM G45\"\nwebsite = \"https://example.invalid\"\n"
    );
    let artifact = TrustedPluginArtifact::load(directory.path(), &manifest).unwrap();
    let launch = PluginLaunchContext {
        package_sha256: digest,
        workspace_id: "g45-workspace".to_owned(),
        instance_id: "g45-instance".to_owned(),
        generation: 1,
    };
    let factory = PluginEngineFactory::with_authorization_gate(Arc::new(Allow)).unwrap();
    factory.load_authorized(
        &artifact,
        &launch,
        std::iter::empty::<Capability>(),
        CapabilityRpc::new(Box::new(std::io::sink()), MessageIdSequence::new()),
    )
}

fn context() -> wit::HostContext {
    let limits = default_resource_limits();
    wit::HostContext {
        workspace_id: "g45-workspace".to_owned(),
        plugin_id: "dev.bbcom.g45-fixture".to_owned(),
        instance_id: "g45-instance".to_owned(),
        generation: 1,
        locale: "en-US".to_owned(),
        theme: wit::ColorScheme::System,
        granted_capabilities: Vec::new(),
        limits: wit::ResourceLimits {
            max_frame_bytes: limits.max_frame_bytes,
            max_queue_bytes: limits.max_queue_bytes,
            max_stream_chunk_bytes: limits.max_stream_chunk_bytes,
            max_concurrent_streams: limits.max_concurrent_streams,
            max_pending_host_requests: limits.max_pending_host_requests,
            wasm_memory_limit_bytes: limits.wasm_memory_limit_bytes,
            host_process_memory_limit_bytes: limits.host_process_memory_limit_bytes,
            call_timeout_ms: limits.call_timeout_ms,
            serial_read_timeout_ms: limits.serial_read_timeout_ms,
            long_task_timeout_ms: limits.long_task_timeout_ms,
            activity_timeout_ms: limits.activity_timeout_ms,
            max_ui_document_bytes: limits.max_ui_document_bytes,
            max_ui_nodes: limits.max_ui_nodes,
        },
        sessions: Vec::new(),
    }
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/plugins/malicious")
        .join(name)
}
