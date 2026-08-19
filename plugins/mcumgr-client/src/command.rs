//! Typed Zephyr MCUmgr command catalogue and request encoding.

use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use crate::cbor::Value;
use crate::error::ProtocolError;
use crate::smp::{Op, Packet, Version};

pub mod group {
    pub const OS: u16 = 0;
    pub const IMAGE: u16 = 1;
    pub const STATS: u16 = 2;
    pub const SETTINGS: u16 = 3;
    pub const FS: u16 = 8;
    pub const SHELL: u16 = 9;
    pub const ENUM: u16 = 10;
    pub const ZEPHYR_BASIC: u16 = 63;
    pub const USER_START: u16 = 64;
}

/// User-facing safety classification. The v2 host must render confirmation
/// for `Destructive` and `Reset` command buttons.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Risk {
    ReadOnly,
    Mutation,
    Destructive,
    Reset,
}

impl Risk {
    pub const fn requires_confirmation(self) -> bool {
        matches!(self, Self::Destructive | Self::Reset)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetrySafety {
    /// A read can be repeated after a transport failure.
    Safe,
    /// Once a physical write may have begun, the outcome is unknown and the
    /// command must not be retried automatically.
    NeverAfterWrite,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandMeta {
    pub name: &'static str,
    pub op: Op,
    pub group: u16,
    pub command: u8,
    pub risk: Risk,
    pub retry: RetrySafety,
}

impl CommandMeta {
    const fn read(name: &'static str, group: u16, command: u8) -> Self {
        Self {
            name,
            op: Op::Read,
            group,
            command,
            risk: Risk::ReadOnly,
            retry: RetrySafety::Safe,
        }
    }

    const fn write(name: &'static str, group: u16, command: u8, risk: Risk) -> Self {
        Self {
            name,
            op: Op::Write,
            group,
            command,
            risk,
            retry: RetrySafety::NeverAfterWrite,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OsCommand {
    Echo { message: String },
    ConsoleEchoControl { enabled: bool },
    TaskStatistics,
    MemoryPoolStatistics,
    DateTimeGet,
    DateTimeSet { value: String },
    Reset { force: bool, boot_mode: Option<u8> },
    McumgrParameters,
    ApplicationInfo { format: Option<String> },
    BootloaderInfo { query: Option<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImageCommand {
    State,
    SetState {
        hash: Option<Vec<u8>>,
        confirm: bool,
    },
    Upload(ImageUploadChunk),
    /// Legacy image file operation retained for devices that expose command 2.
    File {
        op: Op,
        fields: Value,
    },
    CoreList,
    CoreLoad {
        fields: Value,
    },
    Erase {
        slot: Option<u32>,
    },
    SlotInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageUploadChunk {
    pub image: u32,
    pub offset: u64,
    pub data: Vec<u8>,
    /// Required on the first chunk (`offset == 0`).
    pub total_len: Option<u64>,
    /// MCUboot image identity hash, required on the first chunk for robust
    /// resumption. This is not necessarily the SHA-256 of the whole file.
    pub sha: Option<Vec<u8>>,
    pub upgrade_only: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StatsCommand {
    Show { name: String },
    List,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettingsCommand {
    Read { name: String, max_size: Option<u64> },
    Write { name: String, value: Vec<u8> },
    Delete { name: String },
    Commit,
    Load,
    Save { name: Option<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FsCommand {
    Download {
        name: String,
        offset: u64,
    },
    Upload {
        name: String,
        offset: u64,
        data: Vec<u8>,
        total_len: Option<u64>,
    },
    Status {
        name: String,
    },
    Checksum {
        name: String,
        algorithm: Option<String>,
        offset: Option<u64>,
        length: Option<u64>,
    },
    SupportedChecksums,
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellCommand {
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnumCommand {
    Count,
    List,
    Single { index: u16 },
    Details { groups: Option<Vec<u16>> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ZephyrCommand {
    EraseStorage,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawCommand {
    pub op: Op,
    pub group: u16,
    pub command: u8,
    /// Already encoded CBOR payload. It is intentionally opaque so custom
    /// groups can use any valid CBOR shape.
    pub payload: Vec<u8>,
}

impl RawCommand {
    pub fn read(group: u16, command: u8, payload: Vec<u8>) -> Self {
        Self {
            op: Op::Read,
            group,
            command,
            payload,
        }
    }

    pub fn write(group: u16, command: u8, payload: Vec<u8>) -> Self {
        Self {
            op: Op::Write,
            group,
            command,
            payload,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Os(OsCommand),
    Image(ImageCommand),
    Stats(StatsCommand),
    Settings(SettingsCommand),
    Fs(FsCommand),
    Shell(ShellCommand),
    Enum(EnumCommand),
    Zephyr(ZephyrCommand),
    Raw(RawCommand),
}

impl Command {
    pub fn metadata(&self) -> CommandMeta {
        match self {
            Self::Os(command) => os_meta(command),
            Self::Image(command) => image_meta(command),
            Self::Stats(command) => match command {
                StatsCommand::Show { .. } => CommandMeta::read("stats.show", group::STATS, 0),
                StatsCommand::List => CommandMeta::read("stats.list", group::STATS, 1),
            },
            Self::Settings(command) => settings_meta(command),
            Self::Fs(command) => fs_meta(command),
            Self::Shell(_) => CommandMeta::write("shell.execute", group::SHELL, 0, Risk::Mutation),
            Self::Enum(command) => match command {
                EnumCommand::Count => CommandMeta::read("enum.count", group::ENUM, 0),
                EnumCommand::List => CommandMeta::read("enum.list", group::ENUM, 1),
                EnumCommand::Single { .. } => CommandMeta::read("enum.single", group::ENUM, 2),
                EnumCommand::Details { .. } => CommandMeta::read("enum.details", group::ENUM, 3),
            },
            Self::Zephyr(ZephyrCommand::EraseStorage) => CommandMeta::write(
                "zephyr.erase-storage",
                group::ZEPHYR_BASIC,
                0,
                Risk::Destructive,
            ),
            Self::Raw(raw) => CommandMeta {
                name: "raw",
                op: raw.op,
                group: raw.group,
                command: raw.command,
                risk: if raw.op == Op::Read {
                    Risk::ReadOnly
                } else {
                    Risk::Mutation
                },
                retry: if raw.op == Op::Read {
                    RetrySafety::Safe
                } else {
                    RetrySafety::NeverAfterWrite
                },
            },
        }
    }

    pub fn payload_bytes(&self) -> Vec<u8> {
        if let Self::Raw(raw) = self {
            return raw.payload.clone();
        }
        self.payload_value().encoded()
    }

    pub fn to_packet(&self, version: Version, sequence: u8) -> Result<Packet, ProtocolError> {
        let metadata = self.metadata();
        Packet::request(
            version,
            metadata.op,
            metadata.group,
            sequence,
            metadata.command,
            self.payload_bytes(),
        )
    }

    fn payload_value(&self) -> Value {
        match self {
            Self::Os(command) => os_payload(command),
            Self::Image(command) => image_payload(command),
            Self::Stats(StatsCommand::Show { name }) => map(vec![("name", text(name))]),
            Self::Stats(StatsCommand::List) => empty_map(),
            Self::Settings(command) => settings_payload(command),
            Self::Fs(command) => fs_payload(command),
            Self::Shell(command) => map(vec![(
                "argv",
                Value::Array(command.argv.iter().cloned().map(Value::Text).collect()),
            )]),
            Self::Enum(command) => enum_payload(command),
            Self::Zephyr(ZephyrCommand::EraseStorage) => empty_map(),
            Self::Raw(_) => unreachable!("raw payloads bypass typed CBOR encoding"),
        }
    }
}

fn os_meta(command: &OsCommand) -> CommandMeta {
    match command {
        OsCommand::Echo { .. } => CommandMeta::write("os.echo", group::OS, 0, Risk::Mutation),
        OsCommand::ConsoleEchoControl { .. } => {
            CommandMeta::write("os.console-echo", group::OS, 1, Risk::Mutation)
        }
        OsCommand::TaskStatistics => CommandMeta::read("os.task-statistics", group::OS, 2),
        OsCommand::MemoryPoolStatistics => {
            CommandMeta::read("os.memory-pool-statistics", group::OS, 3)
        }
        OsCommand::DateTimeGet => CommandMeta::read("os.datetime-get", group::OS, 4),
        OsCommand::DateTimeSet { .. } => {
            CommandMeta::write("os.datetime-set", group::OS, 4, Risk::Mutation)
        }
        OsCommand::Reset { .. } => CommandMeta::write("os.reset", group::OS, 5, Risk::Reset),
        OsCommand::McumgrParameters => CommandMeta::read("os.mcumgr-parameters", group::OS, 6),
        OsCommand::ApplicationInfo { .. } => CommandMeta::read("os.application-info", group::OS, 7),
        OsCommand::BootloaderInfo { .. } => CommandMeta::read("os.bootloader-info", group::OS, 8),
    }
}

fn os_payload(command: &OsCommand) -> Value {
    match command {
        OsCommand::Echo { message } => map(vec![("d", text(message))]),
        OsCommand::ConsoleEchoControl { enabled } => map(vec![("echo", Value::Bool(*enabled))]),
        OsCommand::TaskStatistics
        | OsCommand::MemoryPoolStatistics
        | OsCommand::DateTimeGet
        | OsCommand::McumgrParameters => empty_map(),
        OsCommand::DateTimeSet { value } => map(vec![("datetime", text(value))]),
        OsCommand::Reset { force, boot_mode } => {
            let mut entries = Vec::new();
            if *force {
                entries.push(("force", Value::Bool(true)));
            }
            if let Some(boot_mode) = boot_mode {
                entries.push(("boot_mode", Value::Unsigned(u64::from(*boot_mode))));
            }
            map(entries)
        }
        OsCommand::ApplicationInfo { format } => optional_text("format", format),
        OsCommand::BootloaderInfo { query } => optional_text("query", query),
    }
}

fn image_meta(command: &ImageCommand) -> CommandMeta {
    match command {
        ImageCommand::State => CommandMeta::read("image.state", group::IMAGE, 0),
        ImageCommand::SetState { .. } => {
            CommandMeta::write("image.set-state", group::IMAGE, 0, Risk::Destructive)
        }
        ImageCommand::Upload(_) => {
            CommandMeta::write("image.upload", group::IMAGE, 1, Risk::Mutation)
        }
        ImageCommand::File { op, .. } => CommandMeta {
            name: "image.file",
            op: *op,
            group: group::IMAGE,
            command: 2,
            risk: if *op == Op::Read {
                Risk::ReadOnly
            } else {
                Risk::Mutation
            },
            retry: if *op == Op::Read {
                RetrySafety::Safe
            } else {
                RetrySafety::NeverAfterWrite
            },
        },
        ImageCommand::CoreList => CommandMeta::read("image.core-list", group::IMAGE, 3),
        ImageCommand::CoreLoad { .. } => {
            CommandMeta::write("image.core-load", group::IMAGE, 4, Risk::Mutation)
        }
        ImageCommand::Erase { .. } => {
            CommandMeta::write("image.erase", group::IMAGE, 5, Risk::Destructive)
        }
        ImageCommand::SlotInfo => CommandMeta::read("image.slot-info", group::IMAGE, 6),
    }
}

fn image_payload(command: &ImageCommand) -> Value {
    match command {
        ImageCommand::State | ImageCommand::CoreList | ImageCommand::SlotInfo => empty_map(),
        ImageCommand::SetState { hash, confirm } => {
            let mut entries = Vec::new();
            if let Some(hash) = hash {
                entries.push(("hash", Value::Bytes(hash.clone())));
            }
            entries.push(("confirm", Value::Bool(*confirm)));
            map(entries)
        }
        ImageCommand::Upload(chunk) => {
            let mut entries = Vec::new();
            if chunk.image != 0 {
                entries.push(("image", Value::Unsigned(u64::from(chunk.image))));
            }
            entries.push(("data", Value::Bytes(chunk.data.clone())));
            if let Some(length) = chunk.total_len {
                entries.push(("len", Value::Unsigned(length)));
            }
            entries.push(("off", Value::Unsigned(chunk.offset)));
            if let Some(sha) = &chunk.sha {
                entries.push(("sha", Value::Bytes(sha.clone())));
            }
            if chunk.upgrade_only {
                entries.push(("upgrade", Value::Bool(true)));
            }
            map(entries)
        }
        ImageCommand::File { fields, .. } | ImageCommand::CoreLoad { fields } => fields.clone(),
        ImageCommand::Erase { slot: None } => empty_map(),
        ImageCommand::Erase { slot: Some(slot) } => {
            map(vec![("slot", Value::Unsigned(u64::from(*slot)))])
        }
    }
}

fn settings_meta(command: &SettingsCommand) -> CommandMeta {
    match command {
        SettingsCommand::Read { .. } => CommandMeta::read("settings.read", group::SETTINGS, 0),
        SettingsCommand::Write { .. } => {
            CommandMeta::write("settings.write", group::SETTINGS, 0, Risk::Mutation)
        }
        SettingsCommand::Delete { .. } => {
            CommandMeta::write("settings.delete", group::SETTINGS, 1, Risk::Mutation)
        }
        SettingsCommand::Commit => {
            CommandMeta::write("settings.commit", group::SETTINGS, 2, Risk::Mutation)
        }
        SettingsCommand::Load => CommandMeta::read("settings.load", group::SETTINGS, 3),
        SettingsCommand::Save { .. } => {
            CommandMeta::write("settings.save", group::SETTINGS, 3, Risk::Mutation)
        }
    }
}

fn settings_payload(command: &SettingsCommand) -> Value {
    match command {
        SettingsCommand::Read { name, max_size } => {
            let mut entries = vec![("name", text(name))];
            if let Some(max_size) = max_size {
                entries.push(("max_size", Value::Unsigned(*max_size)));
            }
            map(entries)
        }
        SettingsCommand::Write { name, value } => map(vec![
            ("name", text(name)),
            ("val", Value::Bytes(value.clone())),
        ]),
        SettingsCommand::Delete { name } => map(vec![("name", text(name))]),
        SettingsCommand::Commit | SettingsCommand::Load => empty_map(),
        SettingsCommand::Save { name } => optional_text("name", name),
    }
}

fn fs_meta(command: &FsCommand) -> CommandMeta {
    match command {
        FsCommand::Download { .. } => CommandMeta::read("fs.download", group::FS, 0),
        FsCommand::Upload { .. } => CommandMeta::write("fs.upload", group::FS, 0, Risk::Mutation),
        FsCommand::Status { .. } => CommandMeta::read("fs.status", group::FS, 1),
        FsCommand::Checksum { .. } => CommandMeta::read("fs.checksum", group::FS, 2),
        FsCommand::SupportedChecksums => CommandMeta::read("fs.supported-checksums", group::FS, 3),
        FsCommand::Close => CommandMeta::write("fs.close", group::FS, 4, Risk::Mutation),
    }
}

fn fs_payload(command: &FsCommand) -> Value {
    match command {
        FsCommand::Download { name, offset } => map(vec![
            ("name", text(name)),
            ("off", Value::Unsigned(*offset)),
        ]),
        FsCommand::Upload {
            name,
            offset,
            data,
            total_len,
        } => {
            let mut entries = vec![
                ("name", text(name)),
                ("off", Value::Unsigned(*offset)),
                ("data", Value::Bytes(data.clone())),
            ];
            if let Some(length) = total_len {
                entries.push(("len", Value::Unsigned(*length)));
            }
            map(entries)
        }
        FsCommand::Status { name } => map(vec![("name", text(name))]),
        FsCommand::Checksum {
            name,
            algorithm,
            offset,
            length,
        } => {
            let mut entries = vec![("name", text(name))];
            if let Some(algorithm) = algorithm {
                entries.push(("type", text(algorithm)));
            }
            if let Some(offset) = offset {
                entries.push(("off", Value::Unsigned(*offset)));
            }
            if let Some(length) = length {
                entries.push(("len", Value::Unsigned(*length)));
            }
            map(entries)
        }
        FsCommand::SupportedChecksums | FsCommand::Close => empty_map(),
    }
}

fn enum_payload(command: &EnumCommand) -> Value {
    match command {
        EnumCommand::Count | EnumCommand::List => empty_map(),
        EnumCommand::Single { index } => map(vec![("index", Value::Unsigned(u64::from(*index)))]),
        EnumCommand::Details { groups: None } => empty_map(),
        EnumCommand::Details {
            groups: Some(groups),
        } => map(vec![(
            "groups",
            Value::Array(
                groups
                    .iter()
                    .map(|group| Value::Unsigned(u64::from(*group)))
                    .collect(),
            ),
        )]),
    }
}

fn empty_map() -> Value {
    Value::Map(Vec::new())
}

fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn text(value: &str) -> Value {
    Value::Text(value.to_string())
}

fn optional_text(key: &str, value: &Option<String>) -> Value {
    match value {
        Some(value) => map(vec![(key, text(value))]),
        None => empty_map(),
    }
}

// Typed response models. Parsing stays separate from request construction so
// callers can retain unknown CBOR fields for forward compatibility.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskStatistics {
    pub name: String,
    pub task_id: u64,
    pub priority: i64,
    pub state: u64,
    pub stack_size: Option<u64>,
    pub stack_used: Option<u64>,
    pub context_switches: Option<u64>,
    pub runtime_ticks: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryPoolStatistics {
    pub name: String,
    pub block_size: u64,
    pub blocks: u64,
    pub free: u64,
    pub minimum_free: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct McumgrParameters {
    pub buffer_size: u64,
    pub buffer_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageState {
    pub image: u64,
    pub slot: u64,
    pub version: String,
    pub hash: Option<Vec<u8>>,
    pub bootable: bool,
    pub pending: bool,
    pub confirmed: bool,
    pub active: bool,
    pub permanent: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlotInfo {
    pub image: u64,
    pub max_image_size: Option<u64>,
    pub slots: Vec<Slot>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Slot {
    pub slot: u64,
    pub size: u64,
    pub upload_image_id: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettingData {
    pub value: Vec<u8>,
    pub max_size: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileStatus {
    pub length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileChecksum {
    pub algorithm: String,
    pub output: Vec<u8>,
    pub offset: u64,
    pub length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChecksumProperties {
    pub algorithm: String,
    pub output_size: u64,
    pub byte_array: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupDetails {
    pub group: u16,
    pub name: Option<String>,
    pub handlers: Option<u64>,
}

/// Standard MCUmgr error number. V2 group-specific errors retain their group
/// and numeric code in `CommandError` instead of being lossy-translated.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagementError {
    Unknown,
    NoMemory,
    InvalidInput,
    Timeout,
    NotFound,
    BadState,
    MessageTooLarge,
    NotSupported,
    Corrupt,
    Busy,
    AccessDenied,
    VersionTooOld,
    VersionTooNew,
    User(u16),
    Other(u16),
}

impl ManagementError {
    pub const fn from_code(code: u16) -> Option<Self> {
        match code {
            0 => None,
            1 => Some(Self::Unknown),
            2 => Some(Self::NoMemory),
            3 => Some(Self::InvalidInput),
            4 => Some(Self::Timeout),
            5 => Some(Self::NotFound),
            6 => Some(Self::BadState),
            7 => Some(Self::MessageTooLarge),
            8 => Some(Self::NotSupported),
            9 => Some(Self::Corrupt),
            10 => Some(Self::Busy),
            11 => Some(Self::AccessDenied),
            12 => Some(Self::VersionTooOld),
            13 => Some(Self::VersionTooNew),
            256.. => Some(Self::User(code)),
            other => Some(Self::Other(other)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandError {
    pub group: u16,
    pub code: u16,
}

/// Extract either an SMP v2 `{ "err": { "group", "rc" } }` error or a
/// legacy top-level `{ "rc" }` error without discarding group-specific codes.
/// Unknown/malformed response fields are left to the caller's schema parser.
pub fn command_error_from_response(value: &Value) -> Option<CommandError> {
    let Value::Map(root) = value else {
        return None;
    };
    if let Some(Value::Map(error)) = field(root, "err") {
        let group = unsigned_field(error, "group").and_then(|value| u16::try_from(value).ok())?;
        let code = unsigned_field(error, "rc").and_then(|value| u16::try_from(value).ok())?;
        return (code != 0).then_some(CommandError { group, code });
    }
    let code = unsigned_field(root, "rc").and_then(|value| u16::try_from(value).ok())?;
    (code != 0).then_some(CommandError { group: 0, code })
}

fn field<'a>(fields: &'a [(String, Value)], name: &str) -> Option<&'a Value> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn unsigned_field(fields: &[(String, Value)], name: &str) -> Option<u64> {
    match field(fields, name) {
        Some(Value::Unsigned(value)) => Some(*value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::String;
    use alloc::vec;

    use super::*;
    use crate::smp::HEADER_LEN;

    #[test]
    fn every_public_group_matches_zephyr_ids() {
        assert_eq!(
            [
                group::OS,
                group::IMAGE,
                group::STATS,
                group::SETTINGS,
                group::FS,
                group::SHELL,
                group::ENUM
            ],
            [0, 1, 2, 3, 8, 9, 10]
        );
        assert_eq!(group::ZEPHYR_BASIC, 63);
        assert_eq!(group::USER_START, 64);
    }

    #[test]
    fn os_echo_packet_is_a_full_golden_vector() {
        let command = Command::Os(OsCommand::Echo {
            message: String::from("hi"),
        });
        let bytes = command
            .to_packet(Version::V2, 0x2a)
            .unwrap()
            .encode()
            .unwrap();
        assert_eq!(
            bytes,
            [0x0a, 0x00, 0x00, 0x06, 0x00, 0x00, 0x2a, 0x00, 0xa1, 0x61, b'd', 0x62, b'h', b'i']
        );
    }

    #[test]
    fn image_upload_first_and_later_chunks_have_expected_fields() {
        let first = Command::Image(ImageCommand::Upload(ImageUploadChunk {
            image: 0,
            offset: 0,
            data: vec![1, 2],
            total_len: Some(10),
            sha: Some(vec![0xaa; 4]),
            upgrade_only: true,
        }));
        let first_value = crate::cbor::decode(&first.payload_bytes()).unwrap();
        let Value::Map(fields) = first_value else {
            panic!("map expected")
        };
        assert_eq!(
            fields
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            ["data", "len", "off", "sha", "upgrade"]
        );

        let later = Command::Image(ImageCommand::Upload(ImageUploadChunk {
            image: 0,
            offset: 2,
            data: vec![3, 4],
            total_len: None,
            sha: None,
            upgrade_only: false,
        }));
        let Value::Map(fields) = crate::cbor::decode(&later.payload_bytes()).unwrap() else {
            panic!("map expected")
        };
        assert_eq!(
            fields
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            ["data", "off"]
        );
    }

    #[test]
    fn command_catalogue_maps_all_required_groups_and_ids() {
        let cases = vec![
            (
                Command::Os(OsCommand::BootloaderInfo { query: None }),
                (group::OS, 8),
            ),
            (Command::Image(ImageCommand::SlotInfo), (group::IMAGE, 6)),
            (Command::Stats(StatsCommand::List), (group::STATS, 1)),
            (
                Command::Settings(SettingsCommand::Save { name: None }),
                (group::SETTINGS, 3),
            ),
            (Command::Fs(FsCommand::Close), (group::FS, 4)),
            (
                Command::Shell(ShellCommand {
                    argv: vec![String::from("help")],
                }),
                (group::SHELL, 0),
            ),
            (
                Command::Enum(EnumCommand::Details {
                    groups: Some(vec![0, 1]),
                }),
                (group::ENUM, 3),
            ),
            (
                Command::Zephyr(ZephyrCommand::EraseStorage),
                (group::ZEPHYR_BASIC, 0),
            ),
        ];
        for (command, expected) in cases {
            let meta = command.metadata();
            assert_eq!((meta.group, meta.command), expected);
            assert!(
                command
                    .to_packet(Version::V2, 0)
                    .unwrap()
                    .encode()
                    .unwrap()
                    .len()
                    > HEADER_LEN
            );
        }
    }

    #[test]
    fn physical_writes_are_never_automatically_retryable() {
        let destructive = Command::Image(ImageCommand::Erase { slot: Some(1) }).metadata();
        assert_eq!(destructive.retry, RetrySafety::NeverAfterWrite);
        assert!(destructive.risk.requires_confirmation());

        let read = Command::Image(ImageCommand::State).metadata();
        assert_eq!(read.retry, RetrySafety::Safe);
        assert!(!read.risk.requires_confirmation());
    }

    #[test]
    fn optional_zephyr_parameters_are_not_lost() {
        let reset = Command::Os(OsCommand::Reset {
            force: true,
            boot_mode: Some(1),
        });
        assert_eq!(
            crate::cbor::decode(&reset.payload_bytes()).unwrap(),
            Value::Map(vec![
                (String::from("force"), Value::Bool(true)),
                (String::from("boot_mode"), Value::Unsigned(1)),
            ])
        );

        let save = Command::Settings(SettingsCommand::Save {
            name: Some(String::from("app/network")),
        });
        assert_eq!(
            crate::cbor::decode(&save.payload_bytes()).unwrap(),
            Value::Map(vec![(
                String::from("name"),
                Value::Text(String::from("app/network")),
            )])
        );

        let details = Command::Enum(EnumCommand::Details { groups: None });
        assert_eq!(details.payload_bytes(), vec![0xa0]);
    }

    #[test]
    fn raw_request_preserves_arbitrary_group_command_and_cbor() {
        let payload = vec![0xa1, 0x61, b'x', 0x18, 0x2a];
        let command = Command::Raw(RawCommand::write(0xbeef, 0x7f, payload.clone()));
        let packet = command.to_packet(Version::V1, 99).unwrap();
        assert_eq!(packet.header.group, 0xbeef);
        assert_eq!(packet.header.command, 0x7f);
        assert_eq!(packet.payload, payload);
    }

    #[test]
    fn management_error_mapping_keeps_unknown_and_user_codes() {
        assert_eq!(ManagementError::from_code(0), None);
        assert_eq!(
            ManagementError::from_code(3),
            Some(ManagementError::InvalidInput)
        );
        assert_eq!(
            ManagementError::from_code(14),
            Some(ManagementError::Other(14))
        );
        assert_eq!(
            ManagementError::from_code(300),
            Some(ManagementError::User(300))
        );
    }

    #[test]
    fn extracts_v2_group_errors_and_legacy_global_errors() {
        let v2 = Value::Map(vec![(
            String::from("err"),
            Value::Map(vec![
                (String::from("group"), Value::Unsigned(group::IMAGE.into())),
                (String::from("rc"), Value::Unsigned(9)),
            ]),
        )]);
        assert_eq!(
            command_error_from_response(&v2),
            Some(CommandError {
                group: group::IMAGE,
                code: 9
            })
        );

        let legacy = Value::Map(vec![(String::from("rc"), Value::Unsigned(3))]);
        assert_eq!(
            command_error_from_response(&legacy),
            Some(CommandError { group: 0, code: 3 })
        );
        assert_eq!(
            command_error_from_response(&Value::Map(vec![(
                String::from("rc"),
                Value::Unsigned(0)
            )])),
            None
        );
    }
}
