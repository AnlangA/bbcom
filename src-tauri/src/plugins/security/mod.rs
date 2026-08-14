//! Native, profile-scoped persistence for plugin authorization and revocation.
//!
//! This module has no renderer-facing surface. The only caller-provided path is
//! the native application-data directory passed during application setup.

mod store;

pub use store::{NativePluginSecurityError, NativePluginSecurityStore};

#[cfg(test)]
mod tests;
