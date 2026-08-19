use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use core::fmt;

use bbcom_mcumgr_core::cbor::{self, Value};
use bbcom_mcumgr_core::command::{
    command_error_from_response, CommandError, FsCommand, ImageCommand, ImageUploadChunk,
    RetrySafety,
};
use bbcom_mcumgr_core::{Command, ConsoleCodec, ConsoleParser, PendingRequest, RawParser, Version};
use bbcom_plugin_sdk::file::{ReadGrant, SaveGrant};
use bbcom_plugin_sdk::serial::{Read, Write};
use bbcom_plugin_sdk::task::{Progress, TaskContext};
use bbcom_plugin_sdk::ContractError;

use crate::model::{ClientState, TransportMode};
use crate::sha256::Sha256;

const IO_CHUNK_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_READS: usize = 4_096;
const MAX_OFFSET_REDIRECTS: usize = 8;
const MCUBOOT_MAGIC: u32 = 0x96f3_b83d;
const MCUBOOT_HEADER_BYTES: usize = 32;
const TLV_INFO_MAGIC: u16 = 0x6907;
const TLV_PROTECTED_MAGIC: u16 = 0x6908;
const TLV_SHA256: u8 = 0x10;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowError {
    Contract(ContractError),
    Protocol(bbcom_mcumgr_core::ProtocolError),
    Device(CommandError),
    InvalidResponse(&'static str),
    InvalidImage(&'static str),
}

impl WorkflowError {
    pub const fn contract_code(&self) -> ContractError {
        match self {
            Self::Contract(error) => *error,
            Self::Protocol(_) | Self::InvalidResponse(_) | Self::InvalidImage(_) => {
                ContractError::ProtocolError
            }
            Self::Device(error) => match error.code {
                2 => ContractError::LimitExceeded,
                3 => ContractError::InvalidInput,
                4 => ContractError::Timeout,
                5 => ContractError::NotFound,
                7 => ContractError::LimitExceeded,
                10 => ContractError::Busy,
                11 => ContractError::PermissionDenied,
                _ => ContractError::IoError,
            },
        }
    }
}

impl fmt::Display for WorkflowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Contract(error) => formatter.write_str(error.as_str()),
            Self::Protocol(error) => write!(formatter, "{error}"),
            Self::Device(error) => {
                write!(
                    formatter,
                    "MCUmgr group {} returned rc {}",
                    error.group, error.code
                )
            }
            Self::InvalidResponse(message) => write!(formatter, "invalid response: {message}"),
            Self::InvalidImage(message) => write!(formatter, "invalid MCUboot image: {message}"),
        }
    }
}

impl From<ContractError> for WorkflowError {
    fn from(value: ContractError) -> Self {
        Self::Contract(value)
    }
}

