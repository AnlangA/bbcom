//! Minimal authorization-ticket example for the protocol-v2 sidecar launch.

use bbcom_plugin_contracts::generated_v2::Capability;
use bbcom_plugin_host::{AuthorizationRequest, authorization_ticket};

fn main() {
    let request = AuthorizationRequest {
        plugin_id: "dev.bbcom.example".to_owned(),
        plugin_version: "2.0.0".to_owned(),
        component_sha256: "0".repeat(64),
        package_sha256: "1".repeat(64),
        workspace_id: "workspace-example".to_owned(),
        instance_id: "instance-example".to_owned(),
        generation: 1,
        capabilities: vec![Capability::UiWorkspace],
    };
    println!("{}", authorization_ticket(&request));
}
