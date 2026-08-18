//! Native isolation boundary for one bbcom Wasm Component plugin.

pub mod artifact;
pub mod bindings;
pub mod error;
pub mod handshake;
mod host_state;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod native_sandbox_probe;
pub mod policy;
#[cfg(target_os = "macos")]
pub mod process_memory_limit;
pub mod runtime;
pub mod sidecar;
pub mod transport;
pub mod uplink;

pub use artifact::TrustedPluginArtifact;
pub use error::{ExecutionFailure, ExecutionFailureKind, HostError, Result};
pub use handshake::{HandshakeExpectation, HandshakeMachine};
pub use policy::{AmbientAuthorityPolicy, HostPlatform, HostPolicy, ProcessLimitPolicy};
pub use runtime::{CallKind, PluginEngineFactory, PluginRuntime, RuntimeInterruptHandle};
pub use sidecar::{PluginExecutor, PluginInterrupt, Sidecar, SidecarExit};
pub use uplink::{ProposalOutcome, Uplink};
