//! Plugin protocol negotiation, framing, and resource-bound validation.

use std::collections::{BTreeMap, BTreeSet};

use prost::Message;

use crate::generated_v2::{
    Envelope, ResourceLimits, SurfacePatch, SurfaceSnapshot, UiNode, envelope, handshake, stream,
};
use crate::{ContractError, FRAME_LENGTH_PREFIX_BYTES, Result};

pub const PROTOCOL_MAJOR: u32 = 2;
pub const MIN_PROTOCOL_MINOR: u32 = 0;
pub const MAX_PROTOCOL_MINOR: u32 = 0;
pub const WIT_PACKAGE: &str = "bbcom:plugin@2.0.0";

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_STREAM_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_CONCURRENT_STREAMS: u32 = 4;
pub const MAX_PENDING_HOST_REQUESTS: u32 = 32;
pub const WASM_MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
pub const HOST_PROCESS_MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
pub const CALL_TIMEOUT_MS: u32 = 2_000;
pub const SERIAL_READ_TIMEOUT_MS: u32 = 10_000;
pub const LONG_TASK_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1_000;
pub const ACTIVITY_TIMEOUT_MS: u32 = 30_000;
pub const MAX_UI_DOCUMENT_BYTES: u32 = 512 * 1024;
pub const MAX_UI_NODES: u32 = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MinorRange {
    pub min: u32,
    pub max: u32,
}

/// Per-direction replay/ordering guard for Envelope message IDs. A new runtime
/// starts at zero; rollover is a protocol error and requires a fresh handshake.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MessageIdTracker {
    last: u64,
}

impl MessageIdTracker {
    #[must_use]
    pub const fn new() -> Self {
        Self { last: 0 }
    }

    #[must_use]
    pub const fn last(self) -> u64 {
        self.last
    }

    pub fn observe(&mut self, message_id: u64) -> Result<()> {
        if message_id == 0 || message_id <= self.last {
            return Err(ContractError::InvalidField { field: "messageId" });
        }
        self.last = message_id;
        Ok(())
    }
}

impl MinorRange {
    #[must_use]
    pub const fn new(min: u32, max: u32) -> Self {
        Self { min, max }
    }

    #[must_use]
    pub const fn is_valid(self) -> bool {
        self.min <= self.max
    }
}

/// Selects the highest minor version supported by both peers. Major versions
/// are intentionally not negotiated: a mismatch is a hard incompatibility.
pub fn negotiate_minor(
    local_major: u32,
    local: MinorRange,
    peer_major: u32,
    peer: MinorRange,
) -> Result<u32> {
    if local_major != peer_major || local_major != PROTOCOL_MAJOR {
        return Err(ContractError::IncompatibleMajor { found: peer_major });
    }
    if !local.is_valid() || !peer.is_valid() {
        return Err(ContractError::InvalidField {
            field: "minorRange",
        });
    }
    let minimum = local.min.max(peer.min);
    let maximum = local.max.min(peer.max);
    if minimum > maximum {
        return Err(ContractError::InvalidField {
            field: "protocolMinor",
        });
    }
    Ok(maximum)
}

#[must_use]
pub fn default_resource_limits() -> ResourceLimits {
    ResourceLimits {
        max_frame_bytes: MAX_FRAME_BYTES as u64,
        max_queue_bytes: MAX_QUEUE_BYTES as u64,
        max_stream_chunk_bytes: MAX_STREAM_CHUNK_BYTES as u32,
        max_concurrent_streams: MAX_CONCURRENT_STREAMS,
        max_pending_host_requests: MAX_PENDING_HOST_REQUESTS,
        wasm_memory_limit_bytes: WASM_MEMORY_LIMIT_BYTES as u64,
        host_process_memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES as u64,
        call_timeout_ms: CALL_TIMEOUT_MS,
        serial_read_timeout_ms: SERIAL_READ_TIMEOUT_MS,
        long_task_timeout_ms: LONG_TASK_TIMEOUT_MS,
        activity_timeout_ms: ACTIVITY_TIMEOUT_MS,
        max_ui_document_bytes: MAX_UI_DOCUMENT_BYTES,
        max_ui_nodes: MAX_UI_NODES,
    }
}

