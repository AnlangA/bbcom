use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

use bbcom_plugin_contracts::FRAME_LENGTH_PREFIX_BYTES;
use bbcom_plugin_contracts::generated_v2::{Envelope, envelope, request};
use bbcom_plugin_contracts::v2::{
    MAX_FRAME_BYTES, MAX_QUEUE_BYTES, MessageIdTracker, decode_frame, encode_frame,
};

use crate::{HostError, Result};

pub struct FrameReader<R> {
    inner: R,
}

impl<R: Read> FrameReader<R> {
    #[must_use]
    pub const fn new(inner: R) -> Self {
        Self { inner }
    }

    pub fn read_envelope(&mut self) -> Result<Option<Envelope>> {
        self.read_envelope_with_size()
            .map(|value| value.map(|(envelope, _)| envelope))
    }

    fn read_envelope_with_size(&mut self) -> Result<Option<(Envelope, usize)>> {
        let mut prefix = [0_u8; FRAME_LENGTH_PREFIX_BYTES];
        match self.inner.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => {}
            Ok(_) => unreachable!("one-byte read returned more than one byte"),
            Err(error) if error.kind() == ErrorKind::Interrupted => {
                return self.read_envelope_with_size();
            }
            Err(_) => return Err(HostError::Transport),
        }
        self.inner
            .read_exact(&mut prefix[1..])
            .map_err(|error| match error.kind() {
                ErrorKind::UnexpectedEof => HostError::TruncatedTransport,
                _ => HostError::Transport,
            })?;
        let announced = u32::from_le_bytes(prefix) as usize;
        if announced > MAX_FRAME_BYTES {
            return Err(bbcom_plugin_contracts::ContractError::LimitExceeded {
                field: "frameBytes",
                limit: MAX_FRAME_BYTES as u64,
                actual: announced as u64,
            }
            .into());
        }
        let mut frame = Vec::with_capacity(FRAME_LENGTH_PREFIX_BYTES + announced);
        frame.extend_from_slice(&prefix);
        frame.resize(FRAME_LENGTH_PREFIX_BYTES + announced, 0);
        self.inner
            .read_exact(&mut frame[FRAME_LENGTH_PREFIX_BYTES..])
            .map_err(|error| match error.kind() {
                ErrorKind::UnexpectedEof => HostError::TruncatedTransport,
                _ => HostError::Transport,
            })?;
        let envelope = decode_frame(&frame).map_err(HostError::from)?;
        Ok(Some((envelope, frame.len())))
    }
}

pub struct FrameWriter<W> {
    inner: W,
}

impl<W: Write> FrameWriter<W> {
    #[must_use]
    pub const fn new(inner: W) -> Self {
        Self { inner }
    }

    pub fn write_envelope(&mut self, envelope: &Envelope) -> Result<()> {
        let frame = encode_frame(envelope)?;
        self.inner
            .write_all(&frame)
            .map_err(|_| HostError::Transport)?;
        self.inner.flush().map_err(|_| HostError::Transport)
    }
}

#[derive(Default)]
pub struct BoundedFrameQueue {
    frames: VecDeque<Vec<u8>>,
    queued_bytes: usize,
}

impl BoundedFrameQueue {
    pub fn push(&mut self, frame: Vec<u8>) -> Result<()> {
        if frame.len() > FRAME_LENGTH_PREFIX_BYTES + MAX_FRAME_BYTES {
            return Err(bbcom_plugin_contracts::ContractError::LimitExceeded {
                field: "frameBytes",
                limit: MAX_FRAME_BYTES as u64,
                actual: frame.len().saturating_sub(FRAME_LENGTH_PREFIX_BYTES) as u64,
            }
            .into());
        }
        let next = self.queued_bytes.checked_add(frame.len()).ok_or(
            bbcom_plugin_contracts::ContractError::LimitExceeded {
                field: "queueBytes",
                limit: MAX_QUEUE_BYTES as u64,
                actual: u64::MAX,
            },
        )?;
        if next > MAX_QUEUE_BYTES {
            return Err(bbcom_plugin_contracts::ContractError::LimitExceeded {
                field: "queueBytes",
                limit: MAX_QUEUE_BYTES as u64,
                actual: next as u64,
            }
            .into());
        }
        self.queued_bytes = next;
        self.frames.push_back(frame);
        Ok(())
    }

    pub fn pop(&mut self) -> Option<Vec<u8>> {
        let frame = self.frames.pop_front()?;
        self.queued_bytes -= frame.len();
        Some(frame)
    }

    #[must_use]
    pub const fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }
}

pub(crate) enum PumpEvent {
    Envelope(Envelope, ByteQueuePermit),
    Cancel(Envelope, ByteQueuePermit, bool),
    Busy(Envelope, ByteQueuePermit),
    Eof,
    Failed(HostError),
}

pub(crate) trait InputOperationControl: Send + Sync + 'static {
    fn register(&self, message_id: u64) -> bool;
    fn cancel(&self, target_message_id: u64) -> bool;
}

