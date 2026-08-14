use prost::Message;

use crate::generated::{Envelope, envelope};
use crate::{ContractError, FRAME_LENGTH_PREFIX_BYTES, MAX_FRAME_BYTES, PROTOCOL_MAJOR, Result};

pub fn encode_frame(envelope: &Envelope) -> Result<Vec<u8>> {
    validate_envelope(envelope)?;
    let payload = envelope.encode_to_vec();
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ContractError::LimitExceeded {
            field: "frameBytes",
            limit: MAX_FRAME_BYTES as u64,
            actual: payload.len() as u64,
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| ContractError::LimitExceeded {
        field: "frameBytes",
        limit: MAX_FRAME_BYTES as u64,
        actual: payload.len() as u64,
    })?;
    let mut frame = Vec::with_capacity(FRAME_LENGTH_PREFIX_BYTES + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame(frame: &[u8]) -> Result<Envelope> {
    if frame.len() < FRAME_LENGTH_PREFIX_BYTES {
        return Err(ContractError::TruncatedFrame);
    }
    let announced = u32::from_le_bytes(frame[..4].try_into().expect("prefix length checked"));
    let announced = announced as usize;
    if announced > MAX_FRAME_BYTES {
        return Err(ContractError::LimitExceeded {
            field: "frameBytes",
            limit: MAX_FRAME_BYTES as u64,
            actual: announced as u64,
        });
    }
    if frame.len() != FRAME_LENGTH_PREFIX_BYTES + announced {
        return Err(ContractError::TruncatedFrame);
    }
    let envelope = Envelope::decode(&frame[FRAME_LENGTH_PREFIX_BYTES..])
        .map_err(|_| ContractError::Protobuf)?;
    validate_envelope(&envelope)?;
    Ok(envelope)
}

pub fn validate_queue_bytes(bytes: usize) -> Result<()> {
    if bytes > crate::MAX_QUEUE_BYTES {
        Err(ContractError::LimitExceeded {
            field: "queueBytes",
            limit: crate::MAX_QUEUE_BYTES as u64,
            actual: bytes as u64,
        })
    } else {
        Ok(())
    }
}

pub fn validate_envelope(envelope: &Envelope) -> Result<()> {
    if envelope.protocol_major != PROTOCOL_MAJOR {
        return Err(ContractError::IncompatibleMajor {
            found: envelope.protocol_major,
        });
    }
    if envelope.request_id == 0 {
        return Err(ContractError::InvalidField { field: "requestId" });
    }
    let payload = envelope
        .payload
        .as_ref()
        .ok_or(ContractError::UnknownPayload)?;
    match payload {
        envelope::Payload::HostHello(message) => {
            if message.wit_package != crate::WIT_PACKAGE
                || message.plugin_id.is_empty()
                || message.plugin_version.is_empty()
            {
                return Err(ContractError::InvalidField { field: "hostHello" });
            }
        }
        envelope::Payload::PluginHello(message) => {
            if message.wit_package != crate::WIT_PACKAGE
                || message.plugin_id.is_empty()
                || message.plugin_version.is_empty()
            {
                return Err(ContractError::InvalidField {
                    field: "pluginHello",
                });
            }
        }
        envelope::Payload::InvokeRequest(message) if message.method.is_empty() => {
            return Err(ContractError::InvalidField { field: "method" });
        }
        envelope::Payload::PutStateChunkRequest(message)
            if message.state_schema_version != crate::PLUGIN_STATE_SCHEMA_VERSION
                || message.kind == 0
                || message.payload.len() > crate::MAX_PLUGIN_STATE_CHUNK_BYTES =>
        {
            return Err(ContractError::InvalidField {
                field: "stateChunk",
            });
        }
        envelope::Payload::InitializeRequest(message)
            if message.state_schema_version != crate::PLUGIN_STATE_SCHEMA_VERSION =>
        {
            return Err(ContractError::InvalidField {
                field: "initialize",
            });
        }
        envelope::Payload::GetStateChunkRequest(message)
            if message.state_schema_version != crate::PLUGIN_STATE_SCHEMA_VERSION
                || message.revision == 0
                || message.kind == 0
                || message.max_bytes == 0
                || message.max_bytes as usize > crate::MAX_PLUGIN_STATE_CHUNK_BYTES =>
        {
            return Err(ContractError::InvalidField { field: "stateRead" });
        }
        envelope::Payload::ShutdownRequest(message)
            if message.state_schema_version != crate::PLUGIN_STATE_SCHEMA_VERSION =>
        {
            return Err(ContractError::InvalidField { field: "shutdown" });
        }
        envelope::Payload::CompleteShutdownRequest(message)
            if message.state_schema_version != crate::PLUGIN_STATE_SCHEMA_VERSION
                || message.revision == 0 =>
        {
            return Err(ContractError::InvalidField {
                field: "completeShutdown",
            });
        }
        envelope::Payload::CancelRequest(message) if message.target_request_id == 0 => {
            return Err(ContractError::InvalidField {
                field: "targetRequestId",
            });
        }
        envelope::Payload::Event(message) if message.topic.is_empty() => {
            return Err(ContractError::InvalidField { field: "topic" });
        }
        envelope::Payload::Error(message)
            if message.code.is_empty() || message.message_key.is_empty() =>
        {
            return Err(ContractError::InvalidField { field: "error" });
        }
        _ => {}
    }
    Ok(())
}
