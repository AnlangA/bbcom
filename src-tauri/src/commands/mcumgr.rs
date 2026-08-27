//! MCUmgr backend commands built on `mcumgr-toolkit`.
//!
//! The WebView owns the serial port during normal operation. For MCUmgr the
//! frontend yields the port (clean close), invokes these commands, and
//! reconnects afterwards. Every command opens the port itself, executes
//! through `MCUmgrClient`, and drops the port when done, so the backend holds
//! no cross-call state and stays healthy across device resets.
//!
//! Local files never cross IPC as paths: uploads and downloads go through
//! opaque one-shot grants issued by the native open/save dialogs here.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bbcom_contracts::{Direction, MAX_SERIAL_PORT_PATH_BYTES, decode_data_b64};
pub use bbcom_contracts::{
    McumgrCommandResult, McumgrError, McumgrErrorKind, McumgrExecuteRequest, McumgrFilePick,
    McumgrFilePurpose, McumgrFirmwareUpdateRequest, McumgrFsDownloadRequest,
    McumgrFsDownloadResult, McumgrFsUploadRequest, McumgrImageUploadRequest, McumgrOp, McumgrPhase,
    McumgrPickFileRequest, McumgrPickSaveRequest, McumgrPortRequest, McumgrProgress,
    McumgrSavePick, McumgrTraceFrame,
};
use mcumgr_toolkit::client::{
    FirmwareUpdateError, FirmwareUpdateParams, FirmwareUpdateStep, MCUmgrClientError,
};
use mcumgr_toolkit::commands::McuMgrCommand;
use mcumgr_toolkit::connection::ExecuteError;
use mcumgr_toolkit::smp_errors::DeviceError;
use mcumgr_toolkit::transport::serial::ConfigurableTimeout;
use mcumgr_toolkit::transport::{ReceiveError, SendError};
use mcumgr_toolkit::{MCUmgrClient, MCUmgrGroup};
use serde_json::{Value as JsonValue, json};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::utils::window::require_main_window_label;

/// Upper bound for firmware/image files read fully into memory.
const MAX_TRANSFER_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Upper bound for inline payloads (settings values, raw CBOR/JSON payloads).
const MAX_INLINE_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_REMOTE_PATH_BYTES: usize = 512;
const MAX_ACTIVE_GRANTS: usize = 8;
const MIN_TIMEOUT_MS: u32 = 100;
const MAX_TIMEOUT_MS: u32 = 120_000;
const MIN_FRAME_SIZE: u32 = 64;
const MAX_FRAME_SIZE: u32 = 65_535;
const MAX_RETRIES: u8 = 16;
/// Cap wire trace returned to the WebView so a firmware upload cannot flood IPC.
const MAX_MCUMGR_TRACE_BYTES: usize = 512 * 1024;
const MAX_MCUMGR_TRACE_FRAMES: usize = 2048;

struct SerialTraceCollector {
    frames: StdMutex<Vec<McumgrTraceFrame>>,
    total_bytes: StdMutex<usize>,
}

impl SerialTraceCollector {
    fn new() -> Self {
        Self {
            frames: StdMutex::new(Vec::new()),
            total_bytes: StdMutex::new(0),
        }
    }

    fn record(&self, direction: Direction, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut total_bytes = self
            .total_bytes
            .lock()
            .expect("mcumgr trace bytes lock poisoned");
        if *total_bytes >= MAX_MCUMGR_TRACE_BYTES {
            return;
        }
        let mut frames = self
            .frames
            .lock()
            .expect("mcumgr trace frames lock poisoned");
        if frames.len() >= MAX_MCUMGR_TRACE_FRAMES {
            return;
        }
        let allowed = data.len().min(MAX_MCUMGR_TRACE_BYTES - *total_bytes);
        *total_bytes += allowed;
        frames.push(McumgrTraceFrame {
            direction,
            timestamp_ms: trace_timestamp_ms(),
            data: data[..allowed].to_vec(),
        });
    }

    fn into_frames(self) -> Vec<McumgrTraceFrame> {
        self.frames
            .into_inner()
            .expect("mcumgr trace frames lock poisoned")
    }
}

struct TracingSerial {
    inner: Box<dyn serialport::SerialPort>,
    trace: Arc<SerialTraceCollector>,
}

impl Read for TracingSerial {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        if read > 0 {
            self.trace.record(Direction::Rx, &buf[..read]);
        }
        Ok(read)
    }
}

impl Write for TracingSerial {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        if written > 0 {
            self.trace.record(Direction::Tx, &buf[..written]);
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl ConfigurableTimeout for TracingSerial {
    fn set_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.inner.set_timeout(timeout)
    }
}

struct OpenedMcumgrClient {
    client: MCUmgrClient,
    trace: Arc<SerialTraceCollector>,
}

fn trace_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// One MCUmgr operation runs at a time: the serial port is exclusive anyway
/// and a single busy flag keeps cancel semantics unambiguous.
#[derive(Default)]
pub struct McumgrState {
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    grants: StdMutex<GrantStore>,
}

#[derive(Default)]
struct GrantStore {
    entries: HashMap<String, FileGrant>,
    next_order: u64,
}

struct FileGrant {
    path: PathBuf,
    purpose: GrantPurpose,
    order: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GrantPurpose {
    Read(McumgrFilePurpose),
    Save,
}

impl McumgrState {
    fn acquire(&self) -> Result<BusyGuard, McumgrError> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(McumgrError::new(
                McumgrErrorKind::Busy,
                "another MCUmgr operation is still running",
            ));
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(BusyGuard {
            busy: Arc::clone(&self.busy),
        })
    }

    fn issue_grant(&self, path: PathBuf, purpose: GrantPurpose) -> Result<String, McumgrError> {
        let token = new_token()?;
        let mut store = self.grants.lock().expect("mcumgr grant lock poisoned");
        if store.entries.len() >= MAX_ACTIVE_GRANTS {
            let oldest = store
                .entries
                .iter()
                .min_by_key(|(_, grant)| grant.order)
                .map(|(token, _)| token.clone());
            if let Some(oldest) = oldest {
                store.entries.remove(&oldest);
            }
        }
        let order = store.next_order;
        store.next_order += 1;
        store.entries.insert(
            token.clone(),
            FileGrant {
                path,
                purpose,
                order,
            },
        );
        Ok(token)
    }

