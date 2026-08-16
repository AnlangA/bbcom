//! SQLite-backed workspace persistence owned by bbcom's Rust process.
//!
//! This crate has no Tauri dependency. It validates the application file
//! header, owns the only writable SQLite connection, applies idempotent
//! revisioned mutation batches, and exposes bounded hydration/backup APIs.

pub mod container;
mod error;
mod model;
mod mutation;
mod schema;
mod service;

pub use error::{Result, WorkspaceError};
pub use model::{
    CreateWorkspaceRequest, WorkspaceFrame, WorkspaceFramePage, WorkspaceIntegrityReport,
    WorkspacePluginBindingSnapshot, WorkspaceSessionPage, WorkspaceSessionSnapshot,
};
pub use schema::{WORKSPACE_APPLICATION_ID, WORKSPACE_SCHEMA_VERSION};
pub use service::{WorkspaceAiMessagePage, WorkspaceService, WorkspaceWaveformPage};
