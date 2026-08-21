//! Drives the real sidecar executable through handshake and initialize.
//!
//! Usage:
//!   cargo run -p bbcom-plugin-host --example drive_sidecar -- <sidecar> <package-root>

use std::path::PathBuf;
use std::process::{Command, Stdio};

use bbcom_plugin_contracts::generated_v2::{
    ColorScheme, Envelope, Handshake, HostContext, HostHello, InitializeRequest,
    ListSessionsResponse, OperationAck, PluginIdentity, ProjectStateGetResponse, Request, Response,
    ShutdownRequest, envelope, handshake, request, response,
};
use bbcom_plugin_contracts::v2::{
    MAX_PROTOCOL_MINOR, MIN_PROTOCOL_MINOR, PROTOCOL_MAJOR, WIT_PACKAGE, default_resource_limits,
};
use bbcom_plugin_contracts::{PluginManifest, v2_capability_name};
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};

const WORKSPACE_ID: &str = "8e7b84cf-35f4-45cd-baf0-55d94ebf0213";

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let sidecar = PathBuf::from(arguments.next().expect("pass the sidecar executable"));
    let package_root = PathBuf::from(arguments.next().expect("pass the package root"));

    let manifest_text =
        std::fs::read_to_string(package_root.join("plugin.toml")).expect("read plugin.toml");
    let manifest = PluginManifest::parse(&manifest_text).expect("parse manifest");
    let granted = manifest.v2_capabilities().expect("capabilities");

    let mut command = Command::new(&sidecar);
    command
        .current_dir(&package_root)
        .arg("--package-root")
        .arg(&package_root)
        .args(["--workspace-id", WORKSPACE_ID])
        .args(["--instance-id", "1"])
        .args(["--generation", "1"]);
    for capability in &granted {
        command.arg("--grant").arg(v2_capability_name(*capability));
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn sidecar");

    let mut writer = FrameWriter::new(child.stdin.take().expect("stdin"));
    let mut reader = FrameReader::new(child.stdout.take().expect("stdout"));

    let envelope = |message_id: u64, payload: envelope::Payload| Envelope {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: MAX_PROTOCOL_MINOR,
        message_id,
        reply_to: None,
        payload: Some(payload),
    };
    let mut host_message_id = 0_u64;

    host_message_id += 1;
    writer
        .write_envelope(&envelope(
            host_message_id,
            envelope::Payload::Handshake(Handshake {
                hello: Some(handshake::Hello::Host(HostHello {
                    protocol_major: PROTOCOL_MAJOR,
                    min_minor: MIN_PROTOCOL_MINOR,
                    max_minor: MAX_PROTOCOL_MINOR,
                    wit_package: WIT_PACKAGE.to_owned(),
                    plugin: Some(PluginIdentity {
                        plugin_id: manifest.id.clone(),
                        plugin_version: manifest.version.clone(),
                        component_sha256: manifest.component.sha256.clone(),
                    }),
                    granted_capabilities: granted.iter().map(|value| *value as i32).collect(),
                    limits: Some(default_resource_limits()),
                    workspace_id: WORKSPACE_ID.to_owned(),
                    instance_id: "1".to_owned(),
                    generation: 1,
                })),
            }),
        ))
        .expect("write host hello");

    match reader
        .read_envelope()
        .expect("read handshake reply")
        .expect("handshake frame")
        .payload
    {
        Some(envelope::Payload::Handshake(Handshake {
            hello: Some(handshake::Hello::Plugin(plugin)),
        })) => {
            let identity = plugin.plugin.expect("plugin identity");
            println!(
                "handshake ok: plugin_id={} version={} negotiated_minor={}",
                identity.plugin_id, identity.plugin_version, plugin.negotiated_minor
            );
        }
        other => panic!("unexpected handshake reply: {other:?}"),
    }

    host_message_id += 1;
    writer
        .write_envelope(&envelope(
            host_message_id,
            envelope::Payload::Request(Request {
                operation: Some(request::Operation::Initialize(InitializeRequest {
                    context: Some(HostContext {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        plugin_id: manifest.id.clone(),
                        instance_id: "1".to_owned(),
                        generation: 1,
                        locale: "zh".to_owned(),
                        theme: ColorScheme::Dark as i32,
                        granted_capabilities: granted.iter().map(|value| *value as i32).collect(),
                        limits: Some(default_resource_limits()),
                        sessions: Vec::new(),
                    }),
                })),
            }),
        ))
        .expect("write initialize");

    loop {
        let reply = reader
            .read_envelope()
            .expect("read initialize reply")
            .expect("initialize frame");
        let reply_to = reply.message_id;
        match reply.payload {
            Some(envelope::Payload::Response(value)) => match value.result {
                Some(response::Result::Initialize(initialized)) => {
                    let model = initialized.model.expect("plugin model");
                    println!(
                        "initialize ok: surfaces={:?} commands={:?}",
                        model
                            .surfaces
                            .iter()
                            .map(|surface| surface.surface_id.as_str())
                            .collect::<Vec<_>>(),
                        model
                            .commands
                            .iter()
                            .map(|value| value.command_id.as_str())
                            .collect::<Vec<_>>(),
                    );
                    break;
                }
                other => panic!("unexpected initialize result: {other:?}"),
            },
            // The guest calls back into the host while initializing; every
            // uplink must be answered or the guest's import times out.
            Some(envelope::Payload::Request(value)) => {
                let operation = value.operation.expect("uplink operation");
                let (name, result) = answer_uplink(&operation);
                println!("guest uplink: {name}");
                host_message_id += 1;
                let mut ack = envelope(
                    host_message_id,
                    envelope::Payload::Response(Response {
                        result: Some(result),
                    }),
                );
                ack.reply_to = Some(reply_to);
                writer.write_envelope(&ack).expect("write uplink ack");
            }
            other => panic!("unexpected initialize reply: {other:?}"),
        }
    }

    host_message_id += 1;
    writer
        .write_envelope(&envelope(
            host_message_id,
            envelope::Payload::Request(Request {
                operation: Some(request::Operation::Shutdown(ShutdownRequest {})),
            }),
        ))
        .expect("write shutdown");
    drop(writer);
    println!("sidecar exited: {}", child.wait().expect("wait"));
}

/// Minimal host answers for the uplinks `counter-v2` issues during initialize.
fn answer_uplink(operation: &request::Operation) -> (&'static str, response::Result) {
    match operation {
        request::Operation::ProjectStateGet(_) => (
            "project-state-get",
            response::Result::ProjectStateGet(ProjectStateGetResponse {
                schema_version: None,
                value: None,
            }),
        ),
        request::Operation::ListSessions(_) => (
            "list-sessions",
            response::Result::ListSessions(ListSessionsResponse {
                sessions: Vec::new(),
            }),
        ),
        request::Operation::RegisterSurface(_) => (
            "register-surface",
            response::Result::RegisterSurface(OperationAck {}),
        ),
        request::Operation::RegisterCommand(_) => (
            "register-command",
            response::Result::RegisterCommand(OperationAck {}),
        ),
        request::Operation::PublishSurfaceSnapshot(_) => (
            "publish-surface-snapshot",
            response::Result::PublishSurfaceSnapshot(OperationAck {}),
        ),
        request::Operation::ProjectStateSet(_) => (
            "project-state-set",
            response::Result::ProjectStateSet(OperationAck {}),
        ),
        other => panic!("unhandled guest uplink: {other:?}"),
    }
}