impl From<bbcom_mcumgr_core::ProtocolError> for WorkflowError {
    fn from(value: bbcom_mcumgr_core::ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

impl From<bbcom_mcumgr_core::CborError> for WorkflowError {
    fn from(value: bbcom_mcumgr_core::CborError) -> Self {
        Self::Protocol(value.into())
    }
}

pub type WorkflowResult<T> = core::result::Result<T, WorkflowError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Response {
    pub cbor: Value,
    pub raw_cbor: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McubootImage {
    pub image_size: u32,
    pub header_size: u16,
    pub protected_tlv_size: u16,
    pub version_major: u8,
    pub version_minor: u8,
    pub version_revision: u16,
    pub version_build: u32,
    pub image_hash: Option<[u8; 32]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareDigest {
    pub file_sha256: [u8; 32],
    pub mcuboot: McubootImage,
}

pub fn transact<T, C>(
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
    command: &Command,
) -> WorkflowResult<Response>
where
    T: Read + Write,
    C: TaskContext,
{
    state.validate()?;
    let maximum_attempts = match command.metadata().retry {
        RetrySafety::Safe => usize::from(state.retries) + 1,
        RetrySafety::NeverAfterWrite => 1,
    };
    let mut attempt = 0_usize;
    loop {
        attempt += 1;
        match transact_once(transport, task, task_id, state, command) {
            Err(WorkflowError::Contract(ContractError::Timeout)) if attempt < maximum_attempts => {
                task.checkpoint(task_id)?;
            }
            result => return result,
        }
    }
}

fn transact_once<T, C>(
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
    command: &Command,
) -> WorkflowResult<Response>
where
    T: Read + Write,
    C: TaskContext,
{
    task.checkpoint(task_id)?;
    let version = if state.smp_v2 {
        Version::V2
    } else {
        Version::V1
    };
    let packet = command.to_packet(version, state.take_sequence())?;
    let encoded = packet.encode()?;
    if encoded.len() > state.frame_size as usize {
        return Err(WorkflowError::Contract(ContractError::LimitExceeded));
    }
    let pending = PendingRequest::from_packet(&packet)?;
    let wire = match state.transport {
        TransportMode::Console => ConsoleCodec::default().encode_bytes(&encoded)?,
        TransportMode::RawUart => encoded,
    };
    // No code below retries a failed physical write. Unknown outcomes remain
    // visible as `unknown-outcome` through the SDK adapter.
    transport.write_all(&wire)?;

    let mut parser = TransportParser::new(state.transport, state.frame_size as usize);
    let read_size = (state.frame_size as usize).clamp(64, IO_CHUNK_BYTES);
    let mut buffer = vec![0_u8; read_size];
    for _ in 0..MAX_RESPONSE_READS {
        task.checkpoint(task_id)?;
        let count = transport.read(&mut buffer, state.timeout_ms)?;
        if count == 0 {
            continue;
        }
        for response in parser.feed(&buffer[..count])? {
            // Delayed replies from a prior safe retry are ignored by sequence;
            // a same-sequence header mismatch is a protocol failure.
            if response.header.sequence != packet.header.sequence {
                continue;
            }
            let payload = pending.match_response(&response)?;
            let value = cbor::decode(payload)?;
            if let Some(error) = command_error_from_response(&value) {
                return Err(WorkflowError::Device(error));
            }
            return Ok(Response {
                cbor: value,
                raw_cbor: payload.to_vec(),
            });
        }
    }
    Err(WorkflowError::Contract(ContractError::Timeout))
}

enum TransportParser {
    Console(ConsoleParser),
    Raw(RawParser),
}

impl TransportParser {
    fn new(mode: TransportMode, maximum_packet: usize) -> Self {
        match mode {
            TransportMode::Console => Self::Console(ConsoleParser::new(127, maximum_packet.max(8))),
            TransportMode::RawUart => Self::Raw(RawParser::new(maximum_packet.saturating_sub(8))),
        }
    }

    fn feed(&mut self, input: &[u8]) -> WorkflowResult<Vec<bbcom_mcumgr_core::Packet>> {
        match self {
            Self::Console(parser) => Ok(parser.feed(input)?),
            Self::Raw(parser) => Ok(parser.feed(input)?),
        }
    }
}

pub fn inspect_and_hash_firmware<G, C>(
    grant: &mut G,
    task: &mut C,
    task_id: &str,
) -> WorkflowResult<FirmwareDigest>
where
    G: ReadGrant,
    C: TaskContext,
{
    let mcuboot = inspect_mcuboot(grant)?;
    let info = grant.info();
    let mut offset = 0_u64;
    let mut sha = Sha256::default();
    while offset < info.size {
        task.checkpoint(task_id)?;
        let request = (info.size - offset).min(IO_CHUNK_BYTES as u64) as u32;
        let chunk = grant.read_at(offset, request)?;
        validate_read_chunk(&chunk, request, info.size - offset)?;
        sha.update(&chunk);
        offset = offset
            .checked_add(chunk.len() as u64)
            .ok_or(WorkflowError::InvalidImage("file length overflow"))?;
        task.progress(Progress {
            task_id,
            completed: offset,
            total: Some(info.size),
            message: "Hashing firmware",
        })?;
    }
    Ok(FirmwareDigest {
        file_sha256: sha.finalize(),
        mcuboot,
    })
}

pub fn inspect_mcuboot<G: ReadGrant>(grant: &mut G) -> WorkflowResult<McubootImage> {
    let info = grant.info();
    if info.size < MCUBOOT_HEADER_BYTES as u64 {
        return Err(WorkflowError::InvalidImage("truncated header"));
    }
    let header = read_exact_at(grant, 0, MCUBOOT_HEADER_BYTES)?;
    if little_u32(&header[0..4]) != MCUBOOT_MAGIC {
        return Err(WorkflowError::InvalidImage("wrong magic"));
    }
    let header_size = little_u16(&header[8..10]);
    let protected_tlv_size = little_u16(&header[10..12]);
    let image_size = little_u32(&header[12..16]);
    if usize::from(header_size) < MCUBOOT_HEADER_BYTES {
        return Err(WorkflowError::InvalidImage("header size is too small"));
    }
    let image_end = u64::from(header_size)
        .checked_add(u64::from(image_size))
        .ok_or(WorkflowError::InvalidImage("image length overflow"))?;
    let regular_tlv = image_end
        .checked_add(u64::from(protected_tlv_size))
        .ok_or(WorkflowError::InvalidImage("TLV offset overflow"))?;
    if regular_tlv > info.size {
        return Err(WorkflowError::InvalidImage("declared image exceeds file"));
    }
    let image_hash = if regular_tlv == info.size {
        None
    } else {
        find_sha_tlv(grant, regular_tlv, info.size)?
    };
    Ok(McubootImage {
        image_size,
        header_size,
        protected_tlv_size,
        version_major: header[20],
        version_minor: header[21],
        version_revision: little_u16(&header[22..24]),
        version_build: little_u32(&header[24..28]),
        image_hash,
    })
}

fn find_sha_tlv<G: ReadGrant>(
    grant: &mut G,
    offset: u64,
    file_size: u64,
) -> WorkflowResult<Option<[u8; 32]>> {
    let info = read_exact_at(grant, offset, 4)?;
    let magic = little_u16(&info[0..2]);
    if !matches!(magic, TLV_INFO_MAGIC | TLV_PROTECTED_MAGIC) {
        return Err(WorkflowError::InvalidImage("invalid TLV info magic"));
    }
    let total = u64::from(little_u16(&info[2..4]));
    if total < 4 || offset.checked_add(total).is_none_or(|end| end > file_size) {
        return Err(WorkflowError::InvalidImage("invalid TLV total length"));
    }
    let end = offset + total;
    let mut cursor = offset + 4;
    while cursor < end {
        let entry = read_exact_at(grant, cursor, 4)?;
        let length = u64::from(little_u16(&entry[2..4]));
        cursor = cursor
            .checked_add(4)
            .ok_or(WorkflowError::InvalidImage("TLV offset overflow"))?;
        if cursor.checked_add(length).is_none_or(|value| value > end) {
            return Err(WorkflowError::InvalidImage("TLV entry exceeds area"));
        }
        if entry[0] == TLV_SHA256 {
            if length != 32 {
                return Err(WorkflowError::InvalidImage("SHA-256 TLV has wrong length"));
            }
            let hash = read_exact_at(grant, cursor, 32)?;
            return Ok(Some(hash.try_into().expect("32-byte SHA-256 TLV")));
        }
        cursor += length;
    }
    Ok(None)
}

pub fn upload_firmware<G, T, C>(
    grant: &mut G,
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
) -> WorkflowResult<FirmwareDigest>
where
    G: ReadGrant,
    T: Read + Write,
    C: TaskContext,
{
    let result = upload_firmware_inner(grant, transport, task, task_id, state);
    grant.close();
    result
}

fn upload_firmware_inner<G, T, C>(
    grant: &mut G,
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
) -> WorkflowResult<FirmwareDigest>
where
    G: ReadGrant,
    T: Read + Write,
    C: TaskContext,
{
    let digest = inspect_and_hash_firmware(grant, task, task_id)?;
    let size = grant.info().size;
    let mut offset = 0_u64;
    let mut redirects = 0_usize;
    while offset < size {
        task.checkpoint(task_id)?;
        let maximum_data = maximum_data_bytes(state.frame_size)?;
        let request = (size - offset).min(maximum_data as u64) as u32;
        let data = grant.read_at(offset, request)?;
        validate_read_chunk(&data, request, size - offset)?;
        let mut command = Command::Image(ImageCommand::Upload(ImageUploadChunk {
            image: state.image,
            offset,
            data,
            total_len: (offset == 0).then_some(size),
            sha: (offset == 0).then_some(digest.file_sha256.to_vec()),
            upgrade_only: false,
        }));
        fit_command_to_frame(&mut command, state.frame_size as usize)?;
        let sent = match &command {
            Command::Image(ImageCommand::Upload(chunk)) => chunk.data.len() as u64,
            _ => unreachable!(),
        };
        let response = transact(transport, task, task_id, state, &command)?;
        let next = unsigned(&response.cbor, "off").ok_or(WorkflowError::InvalidResponse(
            "image upload response has no off",
        ))?;
        if next > size {
            return Err(WorkflowError::InvalidResponse(
                "image upload offset exceeds file",
            ));
        }
        let expected = offset + sent;
        if next == offset || next != expected {
            redirects += 1;
            if redirects > MAX_OFFSET_REDIRECTS {
                return Err(WorkflowError::InvalidResponse(
                    "image upload offset did not advance",
                ));
            }
        } else {
            redirects = 0;
        }
        offset = next;
        task.progress(Progress {
            task_id,
            completed: offset,
            total: Some(size),
            message: "Uploading firmware",
        })?;
    }
    Ok(digest)
}

pub fn upload_file<G, T, C>(
    grant: &mut G,
    remote_path: &str,
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
) -> WorkflowResult<()>
where
    G: ReadGrant,
    T: Read + Write,
    C: TaskContext,
{
    let result = upload_file_inner(grant, remote_path, transport, task, task_id, state);
    grant.close();
    result
}

fn upload_file_inner<G, T, C>(
    grant: &mut G,
    remote_path: &str,
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
) -> WorkflowResult<()>
where
    G: ReadGrant,
    T: Read + Write,
    C: TaskContext,
{
    if remote_path.is_empty() || remote_path.len() > 1_024 {
        return Err(WorkflowError::Contract(ContractError::InvalidInput));
    }
    let size = grant.info().size;
    let mut offset = 0_u64;
    // An empty file still requires one protocol request.
    loop {
        task.checkpoint(task_id)?;
        let maximum_data = maximum_data_bytes(state.frame_size)?;
        let data = if offset == size {
            Vec::new()
        } else {
            let request = (size - offset).min(maximum_data as u64) as u32;
            let data = grant.read_at(offset, request)?;
            validate_read_chunk(&data, request, size - offset)?;
            data
        };
        let mut command = Command::Fs(FsCommand::Upload {
            name: remote_path.to_string(),
            offset,
            data,
            total_len: (offset == 0).then_some(size),
        });
        fit_command_to_frame(&mut command, state.frame_size as usize)?;
        let sent = match &command {
            Command::Fs(FsCommand::Upload { data, .. }) => data.len() as u64,
            _ => unreachable!(),
        };
        let response = transact(transport, task, task_id, state, &command)?;
        let next = unsigned(&response.cbor, "off").ok_or(WorkflowError::InvalidResponse(
            "file upload response has no off",
        ))?;
        if next != offset + sent || next > size {
            return Err(WorkflowError::InvalidResponse(
                "file upload returned wrong offset",
            ));
        }
        offset = next;
        task.progress(Progress {
            task_id,
            completed: offset,
            total: Some(size),
            message: "Uploading file",
        })?;
        if offset == size {
            return Ok(());
        }
    }
}

pub fn download_file<G, T, C>(
    grant: &mut G,
    remote_path: &str,
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
) -> WorkflowResult<u64>
where
    G: SaveGrant,
    T: Read + Write,
    C: TaskContext,
{
    let result = download_file_inner(grant, remote_path, transport, task, task_id, state);
    match result {
        Ok(size) => {
            grant.commit()?;
            Ok(size)
        }
        Err(error) => {
            grant.cancel();
            Err(error)
        }
    }
}

fn download_file_inner<G, T, C>(
    grant: &mut G,
    remote_path: &str,
    transport: &mut T,
    task: &mut C,
    task_id: &str,
    state: &mut ClientState,
) -> WorkflowResult<u64>
where
    G: SaveGrant,
    T: Read + Write,
    C: TaskContext,
{
    if remote_path.is_empty() || remote_path.len() > 1_024 {
        return Err(WorkflowError::Contract(ContractError::InvalidInput));
    }
    let mut offset = 0_u64;
    let mut total = None;
    loop {
        task.checkpoint(task_id)?;
        let response = transact(
            transport,
            task,
            task_id,
            state,
            &Command::Fs(FsCommand::Download {
                name: remote_path.to_string(),
                offset,
            }),
        )?;
        let data = bytes(&response.cbor, "data").ok_or(WorkflowError::InvalidResponse(
            "file download response has no data",
        ))?;
        let response_offset = unsigned(&response.cbor, "off").unwrap_or(offset);
        if response_offset != offset {
            return Err(WorkflowError::InvalidResponse(
                "file download returned wrong offset",
            ));
        }
        if let Some(length) = unsigned(&response.cbor, "len") {
            if total.replace(length).is_some_and(|known| known != length) {
                return Err(WorkflowError::InvalidResponse(
                    "file length changed during download",
                ));
            }
        }
        let accepted = grant.write(data)?;
        if accepted != data.len() as u64 {
            return Err(WorkflowError::Contract(ContractError::PartialWrite));
        }
        offset = offset
            .checked_add(data.len() as u64)
            .ok_or(WorkflowError::InvalidResponse(
                "file download offset overflow",
            ))?;
        let total = total.ok_or(WorkflowError::InvalidResponse("first response has no len"))?;
        if offset > total {
            return Err(WorkflowError::InvalidResponse(
                "download exceeds declared length",
            ));
        }
        task.progress(Progress {
            task_id,
            completed: offset,
            total: Some(total),
            message: "Downloading file",
        })?;
        if offset == total {
            return Ok(total);
        }
        if data.is_empty() {
            return Err(WorkflowError::InvalidResponse("download made no progress"));
        }
    }
}

fn maximum_data_bytes(frame_size: u32) -> WorkflowResult<usize> {
    let maximum = (frame_size as usize)
        .saturating_sub(160)
        .min(IO_CHUNK_BYTES);
    if maximum == 0 {
        Err(WorkflowError::Contract(ContractError::LimitExceeded))
    } else {
        Ok(maximum)
    }
}

fn fit_command_to_frame(command: &mut Command, maximum: usize) -> WorkflowResult<()> {
    loop {
        if command.to_packet(Version::V2, 0)?.encode()?.len() <= maximum {
            return Ok(());
        }
        let data = match command {
            Command::Image(ImageCommand::Upload(chunk)) => &mut chunk.data,
            Command::Fs(FsCommand::Upload { data, .. }) => data,
            _ => return Err(WorkflowError::Contract(ContractError::LimitExceeded)),
        };
        if data.len() <= 1 {
            return Err(WorkflowError::Contract(ContractError::LimitExceeded));
        }
        data.truncate(data.len() - data.len().div_ceil(8));
    }
}

fn validate_read_chunk(chunk: &[u8], requested: u32, remaining: u64) -> WorkflowResult<()> {
    if chunk.is_empty() || chunk.len() > requested as usize || chunk.len() as u64 > remaining {
        Err(WorkflowError::Contract(ContractError::IoError))
    } else {
        Ok(())
    }
}

fn read_exact_at<G: ReadGrant>(
    grant: &mut G,
    mut offset: u64,
    length: usize,
) -> WorkflowResult<Vec<u8>> {
    let mut output = Vec::with_capacity(length);
    while output.len() < length {
        let request = (length - output.len()).min(IO_CHUNK_BYTES) as u32;
        let chunk = grant.read_at(offset, request)?;
        validate_read_chunk(&chunk, request, u64::MAX)?;
        offset = offset
            .checked_add(chunk.len() as u64)
            .ok_or(WorkflowError::InvalidImage("file offset overflow"))?;
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn little_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().expect("two-byte little-endian value"))
}

fn little_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte little-endian value"))
}

pub fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Map(entries) = value else {
        return None;
    };
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

pub fn unsigned(value: &Value, name: &str) -> Option<u64> {
    match field(value, name) {
        Some(Value::Unsigned(value)) => Some(*value),
        _ => None,
    }
}

pub fn bytes<'a>(value: &'a Value, name: &str) -> Option<&'a [u8]> {
    match field(value, name) {
        Some(Value::Bytes(value)) => Some(value),
        _ => None,
    }
}

pub fn firmware_summary(digest: &FirmwareDigest) -> String {
    format!(
        "MCUboot {}.{}.{}+{}; image {} bytes; header {} bytes; protected TLV {} bytes",
        digest.mcuboot.version_major,
        digest.mcuboot.version_minor,
        digest.mcuboot.version_revision,
        digest.mcuboot.version_build,
        digest.mcuboot.image_size,
        digest.mcuboot.header_size,
        digest.mcuboot.protected_tlv_size
    )
}

#[cfg(test)]
mod tests {
    use alloc::collections::VecDeque;

