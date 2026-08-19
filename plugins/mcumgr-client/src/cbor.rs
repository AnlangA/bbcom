//! Small, bounded CBOR subset used by Zephyr MCUmgr command maps.
//!
//! Zephyr command payloads use text-keyed maps. Decoding supports both definite
//! and indefinite arrays/maps/byte strings/text strings because Zephyr's
//! zcbor encoder may emit either form. Floating-point/simple extension values
//! and non-text map keys are rejected deliberately.

use alloc::string::String;
use alloc::vec::Vec;

use crate::error::CborError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Value {
    Unsigned(u64),
    Negative(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
    Bool(bool),
    Null,
}

impl Value {
    pub fn encoded(&self) -> Vec<u8> {
        let mut output = Vec::new();
        self.encode_into(&mut output);
        output
    }

    pub fn map(entries: Vec<(String, Value)>) -> Self {
        Self::Map(entries)
    }

    pub fn encode_into(&self, output: &mut Vec<u8>) {
        match self {
            Self::Unsigned(value) => encode_argument(0, *value, output),
            Self::Negative(value) => {
                debug_assert!(*value < 0);
                let encoded = (-1i128 - i128::from(*value)) as u64;
                encode_argument(1, encoded, output);
            }
            Self::Bytes(value) => {
                encode_argument(2, value.len() as u64, output);
                output.extend_from_slice(value);
            }
            Self::Text(value) => {
                encode_argument(3, value.len() as u64, output);
                output.extend_from_slice(value.as_bytes());
            }
            Self::Array(values) => {
                encode_argument(4, values.len() as u64, output);
                for value in values {
                    value.encode_into(output);
                }
            }
            Self::Map(entries) => {
                encode_argument(5, entries.len() as u64, output);
                for (key, value) in entries {
                    Value::Text(key.clone()).encode_into(output);
                    value.encode_into(output);
                }
            }
            Self::Bool(false) => output.push(0xf4),
            Self::Bool(true) => output.push(0xf5),
            Self::Null => output.push(0xf6),
        }
    }
}

fn encode_argument(major: u8, value: u64, output: &mut Vec<u8>) {
    let prefix = major << 5;
    match value {
        0..=23 => output.push(prefix | value as u8),
        24..=0xff => output.extend_from_slice(&[prefix | 24, value as u8]),
        0x100..=0xffff => {
            output.push(prefix | 25);
            output.extend_from_slice(&(value as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            output.push(prefix | 26);
            output.extend_from_slice(&(value as u32).to_be_bytes());
        }
        _ => {
            output.push(prefix | 27);
            output.extend_from_slice(&value.to_be_bytes());
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodeLimits {
    pub max_depth: usize,
    pub max_items: usize,
    pub max_bytes: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_depth: 32,
            max_items: 4096,
            max_bytes: 256 * 1024,
        }
    }
}

pub fn decode(bytes: &[u8]) -> Result<Value, CborError> {
    decode_with_limits(bytes, DecodeLimits::default())
}

pub fn decode_with_limits(bytes: &[u8], limits: DecodeLimits) -> Result<Value, CborError> {
    if bytes.len() > limits.max_bytes {
        return Err(CborError::ByteLimit);
    }
    let mut decoder = Decoder {
        bytes,
        offset: 0,
        items: 0,
        limits,
    };
    let value = decoder.item(0)?;
    if decoder.offset != bytes.len() {
        return Err(CborError::TrailingData);
    }
    Ok(value)
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    items: usize,
    limits: DecodeLimits,
}

impl Decoder<'_> {
    fn item(&mut self, depth: usize) -> Result<Value, CborError> {
        if depth > self.limits.max_depth {
            return Err(CborError::DepthLimit);
        }
        self.items = self.items.checked_add(1).ok_or(CborError::ItemLimit)?;
        if self.items > self.limits.max_items {
            return Err(CborError::ItemLimit);
        }

        let initial = self.byte()?;
        let major = initial >> 5;
        let additional = initial & 0x1f;
        match major {
            0 => Ok(Value::Unsigned(self.argument(additional)?)),
            1 => {
                let encoded = self.argument(additional)?;
                if encoded > i64::MAX as u64 {
                    return Err(CborError::IntegerOutOfRange);
                }
                Ok(Value::Negative(-1 - encoded as i64))
            }
            2 => self.byte_string(additional),
            3 => self.text_string(additional),
            4 => self.array(additional, depth),
            5 => self.map(additional, depth),
            6 => {
                let _tag = self.argument(additional)?;
                self.item(depth + 1)
            }
            7 => match additional {
                20 => Ok(Value::Bool(false)),
                21 => Ok(Value::Bool(true)),
                22 => Ok(Value::Null),
                31 => Err(CborError::UnexpectedBreak),
                other => Err(CborError::UnsupportedSimple(other)),
            },
            _ => unreachable!(),
        }
    }

    fn byte_string(&mut self, additional: u8) -> Result<Value, CborError> {
        if additional == 31 {
            let mut output = Vec::new();
            loop {
                if self.peek()? == 0xff {
                    self.offset += 1;
                    return Ok(Value::Bytes(output));
                }
                let initial = self.byte()?;
                if initial >> 5 != 2 || initial & 0x1f == 31 {
                    return Err(CborError::InvalidAdditionalInfo(initial & 0x1f));
                }
                let length = self.length(initial & 0x1f)?;
                let bytes = self.take(length)?;
                output.extend_from_slice(bytes);
                if output.len() > self.limits.max_bytes {
                    return Err(CborError::ByteLimit);
                }
            }
        }
        let length = self.length(additional)?;
        Ok(Value::Bytes(self.take(length)?.to_vec()))
    }

    fn text_string(&mut self, additional: u8) -> Result<Value, CborError> {
        if additional == 31 {
            let mut output = String::new();
            loop {
                if self.peek()? == 0xff {
                    self.offset += 1;
                    return Ok(Value::Text(output));
                }
                let initial = self.byte()?;
                if initial >> 5 != 3 || initial & 0x1f == 31 {
                    return Err(CborError::InvalidAdditionalInfo(initial & 0x1f));
                }
                let length = self.length(initial & 0x1f)?;
                let text =
                    core::str::from_utf8(self.take(length)?).map_err(|_| CborError::InvalidUtf8)?;
                output.push_str(text);
                if output.len() > self.limits.max_bytes {
                    return Err(CborError::ByteLimit);
                }
            }
        }
        let length = self.length(additional)?;
        let text = core::str::from_utf8(self.take(length)?).map_err(|_| CborError::InvalidUtf8)?;
        Ok(Value::Text(String::from(text)))
    }

    fn array(&mut self, additional: u8, depth: usize) -> Result<Value, CborError> {
        let mut output = Vec::new();
        if additional == 31 {
            loop {
                if self.peek()? == 0xff {
                    self.offset += 1;
                    return Ok(Value::Array(output));
                }
                output.push(self.item(depth + 1)?);
            }
        }
        let length = self.length(additional)?;
        if length > self.limits.max_items.saturating_sub(self.items) {
            return Err(CborError::ItemLimit);
        }
        output.reserve(length);
        for _ in 0..length {
            output.push(self.item(depth + 1)?);
        }
        Ok(Value::Array(output))
    }

    fn map(&mut self, additional: u8, depth: usize) -> Result<Value, CborError> {
        let mut output = Vec::new();
        if additional == 31 {
            loop {
                if self.peek()? == 0xff {
                    self.offset += 1;
                    return Ok(Value::Map(output));
                }
                let key = self.item(depth + 1)?;
                let Value::Text(key) = key else {
                    return Err(CborError::MapKeyNotText);
                };
                output.push((key, self.item(depth + 1)?));
            }
        }
        let length = self.length(additional)?;
        let required = length.checked_mul(2).ok_or(CborError::ItemLimit)?;
        if required > self.limits.max_items.saturating_sub(self.items) {
            return Err(CborError::ItemLimit);
        }
        output.reserve(length);
        for _ in 0..length {
            let key = self.item(depth + 1)?;
            let Value::Text(key) = key else {
                return Err(CborError::MapKeyNotText);
            };
            output.push((key, self.item(depth + 1)?));
        }
        Ok(Value::Map(output))
    }

    fn argument(&mut self, additional: u8) -> Result<u64, CborError> {
        match additional {
            value @ 0..=23 => Ok(u64::from(value)),
            24 => Ok(u64::from(self.byte()?)),
            25 => Ok(u64::from(u16::from_be_bytes(self.read_array()?))),
            26 => Ok(u64::from(u32::from_be_bytes(self.read_array()?))),
            27 => Ok(u64::from_be_bytes(self.read_array()?)),
            other => Err(CborError::InvalidAdditionalInfo(other)),
        }
    }

    fn length(&mut self, additional: u8) -> Result<usize, CborError> {
        let value = self.argument(additional)?;
        let length = usize::try_from(value).map_err(|_| CborError::ByteLimit)?;
        if length > self.limits.max_bytes {
            return Err(CborError::ByteLimit);
        }
        Ok(length)
    }

    fn byte(&mut self) -> Result<u8, CborError> {
        let byte = *self.bytes.get(self.offset).ok_or(CborError::Truncated)?;
        self.offset += 1;
        Ok(byte)
    }

    fn peek(&self) -> Result<u8, CborError> {
        self.bytes
            .get(self.offset)
            .copied()
            .ok_or(CborError::Truncated)
    }

    fn take(&mut self, length: usize) -> Result<&[u8], CborError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(CborError::ByteLimit)?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or(CborError::Truncated)?;
        self.offset = end;
        Ok(bytes)
    }

    fn read_array<const N: usize>(&mut self) -> Result<[u8; N], CborError> {
        self.take(N)?.try_into().map_err(|_| CborError::Truncated)
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::String;
    use alloc::vec;

    use super::{decode, decode_with_limits, DecodeLimits, Value};
    use crate::error::CborError;

    fn text(value: &str) -> String {
        String::from(value)
    }

    #[test]
    fn echo_request_matches_canonical_cbor_golden_bytes() {
        let value = Value::Map(vec![(text("d"), Value::Text(text("hello")))]);
        assert_eq!(
            value.encoded(),
            [0xa1, 0x61, b'd', 0x65, b'h', b'e', b'l', b'l', b'o']
        );
        assert_eq!(decode(&value.encoded()).unwrap(), value);
    }

    #[test]
    fn decodes_indefinite_zephyr_style_maps_arrays_and_strings() {
        let bytes = [
            0xbf, 0x61, b'r', 0x7f, 0x62, b'o', b'k', 0xff, 0x64, b'l', b'i', b's', b't', 0x9f,
            0x01, 0x21, 0xf5, 0xff, 0xff,
        ];
        assert_eq!(
            decode(&bytes).unwrap(),
            Value::Map(vec![
                (text("r"), Value::Text(text("ok"))),
                (
                    text("list"),
                    Value::Array(vec![
                        Value::Unsigned(1),
                        Value::Negative(-2),
                        Value::Bool(true)
                    ])
                )
            ])
        );
    }

    #[test]
    fn rejects_trailing_data_non_text_keys_and_limits() {
        assert_eq!(decode(&[0xa0, 0x00]), Err(CborError::TrailingData));
        assert_eq!(decode(&[0xa1, 0x00, 0x00]), Err(CborError::MapKeyNotText));
        assert_eq!(
            decode_with_limits(
                &[0x82, 0x00, 0x01],
                DecodeLimits {
                    max_depth: 4,
                    max_items: 2,
                    max_bytes: 8
                }
            ),
            Err(CborError::ItemLimit)
        );
    }

    #[test]
    fn all_integer_widths_and_binary_data_round_trip() {
        let value = Value::Array(vec![
            Value::Unsigned(23),
            Value::Unsigned(24),
            Value::Unsigned(256),
            Value::Unsigned(65_536),
            Value::Unsigned(u64::MAX),
            Value::Negative(i64::MIN),
            Value::Bytes(vec![0, 1, 2, 255]),
            Value::Null,
        ]);
        assert_eq!(decode(&value.encoded()).unwrap(), value);
    }
}
