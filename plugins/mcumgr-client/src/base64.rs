//! Strict standard-alphabet Base64 used by SMP-over-console.

use alloc::vec::Vec;

use crate::error::ProtocolError;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(input: &[u8]) -> Vec<u8> {
    let capacity = input.len().saturating_add(2) / 3 * 4;
    let mut output = Vec::with_capacity(capacity);
    let mut offset = 0usize;
    while offset + 3 <= input.len() {
        encode_triple(&input[offset..offset + 3], &mut output);
        offset += 3;
    }

    match input.len() - offset {
        0 => {}
        1 => {
            let a = input[offset];
            output.push(ALPHABET[(a >> 2) as usize]);
            output.push(ALPHABET[((a & 0x03) << 4) as usize]);
            output.extend_from_slice(b"==");
        }
        2 => {
            let a = input[offset];
            let b = input[offset + 1];
            output.push(ALPHABET[(a >> 2) as usize]);
            output.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize]);
            output.push(ALPHABET[((b & 0x0f) << 2) as usize]);
            output.push(b'=');
        }
        _ => unreachable!(),
    }
    output
}

fn encode_triple(input: &[u8], output: &mut Vec<u8>) {
    let a = input[0];
    let b = input[1];
    let c = input[2];
    output.push(ALPHABET[(a >> 2) as usize]);
    output.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize]);
    output.push(ALPHABET[(((b & 0x0f) << 2) | (c >> 6)) as usize]);
    output.push(ALPHABET[(c & 0x3f) as usize]);
}

pub fn decode(input: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    if !input.len().is_multiple_of(4) {
        return Err(ProtocolError::InvalidBase64Length(input.len()));
    }
    if input.is_empty() {
        return Ok(Vec::new());
    }

    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for (quartet_index, quartet) in input.chunks_exact(4).enumerate() {
        let base_offset = quartet_index * 4;
        let last = base_offset + 4 == input.len();
        let a = sextet(quartet[0], base_offset)?;
        let b = sextet(quartet[1], base_offset + 1)?;

        if quartet[2] == b'=' {
            if !last || quartet[3] != b'=' {
                return Err(ProtocolError::InvalidBase64Padding);
            }
            if b & 0x0f != 0 {
                return Err(ProtocolError::NonCanonicalBase64);
            }
            output.push((a << 2) | (b >> 4));
            continue;
        }

        let c = sextet(quartet[2], base_offset + 2)?;
        output.push((a << 2) | (b >> 4));
        if quartet[3] == b'=' {
            if !last {
                return Err(ProtocolError::InvalidBase64Padding);
            }
            if c & 0x03 != 0 {
                return Err(ProtocolError::NonCanonicalBase64);
            }
            output.push((b << 4) | (c >> 2));
            continue;
        }

        let d = sextet(quartet[3], base_offset + 3)?;
        output.push((b << 4) | (c >> 2));
        output.push((c << 6) | d);
    }
    Ok(output)
}

fn sextet(byte: u8, offset: usize) -> Result<u8, ProtocolError> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(ProtocolError::InvalidBase64Byte { offset, byte }),
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec;
    use alloc::vec::Vec;

    use super::{decode, encode};
    use crate::error::ProtocolError;

    #[test]
    fn rfc_4648_vectors_round_trip() {
        let vectors: &[(&[u8], &[u8])] = &[
            (b"", b""),
            (b"f", b"Zg=="),
            (b"fo", b"Zm8="),
            (b"foo", b"Zm9v"),
            (b"foob", b"Zm9vYg=="),
            (b"fooba", b"Zm9vYmE="),
            (b"foobar", b"Zm9vYmFy"),
        ];
        for (plain, encoded) in vectors {
            assert_eq!(encode(plain), *encoded);
            assert_eq!(decode(encoded).unwrap(), *plain);
        }
    }

    #[test]
    fn rejects_non_canonical_or_misplaced_padding() {
        assert_eq!(decode(b"Zh=="), Err(ProtocolError::NonCanonicalBase64));
        assert_eq!(decode(b"Zm9="), Err(ProtocolError::NonCanonicalBase64));
        assert_eq!(
            decode(b"Zg==AAAA"),
            Err(ProtocolError::InvalidBase64Padding)
        );
        assert_eq!(
            decode(b"Z==="),
            Err(ProtocolError::InvalidBase64Byte {
                offset: 1,
                byte: b'='
            })
        );
        assert_eq!(decode(b"abc"), Err(ProtocolError::InvalidBase64Length(3)));
        assert_eq!(
            decode(b"!!!!"),
            Err(ProtocolError::InvalidBase64Byte {
                offset: 0,
                byte: b'!'
            })
        );
    }

    #[test]
    fn every_byte_value_round_trips() {
        let input = (0u16..=255).map(|value| value as u8).collect::<Vec<_>>();
        assert_eq!(decode(&encode(&input)).unwrap(), input);
        assert_ne!(encode(&input), vec![]);
    }
}
