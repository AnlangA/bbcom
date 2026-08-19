//! Generated `bbcom:plugin@2` adapter.
//!
//! Kept in its own module so native workflow tests can disable the `component`
//! feature while still compiling the exact same no-std business logic.

// Canonical-ABI lowering for WIT records generates functions whose argument
// count mirrors the wire record. It is generated code, not a guest API choice.
#![allow(clippy::too_many_arguments)]

wit_bindgen::generate!({
    path: "../../../wit/bbcom-plugin-v2",
    world: "plugin",
    std_feature,
});

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use bbcom_mcumgr_core::cbor::{self, Value};
use bbcom_mcumgr_core::command::{
    EnumCommand, FsCommand, ImageCommand, OsCommand, RawCommand, SettingsCommand, ShellCommand,
    StatsCommand, ZephyrCommand,
};
use bbcom_mcumgr_core::{Command, Op};
use bbcom_plugin_sdk::file::{
    ReadGrant as SdkReadGrant, ReadGrantInfo, SaveGrant as SdkSaveGrant, SaveGrantInfo,
};
use bbcom_plugin_sdk::serial::{
    InputLines, OutputLines, PendingBytes, ReadResult, SerialIoAdapter,
    SerialLease as SdkSerialLease, WriteOutcome, WriteResult,
};
use bbcom_plugin_sdk::task::{Progress, TaskContext};
use bbcom_plugin_sdk::ui::{SurfaceDocument, UiNode, UiNodeKind};
use bbcom_plugin_sdk::ContractError as SdkError;

use self::bbcom::plugin::{host, types};
use crate::model::ClientState;
use crate::raw_input::{decode_hex, describe_response, parse_payload};
use crate::surfaces::{
    apply_interaction, build_all, CommandSpec, InteractionValue, SessionChoice, COMMANDS, SURFACES,
};
use crate::workflow::{
    download_file, firmware_summary, transact, upload_file, upload_firmware, WorkflowError,
};

const FIRMWARE_ACCEPTED_EXTENSIONS: [&str; 1] = ["bin"];

struct McumgrGuest;

impl Guest for McumgrGuest {
    fn initialize(context: types::HostContext) -> Result<types::PluginModel, types::ContractError> {
        let mut state = load_state()?;
        let initial_sessions = context
            .sessions
            .iter()
            .map(|session| SessionChoice {
                id: session.session_id.clone(),
                label: session.name.clone(),
                connected: session.connected,
            })
            .collect::<Vec<_>>();
        reconcile_session(&mut state, &initial_sessions);
        state.locale = context.locale;
        state.theme = theme_name(context.theme).to_string();
        state.validate().map_err(to_wit_error)?;
        persist_state(&state)?;
        let model = plugin_model();
        register_model(&model)?;
        publish_all(&state)?;
        Ok(model)
    }

    fn handle_event(event: types::PluginEvent) -> Result<types::EventResult, types::ContractError> {
        let mut state = load_state()?;
        match event {
            types::PluginEvent::Surface(event) => {
                if event.revision != state.revision {
                    return Err(types::ContractError::StaleHandle);
                }
                let value = from_wit_value(event.value);
                if let Some(command_id) =
                    apply_interaction(&mut state, &event.node_id, value).map_err(to_wit_error)?
                {
                    let invocation = Invocation {
                        command_id: command_id.to_string(),
                        invocation_id: format!("surface:{}:{}", event.surface_id, event.revision),
                        arguments: Vec::new(),
                    };
                    match execute(&invocation, &mut state) {
                        Ok(message) => state.last_output = message,
                        Err(failure) => {
                            state.last_output = failure.message;
                            state.bump_revision();
                            persist_state(&state)?;
                            publish_all(&state)?;
                            return Err(to_wit_error(failure.code));
                        }
                    }
                }
                state.bump_revision();
                persist_state(&state)?;
                publish_all(&state)?;
            }
            types::PluginEvent::LocaleChanged(locale) => {
                state.locale = locale;
                state.bump_revision();
                persist_state(&state)?;
                publish_all(&state)?;
            }
            types::PluginEvent::ThemeChanged(theme) => {
                state.theme = theme_name(theme).to_string();
                state.bump_revision();
                persist_state(&state)?;
                publish_all(&state)?;
            }
            types::PluginEvent::PortCatalogChanged => {
                let choices = sessions()?;
                if reconcile_session(&mut state, &choices) {
                    state.bump_revision();
                    persist_state(&state)?;
                }
                publish_all_with_sessions(&state, &choices)?;
            }
            // The host cancellation path interrupts the active Wasmtime epoch
            // and revokes its lease. This event records acknowledgement for a
            // task that has already reached a safe boundary.
            types::PluginEvent::CancelTask(_) => {}
        }
        Ok(types::EventResult { accepted: true })
    }