pub fn validate_resource_limits(limits: &ResourceLimits) -> Result<()> {
    let exact = default_resource_limits();
    if limits.max_frame_bytes == 0 || limits.max_frame_bytes > exact.max_frame_bytes {
        return limit_error(
            "maxFrameBytes",
            exact.max_frame_bytes,
            limits.max_frame_bytes,
        );
    }
    if limits.max_queue_bytes == 0 || limits.max_queue_bytes > exact.max_queue_bytes {
        return limit_error(
            "maxQueueBytes",
            exact.max_queue_bytes,
            limits.max_queue_bytes,
        );
    }
    if limits.max_stream_chunk_bytes == 0
        || limits.max_stream_chunk_bytes > exact.max_stream_chunk_bytes
    {
        return limit_error(
            "maxStreamChunkBytes",
            exact.max_stream_chunk_bytes.into(),
            limits.max_stream_chunk_bytes.into(),
        );
    }
    if limits.max_concurrent_streams == 0
        || limits.max_concurrent_streams > exact.max_concurrent_streams
    {
        return limit_error(
            "maxConcurrentStreams",
            exact.max_concurrent_streams.into(),
            limits.max_concurrent_streams.into(),
        );
    }
    if limits.max_pending_host_requests == 0
        || limits.max_pending_host_requests > exact.max_pending_host_requests
    {
        return limit_error(
            "maxPendingHostRequests",
            exact.max_pending_host_requests.into(),
            limits.max_pending_host_requests.into(),
        );
    }
    if limits.wasm_memory_limit_bytes == 0
        || limits.wasm_memory_limit_bytes > exact.wasm_memory_limit_bytes
    {
        return limit_error(
            "wasmMemoryLimitBytes",
            exact.wasm_memory_limit_bytes,
            limits.wasm_memory_limit_bytes,
        );
    }
    if limits.host_process_memory_limit_bytes == 0
        || limits.host_process_memory_limit_bytes > exact.host_process_memory_limit_bytes
    {
        return limit_error(
            "hostProcessMemoryLimitBytes",
            exact.host_process_memory_limit_bytes,
            limits.host_process_memory_limit_bytes,
        );
    }
    if limits.call_timeout_ms == 0 || limits.call_timeout_ms > exact.call_timeout_ms {
        return limit_error(
            "callTimeoutMs",
            exact.call_timeout_ms.into(),
            limits.call_timeout_ms.into(),
        );
    }
    if limits.serial_read_timeout_ms == 0
        || limits.serial_read_timeout_ms > exact.serial_read_timeout_ms
    {
        return limit_error(
            "serialReadTimeoutMs",
            exact.serial_read_timeout_ms.into(),
            limits.serial_read_timeout_ms.into(),
        );
    }
    if limits.long_task_timeout_ms == 0 || limits.long_task_timeout_ms > exact.long_task_timeout_ms
    {
        return limit_error(
            "longTaskTimeoutMs",
            exact.long_task_timeout_ms,
            limits.long_task_timeout_ms,
        );
    }
    if limits.activity_timeout_ms == 0 || limits.activity_timeout_ms > exact.activity_timeout_ms {
        return limit_error(
            "activityTimeoutMs",
            exact.activity_timeout_ms.into(),
            limits.activity_timeout_ms.into(),
        );
    }
    if limits.max_ui_document_bytes == 0
        || limits.max_ui_document_bytes > exact.max_ui_document_bytes
    {
        return limit_error(
            "maxUiDocumentBytes",
            exact.max_ui_document_bytes.into(),
            limits.max_ui_document_bytes.into(),
        );
    }
    if limits.max_ui_nodes == 0 || limits.max_ui_nodes > exact.max_ui_nodes {
        return limit_error(
            "maxUiNodes",
            exact.max_ui_nodes.into(),
            limits.max_ui_nodes.into(),
        );
    }
    Ok(())
}

pub fn validate_surface_snapshot(snapshot: &SurfaceSnapshot) -> Result<()> {
    if snapshot.encoded_len() > MAX_UI_DOCUMENT_BYTES as usize {
        return limit_error(
            "uiDocumentBytes",
            MAX_UI_DOCUMENT_BYTES.into(),
            snapshot.encoded_len() as u64,
        );
    }
    if snapshot.surface_id.is_empty()
        || snapshot.revision == 0
        || snapshot.root_node_id.is_empty()
        || snapshot.nodes.is_empty()
        || snapshot.nodes.len() > MAX_UI_NODES as usize
    {
        return Err(ContractError::InvalidField {
            field: "surfaceSnapshot",
        });
    }
    let mut nodes = BTreeMap::new();
    for node in &snapshot.nodes {
        validate_ui_node(node)?;
        if nodes.insert(node.id.as_str(), node).is_some() {
            return Err(ContractError::InvalidField { field: "uiNodeId" });
        }
    }
    let root = nodes
        .get(snapshot.root_node_id.as_str())
        .ok_or(ContractError::InvalidField {
            field: "rootNodeId",
        })?;
    if root.parent_id.is_some() {
        return Err(ContractError::InvalidField {
            field: "rootNodeId",
        });
    }
    for node in nodes.values() {
        if let Some(parent) = node.parent_id.as_deref() {
            if parent == node.id || !nodes.contains_key(parent) {
                return Err(ContractError::InvalidField {
                    field: "uiNodeParent",
                });
            }
            let mut seen = BTreeSet::new();
            let mut current = Some(parent);
            while let Some(id) = current {
                if !seen.insert(id) {
                    return Err(ContractError::InvalidField {
                        field: "uiNodeCycle",
                    });
                }
                current = nodes.get(id).and_then(|value| value.parent_id.as_deref());
            }
        }
    }
    Ok(())
}

