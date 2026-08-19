use alloc::string::String;
use alloc::vec::Vec;

use crate::limits::{MAX_STREAM_CHUNK_BYTES, SERIAL_READ_TIMEOUT_MS};
use crate::{ContractError, Result};

/// Maximum length of an opaque serial port, session, or plugin-local identity.
pub const MAX_SERIAL_ID_BYTES: usize = 128;
/// Maximum length of a host-rendered serial port, session, or device label.
pub const MAX_SERIAL_TEXT_BYTES: usize = 1_024;
/// Defensive upper bound for a port or session catalog returned in one call.
pub const MAX_SERIAL_CATALOG_ENTRIES: usize = 1_024;
/// Maximum number of capture frames returned in one page.
pub const MAX_CAPTURE_FRAMES: u32 = 1_024;
/// Highest integer that survives the host's renderer transport losslessly.
pub const MAX_CAPTURE_SEQUENCE: u64 = 9_007_199_254_740_991;
/// Per-lease mirrored RX capacity. The host keeps the wider 16 MiB queue
/// budget for all traffic, while one serial lease is deliberately capped at
/// 1 MiB so a single protocol client cannot consume that complete budget.
pub const MAX_LEASE_RX_BUFFER_BYTES: u32 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SerialPort {
    /// Runtime-scoped opaque identity. This is never an operating-system path.
    pub port_id: String,
    pub display_name: String,
    pub usb_vendor_id: Option<u16>,
    pub usb_product_id: Option<u16>,
    pub serial_number: Option<String>,
}