    fn consume_grant(&self, token: &str, purpose: GrantPurpose) -> Result<PathBuf, McumgrError> {
        let mut store = self.grants.lock().expect("mcumgr grant lock poisoned");
        let grant = store.entries.remove(token).ok_or_else(|| {
            McumgrError::new(
                McumgrErrorKind::InvalidInput,
                "unknown or already used file grant",
            )
        })?;
        if grant.purpose != purpose {
            return Err(McumgrError::new(
                McumgrErrorKind::InvalidInput,
                "file grant does not match the requested operation",
            ));
        }
        Ok(grant.path)
    }
}

#[derive(Debug)]
struct BusyGuard {
    busy: Arc<AtomicBool>,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

fn new_token() -> Result<String, McumgrError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Io,
            format!("failed to obtain OS randomness: {error}"),
        )
    })?;
    Ok(hex::encode(random))
}

fn security_denied(operation: &str) -> McumgrError {
    McumgrError::new(
        McumgrErrorKind::InvalidInput,
        format!("{operation} is only available to the main window"),
    )
}

fn invalid(message: impl Into<String>) -> McumgrError {
    McumgrError::new(McumgrErrorKind::InvalidInput, message)
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

fn render_error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(current) = source {
        message.push_str(": ");
        message.push_str(&current.to_string());
        source = current.source();
    }
    message
}

fn is_timeout(error: &MCUmgrClientError) -> bool {
    match error {
        MCUmgrClientError::ExecuteError(ExecuteError::ReceiveFailed(ReceiveError::Timeout)) => true,
        MCUmgrClientError::ExecuteError(ExecuteError::SendFailed(SendError::Timeout)) => true,
        _ => {
            // Some transports surface raw io timeouts instead of the typed variant.
            let mut current: Option<&dyn std::error::Error> = Some(error);
            while let Some(node) = current {
                if let Some(io_error) = node.downcast_ref::<std::io::Error>()
                    && io_error.kind() == std::io::ErrorKind::TimedOut
                {
                    return true;
                }
                current = node.source();
            }
            false
        }
    }
}

fn io_kind_is_disconnect(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::TimedOut
            | io::ErrorKind::NotFound
            | io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::Other
    )
}

/// Reset typically never gets an SMP ACK: the device drops the USB/serial
/// link as soon as it reboots. Timeouts and transport disconnects are success.
fn is_expected_reset_disconnect(error: &MCUmgrClientError) -> bool {
    if is_timeout(error) {
        return true;
    }
    match error {
        MCUmgrClientError::WriterError(io_error) | MCUmgrClientError::ReaderError(io_error) => {
            io_kind_is_disconnect(io_error.kind())
        }
        MCUmgrClientError::ExecuteError(ExecuteError::ErrorResponse(_)) => false,
        _ => {
            let mut current: Option<&dyn std::error::Error> = Some(error);
            while let Some(node) = current {
                if let Some(io_error) = node.downcast_ref::<std::io::Error>()
                    && io_kind_is_disconnect(io_error.kind())
                {
                    return true;
                }
                current = node.source();
            }
            false
        }
    }
}

/// Do not burn the configured timeout×retries budget waiting for a reset ACK.
const RESET_ACK_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResetTriggerResult {
    Acknowledged,
    DeviceDropped,
}

fn trigger_device_reset(
    client: &MCUmgrClient,
    force: bool,
) -> Result<ResetTriggerResult, MCUmgrClientError> {
    let _ = client.set_timeout(RESET_ACK_TIMEOUT);
    client.set_retries(0);
    match client.os_system_reset(force, None) {
        Ok(()) => Ok(ResetTriggerResult::Acknowledged),
        Err(error) if is_expected_reset_disconnect(&error) => Ok(ResetTriggerResult::DeviceDropped),
        Err(error) => Err(error),
    }
}

fn reset_outcome_label(outcome: ResetTriggerResult) -> &'static str {
    match outcome {
        ResetTriggerResult::Acknowledged => "acknowledged",
        ResetTriggerResult::DeviceDropped => "disconnected",
    }
}

fn map_client_error(error: &MCUmgrClientError, cancelled: bool) -> McumgrError {
    if let MCUmgrClientError::ProgressCallbackError = error
        && cancelled
    {
        return McumgrError::new(McumgrErrorKind::Cancelled, "operation cancelled");
    }
    if let MCUmgrClientError::ExecuteError(ExecuteError::ErrorResponse(device)) = error {
        let (rc, group) = match device {
            DeviceError::V1 { rc, .. } => (Some(*rc), None),
            DeviceError::V2 { group, rc } => (Some(*rc), Some(*group)),
        };
        return McumgrError {
            kind: McumgrErrorKind::Device,
            message: device.to_string(),
            rc,
            group,
        };
    }
    match error {
        MCUmgrClientError::WriterError(_) | MCUmgrClientError::ReaderError(_) => {
            McumgrError::new(McumgrErrorKind::Io, render_error_chain(error))
        }
        _ if is_timeout(error) => McumgrError::new(
            McumgrErrorKind::Timeout,
            "device did not respond within the configured timeout",
        ),
        _ => McumgrError::new(McumgrErrorKind::Protocol, render_error_chain(error)),
    }
}

fn map_firmware_error(error: &FirmwareUpdateError, cancelled: bool) -> McumgrError {
    match error {
        FirmwareUpdateError::ProgressCallbackError if cancelled => {
            McumgrError::new(McumgrErrorKind::Cancelled, "operation cancelled")
        }
        FirmwareUpdateError::ProgressCallbackError => {
            McumgrError::new(McumgrErrorKind::Protocol, render_error_chain(error))
        }
        FirmwareUpdateError::AlreadyInstalled => McumgrError::new(
            McumgrErrorKind::Device,
            "the device is already running this firmware",
        ),
        FirmwareUpdateError::InvalidMcuBootFirmwareImage(_) => {
            McumgrError::new(McumgrErrorKind::InvalidInput, render_error_chain(error))
        }
        FirmwareUpdateError::BootloaderNotSupported(name) => McumgrError::new(
            McumgrErrorKind::Device,
            format!("bootloader '{name}' is not supported"),
        ),
        FirmwareUpdateError::BootloaderDetectionFailed(source)
        | FirmwareUpdateError::GetStateFailed(source)
        | FirmwareUpdateError::ImageUploadFailed(source)
        | FirmwareUpdateError::SetStateFailed(source)
        | FirmwareUpdateError::RebootFailed(source) => {
            let mut mapped = map_client_error(source, cancelled);
            mapped.message = format!("{error}: {}", mapped.message);
            mapped
        }
    }
}

