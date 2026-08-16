//! Native isolation boundary for one bbcom Wasm Component plugin.

pub mod artifact;
pub mod bindings;
pub mod error;
pub mod handshake;
mod host_state;
pub mod policy;
pub mod runtime;
pub mod sidecar;
pub mod transport;

pub use artifact::TrustedPluginArtifact;
pub use error::{ExecutionFailure, ExecutionFailureKind, HostError, Result};
pub use handshake::{HandshakeExpectation, HandshakeMachine};
pub use policy::{AmbientAuthorityPolicy, HostPlatform, HostPolicy, ProcessLimitPolicy};
pub use runtime::{CallKind, PluginEngineFactory, PluginRuntime, RuntimeInterruptHandle};
pub use sidecar::{PluginExecutor, PluginInterrupt, Sidecar, SidecarExit};
