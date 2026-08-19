use alloc::vec::Vec;

use crate::error::ProtocolError;

pub const HEADER_LEN: usize = 8;
pub const MAX_PAYLOAD_LEN: usize = u16::MAX as usize;

/// SMP protocol version encoded in bits 4..=3 of the first header byte.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum Version {
    V1 = 0,
    V2 = 1,
}

impl Version {
    pub const fn bits(self) -> u8 {
        self as u8
    }

    fn from_bits(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0 => Ok(Self::V1),
            1 => Ok(Self::V2),
            _ => Err(ProtocolError::UnsupportedVersion(value)),
        }
    }
}

/// MCUmgr operation encoded in bits 2..=0 of the first header byte.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum Op {
    Read = 0,
    ReadResponse = 1,
    Write = 2,
    WriteResponse = 3,
}

impl Op {
    pub const fn bits(self) -> u8 {
        self as u8
    }

    pub const fn response(self) -> Option<Self> {
        match self {
            Self::Read => Some(Self::ReadResponse),
            Self::Write => Some(Self::WriteResponse),
            Self::ReadResponse | Self::WriteResponse => None,
        }
    }

    pub const fn is_request(self) -> bool {
        matches!(self, Self::Read | Self::Write)
    }

    fn from_bits(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0 => Ok(Self::Read),
            1 => Ok(Self::ReadResponse),
            2 => Ok(Self::Write),
            3 => Ok(Self::WriteResponse),
            _ => Err(ProtocolError::InvalidOperation(value)),
        }
    }
}

/// The fixed eight-byte SMP envelope header.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Header {
    pub version: Version,
    pub op: Op,
    pub flags: u8,
    pub payload_len: u16,
    pub group: u16,
    pub sequence: u8,
    pub command: u8,
}

impl Header {
    pub fn new(
        version: Version,
        op: Op,
        flags: u8,
        payload_len: usize,
        group: u16,
        sequence: u8,
        command: u8,
    ) -> Result<Self, ProtocolError> {
        let payload_len =
            u16::try_from(payload_len).map_err(|_| ProtocolError::PayloadTooLarge {
                actual: payload_len,
                maximum: MAX_PAYLOAD_LEN,
            })?;
        Ok(Self {
            version,
            op,
            flags,
            payload_len,
            group,
            sequence,
            command,
        })
    }

    pub const fn encoded(self) -> [u8; HEADER_LEN] {
        let length = self.payload_len.to_be_bytes();
        let group = self.group.to_be_bytes();
        [
            (self.version.bits() << 3) | self.op.bits(),
            self.flags,
            length[0],
            length[1],
            group[0],
            group[1],
            self.sequence,
            self.command,
        ]
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_LEN {
            return Err(ProtocolError::InvalidHeaderLength {
                actual: bytes.len(),
            });
        }
        let first = bytes[0];
        let reserved = first & 0xe0;
        if reserved != 0 {
            return Err(ProtocolError::ReservedHeaderBits(reserved));
        }
        let version = Version::from_bits((first >> 3) & 0x03)?;
        let op = Op::from_bits(first & 0x07)?;
        Ok(Self {
            version,
            op,
            flags: bytes[1],
            payload_len: u16::from_be_bytes([bytes[2], bytes[3]]),
            group: u16::from_be_bytes([bytes[4], bytes[5]]),
            sequence: bytes[6],
            command: bytes[7],
        })
    }

    pub const fn packet_len(self) -> usize {
        HEADER_LEN + self.payload_len as usize
    }

    /// Cheap validation used by raw-UART noise scanning.
    pub fn is_plausible_prefix(bytes: &[u8], max_payload_len: usize) -> bool {
        if bytes.len() < HEADER_LEN {
            return false;
        }
        if bytes[0] & 0xe0 != 0 || bytes[0] & 0x07 > Op::WriteResponse as u8 {
            return false;
        }
        if (bytes[0] >> 3) & 0x03 > Version::V2 as u8 {
            return false;
        }
        // Flags are currently reserved/unused by Zephyr and emitted as zero.
        // Requiring zero materially improves best-effort raw-UART noise
        // resynchronization; support for a future defined flag belongs in a
        // negotiated protocol update rather than an accidental acceptance.
        if bytes[1] != 0 {
            return false;
        }
        usize::from(u16::from_be_bytes([bytes[2], bytes[3]])) <= max_payload_len
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Packet {
    pub header: Header,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn request(
        version: Version,
        op: Op,
        group: u16,
        sequence: u8,
        command: u8,
        payload: Vec<u8>,
    ) -> Result<Self, ProtocolError> {
        if !op.is_request() {
            return Err(ProtocolError::InvalidOperation(op.bits()));
        }
        Self::from_parts(
            Header::new(version, op, 0, payload.len(), group, sequence, command)?,
            payload,
        )
    }

    pub fn from_parts(header: Header, payload: Vec<u8>) -> Result<Self, ProtocolError> {
        if usize::from(header.payload_len) != payload.len() {
            return Err(ProtocolError::LengthMismatch {
                declared: usize::from(header.payload_len),
                actual: payload.len(),
            });
        }
        Ok(Self { header, payload })
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_LEN {
            return Err(ProtocolError::Truncated {
                needed: HEADER_LEN,
                actual: bytes.len(),
            });
        }
        let header = Header::decode(&bytes[..HEADER_LEN])?;
        let expected = header.packet_len();
        if bytes.len() != expected {
            return Err(ProtocolError::LengthMismatch {
                declared: expected,
                actual: bytes.len(),
            });
        }
        Self::from_parts(header, bytes[HEADER_LEN..].to_vec())
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        if usize::from(self.header.payload_len) != self.payload.len() {
            return Err(ProtocolError::LengthMismatch {
                declared: usize::from(self.header.payload_len),
                actual: self.payload.len(),
            });
        }
        let mut bytes = Vec::with_capacity(self.header.packet_len());
        bytes.extend_from_slice(&self.header.encoded());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }
}

/// Monotonic modulo-256 sequence source. BBCOM serializes guest tasks, so a
/// single instance never has two requests competing for the same next value.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Sequence(u8);

impl Sequence {
    pub const fn new(first: u8) -> Self {
        Self(first)
    }

    pub fn take(&mut self) -> u8 {
        let current = self.0;
        self.0 = self.0.wrapping_add(1);
        current
    }

    pub const fn peek(self) -> u8 {
        self.0
    }
}

/// Identity of an in-flight request. Matching every header field prevents a
/// delayed response from an earlier command being accepted after sequence
/// wraparound.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PendingRequest {
    version: Version,
    response_op: Op,
    group: u16,
    sequence: u8,
    command: u8,
}

impl PendingRequest {
    pub fn from_packet(request: &Packet) -> Result<Self, ProtocolError> {
        let response_op = request
            .header
            .op
            .response()
            .ok_or(ProtocolError::InvalidOperation(request.header.op.bits()))?;
        Ok(Self {
            version: request.header.version,
            response_op,
            group: request.header.group,
            sequence: request.header.sequence,
            command: request.header.command,
        })
    }