// ---------------------------------------------------------------------------
// Port opening
// ---------------------------------------------------------------------------

fn validate_port(port: &McumgrPortRequest) -> Result<(), McumgrError> {
    if port.path.is_empty() || port.path.len() > MAX_SERIAL_PORT_PATH_BYTES {
        return Err(invalid("serial port path is empty or too long"));
    }
    if port.baud_rate == 0 {
        return Err(invalid("baud rate must be positive"));
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&port.timeout_ms) {
        return Err(invalid(format!(
            "timeout must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS} ms"
        )));
    }
    if port.retries > MAX_RETRIES {
        return Err(invalid(format!("retries must be at most {MAX_RETRIES}")));
    }
    if !(MIN_FRAME_SIZE..=MAX_FRAME_SIZE).contains(&port.frame_size) {
        return Err(invalid(format!(
            "frame size must be between {MIN_FRAME_SIZE} and {MAX_FRAME_SIZE} bytes"
        )));
    }
    Ok(())
}

fn open_client(
    port: &McumgrPortRequest,
    cancel: &AtomicBool,
) -> Result<OpenedMcumgrClient, McumgrError> {
    validate_port(port)?;
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }
    let trace = Arc::new(SerialTraceCollector::new());
    let trace_handle = Arc::clone(&trace);
    let serial = serialport::new(&port.path, port.baud_rate)
        .timeout(Duration::from_millis(u64::from(port.timeout_ms)))
        .open()
        .map_err(|error| {
            McumgrError::new(
                McumgrErrorKind::Port,
                format!("failed to open serial port: {error}"),
            )
        })?;
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }
    let traced = TracingSerial {
        inner: serial,
        trace: Arc::clone(&trace_handle),
    };
    let client = MCUmgrClient::new_from_serial(traced);
    let operation_timeout = Duration::from_millis(u64::from(port.timeout_ms));
    client
        .set_timeout(operation_timeout)
        .map_err(|error| map_client_error(&error, false))?;
    client.set_retries(port.retries);
    if port.auto_frame_size {
        // Cap negotiation so a silent/non-SMP port cannot freeze the panel for
        // the full timeout×retries budget after the OS permission dialog.
        let negotiation_ms = u64::from(port.timeout_ms).min(2_000);
        let _ = client.set_timeout(Duration::from_millis(negotiation_ms));
        client.set_retries(port.retries.min(1));
        if cancel.load(Ordering::SeqCst) || client.use_auto_frame_size().is_err() {
            // Negotiation is best-effort; fall back to the manual setting.
            client.set_frame_size(port.frame_size as usize);
        }
        client
            .set_timeout(operation_timeout)
            .map_err(|error| map_client_error(&error, cancel.load(Ordering::SeqCst)))?;
        client.set_retries(port.retries);
    } else {
        client.set_frame_size(port.frame_size as usize);
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }
    Ok(OpenedMcumgrClient {
        client,
        trace: trace_handle,
    })
}

fn take_trace_frames(opened: OpenedMcumgrClient) -> Vec<McumgrTraceFrame> {
    let OpenedMcumgrClient { client, trace } = opened;
    drop(client);
    Arc::try_unwrap(trace)
        .map(SerialTraceCollector::into_frames)
        .unwrap_or_default()
}

fn finish_command(
    opened: OpenedMcumgrClient,
    value: JsonValue,
) -> Result<McumgrCommandResult, McumgrError> {
    command_result(value, take_trace_frames(opened))
}

fn cancelled_error() -> McumgrError {
    McumgrError::new(McumgrErrorKind::Cancelled, "operation cancelled")
}

// ---------------------------------------------------------------------------
// Quick operations
// ---------------------------------------------------------------------------

/// Custom SMP command carrying an arbitrary CBOR payload for raw passthrough.
struct RawCborCommand {
    write: bool,
    group: u16,
    command: u8,
    payload: ciborium::Value,
}

impl McuMgrCommand for RawCborCommand {
    type Payload = ciborium::Value;
    type Response = ciborium::Value;

    fn is_write_operation(&self) -> bool {
        self.write
    }

    fn group_id(&self) -> u16 {
        self.group
    }

    fn command_id(&self) -> u8 {
        self.command
    }

    fn data(&self) -> &Self::Payload {
        &self.payload
    }
}

fn cbor_to_json(value: &ciborium::Value) -> JsonValue {
    match value {
        ciborium::Value::Null => JsonValue::Null,
        ciborium::Value::Bool(inner) => JsonValue::Bool(*inner),
        ciborium::Value::Integer(inner) => {
            let wide: i128 = (*inner).into();
            i64::try_from(wide)
                .map(JsonValue::from)
                .or_else(|_| u64::try_from(wide).map(JsonValue::from))
                .unwrap_or_else(|_| JsonValue::String(wide.to_string()))
        }
        ciborium::Value::Float(inner) => serde_json::Number::from_f64(*inner)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        ciborium::Value::Bytes(bytes) => JsonValue::String(hex::encode(bytes)),
        ciborium::Value::Text(text) => JsonValue::String(text.clone()),
        ciborium::Value::Array(items) => JsonValue::Array(items.iter().map(cbor_to_json).collect()),
        ciborium::Value::Map(entries) => {
            let mut object = serde_json::Map::with_capacity(entries.len());
            for (key, entry) in entries {
                let key = match key {
                    ciborium::Value::Text(text) => text.clone(),
                    other => cbor_to_json(other).to_string(),
                };
                object.insert(key, cbor_to_json(entry));
            }
            JsonValue::Object(object)
        }
        ciborium::Value::Tag(_, inner) => cbor_to_json(inner),
        other => JsonValue::String(format!("{other:?}")),
    }
}