    use bbcom_mcumgr_core::command::{OsCommand, RawCommand, StatsCommand};
    use bbcom_mcumgr_core::{Op, Packet};
    use bbcom_plugin_sdk::file::{ReadGrantInfo, SaveGrantInfo};
    use bbcom_plugin_sdk::serial::{ReadResult, SerialLease, WriteOutcome, WriteResult};
    use bbcom_plugin_sdk::Result as ContractResult;

    use super::*;

    #[derive(Default)]
    struct FakeTask {
        progress: Vec<(u64, Option<u64>)>,
        heartbeats: usize,
        cancelled: bool,
    }

    impl TaskContext for FakeTask {
        fn is_cancelled(&self) -> bool {
            self.cancelled
        }

        fn progress(&mut self, value: Progress<'_>) -> ContractResult<()> {
            self.progress.push((value.completed, value.total));
            Ok(())
        }

        fn heartbeat(&mut self, _task_id: &str) -> ContractResult<()> {
            self.heartbeats += 1;
            Ok(())
        }
    }

    struct FakeIo {
        mode: TransportMode,
        rx: VecDeque<u8>,
        writes: usize,
        file: Vec<u8>,
        upload: Vec<u8>,
        max_write: usize,
        record_upload: bool,
    }

    impl FakeIo {
        fn new(mode: TransportMode) -> Self {
            Self {
                mode,
                rx: VecDeque::new(),
                writes: 0,
                file: (0_u16..777).map(|value| value as u8).collect(),
                upload: Vec::new(),
                max_write: 0,
                record_upload: true,
            }
        }