pub fn validate_surface_patch(patch: &SurfacePatch) -> Result<()> {
    if patch.encoded_len() > MAX_UI_DOCUMENT_BYTES as usize {
        return limit_error(
            "uiDocumentBytes",
            MAX_UI_DOCUMENT_BYTES.into(),
            patch.encoded_len() as u64,
        );
    }
    if patch.surface_id.is_empty()
        || patch.base_revision == 0
        || patch.next_revision <= patch.base_revision
        || patch.operations.is_empty()
        || patch.operations.len() > MAX_UI_NODES as usize
    {
        return Err(ContractError::InvalidField {
            field: "surfacePatch",
        });
    }
    let mut touched = BTreeSet::new();
    for operation in &patch.operations {
        use crate::generated_v2::ui_patch_operation::Operation;
        match operation
            .operation
            .as_ref()
            .ok_or(ContractError::UnknownPayload)?
        {
            Operation::Upsert(node) => {
                validate_ui_node(node)?;
                if !touched.insert(node.id.as_str()) {
                    return Err(ContractError::InvalidField {
                        field: "uiPatchNode",
                    });
                }
            }
            Operation::Remove(id) | Operation::SetRoot(id) if !valid_ui_id(id) => {
                return Err(ContractError::InvalidField {
                    field: "uiPatchNode",
                });
            }
            Operation::Remove(_) | Operation::SetRoot(_) => {}
        }
    }
    Ok(())
}

fn validate_ui_node(node: &UiNode) -> Result<()> {
    use crate::generated_v2::ui_node::Kind;
    if !valid_ui_id(&node.id)
        || node
            .parent_id
            .as_ref()
            .is_some_and(|value| !valid_ui_id(value))
    {
        return Err(ContractError::InvalidField { field: "uiNodeId" });
    }
    match node.kind.as_ref().ok_or(ContractError::UnknownPayload)? {
        Kind::Table(table)
            if table.page_size == 0
                || table.rows.len() > table.page_size as usize
                || table
                    .rows
                    .iter()
                    .any(|row| row.cells.len() != table.columns.len()) =>
        {
            Err(ContractError::InvalidField { field: "uiTable" })
        }
        Kind::DangerousButton(button)
            if button.confirmation.as_deref().is_none_or(str::is_empty) =>
        {
            Err(ContractError::InvalidField {
                field: "dangerousConfirmation",
            })
        }
        _ => Ok(()),
    }
}

fn valid_ui_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn limit_error<T>(field: &'static str, limit: u64, actual: u64) -> Result<T> {
    Err(ContractError::LimitExceeded {
        field,
        limit,
        actual,
    })
}

pub fn validate_envelope(message: &Envelope) -> Result<()> {
    if message.protocol_major != PROTOCOL_MAJOR {
        return Err(ContractError::IncompatibleMajor {
            found: message.protocol_major,
        });
    }
    if !(MIN_PROTOCOL_MINOR..=MAX_PROTOCOL_MINOR).contains(&message.protocol_minor) {
        return Err(ContractError::InvalidField {
            field: "protocolMinor",
        });
    }
    if message.message_id == 0 {
        return Err(ContractError::InvalidField { field: "messageId" });
    }
    let payload = message
        .payload
        .as_ref()
        .ok_or(ContractError::UnknownPayload)?;

    match payload {
        envelope::Payload::Handshake(value) => {
            validate_handshake(value, message.reply_to, message.protocol_minor)
        }
        envelope::Payload::Request(value) => {
            require_no_reply(message.reply_to)?;
            if value.operation.is_none() {
                return Err(ContractError::UnknownPayload);
            }
            Ok(())
        }
        envelope::Payload::Response(value) => {
            require_reply(message.reply_to)?;
            if value.result.is_none() {
                return Err(ContractError::UnknownPayload);
            }
            Ok(())
        }
        envelope::Payload::Event(value) => {
            require_no_reply(message.reply_to)?;
            if value.item.is_none() {
                return Err(ContractError::UnknownPayload);
            }
            Ok(())
        }
        envelope::Payload::Cancel(value) => {
            require_no_reply(message.reply_to)?;
            if value.target_message_id == 0 {
                return Err(ContractError::InvalidField {
                    field: "targetMessageId",
                });
            }
            Ok(())
        }
        envelope::Payload::Stream(value) => {
            require_no_reply(message.reply_to)?;
            validate_stream(value)
        }
        envelope::Payload::Error(value) => {
            require_reply(message.reply_to)?;
            if value.code == 0 || value.message_key.is_empty() {
                return Err(ContractError::InvalidField { field: "error" });
            }
            Ok(())
        }
    }
}

