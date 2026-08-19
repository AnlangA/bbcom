use crate::{ContractError, Result};

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
pub const MAX_UI_DOCUMENT_BYTES: usize = 512 * 1024;
pub const MAX_UI_NODES: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MinorRange {
    pub min: u32,
    pub max: u32,
}

impl MinorRange {
    #[must_use]
    pub const fn new(min: u32, max: u32) -> Self {
        Self { min, max }
    }
}

pub fn negotiate_minor(
    local_major: u32,
    local: MinorRange,
    peer_major: u32,
    peer: MinorRange,
) -> Result<u32> {
    if local_major != PROTOCOL_MAJOR || peer_major != PROTOCOL_MAJOR {
        return Err(ContractError::ProtocolError);
    }
    if local.min > local.max || peer.min > peer.max {
        return Err(ContractError::InvalidInput);
    }
    let minimum = if local.min > peer.min {
        local.min
    } else {
        peer.min
    };
    let maximum = if local.max < peer.max {
        local.max
    } else {
        peer.max
    };
    if minimum > maximum {
        Err(ContractError::ProtocolError)
    } else {
        Ok(maximum)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceLimits {
    pub max_frame_bytes: usize,
    pub max_queue_bytes: usize,
    pub max_stream_chunk_bytes: usize,
    pub max_concurrent_streams: u32,
    pub max_pending_host_requests: u32,
    pub wasm_memory_limit_bytes: usize,
    pub host_process_memory_limit_bytes: usize,
    pub call_timeout_ms: u32,
    pub serial_read_timeout_ms: u32,
    pub long_task_timeout_ms: u64,
    pub activity_timeout_ms: u32,
    pub max_ui_document_bytes: usize,
    pub max_ui_nodes: usize,
}

impl ResourceLimits {
    pub const HOST_MAXIMUM: Self = Self {
        max_frame_bytes: MAX_FRAME_BYTES,
        max_queue_bytes: MAX_QUEUE_BYTES,
        max_stream_chunk_bytes: MAX_STREAM_CHUNK_BYTES,
        max_concurrent_streams: MAX_CONCURRENT_STREAMS,
        max_pending_host_requests: MAX_PENDING_HOST_REQUESTS,
        wasm_memory_limit_bytes: WASM_MEMORY_LIMIT_BYTES,
        host_process_memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
        call_timeout_ms: CALL_TIMEOUT_MS,
        serial_read_timeout_ms: SERIAL_READ_TIMEOUT_MS,
        long_task_timeout_ms: LONG_TASK_TIMEOUT_MS,
        activity_timeout_ms: ACTIVITY_TIMEOUT_MS,
        max_ui_document_bytes: MAX_UI_DOCUMENT_BYTES,
        max_ui_nodes: MAX_UI_NODES,
    };

    pub fn validate(self) -> Result<()> {
        let host = Self::HOST_MAXIMUM;
        let valid = self.max_frame_bytes > 0
            && self.max_frame_bytes <= host.max_frame_bytes
            && self.max_queue_bytes > 0
            && self.max_queue_bytes <= host.max_queue_bytes
            && self.max_stream_chunk_bytes > 0
            && self.max_stream_chunk_bytes <= host.max_stream_chunk_bytes
            && self.max_concurrent_streams > 0
            && self.max_concurrent_streams <= host.max_concurrent_streams
            && self.max_pending_host_requests > 0
            && self.max_pending_host_requests <= host.max_pending_host_requests
            && self.wasm_memory_limit_bytes > 0
            && self.wasm_memory_limit_bytes <= host.wasm_memory_limit_bytes
            && self.host_process_memory_limit_bytes > 0
            && self.host_process_memory_limit_bytes <= host.host_process_memory_limit_bytes
            && self.call_timeout_ms > 0
            && self.call_timeout_ms <= host.call_timeout_ms
            && self.serial_read_timeout_ms > 0
            && self.serial_read_timeout_ms <= host.serial_read_timeout_ms
            && self.long_task_timeout_ms > 0
            && self.long_task_timeout_ms <= host.long_task_timeout_ms
            && self.activity_timeout_ms > 0
            && self.activity_timeout_ms <= host.activity_timeout_ms
            && self.max_ui_document_bytes > 0
            && self.max_ui_document_bytes <= host.max_ui_document_bytes
            && self.max_ui_nodes > 0
            && self.max_ui_nodes <= host.max_ui_nodes;
        if valid {
            Ok(())
        } else {
            Err(ContractError::LimitExceeded)
        }
    }
}