/// Routes correlated capability-RPC replies awaited by parked WIT host imports
/// rather than the main guest-operation loop. Returning `None` consumes the
/// envelope; `Some` hands it back to the normal pump path. Public because the
/// sidecar's `run_with_dispatcher` accepts it from embedders.
pub trait EnvelopeDispatcher: Send + Sync + 'static {
    fn dispatch(&self, envelope: Envelope) -> Option<Envelope>;
}

pub(crate) struct FramePump {
    receiver: Receiver<PumpEvent>,
    join: Option<JoinHandle<()>>,
}

impl FramePump {
    pub fn spawn<R>(
        reader: R,
        operations: Arc<dyn InputOperationControl>,
        dispatcher: Option<Arc<dyn EnvelopeDispatcher>>,
    ) -> Result<Self>
    where
        R: Read + Send + 'static,
    {
        // Byte permits enforce the exact 16 MiB bound. A separate count bound
        // prevents protobuf/container overhead from becoming unbounded for a
        // stream of extremely small frames.
        let (sender, receiver) = sync_channel(1_024);
        let byte_budget = Arc::new(ByteQueueBudget::default());
        let join = thread::Builder::new()
            .name("bbcom-plugin-input".to_owned())
            .spawn(move || pump_frames(reader, sender, byte_budget, operations, dispatcher))
            .map_err(|_| HostError::Transport)?;
        Ok(Self {
            receiver,
            join: Some(join),
        })
    }

    #[must_use]
    pub const fn receiver(&self) -> &Receiver<PumpEvent> {
        &self.receiver
    }
}

impl Drop for FramePump {
    fn drop(&mut self) {
        // stdin/pipe ownership belongs to the thread. A clean EOF lets it join;
        // a blocked OS read is terminated with the sidecar process itself.
        if self.join.as_ref().is_some_and(JoinHandle::is_finished)
            && let Some(join) = self.join.take()
        {
            let _ = join.join();
        }
    }
}

fn pump_frames<R: Read>(
    reader: R,
    sender: SyncSender<PumpEvent>,
    byte_budget: Arc<ByteQueueBudget>,
    operations: Arc<dyn InputOperationControl>,
    dispatcher: Option<Arc<dyn EnvelopeDispatcher>>,
) {
    let mut reader = FrameReader::new(reader);
    let mut message_ids = MessageIdTracker::new();
    loop {
        let event = match reader.read_envelope_with_size() {
            Ok(Some((envelope, bytes))) => {
                if let Err(error) = message_ids.observe(envelope.message_id) {
                    let _ = sender.send(PumpEvent::Failed(error.into()));
                    return;
                }
                let permit = byte_budget.reserve(bytes);
                // Push replies awaited by parked host imports bypass the
                // main queue entirely; their permit is released on drop here.
                let mut envelope = envelope;
                if let Some(dispatch) = dispatcher.as_deref() {
                    match dispatch.dispatch(envelope) {
                        None => {
                            drop(permit);
                            continue;
                        }
                        Some(unconsumed) => envelope = unconsumed,
                    }
                }
                match envelope.payload.as_ref() {
                    Some(envelope::Payload::Request(request))
                        if request.operation.as_ref().is_some_and(is_guest_operation) =>
                    {
                        if operations.register(envelope.message_id) {
                            PumpEvent::Envelope(envelope, permit)
                        } else {
                            PumpEvent::Busy(envelope, permit)
                        }
                    }
                    Some(envelope::Payload::Cancel(request)) => {
                        let accepted = operations.cancel(request.target_message_id);
                        PumpEvent::Cancel(envelope, permit, accepted)
                    }
                    _ => PumpEvent::Envelope(envelope, permit),
                }
            }
            Ok(None) => PumpEvent::Eof,
            Err(error) => PumpEvent::Failed(error),
        };
        let terminal = matches!(event, PumpEvent::Eof | PumpEvent::Failed(_));
        if sender.send(event).is_err() || terminal {
            return;
        }
    }
}

fn is_guest_operation(operation: &request::Operation) -> bool {
    matches!(
        operation,
        request::Operation::Initialize(_)
            | request::Operation::HandleEvent(_)
            | request::Operation::RunCommand(_)
            | request::Operation::MigrateState(_)
            | request::Operation::Shutdown(_)
    )
}

#[derive(Default)]
struct ByteQueueBudget {
    queued_bytes: Mutex<usize>,
    available: Condvar,
}

impl ByteQueueBudget {
    fn reserve(self: &Arc<Self>, bytes: usize) -> ByteQueuePermit {
        debug_assert!(bytes <= FRAME_LENGTH_PREFIX_BYTES + MAX_FRAME_BYTES);
        let mut queued = self
            .queued_bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while queued.saturating_add(bytes) > MAX_QUEUE_BYTES {
            queued = self
                .available
                .wait(queued)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *queued += bytes;
        ByteQueuePermit {
            budget: Arc::clone(self),
            bytes,
        }
    }
}

pub(crate) struct ByteQueuePermit {
    budget: Arc<ByteQueueBudget>,
    bytes: usize,
}

impl Drop for ByteQueuePermit {
    fn drop(&mut self) {
        let mut queued = self
            .budget
            .queued_bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *queued = queued.saturating_sub(self.bytes);
        self.budget.available.notify_one();
    }
}