        fn receive_request(&self, bytes: &[u8]) -> Packet {
            match self.mode {
                TransportMode::RawUart => Packet::decode(bytes).unwrap(),
                TransportMode::Console => {
                    let mut parser = ConsoleParser::default();
                    parser.feed(bytes).unwrap().pop().unwrap()
                }
            }
        }

        fn queue_response(&mut self, request: &Packet, payload: Value) {
            let packet = Packet::from_parts(
                bbcom_mcumgr_core::Header::new(
                    request.header.version,
                    request.header.op.response().unwrap(),
                    0,
                    payload.encoded().len(),
                    request.header.group,
                    request.header.sequence,
                    request.header.command,
                )
                .unwrap(),
                payload.encoded(),
            )
            .unwrap();
            let wire = match self.mode {
                TransportMode::RawUart => packet.encode().unwrap(),
                TransportMode::Console => ConsoleCodec::default().encode_packet(&packet).unwrap(),
            };
            self.rx.extend(wire);
        }
    }

    impl Read for FakeIo {
        fn read(&mut self, output: &mut [u8], _timeout_ms: u32) -> ContractResult<usize> {
            let count = output.len().min(self.rx.len()).min(17);
            for slot in &mut output[..count] {
                *slot = self.rx.pop_front().unwrap();
            }
            if count == 0 {
                Err(ContractError::Timeout)
            } else {
                Ok(count)
            }
        }
    }