fn parse_hash_hex(value: &str) -> Result<Vec<u8>, McumgrError> {
    let compact: String = value.split_whitespace().collect();
    if compact.is_empty() {
        return Err(invalid("hash must be non-empty hex"));
    }
    hex::decode(&compact).map_err(|_| invalid("hash must be a hex byte string"))
}

fn raw_payload(
    payload_json: Option<&str>,
    payload_b64: Option<&str>,
) -> Result<ciborium::Value, McumgrError> {
    if let Some(encoded) = payload_b64 {
        let bytes = decode_data_b64(encoded, MAX_INLINE_PAYLOAD_BYTES)
            .map_err(|error| invalid(format!("invalid raw payload: {error}")))?;
        return ciborium::from_reader(bytes.as_slice())
            .map_err(|error| invalid(format!("raw payload is not valid CBOR: {error}")));
    }
    if let Some(text) = payload_json {
        if text.len() > MAX_INLINE_PAYLOAD_BYTES {
            return Err(invalid("raw JSON payload too large"));
        }
        let json: JsonValue = serde_json::from_str(text)
            .map_err(|error| invalid(format!("raw payload is not valid JSON: {error}")))?;
        if !json.is_object() {
            return Err(invalid("raw JSON payload must be an object"));
        }
        return ciborium::Value::serialized(&json)
            .map_err(|error| invalid(format!("failed to encode payload as CBOR: {error}")));
    }
    Ok(ciborium::Value::Map(Vec::new()))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<JsonValue, McumgrError> {
    serde_json::to_value(value).map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Protocol,
            format!("failed to encode device response: {error}"),
        )
    })
}

fn sorted<T>(map: HashMap<String, T>) -> BTreeMap<String, T> {
    map.into_iter().collect()
}