fn validate_handshake(
    value: &crate::generated_v2::Handshake,
    reply_to: Option<u64>,
    envelope_minor: u32,
) -> Result<()> {
    match value.hello.as_ref().ok_or(ContractError::UnknownPayload)? {
        handshake::Hello::Host(hello) => {
            require_no_reply(reply_to)?;
            validate_hello(
                hello.protocol_major,
                hello.min_minor,
                hello.max_minor,
                &hello.wit_package,
                hello.plugin.as_ref(),
                hello.limits.as_ref(),
            )?;
            validate_selected_minor(envelope_minor, hello.min_minor, hello.max_minor)
        }
        handshake::Hello::Plugin(hello) => {
            require_reply(reply_to)?;
            validate_hello(
                hello.protocol_major,
                hello.min_minor,
                hello.max_minor,
                &hello.wit_package,
                hello.plugin.as_ref(),
                hello.accepted_limits.as_ref(),
            )?;
            if hello.negotiated_minor < hello.min_minor
                || hello.negotiated_minor > hello.max_minor
                || hello.negotiated_minor != envelope_minor
            {
                return Err(ContractError::InvalidField {
                    field: "negotiatedMinor",
                });
            }
            Ok(())
        }
    }
}

fn validate_selected_minor(selected: u32, min: u32, max: u32) -> Result<()> {
    if selected < min || selected > max {
        Err(ContractError::InvalidField {
            field: "negotiatedMinor",
        })
    } else {
        Ok(())
    }
}

fn validate_hello(
    major: u32,
    min_minor: u32,
    max_minor: u32,
    wit_package: &str,
    identity: Option<&crate::generated_v2::PluginIdentity>,
    limits: Option<&ResourceLimits>,
) -> Result<()> {
    if major != PROTOCOL_MAJOR {
        return Err(ContractError::IncompatibleMajor { found: major });
    }
    if min_minor > max_minor || wit_package != WIT_PACKAGE {
        return Err(ContractError::InvalidField { field: "hello" });
    }
    let identity = identity.ok_or(ContractError::InvalidField {
        field: "pluginIdentity",
    })?;
    if identity.plugin_id.is_empty() || identity.plugin_version.is_empty() {
        return Err(ContractError::InvalidField {
            field: "pluginIdentity",
        });
    }
    validate_resource_limits(limits.ok_or(ContractError::InvalidField {
        field: "resourceLimits",
    })?)
}

fn validate_stream(value: &crate::generated_v2::Stream) -> Result<()> {
    match value.item.as_ref().ok_or(ContractError::UnknownPayload)? {
        stream::Item::Open(item)
            if item.stream_id == 0 || item.purpose == 0 || item.initial_window_bytes == 0 =>
        {
            Err(ContractError::InvalidField {
                field: "streamOpen",
            })
        }
        stream::Item::Chunk(item)
            if item.stream_id == 0 || item.payload.len() > MAX_STREAM_CHUNK_BYTES =>
        {
            if item.payload.len() > MAX_STREAM_CHUNK_BYTES {
                limit_error(
                    "streamChunkBytes",
                    MAX_STREAM_CHUNK_BYTES as u64,
                    item.payload.len() as u64,
                )
            } else {
                Err(ContractError::InvalidField {
                    field: "streamChunk",
                })
            }
        }
        stream::Item::Close(item) if item.stream_id == 0 => Err(ContractError::InvalidField {
            field: "streamClose",
        }),
        stream::Item::WindowUpdate(item) if item.stream_id == 0 || item.additional_bytes == 0 => {
            Err(ContractError::InvalidField {
                field: "streamWindowUpdate",
            })
        }
        _ => Ok(()),
    }
}

fn require_reply(reply_to: Option<u64>) -> Result<()> {
    if matches!(reply_to, Some(value) if value != 0) {
        Ok(())
    } else {
        Err(ContractError::InvalidField { field: "replyTo" })
    }
}

