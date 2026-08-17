//! Sidecar→main-process uplink for WIT host imports that need data the
//! sidecar does not own: serial-write proposal decisions (WP8) and G43
//! session metadata / capture pages (WP9).
//!
//! A WIT import such as `propose-serial-send` runs on the sidecar main loop
//! thread inside the guest's own export. It pushes a request envelope to the
//! main process on a dedicated writer handle and parks on a one-shot channel
//! keyed by the request's correlation id; the pump thread routes the matching
//! reply directly into that channel (`EnvelopeDispatcher`), bypassing the
//! main envelope queue. Every wait is bounded — the serial proposal wait
//! slightly exceeds the trusted broker TTL so expiry resolves as `cancelled`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bbcom_plugin_contracts::generated::{
    Envelope, ProposalOutcomeValue, SessionQueryResponse, SerialProposalEvent,
    SessionQueryRequest, envelope,
};
use bbcom_plugin_contracts::{PROTOCOL_MAJOR, PROTOCOL_MINOR};

use crate::transport::FrameWriter;
use crate::{HostError, Result};

/// Mirrors the trusted broker's proposal TTL (bbcom-plugin-broker). The wait
/// adds a 5s margin so expiry resolves as `Cancelled` deterministically
/// instead of racing the broker clock.
const SERIAL_PROPOSAL_TTL_MS: u64 = 60_000;

/// Final disposition of a serial write proposal as delivered by main.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalOutcome {
    Approved,
    Rejected,
    Expired,
}

struct PushWaiters<T> {
    waiters: Mutex<HashMap<String, SyncSender<T>>>,
}

impl<T: Send + 'static> PushWaiters<T> {
    fn new() -> Self {
        Self {
            waiters: Mutex::new(HashMap::new()),
        }
    }
    fn register(&self, key: &str) -> Receiver<T> {
        let (sender, receiver) = sync_channel(1);
        self.waiters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key.to_owned(), sender);
        receiver
    }

    fn deliver(&self, key: &str, value: T) -> bool {
        self.waiters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key)
            .is_some_and(|sender| sender.send(value).is_ok())
    }
}

/// Shared uplink: the pump thread dispatches replies here while WIT imports
/// push requests and await their correlated reply.
pub struct Uplink {
    plugin_id: String,
    writer: Mutex<FrameWriter<Box<dyn Write + Send>>>,
    proposals: PushWaiters<ProposalOutcome>,
    queries: PushWaiters<Arc<SessionQueryResponse>>,
    /// Wire validation rejects request_id 0 and request ids must never be
    /// confused with the main loop's echo responses, so pushes live in a
    /// dedicated high bit range.
    push_request_id: AtomicU64,
}

/// First id of the push range (monotonically increasing from here).
const PUSH_REQUEST_ID_BASE: u64 = 1 << 63;

impl Uplink {
    #[must_use]
    pub fn new(plugin_id: String, writer: Box<dyn Write + Send>) -> Arc<Self> {
        Arc::new(Self {
            plugin_id,
            writer: Mutex::new(FrameWriter::new(writer)),
            proposals: PushWaiters::new(),
            queries: PushWaiters::new(),
            push_request_id: AtomicU64::new(PUSH_REQUEST_ID_BASE),
        })
    }

