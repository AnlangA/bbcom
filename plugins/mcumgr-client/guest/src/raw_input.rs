use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write as _;

use bbcom_mcumgr_core::cbor::{self, Value};
use bbcom_plugin_sdk::{ContractError, Result};

use crate::model::RawInputFormat;

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_ITEMS: usize = 4_096;

pub fn parse_payload(format: RawInputFormat, input: &str) -> Result<Vec<u8>> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(ContractError::LimitExceeded);
    }
    let bytes = match format {
        RawInputFormat::Json => JsonParser::new(input).parse()?.encoded(),
        RawInputFormat::CborHex => decode_hex(input)?,
    };
    cbor::decode(&bytes).map_err(|_| ContractError::InvalidInput)?;
    Ok(bytes)
}

pub fn decode_hex(input: &str) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut high = None;
    for byte in input.bytes() {
        if byte.is_ascii_whitespace() || matches!(byte, b'_' | b':') {
            continue;
        }
        let nibble = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(ContractError::InvalidInput),
        };
        if let Some(value) = high.take() {
            output.push((value << 4) | nibble);
        } else {
            high = Some(nibble);
        }
    }
    if high.is_some() || output.len() > MAX_INPUT_BYTES {
        return Err(ContractError::InvalidInput);
    }
    Ok(output)
}

pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

pub fn describe_response(bytes: &[u8]) -> Result<String> {
    let value = cbor::decode(bytes).map_err(|_| ContractError::ProtocolError)?;
    let mut output = String::new();
    pretty_value(&value, 0, &mut output)?;
    write!(&mut output, "\n\nCBOR hex:\n{}", encode_hex(bytes))
        .map_err(|_| ContractError::LimitExceeded)?;
    Ok(output)
}

fn pretty_value(value: &Value, depth: usize, output: &mut String) -> Result<()> {
    if depth > MAX_DEPTH || output.len() > MAX_INPUT_BYTES.saturating_mul(4) {
        return Err(ContractError::LimitExceeded);
    }
    match value {
        Value::Unsigned(value) => write!(output, "{value}"),
        Value::Negative(value) => write!(output, "{value}"),
        Value::Bytes(bytes) => write!(output, "h'{}'", encode_hex(bytes)),
        Value::Text(text) => write_quoted(text, output),
        Value::Bool(value) => write!(output, "{value}"),
        Value::Null => output.write_str("null"),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push_str(", ");
                }
                pretty_value(value, depth + 1, output)?;
            }
            output.push(']');
            Ok(())
        }
        Value::Map(entries) => {
            output.push_str("{\n");
            for (index, (key, value)) in entries.iter().enumerate() {
                for _ in 0..=depth {
                    output.push_str("  ");
                }
                write_quoted(key, output).map_err(|_| ContractError::LimitExceeded)?;
                output.push_str(": ");
                pretty_value(value, depth + 1, output)?;
                if index + 1 != entries.len() {
                    output.push(',');
                }
                output.push('\n');
            }
            for _ in 0..depth {
                output.push_str("  ");
            }
            output.push('}');
            Ok(())
        }
    }
    .map_err(|_| ContractError::LimitExceeded)
}

fn write_quoted(value: &str, output: &mut String) -> core::fmt::Result {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => write!(output, "\\u{:04x}", character as u32)?,
            character => output.push(character),
        }
    }
    output.push('"');
    Ok(())
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    offset: usize,
    items: usize,
}