    pub fn match_response<'a>(&self, response: &'a Packet) -> Result<&'a [u8], ProtocolError> {
        let header = response.header;
        if header.version != self.version {
            return Err(ProtocolError::VersionMismatch {
                expected: self.version.bits(),
                actual: header.version.bits(),
            });
        }
        if header.op != self.response_op {
            return Err(ProtocolError::OperationMismatch {
                expected: self.response_op.bits(),
                actual: header.op.bits(),
            });
        }
        if header.group != self.group {
            return Err(ProtocolError::GroupMismatch {
                expected: self.group,
                actual: header.group,
            });
        }
        if header.command != self.command {
            return Err(ProtocolError::CommandMismatch {
                expected: self.command,
                actual: header.command,
            });
        }
        if header.sequence != self.sequence {
            return Err(ProtocolError::SequenceMismatch {
                expected: self.sequence,
                actual: header.sequence,
            });
        }
        Ok(&response.payload)
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec;

    use super::{Header, Op, Packet, PendingRequest, Sequence, Version};
    use crate::error::ProtocolError;

    #[test]
    fn v2_header_matches_specification_golden_bytes() {
        let header = Header::new(Version::V2, Op::Read, 0, 4, 0, 1, 0).unwrap();
        assert_eq!(
            header.encoded(),
            [0x08, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x00]
        );
        assert_eq!(Header::decode(&header.encoded()).unwrap(), header);
    }

    #[test]
    fn v1_write_header_matches_specification_golden_bytes() {
        let header = Header::new(Version::V1, Op::Write, 0, 3, 1, 0xa5, 1).unwrap();
        assert_eq!(
            header.encoded(),
            [0x02, 0x00, 0x00, 0x03, 0x00, 0x01, 0xa5, 0x01]
        );
    }

    #[test]
    fn packet_round_trip_is_exact() {
        let packet = Packet::request(
            Version::V2,
            Op::Write,
            0x1234,
            9,
            7,
            vec![0xa1, 0x61, 0x78, 1],
        )
        .unwrap();
        let encoded = packet.encode().unwrap();
        assert_eq!(Packet::decode(&encoded).unwrap(), packet);
        assert_eq!(encoded.len(), 12);
    }

    #[test]
    fn rejects_reserved_bits_future_versions_and_bad_lengths() {
        assert_eq!(
            Header::decode(&[0x20, 0, 0, 0, 0, 0, 0, 0]),
            Err(ProtocolError::ReservedHeaderBits(0x20))
        );
        assert_eq!(
            Header::decode(&[0x10, 0, 0, 0, 0, 0, 0, 0]),
            Err(ProtocolError::UnsupportedVersion(2))
        );
        assert_eq!(
            Packet::decode(&[0, 0, 0, 1, 0, 0, 0, 0]),
            Err(ProtocolError::LengthMismatch {
                declared: 9,
                actual: 8
            })
        );
    }

    #[test]
    fn pending_request_checks_all_identity_fields() {
        let request = Packet::request(Version::V2, Op::Read, 2, 19, 1, vec![0xa0]).unwrap();
        let pending = PendingRequest::from_packet(&request).unwrap();
        let response = Packet::from_parts(
            Header::new(Version::V2, Op::ReadResponse, 0, 1, 2, 19, 1).unwrap(),
            vec![0xa0],
        )
        .unwrap();
        assert_eq!(pending.match_response(&response).unwrap(), &[0xa0]);

        let mut wrong = response.clone();
        wrong.header.sequence = 20;
        assert_eq!(
            pending.match_response(&wrong),
            Err(ProtocolError::SequenceMismatch {
                expected: 19,
                actual: 20
            })
        );
    }

    #[test]
    fn sequence_wraps_without_panicking() {
        let mut sequence = Sequence::new(255);
        assert_eq!(sequence.take(), 255);
        assert_eq!(sequence.take(), 0);
        assert_eq!(sequence.peek(), 1);
    }
}