    fn run_command(
        invocation: types::CommandInvocation,
    ) -> Result<types::CommandResult, types::ContractError> {
        let mut state = load_state()?;
        // Session membership is host-owned and may change while the plugin is
        // stopped or while a catalog event is queued behind another guest
        // task. Reconcile again at the side-effect boundary so a stale saved
        // ID can never be used to request a lease.
        reconcile_session(&mut state, &sessions()?);
        let invocation = Invocation {
            command_id: invocation.command_id,
            invocation_id: invocation.invocation_id,
            arguments: invocation.arguments,
        };
        match execute(&invocation, &mut state) {
            Ok(message) => {
                state.last_output = message.clone();
                state.bump_revision();
                persist_state(&state)?;
                publish_all(&state)?;
                Ok(types::CommandResult { message })
            }
            Err(failure) => {
                state.last_output = failure.message;
                state.bump_revision();
                persist_state(&state)?;
                publish_all(&state)?;
                Err(to_wit_error(failure.code))
            }
        }
    }

    fn migrate_state(
        _previous_api: String,
        state: Vec<u8>,
    ) -> Result<types::MigratedState, types::ContractError> {
        let state = if state.is_empty() {
            ClientState::default()
        } else {
            // Unknown/corrupt state fails before persistence; the host keeps
            // the previous opaque state transactionally.
            ClientState::decode(&state).map_err(to_wit_error)?
        };
        Ok(types::MigratedState {
            schema_version: crate::model::STATE_SCHEMA,
            state: state.encode().map_err(to_wit_error)?,
        })
    }

    fn shutdown() {}
}

#[derive(Clone, Debug)]
struct Invocation {
    command_id: String,
    invocation_id: String,
    arguments: Vec<String>,
}

#[derive(Clone, Debug)]
struct RunFailure {
    code: SdkError,
    message: String,
}

type RunResult<T> = core::result::Result<T, RunFailure>;

impl From<SdkError> for RunFailure {
    fn from(value: SdkError) -> Self {
        Self {
            code: value,
            message: value.as_str().to_string(),
        }
    }
}

impl From<WorkflowError> for RunFailure {
    fn from(value: WorkflowError) -> Self {
        Self {
            code: value.contract_code(),
            message: value.to_string(),
        }
    }
}

fn execute(invocation: &Invocation, state: &mut ClientState) -> RunResult<String> {
    if !COMMANDS
        .iter()
        .any(|command| command.id == invocation.command_id)
    {
        return Err(SdkError::NotFound.into());
    }
    match invocation.command_id.as_str() {
        "automation.quick-command" => create_quick_command(state),
        "automation.macro" => create_macro(state),
        "image.upload" => execute_firmware_upload(invocation, state),
        "fs.upload" => execute_file_upload(invocation, state),
        "fs.download" => execute_file_download(invocation, state),
        _ => {
            let command = build_command(invocation, state)?;
            with_lease(state, |serial, state| {
                let mut task = HostTask::new(&invocation.invocation_id);
                let response = transact(
                    serial,
                    &mut task,
                    &invocation.invocation_id,
                    state,
                    &command,
                )?;
                state.transfer_completed = task.completed;
                state.transfer_total = task.total.unwrap_or(0);
                describe_response(&response.raw_cbor).map_err(RunFailure::from)
            })
        }
    }
}

fn execute_firmware_upload(invocation: &Invocation, state: &mut ClientState) -> RunResult<String> {
    // The host contract accepts extension names, not MIME types or paths.
    let accepts = FIRMWARE_ACCEPTED_EXTENSIONS.map(str::to_string).to_vec();
    let grant = host::open_read_grant(&accepts)
        .map_err(from_host_error)?
        .ok_or(SdkError::Cancelled)?;
    let mut grant = HostReadGrant::new(grant);
    with_lease(state, |serial, state| {
        let mut task = HostTask::new(&invocation.invocation_id);
        let digest = upload_firmware(
            &mut grant,
            serial,
            &mut task,
            &invocation.invocation_id,
            state,
        )?;
        state.transfer_completed = task.completed;
        state.transfer_total = task.total.unwrap_or(0);
        let boot_hash = digest.mcuboot.image_hash.unwrap_or(digest.file_sha256);
        state.image_hash_hex = crate::raw_input::encode_hex(&boot_hash);
        Ok(format!(
            "Firmware upload complete. {}\nFile SHA-256: {}\nMCUboot image hash: {}",
            firmware_summary(&digest),
            crate::raw_input::encode_hex(&digest.file_sha256),
            state.image_hash_hex,
        ))
    })
}

fn execute_file_upload(invocation: &Invocation, state: &mut ClientState) -> RunResult<String> {
    let grant = host::open_read_grant(&[])
        .map_err(from_host_error)?
        .ok_or(SdkError::Cancelled)?;
    let mut grant = HostReadGrant::new(grant);
    let remote_path = state.remote_path.clone();
    with_lease(state, |serial, state| {
        let mut task = HostTask::new(&invocation.invocation_id);
        upload_file(
            &mut grant,
            &remote_path,
            serial,
            &mut task,
            &invocation.invocation_id,
            state,
        )?;
        state.transfer_completed = task.completed;
        state.transfer_total = task.total.unwrap_or(0);
        Ok(format!("Uploaded {remote_path}"))
    })
}