impl<'a> JsonParser<'a> {
    const fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            offset: 0,
            items: 0,
        }
    }

    fn parse(mut self) -> Result<Value> {
        self.space();
        let value = self.value(0)?;
        self.space();
        if self.offset != self.bytes.len() {
            return Err(ContractError::InvalidInput);
        }
        Ok(value)
    }

    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > MAX_DEPTH {
            return Err(ContractError::LimitExceeded);
        }
        self.items = self
            .items
            .checked_add(1)
            .ok_or(ContractError::LimitExceeded)?;
        if self.items > MAX_ITEMS {
            return Err(ContractError::LimitExceeded);
        }
        self.space();
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Value::Text(self.string()?)),
            Some(b't') => {
                self.keyword(b"true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.keyword(b"false")?;
                Ok(Value::Bool(false))
            }
            Some(b'n') => {
                self.keyword(b"null")?;
                Ok(Value::Null)
            }
            Some(b'-' | b'0'..=b'9') => self.integer(),
            _ => Err(ContractError::InvalidInput),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value> {
        self.expect(b'{')?;
        self.space();
        let mut entries = Vec::new();
        if self.consume(b'}') {
            return Ok(Value::Map(entries));
        }
        loop {
            self.space();
            let key = self.string()?;
            self.space();
            self.expect(b':')?;
            entries.push((key, self.value(depth + 1)?));
            self.space();
            if self.consume(b'}') {
                return Ok(Value::Map(entries));
            }
            self.expect(b',')?;
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value> {
        self.expect(b'[')?;
        self.space();
        let mut values = Vec::new();
        if self.consume(b']') {
            return Ok(Value::Array(values));
        }
        loop {
            values.push(self.value(depth + 1)?);
            self.space();
            if self.consume(b']') {
                return Ok(Value::Array(values));
            }
            self.expect(b',')?;
        }
    }

    fn integer(&mut self) -> Result<Value> {
        let start = self.offset;
        let negative = self.consume(b'-');
        if self.consume(b'0') {
            if matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(ContractError::InvalidInput);
            }
        } else {
            let digits = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == digits {
                return Err(ContractError::InvalidInput);
            }
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(ContractError::InvalidInput);
        }
        let text = core::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| ContractError::InvalidInput)?;
        if negative {
            let value = text
                .parse::<i64>()
                .map_err(|_| ContractError::InvalidInput)?;
            Ok(Value::Negative(value))
        } else {
            let value = text
                .parse::<u64>()
                .map_err(|_| ContractError::InvalidInput)?;
            Ok(Value::Unsigned(value))
        }
    }

    fn string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut output = String::new();
        loop {
            let byte = self.byte()?;
            match byte {
                b'"' => return Ok(output),
                b'\\' => match self.byte()? {
                    b'"' => output.push('"'),
                    b'\\' => output.push('\\'),
                    b'/' => output.push('/'),
                    b'b' => output.push('\u{0008}'),
                    b'f' => output.push('\u{000c}'),
                    b'n' => output.push('\n'),
                    b'r' => output.push('\r'),
                    b't' => output.push('\t'),
                    b'u' => self.unicode_escape(&mut output)?,
                    _ => return Err(ContractError::InvalidInput),
                },
                0x00..=0x1f => return Err(ContractError::InvalidInput),
                0x20..=0x7f => output.push(char::from(byte)),
                _ => {
                    self.offset -= 1;
                    let remaining = core::str::from_utf8(&self.bytes[self.offset..])
                        .map_err(|_| ContractError::InvalidInput)?;
                    let character = remaining
                        .chars()
                        .next()
                        .ok_or(ContractError::InvalidInput)?;
                    self.offset += character.len_utf8();
                    output.push(character);
                }
            }
            if output.len() > MAX_INPUT_BYTES {
                return Err(ContractError::LimitExceeded);
            }
        }
    }

    fn unicode_escape(&mut self, output: &mut String) -> Result<()> {
        let first = self.hex_quad()?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            self.expect(b'\\')?;
            self.expect(b'u')?;
            let second = self.hex_quad()?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(ContractError::InvalidInput);
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(ContractError::InvalidInput);
        } else {
            u32::from(first)
        };
        output.push(char::from_u32(scalar).ok_or(ContractError::InvalidInput)?);
        Ok(())
    }

    fn hex_quad(&mut self) -> Result<u16> {
        let mut value = 0_u16;
        for _ in 0..4 {
            value = value.checked_mul(16).ok_or(ContractError::InvalidInput)?;
            value |= u16::from(match self.byte()? {
                byte @ b'0'..=b'9' => byte - b'0',
                byte @ b'a'..=b'f' => byte - b'a' + 10,
                byte @ b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(ContractError::InvalidInput),
            });
        }
        Ok(value)
    }

    fn keyword(&mut self, expected: &[u8]) -> Result<()> {
        if self.bytes.get(self.offset..self.offset + expected.len()) != Some(expected) {
            return Err(ContractError::InvalidInput);
        }
        self.offset += expected.len();
        Ok(())
    }

    fn byte(&mut self) -> Result<u8> {
        let byte = self.peek().ok_or(ContractError::InvalidInput)?;
        self.offset += 1;
        Ok(byte)
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.offset).copied()
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.offset += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, expected: u8) -> Result<()> {
        if self.consume(expected) {
            Ok(())
        } else {
            Err(ContractError::InvalidInput)
        }
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_raw_input_encodes_nested_cbor_and_unicode() {
        let bytes = parse_payload(
            RawInputFormat::Json,
            r#"{"message":"hi \ud83d\ude80","items":[1,-2,true,null]}"#,
        )
        .unwrap();
        let value = cbor::decode(&bytes).unwrap();
        assert!(matches!(value, Value::Map(_)));
        let description = describe_response(&bytes).unwrap();
        assert!(description.contains("hi 🚀"));
        assert!(description.contains("CBOR hex:"));
    }

    #[test]
    fn cbor_hex_accepts_separators_but_requires_valid_cbor() {
        assert_eq!(
            parse_payload(RawInputFormat::CborHex, "a1 61:61_01").unwrap(),
            [0xa1, 0x61, 0x61, 0x01]
        );
        assert_eq!(
            parse_payload(RawInputFormat::CborHex, "abc"),
            Err(ContractError::InvalidInput)
        );
        assert_eq!(
            parse_payload(RawInputFormat::CborHex, "ff"),
            Err(ContractError::InvalidInput)
        );
    }

    #[test]
    fn json_rejects_floats_duplicate_trailing_and_bad_surrogates() {
        for input in ["1.0", "{}x", r#""\ud800""#, "[1,]"] {
            assert_eq!(
                parse_payload(RawInputFormat::Json, input),
                Err(ContractError::InvalidInput),
                "{input}"
            );
        }
    }
}
