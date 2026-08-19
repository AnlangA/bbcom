use std::collections::BTreeMap;

use bbcom_plugin_contracts::generated_v2::{Stream, StreamPurpose, stream};
use bbcom_plugin_contracts::v2::{MAX_CONCURRENT_STREAMS, MAX_STREAM_CHUNK_BYTES};

use crate::gateway::GatewayFailure;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamEvent {
    Opened {
        stream_id: u64,
        purpose: StreamPurpose,
        total_bytes: Option<u64>,
    },
    Chunk {
        stream_id: u64,
        offset: u64,
        payload: Vec<u8>,
        final_chunk: bool,
    },
    WindowUpdated {
        stream_id: u64,
        additional_bytes: u32,
    },
    Closed {
        stream_id: u64,
    },
}

impl StreamEvent {
    #[must_use]
    pub const fn stream_id(&self) -> u64 {
        match self {
            Self::Opened { stream_id, .. }
            | Self::Chunk { stream_id, .. }
            | Self::WindowUpdated { stream_id, .. }
            | Self::Closed { stream_id } => *stream_id,
        }
    }
}

#[derive(Clone, Debug)]
struct ActiveStream {
    next_offset: u64,
    remaining_window: u64,
}

#[derive(Default)]
pub struct StreamMultiplexer {
    active: BTreeMap<u64, ActiveStream>,
}

impl StreamMultiplexer {
    pub fn accept(&mut self, stream: Stream) -> Result<StreamEvent, GatewayFailure> {
        match stream.item.ok_or_else(GatewayFailure::protocol)? {
            stream::Item::Open(open) => {
                let purpose = StreamPurpose::try_from(open.purpose)
                    .ok()
                    .filter(|value| *value != StreamPurpose::Unspecified)
                    .ok_or_else(GatewayFailure::protocol)?;
                if open.stream_id == 0
                    || open.initial_window_bytes == 0
                    || self.active.len() >= MAX_CONCURRENT_STREAMS as usize
                    || self.active.contains_key(&open.stream_id)
                {
                    return Err(GatewayFailure::limit());
                }
                self.active.insert(
                    open.stream_id,
                    ActiveStream {
                        next_offset: 0,
                        remaining_window: open.initial_window_bytes.into(),
                    },
                );
                Ok(StreamEvent::Opened {
                    stream_id: open.stream_id,
                    purpose,
                    total_bytes: open.total_bytes,
                })
            }
            stream::Item::Chunk(chunk) => {
                if chunk.payload.len() > MAX_STREAM_CHUNK_BYTES {
                    return Err(GatewayFailure::limit());
                }
                let state = self
                    .active
                    .get_mut(&chunk.stream_id)
                    .ok_or_else(GatewayFailure::protocol)?;
                if chunk.offset != state.next_offset
                    || chunk.payload.len() as u64 > state.remaining_window
                {
                    return Err(GatewayFailure::protocol());
                }
                state.next_offset = state
                    .next_offset
                    .checked_add(chunk.payload.len() as u64)
                    .ok_or_else(GatewayFailure::limit)?;
                state.remaining_window -= chunk.payload.len() as u64;
                let event = StreamEvent::Chunk {
                    stream_id: chunk.stream_id,
                    offset: chunk.offset,
                    payload: chunk.payload,
                    final_chunk: chunk.final_chunk,
                };
                if chunk.final_chunk {
                    self.active.remove(&chunk.stream_id);
                }
                Ok(event)
            }
            stream::Item::WindowUpdate(update) => {
                let state = self
                    .active
                    .get_mut(&update.stream_id)
                    .ok_or_else(GatewayFailure::protocol)?;
                if update.additional_bytes == 0 {
                    return Err(GatewayFailure::protocol());
                }
                state.remaining_window = state
                    .remaining_window
                    .checked_add(update.additional_bytes.into())
                    .ok_or_else(GatewayFailure::limit)?;
                Ok(StreamEvent::WindowUpdated {
                    stream_id: update.stream_id,
                    additional_bytes: update.additional_bytes,
                })
            }
            stream::Item::Close(close) => {
                if self.active.remove(&close.stream_id).is_none() {
                    return Err(GatewayFailure::protocol());
                }
                Ok(StreamEvent::Closed {
                    stream_id: close.stream_id,
                })
            }
        }
    }

    #[must_use]
    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    /// Aborts one stream after its downstream consumer rejects an admitted
    /// event. This keeps the broker window/resource state transactional with
    /// the production capability sink.
    pub fn abort(&mut self, stream_id: u64) -> bool {
        self.active.remove(&stream_id).is_some()
    }

    pub fn abort_all(&mut self) {
        self.active.clear();
    }
}

#[cfg(test)]
mod tests {
    use bbcom_plugin_contracts::generated_v2::{ErrorCode, StreamChunk, StreamOpen, StreamPurpose};

    use super::*;

    fn open(stream_id: u64, window: u32) -> Stream {
        Stream {
            item: Some(stream::Item::Open(StreamOpen {
                stream_id,
                purpose: StreamPurpose::FileRead as i32,
                initial_window_bytes: window,
                total_bytes: None,
            })),
        }
    }

    #[test]
    fn stream_window_enforces_order_backpressure_and_final_close() {
        let mut streams = StreamMultiplexer::default();
        assert!(matches!(
            streams.accept(open(7, 3)).unwrap(),
            StreamEvent::Opened { stream_id: 7, .. }
        ));
        assert_eq!(streams.active_count(), 1);

        let out_of_order = Stream {
            item: Some(stream::Item::Chunk(StreamChunk {
                stream_id: 7,
                offset: 1,
                payload: vec![1],
                final_chunk: false,
            })),
        };
        assert_eq!(
            streams.accept(out_of_order).unwrap_err().code,
            ErrorCode::ProtocolError
        );

        let final_chunk = Stream {
            item: Some(stream::Item::Chunk(StreamChunk {
                stream_id: 7,
                offset: 0,
                payload: vec![1, 2, 3],
                final_chunk: true,
            })),
        };
        assert!(matches!(
            streams.accept(final_chunk).unwrap(),
            StreamEvent::Chunk {
                final_chunk: true,
                ..
            }
        ));
        assert_eq!(streams.active_count(), 0);
    }

    #[test]
    fn concurrent_stream_limit_is_strict() {
        let mut streams = StreamMultiplexer::default();
        for stream_id in 1..=MAX_CONCURRENT_STREAMS as u64 {
            streams.accept(open(stream_id, 1)).unwrap();
        }
        assert_eq!(
            streams
                .accept(open(MAX_CONCURRENT_STREAMS as u64 + 1, 1))
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
    }
}
