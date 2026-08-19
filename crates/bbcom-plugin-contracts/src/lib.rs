//! Strict, versioned contracts for bbcom plugins.

mod digest;
mod error;
mod limits;
mod manifest;
mod repository;
pub mod v2;

/// Prost types for the plugin sidecar transport.
pub mod generated_v2 {
    include!(concat!(env!("OUT_DIR"), "/bbcom.plugin.host.v2.rs"));
}

pub use digest::Sha256Digest;
pub use error::{ContractError, Result};
pub use limits::*;
pub use manifest::{
    ComponentManifest, PluginManifest, PublisherManifest, parse_v2_capability, v2_capability_name,
};
pub use repository::{
    MAX_REDIRECTS, RepositoryCatalog, RepositoryConfiguration, RepositoryEndpoint, RepositoryIndex,
    RepositoryPackage, RepositoryPlugin, validate_repository_id,
};
pub use v2::{
    ACTIVITY_TIMEOUT_MS, CALL_TIMEOUT_MS, HOST_PROCESS_MEMORY_LIMIT_BYTES, LONG_TASK_TIMEOUT_MS,
    MAX_CONCURRENT_STREAMS, MAX_FRAME_BYTES, MAX_PENDING_HOST_REQUESTS, MAX_PROTOCOL_MINOR,
    MAX_QUEUE_BYTES, MAX_STREAM_CHUNK_BYTES, MAX_UI_DOCUMENT_BYTES, MAX_UI_NODES,
    MIN_PROTOCOL_MINOR, PROTOCOL_MAJOR, SERIAL_READ_TIMEOUT_MS, WASM_MEMORY_LIMIT_BYTES,
    WIT_PACKAGE,
};
