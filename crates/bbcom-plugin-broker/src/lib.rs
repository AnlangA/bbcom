//! Protocol-v2 routing between plugins and bbcom.
//!
//! Concrete host operations remain application-owned and are reached through
//! the typed gateway.

mod error;
mod gateway;
mod limits;
mod stream;

pub use error::{BrokerError, BrokerErrorCode, LimitKind, Result};
pub use gateway::{
    GatewayContext, GatewayDispatch, GatewayFailure, GatewaySession, PendingGatewayRequest,
    PluginCapabilityGateway, RuntimeBootstrapState, TaskTerminal,
};
pub use limits::{
    BROKER_LONG_TIMEOUT_MS, BROKER_NORMAL_TIMEOUT_MS, InvocationClass, validate_invocation,
};
pub use stream::{StreamEvent, StreamMultiplexer};
