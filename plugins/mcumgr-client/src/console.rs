//! Zephyr SMP-over-console framing.

use alloc::vec::Vec;

use crate::base64;
use crate::crc::crc16_xmodem;
use crate::error::ProtocolError;
use crate::smp::{Packet, HEADER_LEN};

pub const FIRST_FRAGMENT_MARKER: [u8; 2] = [0x06, 0x09];
pub const CONTINUATION_MARKER: [u8; 2] = [0x04, 0x14];
pub const DEFAULT_CONSOLE_FRAME_SIZE: usize = 127;
pub const DEFAULT_MAX_PACKET_LEN: usize = u16::MAX as usize - 2;

/// Stateless SMP-over-console encoder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConsoleCodec {
    max_frame_len: usize,
}

impl Default for ConsoleCodec {
    fn default() -> Self {
        Self {
            max_frame_len: DEFAULT_CONSOLE_FRAME_SIZE,
        }
    }
}

impl ConsoleCodec {
    pub fn new(max_frame_len: usize) -> Result<Self, ProtocolError> {
        // Two marker bytes + four Base64 bytes + LF is the smallest legal
        // frame and carries one three-byte raw quantum.
        if max_frame_len < 7 {
            return Err(ProtocolError::ConsoleFrameTooSmall(max_frame_len));
        }
        Ok(Self { max_frame_len })
    }

    pub const fn max_frame_len(self) -> usize {
        self.max_frame_len
    }

    pub fn encode_packet(&self, packet: &Packet) -> Result<Vec<u8>, ProtocolError> {
        self.encode_bytes(&packet.encode()?)
    }

    pub fn encode_packet_frames(&self, packet: &Packet) -> Result<Vec<Vec<u8>>, ProtocolError> {
        self.encode_frames(&packet.encode()?)
    }

    /// Frame an already encoded SMP header + CBOR payload.
    pub fn encode_bytes(&self, packet: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        let frames = self.encode_frames(packet)?;
        let total = frames.iter().map(Vec::len).sum();
        let mut output = Vec::with_capacity(total);
        for frame in frames {
            output.extend_from_slice(&frame);
        }
        Ok(output)
    }

