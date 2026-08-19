use alloc::string::{String, ToString};
use alloc::vec::Vec;

use bbcom_plugin_sdk::{ContractError, Result};

pub const STATE_SCHEMA: u32 = 2;
const MAGIC: &[u8; 4] = b"BCV2";
const MAX_SESSION_BYTES: usize = 128;
const MAX_STATUS_BYTES: usize = 512;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CounterState {
    pub count: u64,
    pub revision: u64,
    pub session_id: String,
    pub last_status: String,
}

impl Default for CounterState {
    fn default() -> Self {
        Self {
            count: 0,
            revision: 1,
            session_id: String::new(),
            last_status: "Ready".to_string(),
        }
    }
}

impl CounterState {
    pub fn increment(&mut self) {
        self.count = self.count.saturating_add(1);
        self.last_status = "Counter incremented".to_string();
    }

    pub fn reset(&mut self) {
        self.count = 0;
        self.last_status = "Counter reset".to_string();
    }

    pub fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1).max(1);
    }

    pub fn validate(&self) -> Result<()> {
        if self.revision == 0
            || self.session_id.len() > MAX_SESSION_BYTES
            || self.last_status.len() > MAX_STATUS_BYTES
        {
            Err(ContractError::LimitExceeded)
        } else {
            Ok(())
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let session_len =
            u16::try_from(self.session_id.len()).map_err(|_| ContractError::LimitExceeded)?;
        let status_len =
            u16::try_from(self.last_status.len()).map_err(|_| ContractError::LimitExceeded)?;
        let mut output = Vec::with_capacity(28 + self.session_id.len() + self.last_status.len());
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&STATE_SCHEMA.to_be_bytes());
        output.extend_from_slice(&self.count.to_be_bytes());
        output.extend_from_slice(&self.revision.to_be_bytes());
        output.extend_from_slice(&session_len.to_be_bytes());
        output.extend_from_slice(self.session_id.as_bytes());
        output.extend_from_slice(&status_len.to_be_bytes());
        output.extend_from_slice(self.last_status.as_bytes());
        Ok(output)
    }

    pub fn decode(input: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(input);
        if cursor.take(4)? != MAGIC {
            return Err(ContractError::InvalidInput);
        }
        if cursor.u32()? != STATE_SCHEMA {
            return Err(ContractError::InvalidInput);
        }
        let count = cursor.u64()?;
        let revision = cursor.u64()?;
        let session_len = usize::from(cursor.u16()?);
        let session_id = text(cursor.take(session_len)?)?;
        let status_len = usize::from(cursor.u16()?);
        let last_status = text(cursor.take(status_len)?)?;
        if !cursor.is_empty() {
            return Err(ContractError::InvalidInput);
        }
        let state = Self {
            count,
            revision,
            session_id,
            last_status,
        };
        state.validate()?;
        Ok(state)
    }
}

/// Validates a snapshot produced by this API generation. The host commits the
/// returned bytes transactionally.
pub fn migrate(previous_api: &str, input: &[u8]) -> Result<CounterState> {
    if input.is_empty() {
        return Ok(CounterState::default());
    }
    if previous_api != "bbcom:plugin@2.0.0" {
        return Err(ContractError::InvalidInput);
    }
    CounterState::decode(input)
}

fn text(bytes: &[u8]) -> Result<String> {
    core::str::from_utf8(bytes)
        .map(ToString::to_string)
        .map_err(|_| ContractError::InvalidInput)
}

struct Cursor<'a> {
    remaining: &'a [u8],
}

impl<'a> Cursor<'a> {
    const fn new(remaining: &'a [u8]) -> Self {
        Self { remaining }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        if count > self.remaining.len() {
            return Err(ContractError::InvalidInput);
        }
        let (value, remaining) = self.remaining.split_at(count);
        self.remaining = remaining;
        Ok(value)
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(
            self.take(2)?.try_into().expect("two-byte slice"),
        ))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().expect("four-byte slice"),
        ))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(
            self.take(8)?.try_into().expect("eight-byte slice"),
        ))
    }

    const fn is_empty(&self) -> bool {
        self.remaining.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_and_rejects_trailing_or_truncated_data() {
        let state = CounterState {
            count: 42,
            revision: 9,
            session_id: "session-1".to_string(),
            last_status: "sent".to_string(),
        };
        let encoded = state.encode().unwrap();
        assert_eq!(CounterState::decode(&encoded), Ok(state));
        assert_eq!(
            CounterState::decode(&encoded[..encoded.len() - 1]),
            Err(ContractError::InvalidInput)
        );
        let mut trailing = encoded;
        trailing.push(0);
        assert_eq!(
            CounterState::decode(&trailing),
            Err(ContractError::InvalidInput)
        );
    }

    #[test]
    fn migration_accepts_only_current_api_snapshots() {
        let encoded = CounterState::default().encode().unwrap();
        assert_eq!(
            migrate("bbcom:plugin@2.0.0", &encoded),
            Ok(CounterState::default())
        );
        assert_eq!(
            migrate("bbcom:plugin@3.0.0", &encoded),
            Err(ContractError::InvalidInput)
        );
    }
}
