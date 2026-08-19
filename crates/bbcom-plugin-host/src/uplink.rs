//! Typed protocol-v2 sidecar -> application capability RPC.
//!
//! Guest imports execute synchronously on the Wasmtime thread. Requests are
//! written on the shared framed stdout and the input pump delivers the typed
//! response to a bounded waiter. No method strings or JSON payloads cross this
//! boundary.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bbcom_plugin_contracts::generated_v2::{
    Cancel, Envelope, Error, Request, envelope, request, response,
};
use bbcom_plugin_contracts::v2::{MAX_PENDING_HOST_REQUESTS, MAX_PROTOCOL_MINOR, PROTOCOL_MAJOR};

use crate::transport::FrameWriter;
use crate::{HostError, Result};

#[derive(Debug)]
pub enum RpcFailure {
    Remote(Error),
    Timeout,
    Cancelled,
    Protocol,
    Transport,
    Limit,
}

#[derive(Default)]
pub struct MessageIdSequence(AtomicU64);

impl MessageIdSequence {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(1)))
    }

    pub fn next(&self) -> Result<u64> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1).filter(|next| *next != 0)
            })
            .map_err(|_| HostError::Transport)
    }
}

type WaitResult = std::result::Result<response::Result, RpcFailure>;

pub struct CapabilityRpc {
    writer: Mutex<FrameWriter<Box<dyn Write + Send>>>,
    ids: Arc<MessageIdSequence>,
    waiters: Mutex<BTreeMap<u64, SyncSender<WaitResult>>>,
}

impl CapabilityRpc {
    #[must_use]
    pub fn new(writer: Box<dyn Write + Send>, ids: Arc<MessageIdSequence>) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(FrameWriter::new(writer)),
            ids,
            waiters: Mutex::new(BTreeMap::new()),
        })
    }

    #[must_use]
    pub fn message_ids(&self) -> Arc<MessageIdSequence> {
        Arc::clone(&self.ids)
    }

    pub fn call(
        &self,
        operation: request::Operation,
        timeout: Duration,
    ) -> std::result::Result<response::Result, RpcFailure> {
        let message_id = self.ids.next().map_err(|_| RpcFailure::Transport)?;
        let receiver = self.register(message_id)?;
        let envelope = Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id,
            reply_to: None,
            payload: Some(envelope::Payload::Request(Request {
                operation: Some(operation),
            })),
        };
        if self.write(&envelope).is_err() {
            self.remove(message_id);
            return Err(RpcFailure::Transport);
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.remove(message_id);
                let _ = self.send_cancel(message_id, "host-import-timeout");
                Err(RpcFailure::Timeout)
            }
            Err(RecvTimeoutError::Disconnected) => Err(RpcFailure::Transport),
        }
    }

    pub fn send_cancel(&self, target_message_id: u64, reason: &str) -> Result<()> {
        let message_id = self.ids.next()?;
        self.write(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: MAX_PROTOCOL_MINOR,
            message_id,
            reply_to: None,
            payload: Some(envelope::Payload::Cancel(Cancel {
                target_message_id,
                reason: reason.to_owned(),
            })),
        })
    }

    pub fn cancel_all(&self) {
        let waiters = {
            let mut waiters = self
                .waiters
                .lock()
                .unwrap_or_else(|value| value.into_inner());
            std::mem::take(&mut *waiters)
        };
        for (message_id, waiter) in waiters {
            let _ = self.send_cancel(message_id, "guest-call-cancelled");
            let _ = waiter.send(Err(RpcFailure::Cancelled));
        }
    }

    fn register(&self, message_id: u64) -> std::result::Result<Receiver<WaitResult>, RpcFailure> {
        let mut waiters = self
            .waiters
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if waiters.len() >= MAX_PENDING_HOST_REQUESTS as usize {
            return Err(RpcFailure::Limit);
        }
        let (sender, receiver) = sync_channel(1);
        if waiters.insert(message_id, sender).is_some() {
            return Err(RpcFailure::Protocol);
        }
        Ok(receiver)
    }

    fn remove(&self, message_id: u64) {
        self.waiters
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(&message_id);
    }

    fn write(&self, envelope: &Envelope) -> Result<()> {
        self.writer
            .lock()
            .map_err(|_| HostError::Transport)?
            .write_envelope(envelope)
    }

    fn dispatch(&self, envelope: Envelope) -> Option<Envelope> {
        let reply_to = match envelope.reply_to {
            Some(value) => value,
            None => return Some(envelope),
        };
        let result = match envelope.payload.clone() {
            Some(envelope::Payload::Response(value)) => value.result.ok_or(RpcFailure::Protocol),
            Some(envelope::Payload::Error(value)) => Err(RpcFailure::Remote(value)),
            _ => return Some(envelope),
        };
        let sender = self
            .waiters
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .remove(&reply_to);
        match sender {
            Some(sender) => {
                let _ = sender.send(result);
                None
            }
            None => Some(Envelope {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: MAX_PROTOCOL_MINOR,
                message_id: envelope.message_id,
                reply_to: Some(reply_to),
                payload: None,
            }),
        }
    }
}

impl Drop for CapabilityRpc {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

pub(crate) struct CapabilityRpcDispatcher(pub Arc<CapabilityRpc>);

impl crate::transport::EnvelopeDispatcher for CapabilityRpcDispatcher {
    fn dispatch(&self, envelope: Envelope) -> Option<Envelope> {
        self.0.dispatch(envelope)
    }
}