    pub fn encode_frames(&self, packet: &[u8]) -> Result<Vec<Vec<u8>>, ProtocolError> {
        if packet.len() < HEADER_LEN {
            return Err(ProtocolError::Truncated {
                needed: HEADER_LEN,
                actual: packet.len(),
            });
        }
        if packet.len() > DEFAULT_MAX_PACKET_LEN {
            return Err(ProtocolError::PayloadTooLarge {
                actual: packet.len(),
                maximum: DEFAULT_MAX_PACKET_LEN,
            });
        }
        // The byte-oriented entry point is used by adapters and Raw commands;
        // validate the embedded header length before adding transport framing.
        Packet::decode(packet)?;

        let declared = (packet.len() + 2) as u16;
        let crc = crc16_xmodem(packet);
        let mut raw = Vec::with_capacity(packet.len() + 4);
        raw.extend_from_slice(&declared.to_be_bytes());
        raw.extend_from_slice(packet);
        raw.extend_from_slice(&crc.to_be_bytes());

        // Base64 output must end at a four-byte quantum before LF. Making
        // every non-final raw chunk a multiple of three matches Zephyr's
        // serial_util.c and avoids padding in continuation fragments.
        let raw_per_frame = ((self.max_frame_len - 3) / 4) * 3;
        let mut frames = Vec::new();
        for (index, chunk) in raw.chunks(raw_per_frame).enumerate() {
            let encoded = base64::encode(chunk);
            let mut frame = Vec::with_capacity(2 + encoded.len() + 1);
            frame.extend_from_slice(if index == 0 {
                &FIRST_FRAGMENT_MARKER
            } else {
                &CONTINUATION_MARKER
            });
            frame.extend_from_slice(&encoded);
            frame.push(b'\n');
            debug_assert!(frame.len() <= self.max_frame_len);
            frames.push(frame);
        }
        Ok(frames)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Assembly {
    expected_total: usize,
    bytes: Vec<u8>,
}

/// Incremental SMP-over-console parser.
///
/// Bytes before a marker and complete non-MCUmgr lines are treated as console
/// noise. A marker may be split across calls because input is buffered until
/// LF. Malformed marked lines fail closed and reset the in-progress packet.
#[derive(Clone, Debug)]
pub struct ConsoleParser {
    line: Vec<u8>,
    assembly: Option<Assembly>,
    max_line_len: usize,
    max_packet_len: usize,
    dropped_noise: usize,
}

impl Default for ConsoleParser {
    fn default() -> Self {
        Self::new(DEFAULT_CONSOLE_FRAME_SIZE, DEFAULT_MAX_PACKET_LEN)
    }
}

impl ConsoleParser {
    pub fn new(max_line_len: usize, max_packet_len: usize) -> Self {
        Self {
            line: Vec::new(),
            assembly: None,
            max_line_len,
            max_packet_len: max_packet_len.min(DEFAULT_MAX_PACKET_LEN),
            dropped_noise: 0,
        }
    }

    pub const fn dropped_noise(&self) -> usize {
        self.dropped_noise
    }

    pub fn is_pending(&self) -> bool {
        !self.line.is_empty() || self.assembly.is_some()
    }

    pub fn reset(&mut self) {
        self.line.clear();
        self.assembly = None;
    }

    pub fn feed(&mut self, input: &[u8]) -> Result<Vec<Packet>, ProtocolError> {
        let mut packets = Vec::new();
        for &byte in input {
            self.line.push(byte);
            if self.line.len() > self.max_line_len {
                self.reset();
                return Err(ProtocolError::ConsoleLineTooLong {
                    maximum: self.max_line_len,
                });
            }
            if byte == b'\n' {
                let mut line = core::mem::take(&mut self.line);
                line.pop();
                if let Some(packet) = self
                    .process_line(&line)
                    .inspect_err(|_| self.assembly = None)?
                {
                    packets.push(packet);
                }
            }
        }
        Ok(packets)
    }

    fn process_line(&mut self, line: &[u8]) -> Result<Option<Packet>, ProtocolError> {
        let content = line.strip_suffix(b"\r").unwrap_or(line);
        let Some((offset, first)) = find_marker(content) else {
            self.dropped_noise = self.dropped_noise.saturating_add(line.len() + 1);
            return Ok(None);
        };
        self.dropped_noise = self.dropped_noise.saturating_add(offset);
        let decoded = base64::decode(&content[offset + 2..])?;

        if first {
            self.assembly = None;
            if decoded.len() < 2 {
                return Err(ProtocolError::ConsoleFragmentTooShort);
            }
            let expected_total = usize::from(u16::from_be_bytes([decoded[0], decoded[1]]));
            if expected_total < HEADER_LEN + 2 {
                return Err(ProtocolError::LengthMismatch {
                    declared: expected_total,
                    actual: decoded.len().saturating_sub(2),
                });
            }
            let packet_len = expected_total - 2;
            if packet_len > self.max_packet_len {
                return Err(ProtocolError::PayloadTooLarge {
                    actual: packet_len,
                    maximum: self.max_packet_len,
                });
            }
            self.assembly = Some(Assembly {
                expected_total,
                bytes: decoded[2..].to_vec(),
            });
        } else {
            let Some(assembly) = &mut self.assembly else {
                return Err(ProtocolError::UnexpectedContinuation);
            };
            assembly.bytes.extend_from_slice(&decoded);
        }

        self.complete_if_ready()
    }

    fn complete_if_ready(&mut self) -> Result<Option<Packet>, ProtocolError> {
        let assembly = self
            .assembly
            .as_ref()
            .expect("assembly was just created or extended");
        if assembly.bytes.len() > assembly.expected_total {
            return Err(ProtocolError::LengthMismatch {
                declared: assembly.expected_total,
                actual: assembly.bytes.len(),
            });
        }
        if assembly.bytes.len() < assembly.expected_total {
            return Ok(None);
        }

        let assembly = self.assembly.take().expect("complete assembly exists");
        let crc_offset = assembly.bytes.len() - 2;
        let expected =
            u16::from_be_bytes([assembly.bytes[crc_offset], assembly.bytes[crc_offset + 1]]);
        let packet_bytes = &assembly.bytes[..crc_offset];
        let actual = crc16_xmodem(packet_bytes);
        if expected != actual {
            return Err(ProtocolError::CrcMismatch { expected, actual });
        }
        Packet::decode(packet_bytes).map(Some)
    }
}

fn find_marker(line: &[u8]) -> Option<(usize, bool)> {
    line.windows(2).enumerate().find_map(|(offset, marker)| {
        if marker == FIRST_FRAGMENT_MARKER {
            Some((offset, true))
        } else if marker == CONTINUATION_MARKER {
            Some((offset, false))
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use alloc::vec;
    use alloc::vec::Vec;

    use super::{ConsoleCodec, ConsoleParser, CONTINUATION_MARKER, FIRST_FRAGMENT_MARKER};
    use crate::base64;
    use crate::error::ProtocolError;
    use crate::smp::{Op, Packet, Version};

    fn echo_packet(sequence: u8, text: &[u8]) -> Packet {
        let mut payload = vec![0xa1, 0x61, b'd'];
        assert!(text.len() < 24);
        payload.push(0x60 | text.len() as u8);
        payload.extend_from_slice(text);
        Packet::request(Version::V2, Op::Write, 0, sequence, 0, payload).unwrap()
    }

    #[test]
    fn specification_style_console_frame_has_expected_marker_and_round_trips() {
        let packet = echo_packet(0x2a, b"hi");
        let encoded = ConsoleCodec::default().encode_packet(&packet).unwrap();
        assert_eq!(encoded, b"\x06\x09ABAKAAAGAAAqAKFhZGJoaQho\n");
        let decoded = ConsoleParser::default().feed(&encoded).unwrap();
        assert_eq!(decoded, vec![packet]);
    }

    #[test]
    fn arbitrary_rx_fragmentation_and_small_transport_frames_round_trip() {
        let packet = echo_packet(254, b"fragment me");
        let encoded = ConsoleCodec::new(11)
            .unwrap()
            .encode_packet(&packet)
            .unwrap();
        assert!(encoded
            .windows(2)
            .any(|window| window == CONTINUATION_MARKER));

        let mut parser = ConsoleParser::new(11, 4096);
        let mut output = Vec::new();
        for byte in encoded {
            output.extend(parser.feed(&[byte]).unwrap());
        }
        assert_eq!(output, vec![packet]);
        assert!(!parser.is_pending());
    }

    #[test]
    fn ignores_shell_noise_and_accepts_marker_after_prompt_text() {
        let packet = echo_packet(7, b"ok");
        let encoded = ConsoleCodec::default().encode_packet(&packet).unwrap();
        let mut input = b"boot banner\r\nshell> ".to_vec();
        input.extend_from_slice(&encoded);
        let mut parser = ConsoleParser::default();
        assert_eq!(parser.feed(&input).unwrap(), vec![packet]);
        assert_eq!(
            parser.dropped_noise(),
            b"boot banner\r\n".len() + b"shell> ".len()
        );
    }

    #[test]
    fn accepts_multiple_coalesced_packets() {
        let first = echo_packet(1, b"one");
        let second = echo_packet(2, b"two");
        let codec = ConsoleCodec::default();
        let mut bytes = codec.encode_packet(&first).unwrap();
        bytes.extend_from_slice(&codec.encode_packet(&second).unwrap());
        assert_eq!(
            ConsoleParser::default().feed(&bytes).unwrap(),
            vec![first, second]
        );
    }

    #[test]
    fn rejects_bad_crc_and_recovers_for_next_first_fragment() {
        let packet = echo_packet(3, b"crc");
        let codec = ConsoleCodec::default();
        let encoded = codec.encode_packet(&packet).unwrap();
        let mut raw = base64::decode(&encoded[2..encoded.len() - 1]).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        let mut corrupt = FIRST_FRAGMENT_MARKER.to_vec();
        corrupt.extend_from_slice(&base64::encode(&raw));
        corrupt.push(b'\n');

        let mut parser = ConsoleParser::default();
        assert!(matches!(
            parser.feed(&corrupt),
            Err(ProtocolError::CrcMismatch { .. })
        ));
        assert_eq!(parser.feed(&encoded).unwrap(), vec![packet]);
    }

    #[test]
    fn rejects_length_overrun_invalid_base64_or_orphan_continuation() {
        let mut short_declared = FIRST_FRAGMENT_MARKER.to_vec();
        short_declared.extend_from_slice(&base64::encode(&[0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        short_declared.push(b'\n');
        assert!(matches!(
            ConsoleParser::default().feed(&short_declared),
            Err(ProtocolError::LengthMismatch { .. })
        ));

        let mut invalid = FIRST_FRAGMENT_MARKER.to_vec();
        invalid.extend_from_slice(b"!!!!\n");
        assert!(matches!(
            ConsoleParser::default().feed(&invalid),
            Err(ProtocolError::InvalidBase64Byte { .. })
        ));

        let mut orphan = CONTINUATION_MARKER.to_vec();
        orphan.extend_from_slice(b"AAAA\n");
        assert_eq!(
            ConsoleParser::default().feed(&orphan),
            Err(ProtocolError::UnexpectedContinuation)
        );
    }

    #[test]
    fn enforces_configured_line_and_packet_limits() {
        assert_eq!(
            ConsoleCodec::new(6),
            Err(ProtocolError::ConsoleFrameTooSmall(6))
        );
        let mut parser = ConsoleParser::new(4, 32);
        assert_eq!(
            parser.feed(b"12345"),
            Err(ProtocolError::ConsoleLineTooLong { maximum: 4 })
        );

        let packet = echo_packet(1, b"large");
        let encoded = ConsoleCodec::default().encode_packet(&packet).unwrap();
        assert!(matches!(
            ConsoleParser::new(127, 8).feed(&encoded),
            Err(ProtocolError::PayloadTooLarge { .. })
        ));

        assert_eq!(
            ConsoleCodec::default().encode_bytes(&[0, 0, 0, 1, 0, 0, 0, 0]),
            Err(ProtocolError::LengthMismatch {
                declared: 9,
                actual: 8
            })
        );
    }
}
