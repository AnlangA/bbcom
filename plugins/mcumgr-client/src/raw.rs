//! Incremental raw-UART SMP parser.
//!
//! Raw UART has no magic bytes or checksum. Resynchronization therefore uses
//! only invariant SMP header bits and the configured payload bound; it cannot
//! mathematically distinguish arbitrary noise that happens to be a valid
//! zero-length header.

use alloc::vec::Vec;

use crate::error::ProtocolError;
use crate::smp::{Header, Packet, HEADER_LEN, MAX_PAYLOAD_LEN};

#[derive(Clone, Debug)]
pub struct RawParser {
    buffer: Vec<u8>,
    max_payload_len: usize,
    dropped_noise: usize,
}

impl Default for RawParser {
    fn default() -> Self {
        Self::new(MAX_PAYLOAD_LEN)
    }
}

impl RawParser {
    pub fn new(max_payload_len: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_payload_len: max_payload_len.min(MAX_PAYLOAD_LEN),
            dropped_noise: 0,
        }
    }

    pub const fn dropped_noise(&self) -> usize {
        self.dropped_noise
    }

    pub fn is_pending(&self) -> bool {
        !self.buffer.is_empty()
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    pub fn feed(&mut self, input: &[u8]) -> Result<Vec<Packet>, ProtocolError> {
        let mut output = Vec::new();
        // Processing bounded pieces prevents one unusually large host RX
        // callback from becoming one equally large retained allocation.
        let chunk_len = (HEADER_LEN + self.max_payload_len).max(HEADER_LEN);
        for chunk in input.chunks(chunk_len) {
            self.buffer.extend_from_slice(chunk);
            self.parse_available(&mut output)?;
        }
        Ok(output)
    }

    /// End the current byte stream. A plausible incomplete packet is an error;
    /// remaining bytes with no plausible header are classified as noise.
    pub fn finish(&mut self) -> Result<Vec<Packet>, ProtocolError> {
        let mut output = Vec::new();
        self.parse_available(&mut output)?;
        if self.buffer.is_empty() {
            return Ok(output);
        }
        if self.buffer.len() >= HEADER_LEN
            && Header::is_plausible_prefix(&self.buffer[..HEADER_LEN], self.max_payload_len)
        {
            let header = Header::decode(&self.buffer[..HEADER_LEN])?;
            let actual = self.buffer.len();
            self.buffer.clear();
            return Err(ProtocolError::Truncated {
                needed: header.packet_len(),
                actual,
            });
        }
        self.dropped_noise = self.dropped_noise.saturating_add(self.buffer.len());
        self.buffer.clear();
        Ok(output)
    }

    fn parse_available(&mut self, output: &mut Vec<Packet>) -> Result<(), ProtocolError> {
        loop {
            if self.buffer.len() < HEADER_LEN {
                return Ok(());
            }

            let candidate = self
                .buffer
                .windows(HEADER_LEN)
                .position(|bytes| Header::is_plausible_prefix(bytes, self.max_payload_len));
            let Some(offset) = candidate else {
                // Retain the final seven bytes because they can be the prefix
                // of a header split across the next host RX chunk.
                let discard = self.buffer.len() - (HEADER_LEN - 1);
                self.buffer.drain(..discard);
                self.dropped_noise = self.dropped_noise.saturating_add(discard);
                return Ok(());
            };

            if offset != 0 {
                self.buffer.drain(..offset);
                self.dropped_noise = self.dropped_noise.saturating_add(offset);
            }
            let header = Header::decode(&self.buffer[..HEADER_LEN])?;
            let packet_len = header.packet_len();
            if self.buffer.len() < packet_len {
                return Ok(());
            }

            let packet = Packet::decode(&self.buffer[..packet_len])?;
            self.buffer.drain(..packet_len);
            output.push(packet);
        }
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec;
    use alloc::vec::Vec;

    use super::RawParser;
    use crate::error::ProtocolError;
    use crate::smp::{Op, Packet, Version};

    fn packet(sequence: u8, payload_len: usize) -> Packet {
        let payload = (0..payload_len).map(|value| value as u8).collect();
        Packet::request(Version::V2, Op::Read, 10, sequence, 3, payload).unwrap()
    }

    #[test]
    fn arbitrary_fragmentation_round_trips() {
        let expected = packet(42, 31);
        let bytes = expected.encode().unwrap();
        let mut parser = RawParser::new(1024);
        let mut output = Vec::new();
        for byte in bytes {
            output.extend(parser.feed(&[byte]).unwrap());
        }
        assert_eq!(output, vec![expected]);
        assert!(!parser.is_pending());
    }

    #[test]
    fn coalesced_packets_are_returned_in_wire_order() {
        let first = packet(1, 0);
        let second = packet(2, 9);
        let mut bytes = first.encode().unwrap();
        bytes.extend_from_slice(&second.encode().unwrap());
        assert_eq!(
            RawParser::default().feed(&bytes).unwrap(),
            vec![first, second]
        );
    }

    #[test]
    fn scans_invalid_reserved_bit_noise_before_header() {
        let expected = packet(8, 3);
        let mut bytes = vec![0xff; 19];
        bytes.extend_from_slice(&expected.encode().unwrap());
        let mut parser = RawParser::default();
        assert_eq!(parser.feed(&bytes).unwrap(), vec![expected]);
        assert_eq!(parser.dropped_noise(), 19);
    }

    #[test]
    fn finish_reports_declared_length_truncation() {
        let expected = packet(1, 20);
        let bytes = expected.encode().unwrap();
        let mut parser = RawParser::default();
        assert!(parser.feed(&bytes[..12]).unwrap().is_empty());
        assert_eq!(
            parser.finish(),
            Err(ProtocolError::Truncated {
                needed: 28,
                actual: 12
            })
        );
        assert!(!parser.is_pending());
    }

    #[test]
    fn payload_limit_rejects_header_candidate_and_resynchronizes() {
        let oversized = packet(1, 33).encode().unwrap();
        let accepted = packet(2, 4);
        let mut bytes = oversized;
        bytes.extend_from_slice(&accepted.encode().unwrap());
        let mut parser = RawParser::new(32);
        // Bytes in an oversized raw frame are noise to this bounded scanner;
        // the next valid header is still recovered.
        assert_eq!(parser.feed(&bytes).unwrap(), vec![accepted]);
        assert!(parser.dropped_noise() >= 8);
    }
}
