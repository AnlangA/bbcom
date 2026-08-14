use std::collections::BTreeSet;
use std::str::FromStr;
use std::time::Instant;

use bbcom_plugin_contracts::{
    HANDSHAKE_TIMEOUT_MS, PROTOCOL_MAJOR, PROTOCOL_MINOR, Permission, WIT_PACKAGE,
    generated::{Envelope, PluginHello, envelope},
};

use crate::{HostError, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandshakeExpectation {
    pub plugin_id: String,
    pub plugin_version: String,
    pub granted_capabilities: BTreeSet<Permission>,
}

impl HandshakeExpectation {
    #[must_use]
    pub fn new(
        plugin_id: impl Into<String>,
        plugin_version: impl Into<String>,
        granted_capabilities: impl IntoIterator<Item = Permission>,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            plugin_version: plugin_version.into(),
            granted_capabilities: granted_capabilities.into_iter().collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Awaiting,
    Established,
    Closed,
}

pub struct HandshakeMachine {
    expectation: HandshakeExpectation,
    started_at: Instant,
    state: State,
}

impl HandshakeMachine {
    #[must_use]
    pub fn new(expectation: HandshakeExpectation) -> Self {
        Self::started(expectation, Instant::now())
    }

    #[must_use]
    pub const fn started(expectation: HandshakeExpectation, started_at: Instant) -> Self {
        Self {
            expectation,
            started_at,
            state: State::Awaiting,
        }
    }

    pub fn accept(&mut self, envelope: Envelope, received_at: Instant) -> Result<Envelope> {
        if self.state != State::Awaiting {
            return Err(HostError::InvalidHandshake);
        }
        if received_at
            .saturating_duration_since(self.started_at)
            .as_millis()
            > u128::from(HANDSHAKE_TIMEOUT_MS)
        {
            return Err(HostError::HandshakeTimeout);
        }
        bbcom_plugin_contracts::validate_envelope(&envelope)?;
        let envelope::Payload::HostHello(hello) = envelope
            .payload
            .as_ref()
            .ok_or(HostError::InvalidHandshake)?
        else {
            return Err(HostError::InvalidHandshake);
        };
        if envelope.protocol_major != PROTOCOL_MAJOR
            || hello.wit_package != WIT_PACKAGE
            || hello.plugin_id != self.expectation.plugin_id
            || hello.plugin_version != self.expectation.plugin_version
        {
            return Err(HostError::InvalidHandshake);
        }
        let mut granted = BTreeSet::new();
        for value in &hello.granted_capabilities {
            let permission = Permission::from_str(value).map_err(HostError::from)?;
            if !granted.insert(permission) {
                return Err(HostError::InvalidHandshake);
            }
        }
        if granted != self.expectation.granted_capabilities {
            return Err(HostError::InvalidHandshake);
        }
        self.state = State::Established;
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id: envelope.request_id,
            payload: Some(envelope::Payload::PluginHello(PluginHello {
                plugin_id: self.expectation.plugin_id.clone(),
                plugin_version: self.expectation.plugin_version.clone(),
                wit_package: WIT_PACKAGE.to_owned(),
            })),
        })
    }

    pub fn ensure_within_deadline(&self, now: Instant) -> Result<()> {
        if self.state == State::Awaiting
            && now.saturating_duration_since(self.started_at).as_millis()
                > u128::from(HANDSHAKE_TIMEOUT_MS)
        {
            Err(HostError::HandshakeTimeout)
        } else {
            Ok(())
        }
    }

    #[must_use]
    pub const fn is_established(&self) -> bool {
        matches!(self.state, State::Established)
    }

    pub fn close(&mut self) {
        self.state = State::Closed;
    }
}
