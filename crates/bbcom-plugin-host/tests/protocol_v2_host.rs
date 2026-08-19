use std::collections::BTreeSet;
use std::fs;
use std::sync::Arc;
use std::time::Instant;

use bbcom_plugin_contracts::generated_v2::{
    Capability, Envelope, Handshake, HostHello, PluginIdentity, envelope, handshake,
};
use bbcom_plugin_contracts::v2::{
    MAX_PROTOCOL_MINOR, MIN_PROTOCOL_MINOR, PROTOCOL_MAJOR, WIT_PACKAGE, default_resource_limits,
};
use bbcom_plugin_host::{
    AuthorizationRequest, CapabilityRpc, HandshakeExpectation, HandshakeMachine, MessageIdSequence,
    PluginAuthorizationGate, PluginEngineFactory, PluginLaunchContext, TrustedPluginArtifact,
    authorization_request, authorization_ticket,
};
use sha2::{Digest, Sha256};

struct Decision(bool);
impl PluginAuthorizationGate for Decision {
    fn authorize(&self, _request: &AuthorizationRequest) -> bool {
        self.0
    }
}

fn expect_load_error<T>(
    result: Result<T, bbcom_plugin_host::HostError>,
) -> bbcom_plugin_host::HostError {
    match result {
        Ok(_) => panic!("expected plugin load to fail"),
        Err(error) => error,
    }
}

#[test]
fn authorization_gate_runs_before_wasmtime_parses_component_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = artifact(directory.path(), b"not-a-component", &[]);
    let launch = PluginLaunchContext {
        package_sha256: artifact.manifest.component.sha256.clone(),
        workspace_id: "workspace-1".to_owned(),
        instance_id: "instance-1".to_owned(),
        generation: 1,
    };
    let rpc = || CapabilityRpc::new(Box::new(std::io::sink()), MessageIdSequence::new());
    let denied = PluginEngineFactory::with_authorization_gate(Arc::new(Decision(false))).unwrap();
    assert_eq!(
        expect_load_error(denied.load_authorized(&artifact, &launch, [], rpc())).code(),
        "PLUGIN_AUTHORIZATION_REQUIRED"
    );
    let allowed = PluginEngineFactory::with_authorization_gate(Arc::new(Decision(true))).unwrap();
    assert_eq!(
        expect_load_error(allowed.load_authorized(&artifact, &launch, [], rpc())).code(),
        "PLUGIN_COMPONENT_INVALID"
    );
}

#[test]
fn launch_ticket_binds_digest_workspace_generation_and_sorted_capabilities() {
    let directory = tempfile::tempdir().unwrap();
    let artifact = artifact(
        directory.path(),
        b"component",
        &["serial.io", "ui.workspace"],
    );
    let launch = PluginLaunchContext {
        package_sha256: "a".repeat(64),
        workspace_id: "workspace-1".to_owned(),
        instance_id: "instance-1".to_owned(),
        generation: 7,
    };
    let first = authorization_request(
        &artifact,
        &launch,
        [Capability::SerialIo, Capability::UiWorkspace],
    );
    let second = authorization_request(
        &artifact,
        &launch,
        [Capability::UiWorkspace, Capability::SerialIo],
    );
    assert_eq!(authorization_ticket(&first), authorization_ticket(&second));
    let mut changed = second;
    changed.generation += 1;
    assert_ne!(authorization_ticket(&first), authorization_ticket(&changed));
}

#[test]
fn handshake_is_exactly_bound_to_v2_identity_context_limits_and_capabilities() {
    let capabilities = BTreeSet::from([Capability::SerialIo, Capability::UiWorkspace]);
    let expectation = HandshakeExpectation::new(
        "dev.bbcom.fixture",
        "2.0.0",
        "a".repeat(64),
        "workspace-1",
        "instance-1",
        3,
        capabilities.iter().copied(),
    );
    let mut machine = HandshakeMachine::started(expectation, Instant::now());
    let request = Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: MAX_PROTOCOL_MINOR,
        message_id: 1,
        reply_to: None,
        payload: Some(envelope::Payload::Handshake(Handshake {
            hello: Some(handshake::Hello::Host(HostHello {
                protocol_major: PROTOCOL_MAJOR,
                min_minor: MIN_PROTOCOL_MINOR,
                max_minor: MAX_PROTOCOL_MINOR,
                wit_package: WIT_PACKAGE.to_owned(),
                plugin: Some(PluginIdentity {
                    plugin_id: "dev.bbcom.fixture".to_owned(),
                    plugin_version: "2.0.0".to_owned(),
                    component_sha256: "a".repeat(64),
                }),
                granted_capabilities: capabilities.iter().map(|value| *value as i32).collect(),
                limits: Some(default_resource_limits()),
                workspace_id: "workspace-1".to_owned(),
                instance_id: "instance-1".to_owned(),
                generation: 3,
            })),
        })),
    };
    let response = machine.accept(request, Instant::now(), 1).unwrap();
    assert_eq!(response.reply_to, Some(1));
    assert!(machine.is_established());
}

fn artifact(
    root: &std::path::Path,
    component: &[u8],
    capabilities: &[&str],
) -> TrustedPluginArtifact {
    fs::create_dir(root.join("component")).unwrap();
    fs::write(root.join("component/plugin.wasm"), component).unwrap();
    let digest = format!("{:x}", Sha256::digest(component));
    let capabilities = capabilities
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let manifest = format!(
        "id = \"dev.bbcom.fixture\"\nname = \"Fixture\"\nversion = \"2.0.0\"\napi = \"^2.0\"\nrequested-capabilities = [{capabilities}]\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{digest}\"\n\n[publisher]\nname = \"Fixture\"\nwebsite = \"https://example.invalid\"\n"
    );
    TrustedPluginArtifact::load(root, &manifest).unwrap()
}