    impl Write for FakeIo {
        fn write(&mut self, input: &[u8]) -> ContractResult<usize> {
            self.writes += 1;
            self.max_write = self.max_write.max(input.len());
            let request = self.receive_request(input);
            let body = cbor::decode(&request.payload).unwrap();
            let response = match (request.header.group, request.header.command) {
                (1, 1) => {
                    let off = unsigned(&body, "off").unwrap();
                    let data = bytes(&body, "data").unwrap();
                    if self.record_upload {
                        if self.upload.len() < off as usize {
                            self.upload.resize(off as usize, 0);
                        }
                        self.upload.extend_from_slice(data);
                    }
                    Value::Map(vec![(
                        "off".to_string(),
                        Value::Unsigned(off + data.len() as u64),
                    )])
                }
                (8, 0) if request.header.op == Op::Write => {
                    let off = unsigned(&body, "off").unwrap();
                    let data = bytes(&body, "data").unwrap();
                    if self.record_upload {
                        if self.upload.len() < off as usize {
                            self.upload.resize(off as usize, 0);
                        }
                        self.upload.extend_from_slice(data);
                    }
                    Value::Map(vec![(
                        "off".to_string(),
                        Value::Unsigned(off + data.len() as u64),
                    )])
                }
                (8, 0) => {
                    let off = unsigned(&body, "off").unwrap() as usize;
                    let end = self.file.len().min(off + 113);
                    Value::Map(vec![
                        ("off".to_string(), Value::Unsigned(off as u64)),
                        ("len".to_string(), Value::Unsigned(self.file.len() as u64)),
                        (
                            "data".to_string(),
                            Value::Bytes(self.file[off..end].to_vec()),
                        ),
                    ])
                }
                _ => Value::Map(vec![("r".to_string(), Value::Text("ok".to_string()))]),
            };
            self.queue_response(&request, response);
            Ok(input.len())
        }
    }