fn execute_file_download(invocation: &Invocation, state: &mut ClientState) -> RunResult<String> {
    let suggested = state
        .remote_path
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("download.bin");
    let grant = host::create_save_grant(suggested)
        .map_err(from_host_error)?
        .ok_or(SdkError::Cancelled)?;
    let mut grant = HostSaveGrant::new(grant);
    let remote_path = state.remote_path.clone();
    with_lease(state, |serial, state| {
        let mut task = HostTask::new(&invocation.invocation_id);
        let bytes = download_file(
            &mut grant,
            &remote_path,
            serial,
            &mut task,
            &invocation.invocation_id,
            state,
        )?;
        state.transfer_completed = task.completed;
        state.transfer_total = task.total.unwrap_or(0);
        Ok(format!("Downloaded {bytes} bytes from {remote_path}"))
    })
}

fn create_quick_command(state: &ClientState) -> RunResult<String> {
    if state.session_id.is_empty() {
        return Err(SdkError::InvalidInput.into());
    }
    let command = Command::Os(OsCommand::Echo {
        message: state.echo_text.clone(),
    });
    let packet = command
        .to_packet(
            if state.smp_v2 {
                bbcom_mcumgr_core::Version::V2
            } else {
                bbcom_mcumgr_core::Version::V1
            },
            state.next_sequence,
        )
        .map_err(WorkflowError::from)?;
    let payload = match state.transport {
        crate::model::TransportMode::Console => bbcom_mcumgr_core::ConsoleCodec::default()
            .encode_packet(&packet)
            .map_err(WorkflowError::from)?,
        crate::model::TransportMode::RawUart => packet.encode().map_err(WorkflowError::from)?,
    };
    let owner_id = host::upsert_quick_command(&types::QuickCommand {
        local_id: "mcumgr-echo".to_string(),
        title: "MCUmgr echo".to_string(),
        session_id: state.session_id.clone(),
        payload,
        append_newline: false,
    })
    .map_err(from_host_error)?;
    Ok(format!("Created native quick command {owner_id}"))
}

fn create_macro(state: &ClientState) -> RunResult<String> {
    if state.session_id.is_empty() {
        return Err(SdkError::InvalidInput.into());
    }
    let owner_id = host::upsert_macro(&types::MacroContribution {
        local_id: "mcumgr-prepare".to_string(),
        title: "Prepare MCUmgr console".to_string(),
        session_id: state.session_id.clone(),
        steps: vec![types::MacroStep {
            delay_ms: 0,
            // A bare newline is intentionally a terminal preparation step,
            // not an SMP request with a stale sequence number.
            payload: vec![b'\n'],
        }],
    })
    .map_err(from_host_error)?;
    Ok(format!("Created native macro {owner_id}"))
}

