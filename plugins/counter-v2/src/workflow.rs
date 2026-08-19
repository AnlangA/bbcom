use alloc::format;
use alloc::vec::Vec;

use bbcom_plugin_sdk::serial::{WriteOutcome, WriteResult};
use bbcom_plugin_sdk::{ContractError, Result};

/// Small authority boundary that makes the transaction-lease workflow
/// testable without a serial device or native API.
pub trait CounterLease {
    fn write(&mut self, payload: &[u8]) -> Result<WriteResult>;
    fn release(&mut self) -> Result<()>;
}

pub fn counter_payload(count: u64) -> Vec<u8> {
    format!("counter={count}\n").into_bytes()
}

/// Writes once and releases on every path. No error after a physical write is
/// retried: `partial-write` and `unknown-outcome` remain visible to the caller.
pub fn send_counter(lease: &mut impl CounterLease, count: u64) -> Result<usize> {
    let payload = counter_payload(count);
    let write = lease.write(&payload).and_then(|result| {
        if result.requested != payload.len() as u64 || result.sent > result.requested {
            return Err(ContractError::ProtocolError);
        }
        match result.outcome {
            WriteOutcome::Completed if result.sent == result.requested => Ok(result.sent as usize),
            WriteOutcome::PartialWrite => Err(ContractError::PartialWrite),
            WriteOutcome::UnknownOutcome => Err(ContractError::UnknownOutcome),
            WriteOutcome::Completed => Err(ContractError::ProtocolError),
        }
    });
    let release = lease.release();
    match (write, release) {
        (Ok(sent), Ok(())) => Ok(sent),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeLease {
        outcome: WriteOutcome,
        writes: Vec<Vec<u8>>,
        releases: u32,
    }

    impl CounterLease for FakeLease {
        fn write(&mut self, payload: &[u8]) -> Result<WriteResult> {
            self.writes.push(payload.to_vec());
            let sent = match self.outcome {
                WriteOutcome::Completed | WriteOutcome::UnknownOutcome => payload.len() as u64,
                WriteOutcome::PartialWrite => 1,
            };
            Ok(WriteResult {
                requested: payload.len() as u64,
                sent,
                outcome: self.outcome,
            })
        }

        fn release(&mut self) -> Result<()> {
            self.releases += 1;
            Ok(())
        }
    }

    #[test]
    fn leased_send_writes_exactly_once_then_releases() {
        let mut lease = FakeLease {
            outcome: WriteOutcome::Completed,
            writes: Vec::new(),
            releases: 0,
        };
        assert_eq!(send_counter(&mut lease, 42), Ok(11));
        assert_eq!(lease.writes, [b"counter=42\n"]);
        assert_eq!(lease.releases, 1);
    }

    #[test]
    fn uncertain_physical_writes_are_not_hidden_or_retried() {
        for (outcome, expected) in [
            (WriteOutcome::PartialWrite, ContractError::PartialWrite),
            (WriteOutcome::UnknownOutcome, ContractError::UnknownOutcome),
        ] {
            let mut lease = FakeLease {
                outcome,
                writes: Vec::new(),
                releases: 0,
            };
            assert_eq!(send_counter(&mut lease, 7), Err(expected));
            assert_eq!(lease.writes.len(), 1);
            assert_eq!(lease.releases, 1);
        }
    }
}