    struct MemoryReadGrant {
        data: Vec<u8>,
        max_request: u32,
        closed: bool,
    }

    #[derive(Default)]
    struct TimeoutIo {
        writes: usize,
    }

    impl Read for TimeoutIo {
        fn read(&mut self, _output: &mut [u8], _timeout_ms: u32) -> ContractResult<usize> {
            Err(ContractError::Timeout)
        }
    }

    impl Write for TimeoutIo {
        fn write(&mut self, input: &[u8]) -> ContractResult<usize> {
            self.writes += 1;
            Ok(input.len())
        }
    }

    impl ReadGrant for MemoryReadGrant {
        fn info(&self) -> ReadGrantInfo {
            ReadGrantInfo {
                display_name: "image.bin".to_string(),
                size: self.data.len() as u64,
            }
        }

        fn read_at(&mut self, offset: u64, maximum: u32) -> ContractResult<Vec<u8>> {
            self.max_request = self.max_request.max(maximum);
            let start = offset as usize;
            let end = self.data.len().min(start.saturating_add(maximum as usize));
            Ok(self.data.get(start..end).unwrap_or_default().to_vec())
        }

        fn close(&mut self) {
            self.closed = true;
        }
    }

    struct SparseImageGrant {
        payload_size: u32,
        max_request: u32,
        closed: bool,
    }

    impl SparseImageGrant {
        fn file_size(&self) -> u64 {
            MCUBOOT_HEADER_BYTES as u64 + u64::from(self.payload_size) + 40
        }

        fn byte_at(&self, offset: u64) -> u8 {
            let tlv_offset = MCUBOOT_HEADER_BYTES as u64 + u64::from(self.payload_size);
            if offset < MCUBOOT_HEADER_BYTES as u64 {
                let mut header = [0_u8; MCUBOOT_HEADER_BYTES];
                header[0..4].copy_from_slice(&MCUBOOT_MAGIC.to_le_bytes());
                header[8..10].copy_from_slice(&(MCUBOOT_HEADER_BYTES as u16).to_le_bytes());
                header[12..16].copy_from_slice(&self.payload_size.to_le_bytes());
                header[20] = 9;
                header[21] = 1;
                return header[offset as usize];
            }
            if offset >= tlv_offset {
                let index = (offset - tlv_offset) as usize;
                let mut tlv = [0_u8; 40];
                tlv[0..2].copy_from_slice(&TLV_INFO_MAGIC.to_le_bytes());
                tlv[2..4].copy_from_slice(&40_u16.to_le_bytes());
                tlv[4] = TLV_SHA256;
                tlv[6..8].copy_from_slice(&32_u16.to_le_bytes());
                for (index, byte) in tlv[8..].iter_mut().enumerate() {
                    *byte = index as u8;
                }
                return tlv[index];
            }
            (offset as u8).wrapping_mul(31)
        }
    }

    impl ReadGrant for SparseImageGrant {
        fn info(&self) -> ReadGrantInfo {
            ReadGrantInfo {
                display_name: "large-image.bin".to_string(),
                size: self.file_size(),
            }
        }

        fn read_at(&mut self, offset: u64, maximum: u32) -> ContractResult<Vec<u8>> {
            self.max_request = self.max_request.max(maximum);
            let end = self
                .file_size()
                .min(offset.saturating_add(u64::from(maximum)));
            Ok((offset..end)
                .map(|position| self.byte_at(position))
                .collect())
        }

        fn close(&mut self) {
            self.closed = true;
        }
    }

    #[derive(Default)]
    struct MemorySaveGrant {
        data: Vec<u8>,
        committed: bool,
        cancelled: bool,
    }