fn with_lease<T>(
    state: &mut ClientState,
    operation: impl FnOnce(&mut SerialIoAdapter<HostLease>, &mut ClientState) -> RunResult<T>,
) -> RunResult<T> {
    if state.session_id.is_empty() {
        return Err(SdkError::InvalidInput.into());
    }
    let lease = host::acquire_serial_lease(
        &state.session_id,
        types::SerialLeaseOptions {
            pause_automation: true,
            rx_buffer_bytes: state.frame_size.saturating_mul(4).clamp(4_096, 1_048_576),
        },
    )
    .map_err(from_host_error)?;
    let mut serial = SerialIoAdapter::new(HostLease(lease));
    let result = operation(&mut serial, state);
    let release = serial.lease_mut().release().map_err(RunFailure::from);
    match (result, release) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn build_command(invocation: &Invocation, state: &ClientState) -> RunResult<Command> {
    let argument = |index: usize| invocation.arguments.get(index).map(String::as_str);
    let required_name = |value: &str| {
        if value.is_empty() {
            Err(RunFailure::from(SdkError::InvalidInput))
        } else {
            Ok(value.to_string())
        }
    };
    let command = match invocation.command_id.as_str() {
        "connection.check" | "os.echo" => Command::Os(OsCommand::Echo {
            message: argument(0).unwrap_or(&state.echo_text).to_string(),
        }),
        "os.console-echo" => Command::Os(OsCommand::ConsoleEchoControl {
            enabled: parse_bool(argument(0).unwrap_or("true"))?,
        }),
        "os.tasks" => Command::Os(OsCommand::TaskStatistics),
        "os.memory-pools" => Command::Os(OsCommand::MemoryPoolStatistics),
        "os.datetime-get" => Command::Os(OsCommand::DateTimeGet),
        "os.datetime-set" => Command::Os(OsCommand::DateTimeSet {
            value: required_name(argument(0).unwrap_or(&state.datetime))?,
        }),
        "os.parameters" => Command::Os(OsCommand::McumgrParameters),
        "os.application-info" => Command::Os(OsCommand::ApplicationInfo {
            format: argument(0).map(ToString::to_string),
        }),
        "os.bootloader-info" => Command::Os(OsCommand::BootloaderInfo {
            query: argument(0).map(ToString::to_string),
        }),
        "os.reset" => Command::Os(OsCommand::Reset {
            force: argument(0).map(parse_bool).transpose()?.unwrap_or(false),
            boot_mode: argument(1).map(parse_u8).transpose()?,
        }),
        "image.state" => Command::Image(ImageCommand::State),
        "image.test" => Command::Image(ImageCommand::SetState {
            hash: Some(image_hash(state)?),
            confirm: false,
        }),
        "image.confirm" => Command::Image(ImageCommand::SetState {
            hash: optional_image_hash(state)?,
            confirm: true,
        }),
        "image.erase" => Command::Image(ImageCommand::Erase {
            slot: argument(0).map(parse_u32).transpose()?,
        }),
        "image.slot-info" => Command::Image(ImageCommand::SlotInfo),
        "image.core-list" => Command::Image(ImageCommand::CoreList),
        "image.core-load" => Command::Image(ImageCommand::CoreLoad {
            fields: raw_fields(state)?,
        }),
        "image.file-read" => Command::Image(ImageCommand::File {
            op: Op::Read,
            fields: raw_fields(state)?,
        }),
        "image.file-write" => Command::Image(ImageCommand::File {
            op: Op::Write,
            fields: raw_fields(state)?,
        }),
        "stats.list" => Command::Stats(StatsCommand::List),
        "stats.show" => Command::Stats(StatsCommand::Show {
            name: required_name(argument(0).unwrap_or(&state.stats_name))?,
        }),
        "settings.read" => Command::Settings(SettingsCommand::Read {
            name: required_name(argument(0).unwrap_or(&state.setting_name))?,
            max_size: argument(1).map(parse_u64).transpose()?,
        }),
        "settings.write" => Command::Settings(SettingsCommand::Write {
            name: required_name(argument(0).unwrap_or(&state.setting_name))?,
            value: argument(1)
                .unwrap_or(&state.setting_value)
                .as_bytes()
                .to_vec(),
        }),
        "settings.delete" => Command::Settings(SettingsCommand::Delete {
            name: required_name(argument(0).unwrap_or(&state.setting_name))?,
        }),
        "settings.commit" => Command::Settings(SettingsCommand::Commit),
        "settings.load" => Command::Settings(SettingsCommand::Load),
        "settings.save" => Command::Settings(SettingsCommand::Save {
            name: argument(0)
                .map(ToString::to_string)
                .or_else(|| (!state.setting_name.is_empty()).then(|| state.setting_name.clone())),
        }),
        "fs.status" => Command::Fs(FsCommand::Status {
            name: required_name(argument(0).unwrap_or(&state.remote_path))?,
        }),
        "fs.checksum" => Command::Fs(FsCommand::Checksum {
            name: required_name(argument(0).unwrap_or(&state.remote_path))?,
            algorithm: Some(argument(1).unwrap_or("sha256").to_string()),
            offset: argument(2).map(parse_u64).transpose()?,
            length: argument(3).map(parse_u64).transpose()?,
        }),
        "fs.supported-checksums" => Command::Fs(FsCommand::SupportedChecksums),
        "fs.close" => Command::Fs(FsCommand::Close),
        "shell.execute" => Command::Shell(ShellCommand {
            argv: parse_argv(argument(0).unwrap_or(&state.shell_line))?,
        }),
        "enum.count" => Command::Enum(EnumCommand::Count),
        "enum.list" => Command::Enum(EnumCommand::List),
        "enum.single" => Command::Enum(EnumCommand::Single {
            index: argument(0).map(parse_u16).transpose()?.unwrap_or(0),
        }),
        "enum.details" => Command::Enum(EnumCommand::Details {
            groups: if invocation.arguments.is_empty() {
                None
            } else {
                Some(
                    invocation
                        .arguments
                        .iter()
                        .map(|value| parse_u16(value))
                        .collect::<RunResult<Vec<_>>>()?,
                )
            },
        }),
        "zephyr.erase-storage" => Command::Zephyr(ZephyrCommand::EraseStorage),
        "raw.execute" => {
            let payload = parse_payload(state.raw_format, &state.raw_payload)?;
            Command::Raw(if state.raw_op_write {
                RawCommand::write(state.raw_group, state.raw_command, payload)
            } else {
                RawCommand::read(state.raw_group, state.raw_command, payload)
            })
        }
        _ => return Err(SdkError::NotFound.into()),
    };
    Ok(command)
}

fn raw_fields(state: &ClientState) -> RunResult<Value> {
    let payload = parse_payload(state.raw_format, &state.raw_payload)?;
    let value = cbor::decode(&payload).map_err(|_| SdkError::InvalidInput)?;
    if matches!(value, Value::Map(_)) {
        Ok(value)
    } else {
        Err(SdkError::InvalidInput.into())
    }
}

fn optional_image_hash(state: &ClientState) -> RunResult<Option<Vec<u8>>> {
    if state.image_hash_hex.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(image_hash(state)?))
    }
}