impl SerialPort {
    pub fn validate(&self) -> Result<()> {
        validate_serial_id(&self.port_id)?;
        validate_serial_text(&self.display_name)?;
        if let Some(serial_number) = self.serial_number.as_deref() {
            validate_serial_text(serial_number)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionLifetime {
    Persistent,
    Runtime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopBits {
    One,
    Two,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SerialConfig {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow_control: FlowControl,
}

impl SerialConfig {
    pub fn validate(self) -> Result<()> {
        if self.baud_rate == 0 || !(5..=8).contains(&self.data_bits) {
            Err(ContractError::InvalidInput)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SerialSession {
    pub session_id: String,
    pub name: String,
    pub port_id: Option<String>,
    pub config: SerialConfig,
    pub connected: bool,
    pub generation: u64,
}

impl SerialSession {
    pub fn validate(&self) -> Result<()> {
        validate_serial_id(&self.session_id)?;
        validate_serial_text(&self.name)?;
        if let Some(port_id) = self.port_id.as_deref() {
            validate_serial_id(port_id)?;
        }
        self.config.validate()?;
        if self.connected && self.generation == 0 {
            return Err(ContractError::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateSession {
    pub local_id: String,
    pub name: String,
    pub lifetime: SessionLifetime,
    pub port_id: Option<String>,
    pub config: SerialConfig,
}

impl CreateSession {
    pub fn validate(&self) -> Result<()> {
        validate_serial_id(&self.local_id)?;
        validate_serial_text(&self.name)?;
        if let Some(port_id) = self.port_id.as_deref() {
            validate_serial_id(port_id)?;
        }
        self.config.validate()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SerialLeaseOptions {
    pub pause_automation: bool,
    pub rx_buffer_bytes: u32,
}

impl SerialLeaseOptions {
    pub fn validate(self) -> Result<()> {
        if !self.pause_automation || self.rx_buffer_bytes == 0 {
            return Err(ContractError::InvalidInput);
        }
        if self.rx_buffer_bytes > MAX_LEASE_RX_BUFFER_BYTES {
            return Err(ContractError::LimitExceeded);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameDirection {
    Rx,
    Tx,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureFrame {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub direction: FrameDirection,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturePage {
    pub frames: Vec<CaptureFrame>,
    pub next_sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureRequest {
    pub session_id: String,
    pub from_sequence: u64,
    pub max_frames: u32,
    pub max_bytes: u32,
}

impl CaptureRequest {
    pub fn validate(&self) -> Result<()> {
        validate_capture_request(
            &self.session_id,
            self.from_sequence,
            self.max_frames,
            self.max_bytes,
        )
    }
}

/// Host/session-management boundary implemented by generated WIT glue.
///
/// Implementations translate generated `bbcom:plugin@2` values into these
/// ambient-authority-free SDK models. Implementations should call the public
/// validation helpers before issuing requests and after decoding responses.
pub trait SerialHost {
    type Lease: SerialLease + SerialLeaseIdentity;

    fn list_ports(&mut self) -> Result<Vec<SerialPort>>;
    fn list_sessions(&mut self) -> Result<Vec<SerialSession>>;
    fn create_session(&mut self, request: CreateSession) -> Result<SerialSession>;
    fn update_session(&mut self, session: SerialSession) -> Result<SerialSession>;
    fn connect_session(&mut self, session_id: &str) -> Result<SerialSession>;
    fn disconnect_session(&mut self, session_id: &str) -> Result<()>;
    fn delete_session(&mut self, session_id: &str) -> Result<()>;
    fn acquire_lease(
        &mut self,
        session_id: &str,
        options: SerialLeaseOptions,
    ) -> Result<Self::Lease>;
    fn capture_read(&mut self, request: CaptureRequest) -> Result<CapturePage>;
}

pub fn validate_serial_id(value: &str) -> Result<()> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(ContractError::InvalidInput);
    };
    if value.len() > MAX_SERIAL_ID_BYTES
        || !first.is_ascii_alphanumeric()
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Err(ContractError::InvalidInput)
    } else {
        Ok(())
    }
}

pub fn validate_serial_text(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_SERIAL_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        Err(ContractError::InvalidInput)
    } else {
        Ok(())
    }
}

pub fn validate_port_catalog(ports: &[SerialPort]) -> Result<()> {
    if ports.len() > MAX_SERIAL_CATALOG_ENTRIES {
        return Err(ContractError::LimitExceeded);
    }
    for (index, port) in ports.iter().enumerate() {
        port.validate()?;
        if ports[..index]
            .iter()
            .any(|candidate| candidate.port_id == port.port_id)
        {
            return Err(ContractError::ProtocolError);
        }
    }
    Ok(())
}

pub fn validate_session_catalog(sessions: &[SerialSession]) -> Result<()> {
    if sessions.len() > MAX_SERIAL_CATALOG_ENTRIES {
        return Err(ContractError::LimitExceeded);
    }
    for (index, session) in sessions.iter().enumerate() {
        session.validate()?;
        if sessions[..index]
            .iter()
            .any(|candidate| candidate.session_id == session.session_id)
        {
            return Err(ContractError::ProtocolError);
        }
    }
    Ok(())
}

pub fn validate_serial_read_request(max_bytes: u32, timeout_ms: u32) -> Result<()> {
    if max_bytes == 0 || timeout_ms == 0 {
        return Err(ContractError::InvalidInput);
    }
    if max_bytes as usize > MAX_STREAM_CHUNK_BYTES || timeout_ms > SERIAL_READ_TIMEOUT_MS {
        return Err(ContractError::LimitExceeded);
    }
    Ok(())
}

pub fn validate_serial_write(payload: &[u8]) -> Result<()> {
    if payload.is_empty() {
        return Err(ContractError::InvalidInput);
    }
    if payload.len() > MAX_STREAM_CHUNK_BYTES {
        return Err(ContractError::LimitExceeded);
    }
    Ok(())
}

pub fn validate_serial_read_result(result: &ReadResult, requested_bytes: u32) -> Result<()> {
    if requested_bytes == 0 || requested_bytes as usize > MAX_STREAM_CHUNK_BYTES {
        return Err(ContractError::InvalidInput);
    }
    if result.payload.len() > requested_bytes as usize {
        Err(ContractError::ProtocolError)
    } else {
        Ok(())
    }
}

pub fn validate_serial_write_result(result: WriteResult, requested_bytes: u64) -> Result<()> {
    if requested_bytes == 0
        || requested_bytes > MAX_STREAM_CHUNK_BYTES as u64
        || result.requested != requested_bytes
        || result.sent > result.requested
    {
        return Err(ContractError::ProtocolError);
    }
    match result.outcome {
        WriteOutcome::Completed if result.sent == result.requested => Ok(()),
        WriteOutcome::PartialWrite if result.sent < result.requested => Ok(()),
        WriteOutcome::UnknownOutcome => Ok(()),
        WriteOutcome::Completed | WriteOutcome::PartialWrite => Err(ContractError::ProtocolError),
    }
}

pub fn validate_capture_request(
    session_id: &str,
    from_sequence: u64,
    max_frames: u32,
    max_bytes: u32,
) -> Result<()> {
    validate_serial_id(session_id)?;
    if max_frames == 0 || max_bytes == 0 {
        return Err(ContractError::InvalidInput);
    }
    if from_sequence > MAX_CAPTURE_SEQUENCE
        || max_frames > MAX_CAPTURE_FRAMES
        || max_bytes as usize > MAX_STREAM_CHUNK_BYTES
    {
        return Err(ContractError::LimitExceeded);
    }
    Ok(())
}

/// Validates a decoded capture response against the request that bounded it.
pub fn validate_capture_page(page: &CapturePage, request: &CaptureRequest) -> Result<()> {
    request.validate()?;
    if page.frames.len() > request.max_frames as usize {
        return Err(ContractError::ProtocolError);
    }
    let mut total_bytes = 0_usize;
    let mut previous_sequence = None;
    for frame in &page.frames {
        if frame.sequence < request.from_sequence
            || frame.sequence > MAX_CAPTURE_SEQUENCE
            || frame.timestamp_ms > MAX_CAPTURE_SEQUENCE
            || previous_sequence.is_some_and(|previous| frame.sequence <= previous)
        {
            return Err(ContractError::ProtocolError);
        }
        total_bytes = total_bytes
            .checked_add(frame.payload.len())
            .ok_or(ContractError::ProtocolError)?;
        if total_bytes > request.max_bytes as usize {
            return Err(ContractError::ProtocolError);
        }
        previous_sequence = Some(frame.sequence);
    }
    if page.next_sequence.is_some_and(|next| {
        next > MAX_CAPTURE_SEQUENCE
            || next < request.from_sequence
            || previous_sequence.is_some_and(|previous| next <= previous)
    }) {
        return Err(ContractError::ProtocolError);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PendingBytes {
    pub rx: u64,
    pub tx: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputLines {
    pub dtr: bool,
    pub rts: bool,
    pub break_active: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputLines {
    pub cts: bool,
    pub dsr: bool,
    pub ri: bool,
    pub cd: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    Completed,
    PartialWrite,
    UnknownOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteResult {
    pub requested: u64,
    pub sent: u64,
    pub outcome: WriteOutcome,
}

impl WriteResult {
    pub fn require_complete(self) -> Result<()> {
        match self.outcome {
            WriteOutcome::Completed if self.requested == self.sent => Ok(()),
            WriteOutcome::PartialWrite => Err(ContractError::PartialWrite),
            WriteOutcome::UnknownOutcome => Err(ContractError::UnknownOutcome),
            WriteOutcome::Completed => Err(ContractError::ProtocolError),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadResult {
    pub payload: Vec<u8>,
    pub timed_out: bool,
    pub disconnected: bool,
}

/// Implemented by generated WIT glue around one host-owned serial lease.
pub trait SerialLease {
    fn read(&mut self, max_bytes: u32, timeout_ms: u32) -> Result<ReadResult>;
    fn write(&mut self, payload: &[u8]) -> Result<WriteResult>;
    fn clear_buffers(&mut self) -> Result<()>;
    fn pending(&mut self) -> Result<PendingBytes>;
    fn set_output_lines(&mut self, lines: OutputLines) -> Result<()>;
    fn input_lines(&mut self) -> Result<InputLines>;
    fn release(&mut self) -> Result<()>;
}

/// Identity methods exposed by the v2 `serial-lease` resource. This remains a
/// separate extension trait so existing `SerialLease` implementations keep
/// their source-compatible I/O surface.
pub trait SerialLeaseIdentity {
    fn session_id(&self) -> String;
    fn generation(&self) -> u64;
}

/// Minimal `no_std` equivalent of a byte reader. It avoids `std::io` and any
/// implication that a plugin can open a native serial device itself.
pub trait Read {
    fn read(&mut self, output: &mut [u8], timeout_ms: u32) -> Result<usize>;
}

/// Minimal `no_std` equivalent of a byte writer.
pub trait Write {
    fn write(&mut self, input: &[u8]) -> Result<usize>;
    fn write_all(&mut self, mut input: &[u8]) -> Result<()> {
        while !input.is_empty() {
            let written = self.write(input)?;
            if written == 0 || written > input.len() {
                return Err(ContractError::IoError);
            }
            input = &input[written..];
        }
        Ok(())
    }
}

/// Converts generated host-lease operations into reusable byte-stream traits.
pub struct SerialIoAdapter<T> {
    lease: T,
}

impl<T> SerialIoAdapter<T> {
    #[must_use]
    pub const fn new(lease: T) -> Self {
        Self { lease }
    }

    #[must_use]
    pub const fn lease(&self) -> &T {
        &self.lease
    }

    pub fn lease_mut(&mut self) -> &mut T {
        &mut self.lease
    }

    #[must_use]
    pub fn into_inner(self) -> T {
        self.lease
    }
}

impl<T: SerialLease> Read for SerialIoAdapter<T> {
    fn read(&mut self, output: &mut [u8], timeout_ms: u32) -> Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        let max_bytes = u32::try_from(output.len()).map_err(|_| ContractError::LimitExceeded)?;
        validate_serial_read_request(max_bytes, timeout_ms)?;
        let result = self.lease.read(max_bytes, timeout_ms)?;
        validate_serial_read_result(&result, max_bytes)?;
        if result.disconnected {
            return Err(ContractError::Disconnected);
        }
        if result.payload.len() > output.len() {
            return Err(ContractError::ProtocolError);
        }
        let count = result.payload.len();
        output[..count].copy_from_slice(&result.payload);
        if count == 0 && result.timed_out {
            Err(ContractError::Timeout)
        } else {
            Ok(count)
        }
    }
}

impl<T: SerialLease> Write for SerialIoAdapter<T> {
    fn write(&mut self, input: &[u8]) -> Result<usize> {
        if input.is_empty() {
            return Ok(0);
        }
        validate_serial_write(input)?;
        let result = self.lease.write(input)?;
        validate_serial_write_result(result, input.len() as u64)?;
        match result.outcome {
            WriteOutcome::Completed if result.sent == result.requested => Ok(result.sent as usize),
            WriteOutcome::PartialWrite => {
                if result.sent == 0 {
                    Err(ContractError::PartialWrite)
                } else {
                    Ok(result.sent as usize)
                }
            }
            WriteOutcome::UnknownOutcome => Err(ContractError::UnknownOutcome),
            WriteOutcome::Completed => Err(ContractError::ProtocolError),
        }
    }

    fn write_all(&mut self, mut input: &[u8]) -> Result<()> {
        while !input.is_empty() {
            let chunk_len = input.len().min(MAX_STREAM_CHUNK_BYTES);
            let mut chunk = &input[..chunk_len];
            while !chunk.is_empty() {
                let written = self.write(chunk)?;
                if written == 0 || written > chunk.len() {
                    return Err(ContractError::IoError);
                }
                chunk = &chunk[written..];
                input = &input[written..];
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeLease {
        rx: Vec<u8>,
        tx: Vec<u8>,
        outcome: WriteOutcome,
        read_calls: usize,
        write_calls: usize,
    }

    impl SerialLease for FakeLease {
        fn read(&mut self, max_bytes: u32, _timeout_ms: u32) -> Result<ReadResult> {
            self.read_calls += 1;
            let count = self.rx.len().min(max_bytes as usize);
            let payload = self.rx.drain(..count).collect();
            Ok(ReadResult {
                payload,
                timed_out: count == 0,
                disconnected: false,
            })
        }

        fn write(&mut self, payload: &[u8]) -> Result<WriteResult> {
            self.write_calls += 1;
            let sent = match self.outcome {
                WriteOutcome::Completed | WriteOutcome::UnknownOutcome => payload.len(),
                WriteOutcome::PartialWrite => payload.len() / 2,
            };
            self.tx.extend_from_slice(&payload[..sent]);
            Ok(WriteResult {
                requested: payload.len() as u64,
                sent: sent as u64,
                outcome: self.outcome,
            })
        }

        fn clear_buffers(&mut self) -> Result<()> {
            self.rx.clear();
            self.tx.clear();
            Ok(())
        }

        fn pending(&mut self) -> Result<PendingBytes> {
            Ok(PendingBytes {
                rx: self.rx.len() as u64,
                tx: self.tx.len() as u64,
            })
        }

        fn set_output_lines(&mut self, _lines: OutputLines) -> Result<()> {
            Ok(())
        }

        fn input_lines(&mut self) -> Result<InputLines> {
            Ok(InputLines::default())
        }

        fn release(&mut self) -> Result<()> {
            Ok(())
        }
    }

    impl SerialLeaseIdentity for FakeLease {
        fn session_id(&self) -> String {
            "session:primary".into()
        }

        fn generation(&self) -> u64 {
            7
        }
    }

    #[test]
    fn adapter_reads_and_reports_physical_write_completion() {
        let lease = FakeLease {
            rx: alloc::vec![1, 2, 3],
            tx: Vec::new(),
            outcome: WriteOutcome::Completed,
            read_calls: 0,
            write_calls: 0,
        };
        let mut adapter = SerialIoAdapter::new(lease);
        let mut output = [0_u8; 2];
        assert_eq!(Read::read(&mut adapter, &mut output, 10), Ok(2));
        assert_eq!(output, [1, 2]);
        assert_eq!(Write::write_all(&mut adapter, &[4, 5, 6]), Ok(()));
        assert_eq!(adapter.lease().tx, [4, 5, 6]);
    }

    #[test]
    fn unknown_write_outcome_is_never_hidden_or_retried() {
        let lease = FakeLease {
            rx: Vec::new(),
            tx: Vec::new(),
            outcome: WriteOutcome::UnknownOutcome,
            read_calls: 0,
            write_calls: 0,
        };
        let mut adapter = SerialIoAdapter::new(lease);
        assert_eq!(
            Write::write(&mut adapter, &[9, 9]),
            Err(ContractError::UnknownOutcome)
        );
        assert_eq!(adapter.lease().tx, [9, 9]);
        assert_eq!(adapter.lease().write_calls, 1);
    }

    const fn config() -> SerialConfig {
        SerialConfig {
            baud_rate: 115_200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: StopBits::One,
            flow_control: FlowControl::None,
        }
    }

    fn session() -> SerialSession {
        SerialSession {
            session_id: "session:primary".into(),
            name: "Primary".into(),
            port_id: Some("port:usb-1".into()),
            config: config(),
            connected: true,
            generation: 7,
        }
    }

    #[test]
    fn request_validators_enforce_transport_boundaries() {
        assert_eq!(validate_serial_read_request(1, 1), Ok(()));
        assert_eq!(
            validate_serial_read_request(MAX_STREAM_CHUNK_BYTES as u32, SERIAL_READ_TIMEOUT_MS),
            Ok(())
        );
        assert_eq!(
            validate_serial_read_request(1, SERIAL_READ_TIMEOUT_MS + 1),
            Err(ContractError::LimitExceeded)
        );
        assert_eq!(
            validate_serial_read_request(MAX_STREAM_CHUNK_BYTES as u32 + 1, 1),
            Err(ContractError::LimitExceeded)
        );
        assert_eq!(
            validate_serial_write(&alloc::vec![0; MAX_STREAM_CHUNK_BYTES + 1]),
            Err(ContractError::LimitExceeded)
        );
        assert_eq!(
            SerialLeaseOptions {
                pause_automation: true,
                rx_buffer_bytes: MAX_LEASE_RX_BUFFER_BYTES + 1,
            }
            .validate(),
            Err(ContractError::LimitExceeded)
        );
    }

    #[test]
    fn adapter_chunks_large_writes_without_hiding_outcomes() {
        let lease = FakeLease {
            rx: Vec::new(),
            tx: Vec::new(),
            outcome: WriteOutcome::Completed,
            read_calls: 0,
            write_calls: 0,
        };
        let mut adapter = SerialIoAdapter::new(lease);
        let payload = alloc::vec![0x5a; MAX_STREAM_CHUNK_BYTES + 7];
        assert_eq!(Write::write_all(&mut adapter, &payload), Ok(()));
        assert_eq!(adapter.lease().write_calls, 2);
        assert_eq!(adapter.lease().tx, payload);
    }

    #[test]
    fn adapter_rejects_invalid_reads_before_calling_the_host() {
        let lease = FakeLease {
            rx: alloc::vec![1],
            tx: Vec::new(),
            outcome: WriteOutcome::Completed,
            read_calls: 0,
            write_calls: 0,
        };
        let mut adapter = SerialIoAdapter::new(lease);
        let mut byte = [0_u8; 1];
        assert_eq!(
            Read::read(&mut adapter, &mut byte, SERIAL_READ_TIMEOUT_MS + 1),
            Err(ContractError::LimitExceeded)
        );
        assert_eq!(adapter.lease().read_calls, 0);
    }

    #[test]
    fn typed_models_validate_ids_configs_and_catalog_uniqueness() {
        assert_eq!(session().validate(), Ok(()));
        assert_eq!(validate_serial_id("plugin.local:session-1"), Ok(()));
        assert_eq!(
            validate_serial_id("/dev/ttyUSB0"),
            Err(ContractError::InvalidInput)
        );
        assert_eq!(
            validate_serial_text("unsafe\nlabel"),
            Err(ContractError::InvalidInput)
        );

        let duplicate = session();
        assert_eq!(
            validate_session_catalog(&[session(), duplicate]),
            Err(ContractError::ProtocolError)
        );
        assert_eq!(
            SerialConfig {
                data_bits: 9,
                ..config()
            }
            .validate(),
            Err(ContractError::InvalidInput)
        );
    }

    #[test]
    fn capture_pages_are_bounded_and_strictly_ordered() {
        let request = CaptureRequest {
            session_id: "session:primary".into(),
            from_sequence: 10,
            max_frames: 2,
            max_bytes: 4,
        };
        let valid = CapturePage {
            frames: alloc::vec![
                CaptureFrame {
                    sequence: 10,
                    timestamp_ms: 1,
                    direction: FrameDirection::Rx,
                    payload: alloc::vec![1, 2],
                },
                CaptureFrame {
                    sequence: 11,
                    timestamp_ms: 2,
                    direction: FrameDirection::Tx,
                    payload: alloc::vec![3, 4],
                },
            ],
            next_sequence: Some(12),
        };
        assert_eq!(validate_capture_page(&valid, &request), Ok(()));

        let mut invalid = valid;
        invalid.frames[1].sequence = 10;
        assert_eq!(
            validate_capture_page(&invalid, &request),
            Err(ContractError::ProtocolError)
        );
    }

    struct FakeHost;

    impl SerialHost for FakeHost {
        type Lease = FakeLease;

        fn list_ports(&mut self) -> Result<Vec<SerialPort>> {
            Ok(alloc::vec![SerialPort {
                port_id: "port:usb-1".into(),
                display_name: "USB serial".into(),
                usb_vendor_id: Some(0x1234),
                usb_product_id: Some(0x5678),
                serial_number: Some("ABC".into()),
            }])
        }

        fn list_sessions(&mut self) -> Result<Vec<SerialSession>> {
            Ok(alloc::vec![session()])
        }

        fn create_session(&mut self, request: CreateSession) -> Result<SerialSession> {
            request.validate()?;
            Ok(session())
        }

        fn update_session(&mut self, value: SerialSession) -> Result<SerialSession> {
            value.validate()?;
            Ok(value)
        }

        fn connect_session(&mut self, session_id: &str) -> Result<SerialSession> {
            validate_serial_id(session_id)?;
            Ok(session())
        }

        fn disconnect_session(&mut self, session_id: &str) -> Result<()> {
            validate_serial_id(session_id)
        }

        fn delete_session(&mut self, session_id: &str) -> Result<()> {
            validate_serial_id(session_id)
        }

        fn acquire_lease(
            &mut self,
            session_id: &str,
            options: SerialLeaseOptions,
        ) -> Result<Self::Lease> {
            validate_serial_id(session_id)?;
            options.validate()?;
            Ok(FakeLease {
                rx: Vec::new(),
                tx: Vec::new(),
                outcome: WriteOutcome::Completed,
                read_calls: 0,
                write_calls: 0,
            })
        }

        fn capture_read(&mut self, request: CaptureRequest) -> Result<CapturePage> {
            request.validate()?;
            Ok(CapturePage {
                frames: Vec::new(),
                next_sequence: None,
            })
        }
    }

    #[test]
    fn generic_plugins_can_manage_sessions_without_bindgen_types() {
        let mut host = FakeHost;
        let ports = host.list_ports().unwrap();
        validate_port_catalog(&ports).unwrap();
        let sessions = host.list_sessions().unwrap();
        validate_session_catalog(&sessions).unwrap();

        let created = host
            .create_session(CreateSession {
                local_id: "mcumgr".into(),
                name: "MCUmgr".into(),
                lifetime: SessionLifetime::Runtime,
                port_id: Some(ports[0].port_id.clone()),
                config: config(),
            })
            .unwrap();
        host.update_session(created.clone()).unwrap();
        host.connect_session(&created.session_id).unwrap();
        host.disconnect_session(&created.session_id).unwrap();
        let lease = host
            .acquire_lease(
                &created.session_id,
                SerialLeaseOptions {
                    pause_automation: true,
                    rx_buffer_bytes: 4_096,
                },
            )
            .unwrap();
        assert_eq!(lease.session_id(), created.session_id);
        assert_eq!(lease.generation(), created.generation);
        host.capture_read(CaptureRequest {
            session_id: created.session_id.clone(),
            from_sequence: 0,
            max_frames: 32,
            max_bytes: 4_096,
        })
        .unwrap();
        host.delete_session(&created.session_id).unwrap();
    }
}