    impl SaveGrant for MemorySaveGrant {
        fn info(&self) -> SaveGrantInfo {
            SaveGrantInfo {
                display_name: "saved.bin".to_string(),
            }
        }

        fn write(&mut self, payload: &[u8]) -> ContractResult<u64> {
            self.data.extend_from_slice(payload);
            Ok(payload.len() as u64)
        }

        fn commit(&mut self) -> ContractResult<()> {
            self.committed = true;
            Ok(())
        }

        fn cancel(&mut self) {
            self.cancelled = true;
            self.data.clear();
        }
    }

    #[derive(Default)]
    struct PartialSaveGrant {
        cancelled: bool,
        committed: bool,
    }

    impl SaveGrant for PartialSaveGrant {
        fn info(&self) -> SaveGrantInfo {
            SaveGrantInfo {
                display_name: "partial.bin".to_string(),
            }
        }

        fn write(&mut self, payload: &[u8]) -> ContractResult<u64> {
            Ok(payload.len().saturating_sub(1) as u64)
        }

        fn commit(&mut self) -> ContractResult<()> {
            self.committed = true;
            Ok(())
        }

        fn cancel(&mut self) {
            self.cancelled = true;
        }
    }

    fn state(mode: TransportMode) -> ClientState {
        ClientState {
            transport: mode,
            frame_size: 512,
            retries: 0,
            ..ClientState::default()
        }
    }

    fn mcuboot_image(payload: usize) -> Vec<u8> {
        let header_size = MCUBOOT_HEADER_BYTES as u16;
        let mut bytes = vec![0_u8; MCUBOOT_HEADER_BYTES + payload + 4 + 4 + 32];
        bytes[0..4].copy_from_slice(&MCUBOOT_MAGIC.to_le_bytes());
        bytes[8..10].copy_from_slice(&header_size.to_le_bytes());
        bytes[12..16].copy_from_slice(&(payload as u32).to_le_bytes());
        bytes[20] = 1;
        bytes[21] = 2;
        bytes[22..24].copy_from_slice(&3_u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&4_u32.to_le_bytes());
        let tlv = MCUBOOT_HEADER_BYTES + payload;
        bytes[tlv..tlv + 2].copy_from_slice(&TLV_INFO_MAGIC.to_le_bytes());
        bytes[tlv + 2..tlv + 4].copy_from_slice(&40_u16.to_le_bytes());
        bytes[tlv + 4] = TLV_SHA256;
        bytes[tlv + 6..tlv + 8].copy_from_slice(&32_u16.to_le_bytes());
        for (index, byte) in bytes[tlv + 8..tlv + 40].iter_mut().enumerate() {
            *byte = index as u8;
        }
        bytes
    }

    #[test]
    fn transactions_work_over_console_and_raw_with_fragmented_rx() {
        for mode in [TransportMode::Console, TransportMode::RawUart] {
            let mut io = FakeIo::new(mode);
            let mut task = FakeTask::default();
            let mut state = state(mode);
            let response = transact(
                &mut io,
                &mut task,
                "echo",
                &mut state,
                &Command::Os(OsCommand::Echo {
                    message: "hello".to_string(),
                }),
            )
            .unwrap();
            assert_eq!(
                field(&response.cbor, "r"),
                Some(&Value::Text("ok".to_string()))
            );
            assert_eq!(state.next_sequence, 1);
            assert!(task.heartbeats > 1);
        }
    }

    #[test]
    fn arbitrary_raw_request_uses_exact_cbor() {
        let mut io = FakeIo::new(TransportMode::RawUart);
        let mut task = FakeTask::default();
        let mut state = state(TransportMode::RawUart);
        let payload = Value::Map(vec![("x".to_string(), Value::Unsigned(7))]).encoded();
        transact(
            &mut io,
            &mut task,
            "raw",
            &mut state,
            &Command::Raw(RawCommand::read(77, 9, payload)),
        )
        .unwrap();
        assert_eq!(io.writes, 1);
    }

    #[test]
    fn only_read_only_commands_retry_and_cancellation_precedes_physical_write() {
        let mut state = state(TransportMode::RawUart);
        state.retries = 2;
        let mut task = FakeTask::default();
        let mut read_io = TimeoutIo::default();
        assert_eq!(
            transact(
                &mut read_io,
                &mut task,
                "read",
                &mut state,
                &Command::Stats(StatsCommand::List),
            ),
            Err(WorkflowError::Contract(ContractError::Timeout))
        );
        assert_eq!(read_io.writes, 3);

        let mut write_io = TimeoutIo::default();
        assert_eq!(
            transact(
                &mut write_io,
                &mut task,
                "write",
                &mut state,
                &Command::Os(OsCommand::Echo {
                    message: "side effect".to_string(),
                }),
            ),
            Err(WorkflowError::Contract(ContractError::Timeout))
        );
        assert_eq!(write_io.writes, 1);

        let mut cancelled = FakeTask {
            cancelled: true,
            ..FakeTask::default()
        };
        let mut never_written = TimeoutIo::default();
        assert_eq!(
            transact(
                &mut never_written,
                &mut cancelled,
                "cancelled",
                &mut state,
                &Command::Stats(StatsCommand::List),
            ),
            Err(WorkflowError::Contract(ContractError::Cancelled))
        );
        assert_eq!(never_written.writes, 0);
    }

