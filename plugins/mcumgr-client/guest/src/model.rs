use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use bbcom_plugin_sdk::{ContractError, Result};

pub const STATE_SCHEMA: u32 = 1;
const MAGIC: &[u8; 4] = b"BMC2";
const MAX_STATE_BYTES: usize = 64 * 1024;
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_DEVICE_PATH_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportMode {
    Console,
    RawUart,
}

impl TransportMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Console => "console",
            Self::RawUart => "raw-uart",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "console" => Ok(Self::Console),
            "raw" | "raw-uart" => Ok(Self::RawUart),
            _ => Err(ContractError::InvalidInput),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RawInputFormat {
    Json,
    CborHex,
}

impl RawInputFormat {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::CborHex => "cbor-hex",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "json" => Ok(Self::Json),
            "cbor-hex" | "hex" => Ok(Self::CborHex),
            _ => Err(ContractError::InvalidInput),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientState {
    pub revision: u64,
    pub next_sequence: u8,
    pub session_id: String,
    pub locale: String,
    pub theme: String,
    pub transport: TransportMode,
    pub smp_v2: bool,
    pub frame_size: u32,
    pub timeout_ms: u32,
    pub retries: u8,
    pub image: u32,
    pub image_hash_hex: String,
    pub remote_path: String,
    pub echo_text: String,
    pub datetime: String,
    pub stats_name: String,
    pub setting_name: String,
    pub setting_value: String,
    pub shell_line: String,
    pub raw_op_write: bool,
    pub raw_group: u16,
    pub raw_command: u8,
    pub raw_format: RawInputFormat,
    pub raw_payload: String,
    pub last_output: String,
    pub transfer_completed: u64,
    pub transfer_total: u64,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            revision: 1,
            next_sequence: 0,
            session_id: String::new(),
            locale: "en".to_string(),
            theme: "system".to_string(),
            transport: TransportMode::Console,
            smp_v2: true,
            frame_size: 512,
            timeout_ms: 10_000,
            retries: 1,
            image: 0,
            image_hash_hex: String::new(),
            remote_path: "/lfs1/upload.bin".to_string(),
            echo_text: "hello from BBCOM".to_string(),
            datetime: String::new(),
            stats_name: String::new(),
            setting_name: String::new(),
            setting_value: String::new(),
            shell_line: "kernel version".to_string(),
            raw_op_write: false,
            raw_group: 0,
            raw_command: 0,
            raw_format: RawInputFormat::Json,
            raw_payload: "{}".to_string(),
            last_output: "Ready".to_string(),
            transfer_completed: 0,
            transfer_total: 0,
        }
    }
}

impl ClientState {
    pub fn validate(&self) -> Result<()> {
        if self.revision == 0
            || self.frame_size < 64
            || self.frame_size > 65_535
            || self.timeout_ms == 0
            || self.timeout_ms > 10_000
            || self.retries > 5
        {
            return Err(ContractError::InvalidInput);
        }
        for text in [
            &self.session_id,
            &self.locale,
            &self.theme,
            &self.image_hash_hex,
            &self.remote_path,
            &self.echo_text,
            &self.datetime,
            &self.stats_name,
            &self.setting_name,
            &self.setting_value,
            &self.shell_line,
            &self.raw_payload,
            &self.last_output,
        ] {
            if text.len() > MAX_TEXT_BYTES {
                return Err(ContractError::LimitExceeded);
            }
        }
        validate_device_path(&self.remote_path)?;
        Ok(())
    }