fn require_no_reply(reply_to: Option<u64>) -> Result<()> {
    if reply_to.is_none() {
        Ok(())
    } else {
        Err(ContractError::InvalidField { field: "replyTo" })
    }
}

pub fn encode_frame(message: &Envelope) -> Result<Vec<u8>> {
    validate_envelope(message)?;
    let payload = message.encode_to_vec();
    if payload.len() > MAX_FRAME_BYTES {
        return limit_error("frameBytes", MAX_FRAME_BYTES as u64, payload.len() as u64);
    }
    let mut frame = Vec::with_capacity(FRAME_LENGTH_PREFIX_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame(frame: &[u8]) -> Result<Envelope> {
    if frame.len() < FRAME_LENGTH_PREFIX_BYTES {
        return Err(ContractError::TruncatedFrame);
    }
    let announced = u32::from_le_bytes(
        frame[..FRAME_LENGTH_PREFIX_BYTES]
            .try_into()
            .expect("checked"),
    ) as usize;
    if announced > MAX_FRAME_BYTES {
        return limit_error("frameBytes", MAX_FRAME_BYTES as u64, announced as u64);
    }
    if frame.len() != FRAME_LENGTH_PREFIX_BYTES + announced {
        return Err(ContractError::TruncatedFrame);
    }
    let message = Envelope::decode(&frame[FRAME_LENGTH_PREFIX_BYTES..])
        .map_err(|_| ContractError::Protobuf)?;
    validate_envelope(&message)?;
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated_v2::{Handshake, HostHello, PluginIdentity, handshake};

    fn host_hello() -> Envelope {
        Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: 1,
            reply_to: None,
            payload: Some(envelope::Payload::Handshake(Handshake {
                hello: Some(handshake::Hello::Host(HostHello {
                    protocol_major: PROTOCOL_MAJOR,
                    min_minor: MIN_PROTOCOL_MINOR,
                    max_minor: MAX_PROTOCOL_MINOR,
                    wit_package: WIT_PACKAGE.into(),
                    plugin: Some(PluginIdentity {
                        plugin_id: "dev.bbcom.test".into(),
                        plugin_version: "2.0.0".into(),
                        component_sha256: String::new(),
                    }),
                    granted_capabilities: Vec::new(),
                    limits: Some(default_resource_limits()),
                    workspace_id: "workspace".into(),
                    instance_id: "instance".into(),
                    generation: 1,
                })),
            })),
        }
    }

    #[test]
    fn minor_negotiation_selects_highest_overlap() {
        assert_eq!(
            negotiate_minor(2, MinorRange::new(0, 4), 2, MinorRange::new(2, 3)),
            Ok(3)
        );
        assert!(negotiate_minor(2, MinorRange::new(0, 1), 2, MinorRange::new(2, 3)).is_err());
        assert!(matches!(
            negotiate_minor(2, MinorRange::new(0, 1), 3, MinorRange::new(0, 1)),
            Err(ContractError::IncompatibleMajor { found: 3 })
        ));
    }

    #[test]
    fn framed_hello_round_trips() {
        let envelope = host_hello();
        let frame = encode_frame(&envelope).unwrap();
        assert_eq!(decode_frame(&frame).unwrap(), envelope);
    }

    #[test]
    fn message_zero_and_oversized_chunks_are_rejected() {
        let mut envelope = host_hello();
        envelope.message_id = 0;
        assert_eq!(
            validate_envelope(&envelope),
            Err(ContractError::InvalidField { field: "messageId" })
        );

        let envelope = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id: 2,
            reply_to: None,
            payload: Some(envelope::Payload::Stream(crate::generated_v2::Stream {
                item: Some(stream::Item::Chunk(crate::generated_v2::StreamChunk {
                    stream_id: 1,
                    offset: 0,
                    payload: vec![0; MAX_STREAM_CHUNK_BYTES + 1],
                    final_chunk: false,
                })),
            })),
        };
        assert!(matches!(
            validate_envelope(&envelope),
            Err(ContractError::LimitExceeded {
                field: "streamChunkBytes",
                ..
            })
        ));
    }

    #[test]
    fn message_ids_are_strictly_monotonic_per_direction() {
        let mut tracker = MessageIdTracker::new();
        assert_eq!(tracker.observe(1), Ok(()));
        assert_eq!(tracker.observe(4), Ok(()));
        assert_eq!(tracker.last(), 4);
        assert_eq!(
            tracker.observe(4),
            Err(ContractError::InvalidField { field: "messageId" })
        );
        assert_eq!(
            tracker.observe(3),
            Err(ContractError::InvalidField { field: "messageId" })
        );
    }
}