fn run_quick_op(client: &MCUmgrClient, op: &McumgrOp) -> Result<JsonValue, McumgrError> {
    let map_err = |error: MCUmgrClientError| map_client_error(&error, false);
    match op {
        McumgrOp::OsEcho { message } => {
            if message.len() > MAX_INLINE_PAYLOAD_BYTES {
                return Err(invalid("echo message too large"));
            }
            let echoed = client.os_echo(message).map_err(map_err)?;
            Ok(json!({ "echo": echoed }))
        }
        McumgrOp::OsTasks => {
            let tasks = client.os_task_statistics().map_err(map_err)?;
            to_json(&sorted(tasks))
        }
        McumgrOp::OsMemoryPools => {
            let pools = client.os_memory_pool_statistics().map_err(map_err)?;
            to_json(&sorted(pools))
        }
        McumgrOp::OsDatetime => {
            let datetime = client.os_get_datetime().map_err(map_err)?;
            Ok(json!({ "datetime": datetime.to_string() }))
        }
        McumgrOp::OsInfo { format } => {
            let info = client
                .os_application_info(format.as_deref())
                .map_err(map_err)?;
            Ok(json!({ "info": info }))
        }
        McumgrOp::OsParams => {
            let params = client.os_mcumgr_parameters().map_err(map_err)?;
            Ok(json!({ "bufSize": params.buf_size, "bufCount": params.buf_count }))
        }
        McumgrOp::OsBootloaderInfo => {
            let info = client.os_bootloader_info().map_err(map_err)?;
            to_json(&info)
        }
        McumgrOp::OsReset { force } => {
            let outcome = trigger_device_reset(client, *force).map_err(map_err)?;
            Ok(json!({ "ok": true, "reboot": reset_outcome_label(outcome) }))
        }
        McumgrOp::ImageState => {
            let images = client.image_get_state().map_err(map_err)?;
            to_json(&images)
        }
        McumgrOp::ImageTest { hash_hex } => {
            let hash = parse_hash_hex(hash_hex)?;
            let images = client
                .image_set_state(Some(&hash), false)
                .map_err(map_err)?;
            to_json(&images)
        }
        McumgrOp::ImageConfirm { hash_hex } => {
            let hash = hash_hex.as_deref().map(parse_hash_hex).transpose()?;
            let images = client
                .image_set_state(hash.as_deref(), true)
                .map_err(map_err)?;
            to_json(&images)
        }
        McumgrOp::ImageErase { slot } => {
            client.image_erase(*slot).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::ImageSlotInfo => {
            let slots = client.image_slot_info().map_err(map_err)?;
            to_json(&slots)
        }
        McumgrOp::Shell { line } => {
            let argv: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
            if argv.is_empty() {
                return Err(invalid("shell command must not be empty"));
            }
            let (ret, output) = client.shell_execute(&argv, false).map_err(map_err)?;
            Ok(json!({ "ret": ret, "output": output }))
        }
        McumgrOp::FsStatus { path } => {
            validate_remote_path(path)?;
            let status = client.fs_file_status(path).map_err(map_err)?;
            Ok(json!({ "len": status.len }))
        }
        McumgrOp::FsHash { path } => {
            validate_remote_path(path)?;
            let checksum = client
                .fs_file_checksum(path, None::<&str>, 0, None)
                .map_err(map_err)?;
            Ok(json!({
                "type": checksum.r#type,
                "off": checksum.off,
                "len": checksum.len,
                "output": checksum.output.hex(),
            }))
        }
        McumgrOp::FsClose => {
            client.fs_file_close().map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::SettingsRead { name } => {
            let value = client.settings_read(name).map_err(map_err)?;
            Ok(json!({
                "valueHex": hex::encode(&value),
                "valueUtf8": String::from_utf8_lossy(&value),
            }))
        }
        McumgrOp::SettingsWrite { name, value_b64 } => {
            let value = decode_data_b64(value_b64, MAX_INLINE_PAYLOAD_BYTES)
                .map_err(|error| invalid(format!("invalid setting value: {error}")))?;
            client.settings_write(name, &value).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::SettingsDelete { name } => {
            client.settings_delete(name).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::SettingsCommit => {
            client.settings_commit().map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::SettingsLoad => {
            client.settings_load().map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::SettingsSave => {
            client.settings_save(None::<&str>).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::StatsList => {
            let groups = client.stats_list_groups().map_err(map_err)?;
            Ok(json!({ "groups": groups }))
        }
        McumgrOp::StatsShow { name } => {
            let values = client.stats_get_group_data(name).map_err(map_err)?;
            to_json(&sorted(values))
        }
        McumgrOp::EnumCount => {
            let count = client.enum_get_group_count().map_err(map_err)?;
            Ok(json!({ "count": count }))
        }
        McumgrOp::EnumList => {
            let ids = client.enum_get_group_ids().map_err(map_err)?;
            let groups: Vec<JsonValue> = ids
                .into_iter()
                .map(|id| json!({ "id": id, "name": MCUmgrGroup::group_id_to_string(id) }))
                .collect();
            Ok(json!({ "groups": groups }))
        }
        McumgrOp::EnumDetails => {
            let details = client.enum_get_group_details(None).map_err(map_err)?;
            to_json(&details)
        }
        McumgrOp::ZephyrEraseStorage => {
            client.zephyr_erase_storage().map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        McumgrOp::Raw {
            group,
            command,
            write,
            payload_json,
            payload_b64,
        } => {
            let payload = raw_payload(payload_json.as_deref(), payload_b64.as_deref())?;
            let raw = RawCborCommand {
                write: *write,
                group: *group,
                command: *command,
                payload,
            };
            let response = client.raw_command(&raw).map_err(map_err)?;
            Ok(cbor_to_json(&response))
        }
    }
}

fn validate_remote_path(path: &str) -> Result<(), McumgrError> {
    if path.is_empty() || path.len() > MAX_REMOTE_PATH_BYTES {
        return Err(invalid("remote path is empty or too long"));
    }
    Ok(())
}

fn command_result(
    value: JsonValue,
    trace_frames: Vec<McumgrTraceFrame>,
) -> Result<McumgrCommandResult, McumgrError> {
    serde_json::to_string(&value)
        .map(|result_json| McumgrCommandResult {
            result_json,
            trace_frames,
        })
        .map_err(|error| {
            McumgrError::new(
                McumgrErrorKind::Protocol,
                format!("failed to encode result: {error}"),
            )
        })
}

#[tauri::command]
pub async fn mcumgr_execute(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrExecuteRequest,
) -> Result<McumgrCommandResult, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_execute")
        .map_err(|_| security_denied("mcumgr_execute"))?;
    let guard = state.acquire()?;
    let cancel = Arc::clone(&state.cancel);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let opened = open_client(&request.port, &cancel)?;
        let result = run_quick_op(&opened.client, &request.op)?;
        finish_command(opened, result)
    })
    .await
    .map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Protocol,
            format!("mcumgr task failed: {error}"),
        )
    })??;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Long-running operations with progress channels
// ---------------------------------------------------------------------------

/// Rate-limits offset progress events so chunked transfers do not flood IPC.
struct ProgressReporter {
    channel: Channel<McumgrProgress>,
    cancel: Arc<AtomicBool>,
    last_offset: AtomicU64,
}

impl ProgressReporter {
    fn new(channel: Channel<McumgrProgress>, cancel: Arc<AtomicBool>) -> Self {
        Self {
            channel,
            cancel,
            last_offset: AtomicU64::new(u64::MAX),
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Sends a phase transition unconditionally.
    fn phase(&self, phase: McumgrPhase, detail: Option<String>) -> bool {
        if self.cancelled() {
            return false;
        }
        self.last_offset.store(u64::MAX, Ordering::Relaxed);
        let _ = self.channel.send(McumgrProgress {
            phase,
            detail,
            offset: None,
            total: None,
        });
        true
    }

    /// Sends byte progress, throttled to meaningful increments.
    fn bytes(&self, phase: McumgrPhase, offset: u64, total: u64) -> bool {
        if self.cancelled() {
            return false;
        }
        let last = self.last_offset.load(Ordering::Relaxed);
        let step = (total / 200).max(4096);
        if last != u64::MAX && offset != total && offset.saturating_sub(last) < step {
            return true;
        }
        self.last_offset.store(offset, Ordering::Relaxed);
        let _ = self.channel.send(McumgrProgress {
            phase,
            detail: None,
            offset: Some(offset),
            total: Some(total),
        });
        true
    }
}

fn firmware_step_progress(
    reporter: &ProgressReporter,
) -> impl FnMut(FirmwareUpdateStep, Option<(u64, u64)>) -> bool + '_ {
    move |step, bytes| {
        if let Some((offset, total)) = bytes {
            return reporter.bytes(McumgrPhase::Uploading, offset, total);
        }
        let (phase, detail) = match &step {
            FirmwareUpdateStep::DetectingBootloader => (McumgrPhase::DetectingBootloader, None),
            FirmwareUpdateStep::BootloaderFound(kind) => {
                (McumgrPhase::BootloaderFound, Some(kind.to_string()))
            }
            FirmwareUpdateStep::ParsingFirmwareImage => (McumgrPhase::ParsingImage, None),
            FirmwareUpdateStep::QueryingDeviceState => (McumgrPhase::QueryingState, None),
            FirmwareUpdateStep::UpdateInfo { .. } => {
                (McumgrPhase::UpdateInfo, Some(step.to_string()))
            }
            FirmwareUpdateStep::UploadingFirmware => (McumgrPhase::Uploading, None),
            FirmwareUpdateStep::ActivatingFirmware => (McumgrPhase::Activating, None),
            FirmwareUpdateStep::TriggeringReboot => (McumgrPhase::Rebooting, None),
        };
        reporter.phase(phase, detail)
    }
}

fn read_transfer_file(path: &PathBuf) -> Result<Vec<u8>, McumgrError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        McumgrError::new(McumgrErrorKind::Io, format!("failed to read file: {error}"))
    })?;
    if metadata.len() > MAX_TRANSFER_FILE_BYTES {
        return Err(invalid(format!(
            "file is larger than the {MAX_TRANSFER_FILE_BYTES} byte transfer limit"
        )));
    }
    std::fs::read(path).map_err(|error| {
        McumgrError::new(McumgrErrorKind::Io, format!("failed to read file: {error}"))
    })
}

#[tauri::command]
pub async fn mcumgr_firmware_update(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrFirmwareUpdateRequest,
    on_progress: Channel<McumgrProgress>,
) -> Result<McumgrCommandResult, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_firmware_update")
        .map_err(|_| security_denied("mcumgr_firmware_update"))?;
    let guard = state.acquire()?;
    let path = state.consume_grant(
        &request.file_token,
        GrantPurpose::Read(McumgrFilePurpose::Firmware),
    )?;
    let cancel = Arc::clone(&state.cancel);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let firmware = read_transfer_file(&path)?;
        let opened = open_client(&request.port, &cancel)?;
        let reporter = ProgressReporter::new(on_progress, cancel);
        let mut progress = firmware_step_progress(&reporter);
        // Toolkit reboot treats a missing SMP ACK as failure. Skip it and send
        // reset ourselves so a USB drop after os-reset is a successful upgrade.
        let params = FirmwareUpdateParams {
            bootloader_type: None,
            skip_reboot: true,
            force_confirm: request.force_confirm,
            upgrade_only: request.upgrade_only,
        };
        opened
            .client
            .firmware_update(&firmware, None, params, Some(&mut progress))
            .map_err(|error| map_firmware_error(&error, reporter.cancelled()))?;
        let reboot = if request.skip_reboot {
            "skipped"
        } else if !reporter.phase(McumgrPhase::Rebooting, None) {
            return Err(cancelled_error());
        } else {
            match trigger_device_reset(&opened.client, false) {
                Ok(outcome) => reset_outcome_label(outcome),
                Err(error) => {
                    return Err(map_firmware_error(
                        &FirmwareUpdateError::RebootFailed(error),
                        reporter.cancelled(),
                    ));
                }
            }
        };
        finish_command(
            opened,
            json!({ "ok": true, "bytes": firmware.len(), "reboot": reboot }),
        )
    })
    .await
    .map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Protocol,
            format!("mcumgr task failed: {error}"),
        )
    })??;
    Ok(result)
}