    pub fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1).max(1);
    }

    pub fn take_sequence(&mut self) -> u8 {
        let value = self.next_sequence;
        self.next_sequence = self.next_sequence.wrapping_add(1);
        value
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut output = Vec::new();
        output.extend_from_slice(MAGIC);
        put_u32(&mut output, STATE_SCHEMA);
        put_u64(&mut output, self.revision);
        output.push(self.next_sequence);
        put_text(&mut output, &self.session_id)?;
        put_text(&mut output, &self.locale)?;
        put_text(&mut output, &self.theme)?;
        output.push(match self.transport {
            TransportMode::Console => 0,
            TransportMode::RawUart => 1,
        });
        output.push(u8::from(self.smp_v2));
        put_u32(&mut output, self.frame_size);
        put_u32(&mut output, self.timeout_ms);
        output.push(self.retries);
        put_u32(&mut output, self.image);
        put_text(&mut output, &self.image_hash_hex)?;
        put_text(&mut output, &self.remote_path)?;
        put_text(&mut output, &self.echo_text)?;
        put_text(&mut output, &self.datetime)?;
        put_text(&mut output, &self.stats_name)?;
        put_text(&mut output, &self.setting_name)?;
        put_text(&mut output, &self.setting_value)?;
        put_text(&mut output, &self.shell_line)?;
        output.push(u8::from(self.raw_op_write));
        put_u16(&mut output, self.raw_group);
        output.push(self.raw_command);
        output.push(match self.raw_format {
            RawInputFormat::Json => 0,
            RawInputFormat::CborHex => 1,
        });
        put_text(&mut output, &self.raw_payload)?;
        put_text(&mut output, &self.last_output)?;
        put_u64(&mut output, self.transfer_completed);
        put_u64(&mut output, self.transfer_total);
        if output.len() > MAX_STATE_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        Ok(output)
    }

    pub fn decode(input: &[u8]) -> Result<Self> {
        if input.len() > MAX_STATE_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        let mut decoder = Decoder { input, offset: 0 };
        if decoder.take(4)? != MAGIC {
            return Err(ContractError::ProtocolError);
        }
        if decoder.u32()? != STATE_SCHEMA {
            return Err(ContractError::ProtocolError);
        }
        let revision = decoder.u64()?;
        let next_sequence = decoder.byte()?;
        let session_id = decoder.text()?;
        let locale = decoder.text()?;
        let theme = decoder.text()?;
        let transport = match decoder.byte()? {
            0 => TransportMode::Console,
            1 => TransportMode::RawUart,
            _ => return Err(ContractError::ProtocolError),
        };
        let smp_v2 = decoder.boolean()?;
        let frame_size = decoder.u32()?;
        let timeout_ms = decoder.u32()?;
        let retries = decoder.byte()?;
        let image = decoder.u32()?;
        let image_hash_hex = decoder.text()?;
        let remote_path = decoder.text()?;
        let echo_text = decoder.text()?;
        let datetime = decoder.text()?;
        let stats_name = decoder.text()?;
        let setting_name = decoder.text()?;
        let setting_value = decoder.text()?;
        let shell_line = decoder.text()?;
        let raw_op_write = decoder.boolean()?;
        let raw_group = decoder.u16()?;
        let raw_command = decoder.byte()?;
        let raw_format = match decoder.byte()? {
            0 => RawInputFormat::Json,
            1 => RawInputFormat::CborHex,
            _ => return Err(ContractError::ProtocolError),
        };
        let raw_payload = decoder.text()?;
        let last_output = decoder.text()?;
        let transfer_completed = decoder.u64()?;
        let transfer_total = decoder.u64()?;
        if decoder.offset != input.len() {
            return Err(ContractError::ProtocolError);
        }
        let state = Self {
            revision,
            next_sequence,
            session_id,
            locale,
            theme,
            transport,
            smp_v2,
            frame_size,
            timeout_ms,
            retries,
            image,
            image_hash_hex,
            remote_path,
            echo_text,
            datetime,
            stats_name,
            setting_name,
            setting_value,
            shell_line,
            raw_op_write,
            raw_group,
            raw_command,
            raw_format,
            raw_payload,
            last_output,
            transfer_completed,
            transfer_total,
        };
        state.validate()?;
        Ok(state)
    }
}

/// Validate the canonical path sent to the remote MCUmgr filesystem.
///
/// This is a device namespace, never a native host path. Keeping it canonical
/// here lets the presentation layer use a separately encoded, root-relative
/// representation without weakening the host's absolute-path disclosure guard.
pub fn validate_device_path(value: &str) -> Result<()> {
    if value.len() > MAX_DEVICE_PATH_BYTES {
        return Err(ContractError::LimitExceeded);
    }
    if !value.starts_with('/')
        || value.len() == 1
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || value[1..]
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(ContractError::InvalidInput);
    }
    Ok(())
}

