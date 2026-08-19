use std::collections::BTreeSet;
use std::time::Instant;

use bbcom_plugin_contracts::HANDSHAKE_TIMEOUT_MS;
use bbcom_plugin_contracts::generated_v2::{
    Capability, Envelope, Handshake, PluginHello, PluginIdentity, ResourceLimits, envelope,
    handshake,
};
use bbcom_plugin_contracts::v2::{
    MAX_PROTOCOL_MINOR, MIN_PROTOCOL_MINOR, MinorRange, PROTOCOL_MAJOR, WIT_PACKAGE,
    default_resource_limits, negotiate_minor, validate_envelope,
};

use crate::{HostError, Result};

#[derive(Clone, Debug, PartialEq)]
pub struct HandshakeExpectation {
    pub plugin_id: String,
    pub plugin_version: String,
    pub component_sha256: String,
    pub workspace_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub granted_capabilities: BTreeSet<Capability>,
    pub limits: ResourceLimits,
}

impl HandshakeExpectation {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn new(
        plugin_id: impl Into<String>,
        plugin_version: impl Into<String>,
        component_sha256: impl Into<String>,
        workspace_id: impl Into<String>,
        instance_id: impl Into<String>,
        generation: u64,
        granted_capabilities: impl IntoIterator<Item = Capability>,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            plugin_version: plugin_version.into(),
            component_sha256: component_sha256.into(),
            workspace_id: workspace_id.into(),
            instance_id: instance_id.into(),
            generation,
            granted_capabilities: granted_capabilities.into_iter().collect(),
            limits: default_resource_limits(),
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

    pub fn accept(
        &mut self,
        envelope: Envelope,
        received_at: Instant,
        response_message_id: u64,
    ) -> Result<Envelope> {
        if self.state != State::Awaiting || response_message_id == 0 {
            return Err(HostError::InvalidHandshake);
        }
        if received_at
            .saturating_duration_since(self.started_at)
            .as_millis()
            > u128::from(HANDSHAKE_TIMEOUT_MS)
        {
            return Err(HostError::HandshakeTimeout);
        }
        validate_envelope(&envelope)?;
        let envelope::Payload::Handshake(Handshake {
            hello: Some(handshake::Hello::Host(hello)),
        }) = envelope
            .payload
            .as_ref()
            .ok_or(HostError::InvalidHandshake)?
        else {
            return Err(HostError::InvalidHandshake);
        };
        let plugin = hello.plugin.as_ref().ok_or(HostError::InvalidHandshake)?;
        if hello.protocol_major != PROTOCOL_MAJOR
            || hello.wit_package != WIT_PACKAGE
            || plugin.plugin_id != self.expectation.plugin_id
            || plugin.plugin_version != self.expectation.plugin_version
            || plugin.component_sha256 != self.expectation.component_sha256
            || hello.workspace_id != self.expectation.workspace_id
            || hello.instance_id != self.expectation.instance_id
            || hello.generation != self.expectation.generation
            || hello.limits.as_ref() != Some(&self.expectation.limits)
        {
            return Err(HostError::InvalidHandshake);
        }

        let mut granted = BTreeSet::new();
        for value in &hello.granted_capabilities {
            let capability = Capability::try_from(*value)
                .ok()
                .filter(|value| *value != Capability::Unspecified)
                .ok_or(HostError::InvalidHandshake)?;
            if !granted.insert(capability) {
                return Err(HostError::InvalidHandshake);
            }
        }
        if granted != self.expectation.granted_capabilities {
            return Err(HostError::InvalidHandshake);
        }
        let negotiated_minor = negotiate_minor(
            PROTOCOL_MAJOR,
            MinorRange::new(MIN_PROTOCOL_MINOR, MAX_PROTOCOL_MINOR),
            hello.protocol_major,
            MinorRange::new(hello.min_minor, hello.max_minor),
        )?;
        self.state = State::Established;
        Ok(Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: negotiated_minor,
            message_id: response_message_id,
            reply_to: Some(envelope.message_id),
            payload: Some(envelope::Payload::Handshake(Handshake {
                hello: Some(handshake::Hello::Plugin(PluginHello {
                    protocol_major: PROTOCOL_MAJOR,
                    min_minor: MIN_PROTOCOL_MINOR,
                    max_minor: MAX_PROTOCOL_MINOR,
                    wit_package: WIT_PACKAGE.to_owned(),
                    plugin: Some(PluginIdentity {
                        plugin_id: self.expectation.plugin_id.clone(),
                        plugin_version: self.expectation.plugin_version.clone(),
                        component_sha256: self.expectation.component_sha256.clone(),
                    }),
                    required_capabilities: self
                        .expectation
                        .granted_capabilities
                        .iter()
                        .map(|value| *value as i32)
                        .collect(),
                    accepted_limits: Some(self.expectation.limits),
                    negotiated_minor,
                })),
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

    #[must_use]
    pub const fn expectation(&self) -> &HandshakeExpectation {
        &self.expectation
    }

    pub fn close(&mut self) {
        self.state = State::Closed;
    }
}