fn image_hash(state: &ClientState) -> RunResult<Vec<u8>> {
    let value = decode_hex(&state.image_hash_hex)?;
    if value.len() == 32 {
        Ok(value)
    } else {
        Err(SdkError::InvalidInput.into())
    }
}

fn parse_bool(value: &str) -> RunResult<bool> {
    match value {
        "true" | "1" | "on" => Ok(true),
        "false" | "0" | "off" => Ok(false),
        _ => Err(SdkError::InvalidInput.into()),
    }
}

fn parse_u8(value: &str) -> RunResult<u8> {
    value.parse().map_err(|_| SdkError::InvalidInput.into())
}

fn parse_u16(value: &str) -> RunResult<u16> {
    value.parse().map_err(|_| SdkError::InvalidInput.into())
}

fn parse_u32(value: &str) -> RunResult<u32> {
    value.parse().map_err(|_| SdkError::InvalidInput.into())
}

fn parse_u64(value: &str) -> RunResult<u64> {
    value.parse().map_err(|_| SdkError::InvalidInput.into())
}

fn parse_argv(input: &str) -> RunResult<Vec<String>> {
    let mut output = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in input.chars() {
        if escaped {
            current.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if let Some(expected) = quote {
            if character == expected {
                quote = None;
            } else {
                current.push(character);
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                output.push(core::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped || quote.is_some() {
        return Err(SdkError::InvalidInput.into());
    }
    if !current.is_empty() {
        output.push(current);
    }
    if output.is_empty() || output.len() > 128 {
        Err(SdkError::InvalidInput.into())
    } else {
        Ok(output)
    }
}

fn plugin_model() -> types::PluginModel {
    types::PluginModel {
        surfaces: SURFACES
            .iter()
            .map(|surface| types::PluginSurface {
                surface_id: surface.id.to_string(),
                title: surface.title.to_string(),
                location: types::SurfaceLocation::Workspace,
            })
            .collect(),
        commands: COMMANDS.iter().map(wit_command).collect(),
    }
}

/// Register initial declarations before publishing their first snapshots.
/// Imports are serviced during `initialize`, so relying only on the model
/// returned after the call would make the first snapshot race a nonexistent
/// surface in the native projection.
fn register_model(model: &types::PluginModel) -> Result<(), types::ContractError> {
    for surface in &model.surfaces {
        host::register_surface(surface)?;
    }
    for command in &model.commands {
        host::register_command(command)?;
    }
    Ok(())
}

fn wit_command(command: &CommandSpec) -> types::CommandContribution {
    types::CommandContribution {
        command_id: command.id.to_string(),
        title: command.title.to_string(),
        description: command.description.to_string(),
        long_running: command.long_running,
        confirmation: command_confirmation(command.id).map(str::to_string),
    }
}

fn command_confirmation(command_id: &str) -> Option<&'static str> {
    match command_id {
        "os.reset" => Some("Reset the connected target now?"),
        "image.test" => Some("Mark the selected image pending for the next boot?"),
        "image.confirm" => Some("Permanently confirm the selected or running image?"),
        "image.erase" => Some("Erase the selected secondary image slot?"),
        "settings.delete" => Some("Delete the selected device setting?"),
        "zephyr.erase-storage" => Some("Erase all Zephyr storage on the connected target?"),
        "raw.execute" => Some(
            "Send the configured arbitrary SMP request? Raw writes can mutate or erase device state.",
        ),
        _ => None,
    }
}

fn sessions() -> Result<Vec<SessionChoice>, types::ContractError> {
    host::serial_sessions().map(|sessions| {
        sessions
            .into_iter()
            .map(|session| SessionChoice {
                id: session.session_id,
                label: session.name,
                connected: session.connected,
            })
            .collect()
    })
}

fn publish_all(state: &ClientState) -> Result<(), types::ContractError> {
    publish_all_with_sessions(state, &sessions()?)
}

fn publish_all_with_sessions(
    state: &ClientState,
    sessions: &[SessionChoice],
) -> Result<(), types::ContractError> {
    for document in build_all(state, sessions).map_err(to_wit_error)? {
        host::publish_surface_snapshot(&wit_snapshot(document))?;
    }
    Ok(())
}

/// Keeps the executable state and the host-rendered selector on the same
/// authoritative session. A removed saved ID selects a connected session
/// first, then the first remaining session; an empty catalogue clears the ID.
fn reconcile_session(state: &mut ClientState, sessions: &[SessionChoice]) -> bool {
    if sessions.iter().any(|session| session.id == state.session_id) {
        return false;
    }
    let replacement = sessions
        .iter()
        .find(|session| session.connected)
        .or_else(|| sessions.first())
        .map_or_else(String::new, |session| session.id.clone());
    if replacement == state.session_id {
        false
    } else {
        state.session_id = replacement;
        true
    }
}

fn wit_snapshot(document: SurfaceDocument) -> types::SurfaceSnapshot {
    types::SurfaceSnapshot {
        surface_id: document.surface_id,
        revision: document.revision,
        root_node_id: document.root_node_id,
        nodes: document.nodes.into_iter().map(wit_node).collect(),
    }
}

fn wit_node(node: UiNode) -> types::UiNode {
    types::UiNode {
        id: node.id,
        parent_id: node.parent_id,
        order: node.order,
        kind: match node.kind {
            UiNodeKind::Column => types::UiNodeKind::Column,
            UiNodeKind::Row => types::UiNodeKind::Row,
            UiNodeKind::Group { title } => types::UiNodeKind::Group(types::GroupNode { title }),
            UiNodeKind::Tabs { selected_child_id } => {
                types::UiNodeKind::Tabs(types::TabsNode { selected_child_id })
            }
            UiNodeKind::Text { text } => types::UiNodeKind::Text(types::TextNode { text }),
            UiNodeKind::Badge { text, tone } => {
                types::UiNodeKind::Badge(types::BadgeNode { text, tone })
            }
            UiNodeKind::KeyValue { entries } => types::UiNodeKind::KeyValue(types::KeyValueNode {
                entries: entries
                    .into_iter()
                    .map(|(key, value)| types::KeyValueEntry { key, value })
                    .collect(),
            }),
            UiNodeKind::Progress {
                value,
                maximum,
                label,
            } => types::UiNodeKind::Progress(types::ProgressNode {
                value,
                maximum,
                label,
            }),
            UiNodeKind::Log { text, language } => {
                types::UiNodeKind::Log(types::LogNode { text, language })
            }
            UiNodeKind::Code { text, language } => {
                types::UiNodeKind::Code(types::LogNode { text, language })
            }
            UiNodeKind::Table {
                columns,
                rows,
                page,
                page_size,
                total_rows,
            } => types::UiNodeKind::Table(types::TableNode {
                columns,
                rows,
                page,
                page_size,
                total_rows,
            }),
            UiNodeKind::Input {
                label,
                value,
                placeholder,
                disabled,
            } => types::UiNodeKind::Input(types::InputNode {
                label,
                value,
                placeholder,
                disabled,
            }),
            UiNodeKind::NumberInput {
                label,
                value,
                minimum,
                maximum,
                step,
                disabled,
            } => types::UiNodeKind::NumberInput(types::NumberInputNode {
                label,
                value,
                minimum,
                maximum,
                step,
                disabled,
            }),
            UiNodeKind::Select {
                label,
                value,
                options,
                disabled,
            } => types::UiNodeKind::Select(types::SelectNode {
                label,
                value,
                options: options
                    .into_iter()
                    .map(|(value, label)| types::SelectOption { value, label })
                    .collect(),
                disabled,
            }),
            UiNodeKind::Toggle {
                label,
                checked,
                disabled,
            } => types::UiNodeKind::Toggle(types::ToggleNode {
                label,
                checked,
                disabled,
            }),
            UiNodeKind::Button { label, disabled } => {
                types::UiNodeKind::Button(types::ButtonNode {
                    label,
                    disabled,
                    confirmation: None,
                })
            }
            UiNodeKind::DangerousButton {
                label,
                disabled,
                confirmation,
            } => types::UiNodeKind::DangerousButton(types::ButtonNode {
                label,
                disabled,
                confirmation: Some(confirmation),
            }),
            _ => unreachable!("SDK UI node kind is newer than this pinned guest adapter"),
        },
    }
}

fn from_wit_value(value: types::UiValue) -> InteractionValue {
    match value {
        types::UiValue::Text(value) => InteractionValue::Text(value),
        types::UiValue::Number(value) => InteractionValue::Number(value),
        types::UiValue::Toggle(value) => InteractionValue::Toggle(value),
        types::UiValue::Selection(value) => InteractionValue::Selection(value),
        types::UiValue::Action => InteractionValue::Action,
    }
}

const fn theme_name(theme: types::ColorScheme) -> &'static str {
    match theme {
        types::ColorScheme::Light => "light",
        types::ColorScheme::Dark => "dark",
        types::ColorScheme::System => "system",
    }
}

fn load_state() -> Result<ClientState, types::ContractError> {
    match host::project_state_get()? {
        Some(state) => decode_project_state(state),
        None => Ok(ClientState::default()),
    }
}

fn persist_state(state: &ClientState) -> Result<(), types::ContractError> {
    host::project_state_set(&types::ProjectState {
        schema_version: crate::model::STATE_SCHEMA,
        value: state.encode().map_err(to_wit_error)?,
    })
}

fn decode_project_state(state: types::ProjectState) -> Result<ClientState, types::ContractError> {
    if state.schema_version != crate::model::STATE_SCHEMA {
        return Err(types::ContractError::InvalidInput);
    }
    ClientState::decode(&state.value).map_err(to_wit_error)
}

struct HostLease(host::SerialLease);

impl SdkSerialLease for HostLease {
    fn read(&mut self, max_bytes: u32, timeout_ms: u32) -> bbcom_plugin_sdk::Result<ReadResult> {
        self.0
            .read(max_bytes, timeout_ms)
            .map(|value| ReadResult {
                payload: value.payload,
                timed_out: value.timed_out,
                disconnected: value.disconnected,
            })
            .map_err(from_wit_error)
    }

    fn write(&mut self, payload: &[u8]) -> bbcom_plugin_sdk::Result<WriteResult> {
        self.0
            .write(payload)
            .map(|value| WriteResult {
                requested: value.requested,
                sent: value.sent,
                outcome: match value.outcome {
                    types::WriteOutcome::Completed => WriteOutcome::Completed,
                    types::WriteOutcome::PartialWrite => WriteOutcome::PartialWrite,
                    types::WriteOutcome::UnknownOutcome => WriteOutcome::UnknownOutcome,
                },
            })
            .map_err(from_wit_error)
    }

    fn clear_buffers(&mut self) -> bbcom_plugin_sdk::Result<()> {
        self.0.clear_buffers().map_err(from_wit_error)
    }

    fn pending(&mut self) -> bbcom_plugin_sdk::Result<PendingBytes> {
        self.0
            .pending()
            .map(|value| PendingBytes {
                rx: value.rx,
                tx: value.tx,
            })
            .map_err(from_wit_error)
    }

    fn set_output_lines(&mut self, lines: OutputLines) -> bbcom_plugin_sdk::Result<()> {
        self.0
            .set_output_lines(types::OutputLines {
                dtr: lines.dtr,
                rts: lines.rts,
                break_active: lines.break_active,
            })
            .map_err(from_wit_error)
    }

    fn input_lines(&mut self) -> bbcom_plugin_sdk::Result<InputLines> {
        self.0
            .input_lines()
            .map(|value| InputLines {
                cts: value.cts,
                dsr: value.dsr,
                ri: value.ri,
                cd: value.cd,
            })
            .map_err(from_wit_error)
    }

    fn release(&mut self) -> bbcom_plugin_sdk::Result<()> {
        self.0.release().map_err(from_wit_error)
    }
}

struct HostReadGrant {
    inner: host::ReadGrant,
    closed: bool,
}

impl HostReadGrant {
    const fn new(inner: host::ReadGrant) -> Self {
        Self {
            inner,
            closed: false,
        }
    }
}

impl SdkReadGrant for HostReadGrant {
    fn info(&self) -> ReadGrantInfo {
        let info = self.inner.info();
        ReadGrantInfo {
            display_name: info.display_name,
            size: info.size,
        }
    }

    fn read_at(&mut self, offset: u64, max_bytes: u32) -> bbcom_plugin_sdk::Result<Vec<u8>> {
        self.inner
            .read_at(offset, max_bytes)
            .map_err(from_wit_error)
    }

    fn close(&mut self) {
        if !self.closed {
            self.inner.close();
            self.closed = true;
        }
    }
}

impl Drop for HostReadGrant {
    fn drop(&mut self) {
        self.close();
    }
}

struct HostSaveGrant {
    inner: host::SaveGrant,
    finished: bool,
}

impl HostSaveGrant {
    const fn new(inner: host::SaveGrant) -> Self {
        Self {
            inner,
            finished: false,
        }
    }
}

impl SdkSaveGrant for HostSaveGrant {
    fn info(&self) -> SaveGrantInfo {
        let info = self.inner.info();
        SaveGrantInfo {
            display_name: info.display_name,
        }
    }

    fn write(&mut self, payload: &[u8]) -> bbcom_plugin_sdk::Result<u64> {
        self.inner.write(payload).map_err(from_wit_error)
    }

    fn commit(&mut self) -> bbcom_plugin_sdk::Result<()> {
        self.inner.commit().map_err(from_wit_error)?;
        self.finished = true;
        Ok(())
    }

    fn cancel(&mut self) {
        if !self.finished {
            self.inner.cancel();
            self.finished = true;
        }
    }
}

impl Drop for HostSaveGrant {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct HostTask {
    task_id: String,
    completed: u64,
    total: Option<u64>,
}

impl HostTask {
    fn new(task_id: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            completed: 0,
            total: None,
        }
    }
}

impl TaskContext for HostTask {
    fn is_cancelled(&self) -> bool {
        false
    }

    fn progress(&mut self, progress: Progress<'_>) -> bbcom_plugin_sdk::Result<()> {
        self.completed = progress.completed;
        self.total = progress.total;
        host::report_task_progress(&types::TaskProgress {
            task_id: self.task_id.clone(),
            completed: progress.completed,
            total: progress.total,
            message: progress.message.to_string(),
        })
        .map_err(from_wit_error)
    }

    fn heartbeat(&mut self, _task_id: &str) -> bbcom_plugin_sdk::Result<()> {
        host::heartbeat(&self.task_id).map_err(from_wit_error)
    }
}

fn to_wit_error(error: SdkError) -> types::ContractError {
    match error {
        SdkError::InvalidInput => types::ContractError::InvalidInput,
        SdkError::PermissionDenied => types::ContractError::PermissionDenied,
        SdkError::Unavailable => types::ContractError::Unavailable,
        SdkError::Busy => types::ContractError::Busy,
        SdkError::NotFound => types::ContractError::NotFound,
        SdkError::StaleHandle => types::ContractError::StaleHandle,
        SdkError::Disconnected => types::ContractError::Disconnected,
        SdkError::Timeout => types::ContractError::Timeout,
        SdkError::Cancelled => types::ContractError::Cancelled,
        SdkError::LimitExceeded => types::ContractError::LimitExceeded,
        SdkError::PartialWrite => types::ContractError::PartialWrite,
        SdkError::UnknownOutcome => types::ContractError::UnknownOutcome,
        SdkError::ProtocolError => types::ContractError::ProtocolError,
        SdkError::IoError => types::ContractError::IoError,
        _ => types::ContractError::ProtocolError,
    }
}

fn from_wit_error(error: types::ContractError) -> SdkError {
    match error {
        types::ContractError::InvalidInput => SdkError::InvalidInput,
        types::ContractError::PermissionDenied => SdkError::PermissionDenied,
        types::ContractError::Unavailable => SdkError::Unavailable,
        types::ContractError::Busy => SdkError::Busy,
        types::ContractError::NotFound => SdkError::NotFound,
        types::ContractError::StaleHandle => SdkError::StaleHandle,
        types::ContractError::Disconnected => SdkError::Disconnected,
        types::ContractError::Timeout => SdkError::Timeout,
        types::ContractError::Cancelled => SdkError::Cancelled,
        types::ContractError::LimitExceeded => SdkError::LimitExceeded,
        types::ContractError::PartialWrite => SdkError::PartialWrite,
        types::ContractError::UnknownOutcome => SdkError::UnknownOutcome,
        types::ContractError::ProtocolError => SdkError::ProtocolError,
        types::ContractError::IoError => SdkError::IoError,
    }
}

fn from_host_error(error: types::ContractError) -> RunFailure {
    from_wit_error(error).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_non_dialog_command_contribution_has_a_typed_dispatch_path() {
        let state = ClientState {
            image_hash_hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
                .to_string(),
            datetime: "2026-08-19T12:00:00Z".to_string(),
            stats_name: "kernel".to_string(),
            setting_name: "app/key".to_string(),
            setting_value: "value".to_string(),
            ..ClientState::default()
        };
        let host_only = [
            "image.upload",
            "fs.upload",
            "fs.download",
            "automation.quick-command",
            "automation.macro",
        ];
        for specification in COMMANDS {
            if host_only.contains(&specification.id) {
                continue;
            }
            let invocation = Invocation {
                command_id: specification.id.to_string(),
                invocation_id: "test".to_string(),
                arguments: Vec::new(),
            };
            assert!(
                build_command(&invocation, &state).is_ok(),
                "missing dispatch for {}",
                specification.id
            );
        }
    }

    #[test]
    fn shell_arguments_are_parsed_without_invoking_a_local_shell() {
        assert_eq!(
            parse_argv(r#"flash read "path with spaces" 'literal' escaped\ value"#).unwrap(),
            [
                "flash",
                "read",
                "path with spaces",
                "literal",
                "escaped value"
            ]
        );
        assert!(parse_argv("unterminated '").is_err());
        assert!(parse_argv("dangling\\").is_err());
    }

    #[test]
    fn firmware_dialog_filter_uses_extension_names_only() {
        assert_eq!(FIRMWARE_ACCEPTED_EXTENSIONS, ["bin"]);
        assert!(FIRMWARE_ACCEPTED_EXTENSIONS
            .iter()
            .all(|value| !value.contains(['/', '.', '\\'])));
    }

    #[test]
    fn project_state_rejects_zero_and_unknown_guest_schemas() {
        let encoded = ClientState::default().encode().unwrap();
        assert!(decode_project_state(types::ProjectState {
            schema_version: crate::model::STATE_SCHEMA,
            value: encoded.clone(),
        })
        .is_ok());
        for schema_version in [0, crate::model::STATE_SCHEMA + 1, 73] {
            assert!(matches!(
                decode_project_state(types::ProjectState {
                    schema_version,
                    value: encoded.clone(),
                }),
                Err(types::ContractError::InvalidInput)
            ));
        }
    }

    #[test]
    fn executable_session_state_repairs_stale_and_empty_catalogues() {
        let sessions = [
            SessionChoice {
                id: "session-disconnected".to_string(),
                label: "Disconnected".to_string(),
                connected: false,
            },
            SessionChoice {
                id: "session-connected".to_string(),
                label: "Connected".to_string(),
                connected: true,
            },
        ];
        let mut state = ClientState {
            session_id: "removed-session".to_string(),
            ..ClientState::default()
        };

        assert!(reconcile_session(&mut state, &sessions));
        assert_eq!(state.session_id, "session-connected");
        assert!(!reconcile_session(&mut state, &sessions));

        assert!(reconcile_session(&mut state, &[]));
        assert!(state.session_id.is_empty());

        let disconnected_only = &sessions[..1];
        assert!(reconcile_session(&mut state, disconnected_only));
        assert_eq!(state.session_id, "session-disconnected");
    }
}

export!(McumgrGuest);
