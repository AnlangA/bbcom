//! Strict, versioned contracts for bbcom plugins.

mod digest;
mod error;
mod limits;
mod manifest;
mod permission;
mod repository;
mod wire;

pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/bbcom.plugin.host.v1.rs"));
}

pub use digest::Sha256Digest;
pub use error::{ContractError, Result};
pub use limits::*;
pub use manifest::{ComponentManifest, PluginManifest, PublisherManifest};
pub use permission::{
    AuthorizationKey, Permission, PermissionPlan, PermissionRisk, RiskCombination, permission_plan,
    validate_persistent_grant,
};
pub use repository::{RepositoryCatalog, RepositoryIndex, RepositoryPackage, RepositoryPlugin};
pub use wire::{decode_frame, encode_frame, validate_envelope, validate_queue_bytes};

#[must_use]
pub fn empty_plugin_storage_payload() -> Vec<u8> {
    use prost::Message;
    generated::PluginStorageSnapshot {
        state_schema_version: PLUGIN_STATE_SCHEMA_VERSION,
        entries: Vec::new(),
    }
    .encode_to_vec()
}