#[tauri::command]
pub async fn mcumgr_image_upload(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrImageUploadRequest,
    on_progress: Channel<McumgrProgress>,
) -> Result<McumgrCommandResult, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_image_upload")
        .map_err(|_| security_denied("mcumgr_image_upload"))?;
    let guard = state.acquire()?;
    let path = state.consume_grant(
        &request.file_token,
        GrantPurpose::Read(McumgrFilePurpose::Firmware),
    )?;
    let cancel = Arc::clone(&state.cancel);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let image = read_transfer_file(&path)?;
        let opened = open_client(&request.port, &cancel)?;
        let reporter = ProgressReporter::new(on_progress, cancel);
        let mut progress =
            |offset: u64, total: u64| reporter.bytes(McumgrPhase::Uploading, offset, total);
        opened
            .client
            .image_upload(
                &image,
                request.image,
                None,
                request.upgrade_only,
                Some(&mut progress),
            )
            .map_err(|error| map_client_error(&error, reporter.cancelled()))?;
        finish_command(opened, json!({ "ok": true, "bytes": image.len() }))
    })
    .await
    .map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Protocol,
            format!("mcumgr task failed: {error}"),
        )
    })??;
    Ok(result)
}

#[tauri::command]
pub async fn mcumgr_fs_upload(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrFsUploadRequest,
    on_progress: Channel<McumgrProgress>,
) -> Result<McumgrCommandResult, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_fs_upload")
        .map_err(|_| security_denied("mcumgr_fs_upload"))?;
    validate_remote_path(&request.remote_path)?;
    let guard = state.acquire()?;
    let path = state.consume_grant(
        &request.file_token,
        GrantPurpose::Read(McumgrFilePurpose::FsUpload),
    )?;
    let cancel = Arc::clone(&state.cancel);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let file = std::fs::File::open(&path).map_err(|error| {
            McumgrError::new(McumgrErrorKind::Io, format!("failed to open file: {error}"))
        })?;
        let size = file
            .metadata()
            .map_err(|error| {
                McumgrError::new(McumgrErrorKind::Io, format!("failed to stat file: {error}"))
            })?
            .len();
        let opened = open_client(&request.port, &cancel)?;
        let reporter = ProgressReporter::new(on_progress, cancel);
        let mut progress =
            |offset: u64, total: u64| reporter.bytes(McumgrPhase::Uploading, offset, total);
        opened
            .client
            .fs_file_upload(
                &request.remote_path,
                std::io::BufReader::new(file),
                size,
                Some(&mut progress),
            )
            .map_err(|error| map_client_error(&error, reporter.cancelled()))?;
        finish_command(opened, json!({ "ok": true, "bytes": size }))
    })
    .await
    .map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Protocol,
            format!("mcumgr task failed: {error}"),
        )
    })??;
    Ok(result)
}

#[tauri::command]
pub async fn mcumgr_fs_download(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrFsDownloadRequest,
    on_progress: Channel<McumgrProgress>,
) -> Result<McumgrFsDownloadResult, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_fs_download")
        .map_err(|_| security_denied("mcumgr_fs_download"))?;
    validate_remote_path(&request.remote_path)?;
    let guard = state.acquire()?;
    let path = state.consume_grant(&request.save_token, GrantPurpose::Save)?;
    let cancel = Arc::clone(&state.cancel);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let display_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".to_owned());
        let file = std::fs::File::create(&path).map_err(|error| {
            McumgrError::new(
                McumgrErrorKind::Io,
                format!("failed to create file: {error}"),
            )
        })?;
        let mut writer = std::io::BufWriter::new(file);
        let opened = open_client(&request.port, &cancel)?;
        let reporter = ProgressReporter::new(on_progress, cancel);
        let mut progress =
            |offset: u64, total: u64| reporter.bytes(McumgrPhase::Downloading, offset, total);
        let outcome = opened
            .client
            .fs_file_download(&request.remote_path, &mut writer, Some(&mut progress))
            .map_err(|error| map_client_error(&error, reporter.cancelled()));
        let trace_frames = take_trace_frames(opened);
        if let Err(error) = outcome {
            drop(writer);
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        use std::io::Write as _;
        writer.flush().map_err(|error| {
            McumgrError::new(
                McumgrErrorKind::Io,
                format!("failed to flush file: {error}"),
            )
        })?;
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok(McumgrFsDownloadResult {
            bytes,
            display_name,
            trace_frames,
        })
    })
    .await
    .map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Protocol,
            format!("mcumgr task failed: {error}"),
        )
    })?
}