    #[must_use]
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    fn write_push(&self, payload: envelope::Payload) -> Result<()> {
        let request_id = self.push_request_id.fetch_add(1, Ordering::Relaxed);
        let mut writer = self.writer.lock().map_err(|_| HostError::Transport)?;
        writer.write_envelope(&Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(payload),
        })
    }

    /// Push the proposal event, then park until main delivers the decision.
    /// The wait outlives the broker TTL by 5s so an expiring proposal is
    /// observed as `Cancelled` deterministically instead of racing the TTL.
    pub fn request_proposal_outcome(
        &self,
        event: SerialProposalEvent,
    ) -> Result<Option<ProposalOutcome>> {
        let waiter = self.proposals.register(&event.proposal_id);
        self.write_push(envelope::Payload::SerialProposalEvent(event))?;
        Ok(match waiter.recv_timeout(proposal_wait()) {
            Ok(outcome) => Some(outcome),
            Err(RecvTimeoutError::Timeout) => Some(ProposalOutcome::Expired),
            Err(RecvTimeoutError::Disconnected) => None,
        })
    }

    /// Push a session/capture query, then park for the bounded reply.
    pub fn request_session_query(
        &self,
        request: SessionQueryRequest,
        timeout: Duration,
    ) -> Result<Option<Arc<SessionQueryResponse>>> {
        let waiter = self.queries.register(&request.query_id);
        self.write_push(envelope::Payload::SessionQueryRequest(request))?;
        Ok(match waiter.recv_timeout(timeout) {
            Ok(response) => Some(response),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
        })
    }

    /// Route a main-process push reply to its parked waiter. `None`
    /// consumes the envelope (it was a routed reply); `Some` hands an
    /// unrelated envelope back to the pump's normal path.
    pub fn dispatch_push(&self, mut envelope: Envelope) -> Option<Envelope> {
        match envelope.payload.take() {
            None => Some(envelope),
            Some(payload) => match payload {
                envelope::Payload::ProposalResult(result) => {
                    let outcome = match ProposalOutcomeValue::try_from(result.outcome) {
                        Ok(ProposalOutcomeValue::Approved) => ProposalOutcome::Approved,
                        Ok(ProposalOutcomeValue::Rejected) => ProposalOutcome::Rejected,
                        _ => ProposalOutcome::Expired,
                    };
                    self.proposals.deliver(&result.proposal_id, outcome);
                    None
                }
                envelope::Payload::SessionQueryResponse(response) => {
                    let query_id = response.query_id.clone();
                    self.queries.deliver(&query_id, Arc::new(response));
                    None
                }
                other => {
                    envelope.payload = Some(other);
                    Some(envelope)
                }
            },
        }
    }
}

/// Pump adapter: routes proposal decisions and session-query replies.
pub(crate) struct UplinkDispatcher(pub Arc<Uplink>);

impl crate::transport::EnvelopeDispatcher for UplinkDispatcher {
    fn dispatch(&self, envelope: Envelope) -> Option<Envelope> {
        self.0.dispatch_push(envelope)
    }
}

fn proposal_wait() -> Duration {
    Duration::from_millis(SERIAL_PROPOSAL_TTL_MS + 5_000)
}
#[cfg(test)]
mod tests {
    use super::*;
    use bbcom_plugin_contracts::generated::SessionListQuery;

    fn envelope_with(payload: envelope::Payload, request_id: u64) -> Envelope {
        Envelope {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            request_id,
            payload: Some(payload),
        }
    }

    fn proposal_event(proposal_id: &str) -> SerialProposalEvent {
        SerialProposalEvent {
            plugin_id: "dev.bbcom.fixture".to_owned(),
            proposal_id: proposal_id.to_owned(),
            operation_id: "sidecar-proposal-1".to_owned(),
            session_id: "session-1".to_owned(),
            display_label: "write".to_owned(),
            payload: vec![1, 2, 3],
        }
    }

    fn query_request(query_id: &str) -> SessionQueryRequest {
        SessionQueryRequest {
            plugin_id: "dev.bbcom.fixture".to_owned(),
            query_id: query_id.to_owned(),
            query: Some(
                bbcom_plugin_contracts::generated::session_query_request::Query::List(
                    SessionListQuery {},
                ),
            ),
        }
    }