/// Convert a canonical remote path into the presentation-safe value shown in
/// a plugin text input. `/` remains a device-component separator, while bytes
/// that could form markup, schemes, whitespace, or native paths are encoded.
pub fn device_path_to_ui(value: &str) -> Result<String> {
    validate_device_path(value)?;
    let relative = &value.as_bytes()[1..];
    let leading_www =
        relative.len() >= 4 && relative[..3].eq_ignore_ascii_case(b"www") && relative[3] == b'.';
    let mut output = String::with_capacity(relative.len());
    for (index, byte) in relative.iter().copied().enumerate() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if byte == b'/' || (unreserved && !(leading_www && index == 3)) {
            output.push(char::from(byte));
        } else {
            output.push('%');
            output.push(hex_digit(byte >> 4));
            output.push(hex_digit(byte & 0x0f));
        }
    }
    Ok(output)
}

/// Parse the presentation-safe, root-relative device path used by the UI.
pub fn device_path_from_ui(value: &str) -> Result<String> {
    if value.is_empty() || value.starts_with('/') || value.len() > MAX_TEXT_BYTES {
        return Err(ContractError::InvalidInput);
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset] == b'%' {
            if offset + 2 >= bytes.len() {
                return Err(ContractError::InvalidInput);
            }
            let high = hex_value(bytes[offset + 1]).ok_or(ContractError::InvalidInput)?;
            let low = hex_value(bytes[offset + 2]).ok_or(ContractError::InvalidInput)?;
            decoded.push((high << 4) | low);
            offset += 3;
        } else {
            decoded.push(bytes[offset]);
            offset += 1;
        }
    }
    let relative = String::from_utf8(decoded).map_err(|_| ContractError::InvalidInput)?;
    let canonical = format!("/{relative}");
    validate_device_path(&canonical)?;
    Ok(canonical)
}

const fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'A' + value - 10) as char,
    }
}

const fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn put_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_text(output: &mut Vec<u8>, value: &str) -> Result<()> {
    let length = u32::try_from(value.len()).map_err(|_| ContractError::LimitExceeded)?;
    put_u32(output, length);
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

struct Decoder<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(ContractError::ProtocolError)?;
        let value = self
            .input
            .get(self.offset..end)
            .ok_or(ContractError::ProtocolError)?;
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn boolean(&mut self) -> Result<bool> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(ContractError::ProtocolError),
        }
    }

    fn u16(&mut self) -> Result<u16> {
        let bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| ContractError::ProtocolError)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn u32(&mut self) -> Result<u32> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| ContractError::ProtocolError)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| ContractError::ProtocolError)?;
        Ok(u64::from_le_bytes(bytes))
    }

    fn text(&mut self) -> Result<String> {
        let length = usize::try_from(self.u32()?).map_err(|_| ContractError::LimitExceeded)?;
        if length > MAX_TEXT_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        let bytes = self.take(length)?;
        let text = core::str::from_utf8(bytes).map_err(|_| ContractError::ProtocolError)?;
        Ok(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_without_ambient_serial_or_file_identifiers() {
        let state = ClientState {
            session_id: "workspace-session-7".to_string(),
            transport: TransportMode::RawUart,
            next_sequence: 255,
            raw_payload: "a1616101".to_string(),
            ..ClientState::default()
        };
        let encoded = state.encode().unwrap();
        assert_eq!(ClientState::decode(&encoded), Ok(state));
    }

    #[test]
    fn state_rejects_truncation_unknown_schema_and_trailing_bytes() {
        let encoded = ClientState::default().encode().unwrap();
        assert_eq!(
            ClientState::decode(&encoded[..12]),
            Err(ContractError::ProtocolError)
        );

        let mut unknown = encoded.clone();
        unknown[4..8].copy_from_slice(&99_u32.to_le_bytes());
        assert_eq!(
            ClientState::decode(&unknown),
            Err(ContractError::ProtocolError)
        );

        let mut trailing = encoded;
        trailing.push(0);
        assert_eq!(
            ClientState::decode(&trailing),
            Err(ContractError::ProtocolError)
        );
    }
}
