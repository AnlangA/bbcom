use std::sync::Arc;

use bbcom_plugin_contracts::generated_v2::Capability;
use bbcom_plugin_contracts::{Sha256Digest, v2_capability_name};
use sha2::{Digest, Sha256};

use crate::{HostError, Result, TrustedPluginArtifact};

/// Immutable launch identity presented to the authorization gate before any
/// untrusted component bytes are parsed by Wasmtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationRequest {
    pub plugin_id: String,
    pub plugin_version: String,
    pub component_sha256: String,
    pub package_sha256: String,
    pub workspace_id: String,
    pub instance_id: String,
    pub generation: u64,
    /// Canonical ascending set. The gate must persist/compare the entire set,
    /// not only capabilities exercised during initialization.
    pub capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginLaunchContext {
    pub package_sha256: String,
    pub workspace_id: String,
    pub instance_id: String,
    pub generation: u64,
}

impl PluginLaunchContext {
    pub fn validate(&self) -> Result<()> {
        Sha256Digest::parse_hex(&self.package_sha256, "package.sha256")?;
        if self.workspace_id.is_empty() || self.instance_id.is_empty() || self.generation == 0 {
            return Err(HostError::InvalidAuthorizationContext);
        }
        Ok(())
    }
}

/// Application-owned grant gate. Returning true means the exact digest and
/// sorted capability set have already been approved by the user/policy.
pub trait PluginAuthorizationGate: Send + Sync + 'static {
    fn authorize(&self, request: &AuthorizationRequest) -> bool;
}

pub(crate) struct DenyAuthorization;

impl PluginAuthorizationGate for DenyAuthorization {
    fn authorize(&self, _request: &AuthorizationRequest) -> bool {
        false
    }
}

/// One-shot sidecar gate used after the native manager has performed its
/// persistent authorization decision. The ticket is bound to every launch
/// field and cannot be reused after a digest/capability/workspace generation
/// change. It is a launch attestation, not a publisher signature.
pub struct ExactLaunchTicketGate {
    expected_ticket: String,
}

impl ExactLaunchTicketGate {
    #[must_use]
    pub fn new(expected_ticket: String) -> Arc<Self> {
        Arc::new(Self { expected_ticket })
    }
}

impl PluginAuthorizationGate for ExactLaunchTicketGate {
    fn authorize(&self, request: &AuthorizationRequest) -> bool {
        constant_time_eq(
            self.expected_ticket.as_bytes(),
            authorization_ticket(request).as_bytes(),
        )
    }
}

#[must_use]
pub fn authorization_request(
    artifact: &TrustedPluginArtifact,
    launch: &PluginLaunchContext,
    capabilities: impl IntoIterator<Item = Capability>,
) -> AuthorizationRequest {
    let mut capabilities = capabilities.into_iter().collect::<Vec<_>>();
    capabilities.sort_unstable();
    capabilities.dedup();
    AuthorizationRequest {
        plugin_id: artifact.manifest.id.clone(),
        plugin_version: artifact.manifest.version.clone(),
        component_sha256: artifact.manifest.component.sha256.clone(),
        package_sha256: launch.package_sha256.clone(),
        workspace_id: launch.workspace_id.clone(),
        instance_id: launch.instance_id.clone(),
        generation: launch.generation,
        capabilities,
    }
}

#[must_use]
pub fn authorization_ticket(request: &AuthorizationRequest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"bbcom-plugin-launch-v2\0");
    for value in [
        request.plugin_id.as_str(),
        request.plugin_version.as_str(),
        request.component_sha256.as_str(),
        request.package_sha256.as_str(),
        request.workspace_id.as_str(),
        request.instance_id.as_str(),
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(request.generation.to_le_bytes());
    for capability in &request.capabilities {
        let name = v2_capability_name(*capability);
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}