    #[test]
    fn firmware_is_hashed_and_uploaded_without_whole_file_reads() {
        let image = mcuboot_image(24_000);
        let mut grant = MemoryReadGrant {
            data: image.clone(),
            max_request: 0,
            closed: false,
        };
        let mut io = FakeIo::new(TransportMode::RawUart);
        let mut task = FakeTask::default();
        let mut state = state(TransportMode::RawUart);
        let digest =
            upload_firmware(&mut grant, &mut io, &mut task, "firmware", &mut state).unwrap();
        assert_eq!(digest.mcuboot.version_revision, 3);
        assert_eq!(io.upload, image);
        assert!(grant.closed);
        assert!(grant.max_request <= IO_CHUNK_BYTES as u32);
        assert!(io.max_write <= state.frame_size as usize);
        assert_eq!(
            task.progress.last(),
            Some(&(grant.data.len() as u64, Some(grant.data.len() as u64)))
        );
    }

    #[test]
    fn firmware_larger_than_wasm_memory_limit_stays_chunk_bounded() {
        let mut grant = SparseImageGrant {
            payload_size: 65 * 1024 * 1024,
            max_request: 0,
            closed: false,
        };
        let expected_size = grant.file_size();
        let mut io = FakeIo::new(TransportMode::RawUart);
        io.record_upload = false;
        let mut task = FakeTask::default();
        let mut state = state(TransportMode::RawUart);
        state.frame_size = 65_535;
        upload_firmware(&mut grant, &mut io, &mut task, "large-firmware", &mut state).unwrap();
        assert!(grant.closed);
        assert!(grant.max_request <= IO_CHUNK_BYTES as u32);
        assert!(io.upload.is_empty());
        assert!(io.max_write <= state.frame_size as usize);
        assert_eq!(
            task.progress.last(),
            Some(&(expected_size, Some(expected_size)))
        );
    }

    #[test]
    fn file_upload_and_atomic_download_stream_in_protocol_chunks() {
        let source: Vec<u8> = (0_u16..2_000).map(|value| value as u8).collect();
        let mut read = MemoryReadGrant {
            data: source.clone(),
            max_request: 0,
            closed: false,
        };
        let mut upload_io = FakeIo::new(TransportMode::Console);
        let mut task = FakeTask::default();
        let mut upload_state = state(TransportMode::Console);
        upload_file(
            &mut read,
            "/lfs1/a.bin",
            &mut upload_io,
            &mut task,
            "upload",
            &mut upload_state,
        )
        .unwrap();
        assert_eq!(upload_io.upload, source);
        assert!(read.closed);

        let mut save = MemorySaveGrant::default();
        let mut download_io = FakeIo::new(TransportMode::RawUart);
        let expected = download_io.file.clone();
        let mut download_state = state(TransportMode::RawUart);
        let length = download_file(
            &mut save,
            "/lfs1/a.bin",
            &mut download_io,
            &mut task,
            "download",
            &mut download_state,
        )
        .unwrap();
        assert_eq!(length, expected.len() as u64);
        assert_eq!(save.data, expected);
        assert!(save.committed);
        assert!(!save.cancelled);
    }

    #[test]
    fn invalid_mcuboot_image_fails_before_any_serial_write() {
        let mut grant = MemoryReadGrant {
            data: vec![0; 128],
            max_request: 0,
            closed: false,
        };
        let mut io = FakeIo::new(TransportMode::RawUart);
        let mut task = FakeTask::default();
        let mut state = state(TransportMode::RawUart);
        assert!(matches!(
            upload_firmware(&mut grant, &mut io, &mut task, "bad", &mut state),
            Err(WorkflowError::InvalidImage("wrong magic"))
        ));
        assert_eq!(io.writes, 0);
        assert!(grant.closed);
    }

    #[test]
    fn partial_host_save_is_cancelled_and_never_committed() {
        let mut grant = PartialSaveGrant::default();
        let mut io = FakeIo::new(TransportMode::RawUart);
        let mut task = FakeTask::default();
        let mut state = state(TransportMode::RawUart);
        assert_eq!(
            download_file(
                &mut grant,
                "/lfs1/file.bin",
                &mut io,
                &mut task,
                "partial",
                &mut state,
            ),
            Err(WorkflowError::Contract(ContractError::PartialWrite))
        );
        assert!(grant.cancelled);
        assert!(!grant.committed);
    }

    #[allow(dead_code)]
    fn _sdk_lease_trait_is_the_only_serial_authority<T: SerialLease>(lease: &mut T) {
        let _ = lease.read(1, 1);
        let _ = ReadResult {
            payload: Vec::new(),
            timed_out: true,
            disconnected: false,
        };
        let _ = WriteResult {
            requested: 0,
            sent: 0,
            outcome: WriteOutcome::Completed,
        };
    }
}