#[tauri::command]
pub fn mcumgr_cancel(state: State<'_, McumgrState>) {
    if state.busy.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Native file dialogs issuing opaque grants
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mcumgr_pick_file(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrPickFileRequest,
) -> Result<Option<McumgrFilePick>, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_pick_file")
        .map_err(|_| security_denied("mcumgr_pick_file"))?;
    let selected = tauri::async_runtime::spawn_blocking({
        let window = window.clone();
        let purpose = request.purpose;
        move || {
            let mut dialog = window.dialog().file();
            if purpose == McumgrFilePurpose::Firmware {
                dialog = dialog.add_filter("Firmware image", &["bin", "signed", "img"]);
            }
            dialog.blocking_pick_file()
        }
    })
    .await
    .map_err(|_| McumgrError::new(McumgrErrorKind::Io, "file dialog task failed"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| invalid("selected file path is not usable"))?;
    let metadata = std::fs::metadata(&path).map_err(|error| {
        McumgrError::new(
            McumgrErrorKind::Io,
            format!("failed to read selected file: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(invalid("selection must be a regular file"));
    }
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let token = state.issue_grant(path, GrantPurpose::Read(request.purpose))?;
    Ok(Some(McumgrFilePick {
        token,
        display_name,
        size_bytes: metadata.len(),
    }))
}

#[tauri::command]
pub async fn mcumgr_pick_save_target(
    window: WebviewWindow,
    state: State<'_, McumgrState>,
    request: McumgrPickSaveRequest,
) -> Result<Option<McumgrSavePick>, McumgrError> {
    require_main_window_label(window.label(), "mcumgr_pick_save_target")
        .map_err(|_| security_denied("mcumgr_pick_save_target"))?;
    let suggested = sanitize_suggested_name(&request.suggested_name)?;
    let selected = tauri::async_runtime::spawn_blocking({
        let window = window.clone();
        move || {
            window
                .dialog()
                .file()
                .set_file_name(&suggested)
                .blocking_save_file()
        }
    })
    .await
    .map_err(|_| McumgrError::new(McumgrErrorKind::Io, "save dialog task failed"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| invalid("selected save path is not usable"))?;
    if !path.is_absolute() || path.is_dir() {
        return Err(invalid("selected save path must be an absolute file path"));
    }
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| invalid("selected save path must have a file name"))?;
    let token = state.issue_grant(path, GrantPurpose::Save)?;
    Ok(Some(McumgrSavePick {
        token,
        display_name,
    }))
}

fn sanitize_suggested_name(name: &str) -> Result<String, McumgrError> {
    if name.is_empty() || name.len() > 128 {
        return Err(invalid("suggested file name must be 1-128 bytes"));
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(invalid(
            "suggested file name must not contain path separators",
        ));
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_flag_serializes_operations_and_releases_on_drop() {
        let state = McumgrState::default();
        let guard = state.acquire().unwrap();
        let error = state.acquire().unwrap_err();
        assert_eq!(error.kind, McumgrErrorKind::Busy);
        drop(guard);
        assert!(state.acquire().is_ok());
    }

    #[test]
    fn acquire_resets_a_stale_cancel_flag() {
        let state = McumgrState::default();
        state.cancel.store(true, Ordering::SeqCst);
        let _guard = state.acquire().unwrap();
        assert!(!state.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_only_arms_while_busy() {
        let state = McumgrState::default();
        // Not busy: flag must stay clear so the next operation starts clean.
        if state.busy.load(Ordering::SeqCst) {
            unreachable!();
        }
        // Simulate the command body without a Tauri State wrapper.
        if state.busy.load(Ordering::SeqCst) {
            state.cancel.store(true, Ordering::SeqCst);
        }
        assert!(!state.cancel.load(Ordering::SeqCst));
        let _guard = state.acquire().unwrap();
        if state.busy.load(Ordering::SeqCst) {
            state.cancel.store(true, Ordering::SeqCst);
        }
        assert!(state.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn grants_are_one_shot_and_purpose_bound() {
        let state = McumgrState::default();
        let token = state
            .issue_grant(
                PathBuf::from("/tmp/firmware.bin"),
                GrantPurpose::Read(McumgrFilePurpose::Firmware),
            )
            .unwrap();
        assert!(
            state
                .consume_grant(&token, GrantPurpose::Save)
                .unwrap_err()
                .kind
                == McumgrErrorKind::InvalidInput
        );
        // A purpose mismatch burns the grant: a second use must fail too.
        assert!(
            state
                .consume_grant(&token, GrantPurpose::Read(McumgrFilePurpose::Firmware))
                .is_err()
        );

        let token = state
            .issue_grant(
                PathBuf::from("/tmp/firmware.bin"),
                GrantPurpose::Read(McumgrFilePurpose::Firmware),
            )
            .unwrap();
        let path = state
            .consume_grant(&token, GrantPurpose::Read(McumgrFilePurpose::Firmware))
            .unwrap();
        assert_eq!(path, PathBuf::from("/tmp/firmware.bin"));
        assert!(
            state
                .consume_grant(&token, GrantPurpose::Read(McumgrFilePurpose::Firmware))
                .is_err()
        );
    }

    #[test]
    fn grant_store_evicts_the_oldest_entry_at_capacity() {
        let state = McumgrState::default();
        let first = state
            .issue_grant(PathBuf::from("/tmp/0"), GrantPurpose::Save)
            .unwrap();
        for index in 1..=MAX_ACTIVE_GRANTS {
            state
                .issue_grant(PathBuf::from(format!("/tmp/{index}")), GrantPurpose::Save)
                .unwrap();
        }
        assert!(state.consume_grant(&first, GrantPurpose::Save).is_err());
        assert_eq!(
            state.grants.lock().unwrap().entries.len(),
            MAX_ACTIVE_GRANTS
        );
    }

    #[test]
    fn port_validation_rejects_out_of_range_settings() {
        let valid = McumgrPortRequest {
            path: "/dev/ttyACM0".to_owned(),
            baud_rate: 115_200,
            timeout_ms: 1_000,
            retries: 3,
            auto_frame_size: true,
            frame_size: 512,
        };
        assert!(validate_port(&valid).is_ok());
        for broken in [
            McumgrPortRequest {
                path: String::new(),
                ..valid.clone()
            },
            McumgrPortRequest {
                baud_rate: 0,
                ..valid.clone()
            },
            McumgrPortRequest {
                timeout_ms: 5,
                ..valid.clone()
            },
            McumgrPortRequest {
                timeout_ms: MAX_TIMEOUT_MS + 1,
                ..valid.clone()
            },
            McumgrPortRequest {
                retries: MAX_RETRIES + 1,
                ..valid.clone()
            },
            McumgrPortRequest {
                frame_size: 16,
                ..valid.clone()
            },
        ] {
            let error = validate_port(&broken).unwrap_err();
            assert_eq!(error.kind, McumgrErrorKind::InvalidInput);
        }
    }

    #[test]
    fn device_errors_map_to_structured_rc_and_group() {
        let v2 = MCUmgrClientError::ExecuteError(ExecuteError::ErrorResponse(DeviceError::V2 {
            group: 1,
            rc: 3,
        }));
        let mapped = map_client_error(&v2, false);
        assert_eq!(mapped.kind, McumgrErrorKind::Device);
        assert_eq!(mapped.rc, Some(3));
        assert_eq!(mapped.group, Some(1));

        let v1 = MCUmgrClientError::ExecuteError(ExecuteError::ErrorResponse(DeviceError::V1 {
            rc: 8,
            rsn: Some("not supported".to_owned()),
        }));
        let mapped = map_client_error(&v1, false);
        assert_eq!(mapped.kind, McumgrErrorKind::Device);
        assert_eq!(mapped.rc, Some(8));
        assert_eq!(mapped.group, None);
        assert!(mapped.message.contains("not supported"));
    }

    #[test]
    fn cancelled_progress_maps_to_cancelled_only_when_flag_is_set() {
        let cancelled = map_client_error(&MCUmgrClientError::ProgressCallbackError, true);
        assert_eq!(cancelled.kind, McumgrErrorKind::Cancelled);
        let not_cancelled = map_client_error(&MCUmgrClientError::ProgressCallbackError, false);
        assert_eq!(not_cancelled.kind, McumgrErrorKind::Protocol);

        let firmware_cancelled =
            map_firmware_error(&FirmwareUpdateError::ProgressCallbackError, true);
        assert_eq!(firmware_cancelled.kind, McumgrErrorKind::Cancelled);
    }

    #[test]
    fn timeouts_are_detected_from_typed_and_io_sources() {
        let typed =
            MCUmgrClientError::ExecuteError(ExecuteError::ReceiveFailed(ReceiveError::Timeout));
        assert_eq!(
            map_client_error(&typed, false).kind,
            McumgrErrorKind::Timeout
        );

        let io = MCUmgrClientError::ExecuteError(ExecuteError::ReceiveFailed(
            ReceiveError::TransportError(Box::new(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out",
            ))),
        ));
        assert_eq!(map_client_error(&io, false).kind, McumgrErrorKind::Timeout);

        let send = MCUmgrClientError::ExecuteError(ExecuteError::SendFailed(SendError::Timeout));
        assert_eq!(
            map_client_error(&send, false).kind,
            McumgrErrorKind::Timeout
        );
    }

    #[test]
    fn reset_without_an_ack_is_treated_as_the_device_dropping() {
        let timeout =
            MCUmgrClientError::ExecuteError(ExecuteError::ReceiveFailed(ReceiveError::Timeout));
        assert!(is_expected_reset_disconnect(&timeout));

        let broken = MCUmgrClientError::WriterError(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "pipe",
        ));
        assert!(is_expected_reset_disconnect(&broken));

        let other = MCUmgrClientError::ReaderError(std::io::Error::new(
            std::io::ErrorKind::Other,
            "device removed",
        ));
        assert!(is_expected_reset_disconnect(&other));

        let rejected =
            MCUmgrClientError::ExecuteError(ExecuteError::ErrorResponse(DeviceError::V1 {
                rc: 8,
                rsn: Some("not supported".to_owned()),
            }));
        assert!(!is_expected_reset_disconnect(&rejected));
    }

    #[test]
    fn raw_payload_accepts_json_objects_and_rejects_non_objects() {
        let value = raw_payload(Some(r#"{"d":"hello","echo":1}"#), None).unwrap();
        assert!(matches!(value, ciborium::Value::Map(_)));
        assert!(raw_payload(Some("[1,2,3]"), None).is_err());
        assert!(raw_payload(Some("not json"), None).is_err());
        let empty = raw_payload(None, None).unwrap();
        assert_eq!(empty, ciborium::Value::Map(Vec::new()));
    }

    #[test]
    fn cbor_values_render_as_display_friendly_json() {
        let cbor = ciborium::Value::Map(vec![
            (
                ciborium::Value::Text("bytes".into()),
                ciborium::Value::Bytes(vec![0xde, 0xad]),
            ),
            (
                ciborium::Value::Text("num".into()),
                ciborium::Value::Integer(42.into()),
            ),
            (
                ciborium::Value::Integer(7.into()),
                ciborium::Value::Bool(true),
            ),
        ]);
        let json = cbor_to_json(&cbor);
        assert_eq!(json["bytes"], "dead");
        assert_eq!(json["num"], 42);
        assert_eq!(json["7"], true);
    }

    #[test]
    fn hash_parsing_accepts_spaced_hex_and_rejects_garbage() {
        assert_eq!(
            parse_hash_hex("de ad be ef").unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
        assert!(parse_hash_hex("").is_err());
        assert!(parse_hash_hex("xyz").is_err());
    }

    #[test]
    fn suggested_save_names_reject_path_separators() {
        assert!(sanitize_suggested_name("data.bin").is_ok());
        assert!(sanitize_suggested_name("../data.bin").is_err());
        assert!(sanitize_suggested_name("a/b.bin").is_err());
        assert!(sanitize_suggested_name("a\\b.bin").is_err());
        assert!(sanitize_suggested_name("").is_err());
    }
}