    #[test]
    fn proposal_outcomes_are_delivered_to_the_parked_waiter() {
        // Channel pair captures the pushed envelope without a real main
        // process: the writer side is the receiving end of the probe.
        let (writer_sender, writer_receiver) = sync_channel::<Vec<u8>>(8);
        struct ProbeWriter(std::sync::mpsc::SyncSender<Vec<u8>>);
        impl Write for ProbeWriter {
            fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
                self.0.send(buffer.to_vec()).map_err(std::io::Error::other)?;
                Ok(buffer.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let uplink = Uplink::new(
            "dev.bbcom.fixture".to_owned(),
            Box::new(ProbeWriter(writer_sender)),
        );

        let event = proposal_event("proposal-1");
        let waiter = {
            // Register through the public API path by spawning the request on
            // another thread; the probe writer received the pushed frame.
            let uplink = Arc::clone(&uplink);
            let (started_tx, started_rx) = sync_channel(1);
            let handle = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                uplink
                    .request_proposal_outcome(proposal_event("proposal-1"))
                    .expect("push succeeds")
            });
            started_rx.recv().unwrap();
            writer_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("push frame written");
            handle
        };

        let delivered = uplink.dispatch_push(envelope_with(
            envelope::Payload::ProposalResult(bbcom_plugin_contracts::generated::ProposalResult {
                proposal_id: "proposal-1".to_owned(),
                outcome: ProposalOutcomeValue::Approved as i32,
            }),
            1 << 63,
        ));
        assert!(delivered.is_none());
        assert_eq!(waiter.join().unwrap(), Some(ProposalOutcome::Approved));
    }

    #[test]
    fn push_payloads_are_always_consumed_and_other_envelopes_pass_through() {
        let uplink = Uplink::new("dev.bbcom.fixture".to_owned(), Box::new(Vec::new()));
        // A proposal decision with no parked waiter (e.g. it arrived after the
        // sidecar already resolved the call as cancelled) is still consumed:
        // the main envelope loop could only reject it with a protocol error.
        let consumed = uplink.dispatch_push(envelope_with(
            envelope::Payload::ProposalResult(bbcom_plugin_contracts::generated::ProposalResult {
                proposal_id: "proposal-unknown".to_owned(),
                outcome: ProposalOutcomeValue::Rejected as i32,
            }),
            42,
        ));
        assert!(consumed.is_none());
        // Unrelated payloads must pass through untouched for the normal path.
        let passthrough = uplink.dispatch_push(envelope_with(
            envelope::Payload::InvokeRequest(bbcom_plugin_contracts::generated::InvokeRequest {
                method: "panel-event".to_owned(),
                body: Vec::new(),
                long_running: false,
            }),
            7,
        ));
        assert!(passthrough.is_some());
    }

    #[test]
    fn query_replies_deliver_the_full_response_snapshot() {
        let (writer_sender, writer_receiver) = sync_channel::<Vec<u8>>(8);
        struct ProbeWriter(std::sync::mpsc::SyncSender<Vec<u8>>);
        impl Write for ProbeWriter {
            fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
                self.0.send(buffer.to_vec()).map_err(std::io::Error::other)?;
                Ok(buffer.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let uplink = Uplink::new(
            "dev.bbcom.fixture".to_owned(),
            Box::new(ProbeWriter(writer_sender)),
        );
        let uplink_for_thread = Arc::clone(&uplink);
        let handle = std::thread::spawn(move || {
            uplink_for_thread.request_session_query(
                query_request("query-1"),
                Duration::from_secs(1),
            )
        });
        // The pushed frame doubles as the registration signal: by the time it
        // reaches the probe the waiter is parked, so the reply cannot race.
        writer_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("push frame written");
        let delivered = uplink.dispatch_push(envelope_with(
            envelope::Payload::SessionQueryResponse(SessionQueryResponse {
                query_id: "query-1".to_owned(),
                ok: true,
                error_code: String::new(),
                sessions: vec![bbcom_plugin_contracts::generated::SessionMetadataEntry {
                    session_id: "session-1".to_owned(),
                    name: "ttyUSB0".to_owned(),
                    kind: "serial".to_owned(),
                    connected: true,
                    rx_bytes: 10,
                    tx_bytes: 5,
                }],
                frames: Vec::new(),
                next_sequence: 0,
                has_more: false,
            }),
            1 << 63,
        ));
        assert!(delivered.is_none());
        let response = handle.join().unwrap().unwrap().expect("reply");
        assert_eq!(response.sessions.len(), 1);
        assert!(response.sessions[0].connected);
    }
}
