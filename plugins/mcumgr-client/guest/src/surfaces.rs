use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use bbcom_plugin_sdk::ui::{SurfaceBuilder, SurfaceDocument, UiNodeKind};
use bbcom_plugin_sdk::{ContractError, Result};

use crate::model::{
    device_path_from_ui, device_path_to_ui, ClientState, RawInputFormat, TransportMode,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SurfaceSpec {
    pub id: &'static str,
    pub title: &'static str,
}

pub const SURFACES: [SurfaceSpec; 9] = [
    SurfaceSpec {
        id: "overview",
        title: "Overview",
    },
    SurfaceSpec {
        id: "firmware",
        title: "Firmware",
    },
    SurfaceSpec {
        id: "files",
        title: "Files",
    },
    SurfaceSpec {
        id: "os",
        title: "OS",
    },
    SurfaceSpec {
        id: "stats",
        title: "Stats",
    },
    SurfaceSpec {
        id: "settings",
        title: "Settings",
    },
    SurfaceSpec {
        id: "shell",
        title: "Shell",
    },
    SurfaceSpec {
        id: "groups-raw",
        title: "Groups and Raw",
    },
    SurfaceSpec {
        id: "automation",
        title: "Automation",
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub long_running: bool,
}

pub const COMMANDS: &[CommandSpec] = &[
    command(
        "connection.check",
        "Check connection",
        "Send an MCUmgr echo over the selected leased serial session",
        false,
    ),
    command("os.echo", "OS: echo", "Echo the configured text", false),
    command(
        "os.console-echo",
        "OS: console echo",
        "Enable or disable console echo",
        false,
    ),
    command(
        "os.tasks",
        "OS: task statistics",
        "Read RTOS task statistics",
        false,
    ),
    command(
        "os.memory-pools",
        "OS: memory pool statistics",
        "Read memory pool statistics",
        false,
    ),
    command(
        "os.datetime-get",
        "OS: get date/time",
        "Read the target date and time",
        false,
    ),
    command(
        "os.datetime-set",
        "OS: set date/time",
        "Set the target date and time",
        false,
    ),
    command(
        "os.parameters",
        "OS: MCUmgr parameters",
        "Read transport buffer parameters",
        false,
    ),
    command(
        "os.application-info",
        "OS: application info",
        "Read application information",
        false,
    ),
    command(
        "os.bootloader-info",
        "OS: bootloader info",
        "Read bootloader information",
        false,
    ),
    command("os.reset", "OS: reset", "Reset the target", false),
    command(
        "image.state",
        "Image: state",
        "Read MCUboot image state",
        false,
    ),
    command(
        "image.test",
        "Image: test",
        "Mark an image hash pending for one boot",
        false,
    ),
    command(
        "image.confirm",
        "Image: confirm",
        "Confirm an image hash or the running image",
        false,
    ),
    command(
        "image.upload",
        "Image: upload",
        "Stream a host-selected MCUboot image",
        true,
    ),
    command(
        "image.erase",
        "Image: erase",
        "Erase a secondary image slot",
        true,
    ),
    command(
        "image.slot-info",
        "Image: slot info",
        "Read image slot geometry",
        false,
    ),
    command(
        "image.core-list",
        "Image: core list",
        "List stored core dumps",
        false,
    ),
    command(
        "image.core-load",
        "Image: core load",
        "Execute a custom core-load field map",
        false,
    ),
    command(
        "image.file-read",
        "Image: legacy file read",
        "Execute the legacy image-file read command",
        false,
    ),
    command(
        "image.file-write",
        "Image: legacy file write",
        "Execute the legacy image-file write command",
        false,
    ),
    command("stats.list", "Stats: list", "List statistics groups", false),
    command(
        "stats.show",
        "Stats: show",
        "Read one statistics group",
        false,
    ),
    command("settings.read", "Settings: read", "Read one setting", false),
    command(
        "settings.write",
        "Settings: write",
        "Write one setting",
        false,
    ),
    command(
        "settings.delete",
        "Settings: delete",
        "Delete one setting",
        false,
    ),
    command(
        "settings.commit",
        "Settings: commit",
        "Commit pending settings",
        false,
    ),
    command(
        "settings.load",
        "Settings: load",
        "Load persisted settings",
        false,
    ),
    command("settings.save", "Settings: save", "Persist settings", false),
    command(
        "fs.upload",
        "Files: upload",
        "Stream a host-selected file to the target",
        true,
    ),
    command(
        "fs.download",
        "Files: download",
        "Stream a target file to an atomic host save grant",
        true,
    ),
    command("fs.status", "Files: status", "Read target file size", false),
    command(
        "fs.checksum",
        "Files: checksum",
        "Calculate a target file checksum",
        false,
    ),
    command(
        "fs.supported-checksums",
        "Files: checksum algorithms",
        "List supported checksum algorithms",
        false,
    ),
    command(
        "fs.close",
        "Files: close",
        "Close the target file context",
        false,
    ),
    command(
        "shell.execute",
        "Shell: execute",
        "Execute the configured argv",
        false,
    ),
    command(
        "enum.count",
        "Groups: count",
        "Read management group count",
        false,
    ),
    command(
        "enum.list",
        "Groups: list",
        "List management group IDs",
        false,
    ),
    command(
        "enum.single",
        "Groups: single",
        "Read one management group by index",
        false,
    ),
    command(
        "enum.details",
        "Groups: details",
        "Read management group details",
        false,
    ),
    command(
        "zephyr.erase-storage",
        "Zephyr: erase storage",
        "Erase application storage",
        true,
    ),
    command(
        "raw.execute",
        "Raw SMP request",
        "Execute arbitrary group/command CBOR",
        false,
    ),
    command(
        "automation.quick-command",
        "Create quick command",
        "Create a native BBCOM quick command for this workflow",
        false,
    ),
    command(
        "automation.macro",
        "Create macro",
        "Create a native BBCOM macro for this workflow",
        false,
    ),
];

const fn command(
    id: &'static str,
    title: &'static str,
    description: &'static str,
    long_running: bool,
) -> CommandSpec {
    CommandSpec {
        id,
        title,
        description,
        long_running,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionChoice {
    pub id: String,
    pub label: String,
    pub connected: bool,
}

pub fn build_all(state: &ClientState, sessions: &[SessionChoice]) -> Result<Vec<SurfaceDocument>> {
    SURFACES
        .iter()
        .map(|spec| build_surface(spec.id, state, sessions))
        .collect()
}

pub fn build_surface(
    surface_id: &str,
    state: &ClientState,
    sessions: &[SessionChoice],
) -> Result<SurfaceDocument> {
    match surface_id {
        "overview" => overview(state, sessions),
        "firmware" => firmware(state),
        "files" => files(state),
        "os" => os(state),
        "stats" => stats(state),
        "settings" => settings(state),
        "shell" => shell(state),
        "groups-raw" => groups_raw(state),
        "automation" => automation(state),
        _ => Err(ContractError::NotFound),
    }
}

fn overview(state: &ClientState, sessions: &[SessionChoice]) -> Result<SurfaceDocument> {
    let mut builder = root("overview", state.revision)?;
    builder.push(
        "root",
        "connection",
        10,
        UiNodeKind::Group {
            title: "Serial transaction lease".to_string(),
        },
    )?;
    let mut options = sessions
        .iter()
        .map(|session| {
            let suffix = if session.connected {
                "connected"
            } else {
                "disconnected"
            };
            (
                session.id.clone(),
                alloc::format!("{} ({suffix})", session.label),
            )
        })
        .collect::<Vec<_>>();
    let (session_value, session_disabled) = if options.is_empty() {
        options.push((
            "none".to_string(),
            "No BBCOM sessions available".to_string(),
        ));
        ("none".to_string(), true)
    } else {
        let selected = options
            .iter()
            .find(|(id, _)| id == &state.session_id)
            .map_or_else(|| options[0].0.clone(), |(id, _)| id.clone());
        (selected, false)
    };
    builder.push(
        "connection",
        "session-id",
        10,
        UiNodeKind::Select {
            label: "BBCOM session".to_string(),
            value: session_value,
            options,
            disabled: session_disabled,
        },
    )?;
    builder.push(
        "connection",
        "transport",
        20,
        UiNodeKind::Select {
            label: "Serial transport".to_string(),
            value: state.transport.as_str().to_string(),
            options: vec![
                ("console".to_string(), "SMP over console".to_string()),
                ("raw-uart".to_string(), "Raw UART SMP".to_string()),
            ],
            disabled: false,
        },
    )?;
    builder.push(
        "connection",
        "smp-version",
        30,
        UiNodeKind::Select {
            label: "SMP version".to_string(),
            value: if state.smp_v2 { "2" } else { "1" }.to_string(),
            options: vec![
                ("2".to_string(), "SMP v2".to_string()),
                ("1".to_string(), "SMP v1".to_string()),
            ],
            disabled: false,
        },
    )?;
    builder.push(
        "connection",
        "frame-size",
        40,
        UiNodeKind::NumberInput {
            label: "Maximum SMP frame bytes".to_string(),
            value: f64::from(state.frame_size),
            minimum: Some(64.0),
            maximum: Some(65_535.0),
            step: Some(1.0),
            disabled: false,
        },
    )?;
    builder.push(
        "connection",
        "timeout-ms",
        50,
        UiNodeKind::NumberInput {
            label: "Read timeout (ms)".to_string(),
            value: f64::from(state.timeout_ms),
            minimum: Some(1.0),
            maximum: Some(10_000.0),
            step: Some(100.0),
            disabled: false,
        },
    )?;
    builder.push(
        "connection",
        "retries",
        60,
        UiNodeKind::NumberInput {
            label: "Retries for read-only commands".to_string(),
            value: f64::from(state.retries),
            minimum: Some(0.0),
            maximum: Some(5.0),
            step: Some(1.0),
            disabled: false,
        },
    )?;
    builder.button("connection", "connection.check", 70, "Check connection")?;
    builder.push(
        "root",
        "status",
        20,
        UiNodeKind::Group {
            title: "Status".to_string(),
        },
    )?;
    builder.push(
        "status",
        "status-values",
        10,
        UiNodeKind::KeyValue {
            entries: vec![
                (
                    "Session".to_string(),
                    if state.session_id.is_empty() {
                        "Not selected".to_string()
                    } else {
                        state.session_id.clone()
                    },
                ),
                (
                    "Transport".to_string(),
                    state.transport.as_str().to_string(),
                ),
                ("Locale".to_string(), state.locale.clone()),
                ("Theme".to_string(), state.theme.clone()),
                ("Next sequence".to_string(), state.next_sequence.to_string()),
            ],
        },
    )?;
    builder.push(
        "status",
        "last-output",
        20,
        UiNodeKind::Log {
            text: surface_safe_output(&state.last_output),
            language: None,
        },
    )?;
    builder.build()
}

fn firmware(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("firmware", state.revision)?;
    builder.push(
        "root",
        "firmware-config",
        10,
        UiNodeKind::Group {
            title: "MCUboot image".to_string(),
        },
    )?;
    builder.push(
        "firmware-config",
        "image-index",
        10,
        UiNodeKind::NumberInput {
            label: "Image index".to_string(),
            value: f64::from(state.image),
            minimum: Some(0.0),
            maximum: Some(u32::MAX as f64),
            step: Some(1.0),
            disabled: false,
        },
    )?;
    builder.push(
        "firmware-config",
        "image-hash",
        20,
        UiNodeKind::Input {
            label: "Image SHA-256 (optional hex)".to_string(),
            value: state.image_hash_hex.clone(),
            placeholder: "64 hex characters".to_string(),
            disabled: false,
        },
    )?;
    builder.progress(
        "firmware-config",
        "firmware-progress",
        30,
        progress(state).0,
        progress(state).1,
        "Firmware transfer",
    )?;
    builder.button("firmware-config", "image.state", 40, "Read image state")?;
    builder.button("firmware-config", "image.slot-info", 50, "Read slot info")?;
    builder.button(
        "firmware-config",
        "image.upload",
        60,
        "Choose and upload firmware…",
    )?;
    builder.dangerous_button(
        "firmware-config",
        "image.test",
        70,
        "Test selected image",
        "Mark the selected image pending for the next boot? The device may revert if it is not confirmed.",
    )?;
    builder.dangerous_button(
        "firmware-config",
        "image.confirm",
        80,
        "Confirm selected image",
        "Permanently confirm the selected or running image? This changes MCUboot rollback behavior.",
    )?;
    builder.dangerous_button(
        "firmware-config",
        "image.erase",
        90,
        "Erase secondary slot",
        "Erase the target's secondary image slot? The stored upgrade image will be lost.",
    )?;
    builder.dangerous_button(
        "firmware-config",
        "os.reset",
        100,
        "Reset target",
        "Reset the target now? The serial connection may disconnect and in-flight device work will stop.",
    )?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn files(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("files", state.revision)?;
    builder.push(
        "root",
        "file-config",
        10,
        UiNodeKind::Group {
            title: "Target filesystem".to_string(),
        },
    )?;
    builder.push(
        "file-config",
        "remote-path",
        10,
        UiNodeKind::Input {
            label: "Device path (root-relative; omit the leading separator)".to_string(),
            value: device_path_to_ui(&state.remote_path)?,
            placeholder: "lfs1/file.bin".to_string(),
            disabled: false,
        },
    )?;
    builder.progress(
        "file-config",
        "file-progress",
        20,
        progress(state).0,
        progress(state).1,
        "File transfer",
    )?;
    builder.button(
        "file-config",
        "fs.upload",
        30,
        "Choose local file and upload…",
    )?;
    builder.button("file-config", "fs.download", 40, "Download to…")?;
    builder.button("file-config", "fs.status", 50, "File status")?;
    builder.button("file-config", "fs.checksum", 60, "SHA-256 checksum")?;
    builder.button(
        "file-config",
        "fs.supported-checksums",
        70,
        "Supported checksums",
    )?;
    builder.button("file-config", "fs.close", 80, "Close file context")?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn os(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("os", state.revision)?;
    builder.push(
        "root",
        "os-commands",
        10,
        UiNodeKind::Group {
            title: "Operating system management".to_string(),
        },
    )?;
    builder.push(
        "os-commands",
        "echo-text",
        10,
        UiNodeKind::Input {
            label: "Echo text".to_string(),
            value: state.echo_text.clone(),
            placeholder: "message".to_string(),
            disabled: false,
        },
    )?;
    builder.button("os-commands", "os.echo", 20, "Echo")?;
    builder.push(
        "os-commands",
        "datetime",
        30,
        UiNodeKind::Input {
            label: "Date/time (RFC 3339)".to_string(),
            value: state.datetime.clone(),
            placeholder: "2026-08-19T12:00:00Z".to_string(),
            disabled: false,
        },
    )?;
    builder.button("os-commands", "os.datetime-get", 40, "Get date/time")?;
    builder.button("os-commands", "os.datetime-set", 50, "Set date/time")?;
    builder.button("os-commands", "os.tasks", 60, "Task statistics")?;
    builder.button(
        "os-commands",
        "os.memory-pools",
        70,
        "Memory pool statistics",
    )?;
    builder.button("os-commands", "os.parameters", 80, "MCUmgr parameters")?;
    builder.button("os-commands", "os.application-info", 90, "Application info")?;
    builder.button("os-commands", "os.bootloader-info", 100, "Bootloader info")?;
    builder.dangerous_button(
        "os-commands",
        "os.reset",
        110,
        "Reset target",
        "Reset the target now? The serial connection may disconnect and in-flight device work will stop.",
    )?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn stats(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("stats", state.revision)?;
    builder.push(
        "root",
        "stats-commands",
        10,
        UiNodeKind::Group {
            title: "Statistics".to_string(),
        },
    )?;
    builder.push(
        "stats-commands",
        "stats-name",
        10,
        UiNodeKind::Input {
            label: "Group name".to_string(),
            value: state.stats_name.clone(),
            placeholder: "kernel".to_string(),
            disabled: false,
        },
    )?;
    builder.button("stats-commands", "stats.list", 20, "List groups")?;
    builder.button("stats-commands", "stats.show", 30, "Show group")?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn settings(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("settings", state.revision)?;
    builder.push(
        "root",
        "settings-commands",
        10,
        UiNodeKind::Group {
            title: "Settings".to_string(),
        },
    )?;
    builder.push(
        "settings-commands",
        "setting-name",
        10,
        UiNodeKind::Input {
            label: "Setting name".to_string(),
            value: state.setting_name.clone(),
            placeholder: "app/key".to_string(),
            disabled: false,
        },
    )?;
    builder.push(
        "settings-commands",
        "setting-value",
        20,
        UiNodeKind::Input {
            label: "Value (UTF-8)".to_string(),
            value: state.setting_value.clone(),
            placeholder: "value".to_string(),
            disabled: false,
        },
    )?;
    builder.button("settings-commands", "settings.read", 30, "Read")?;
    builder.button("settings-commands", "settings.write", 40, "Write")?;
    builder.dangerous_button(
        "settings-commands",
        "settings.delete",
        50,
        "Delete",
        "Delete the named setting from the target? This may alter application behavior and cannot be undone by BBCOM.",
    )?;
    builder.button("settings-commands", "settings.commit", 60, "Commit")?;
    builder.button("settings-commands", "settings.load", 70, "Load")?;
    builder.button("settings-commands", "settings.save", 80, "Save")?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn shell(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("shell", state.revision)?;
    builder.push(
        "root",
        "shell-command",
        10,
        UiNodeKind::Group {
            title: "Zephyr shell".to_string(),
        },
    )?;
    builder.push(
        "shell-command",
        "shell-line",
        10,
        UiNodeKind::Input {
            label: "Arguments".to_string(),
            value: state.shell_line.clone(),
            placeholder: "kernel version".to_string(),
            disabled: false,
        },
    )?;
    builder.text(
        "shell-command",
        "shell-help",
        20,
        "Arguments support quotes and backslash escapes; no local shell is invoked.",
    )?;
    builder.button("shell-command", "shell.execute", 30, "Execute")?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn groups_raw(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("groups-raw", state.revision)?;
    builder.push(
        "root",
        "enum-commands",
        10,
        UiNodeKind::Group {
            title: "Management group enumeration".to_string(),
        },
    )?;
    builder.button("enum-commands", "enum.count", 10, "Count groups")?;
    builder.button("enum-commands", "enum.list", 20, "List groups")?;
    builder.button("enum-commands", "enum.single", 30, "Read group by index")?;
    builder.button("enum-commands", "enum.details", 40, "Group details")?;
    builder.push(
        "root",
        "raw-command",
        20,
        UiNodeKind::Group {
            title: "Arbitrary SMP request".to_string(),
        },
    )?;
    builder.push(
        "raw-command",
        "raw-op",
        10,
        UiNodeKind::Select {
            label: "Operation".to_string(),
            value: if state.raw_op_write { "write" } else { "read" }.to_string(),
            options: vec![
                ("read".to_string(), "Read".to_string()),
                ("write".to_string(), "Write".to_string()),
            ],
            disabled: false,
        },
    )?;
    builder.push(
        "raw-command",
        "raw-group",
        20,
        UiNodeKind::NumberInput {
            label: "Group ID".to_string(),
            value: f64::from(state.raw_group),
            minimum: Some(0.0),
            maximum: Some(65_535.0),
            step: Some(1.0),
            disabled: false,
        },
    )?;
    builder.push(
        "raw-command",
        "raw-command-id",
        30,
        UiNodeKind::NumberInput {
            label: "Command ID".to_string(),
            value: f64::from(state.raw_command),
            minimum: Some(0.0),
            maximum: Some(255.0),
            step: Some(1.0),
            disabled: false,
        },
    )?;
    builder.push(
        "raw-command",
        "raw-format",
        40,
        UiNodeKind::Select {
            label: "Payload format".to_string(),
            value: state.raw_format.as_str().to_string(),
            options: vec![
                ("json".to_string(), "JSON → CBOR".to_string()),
                ("cbor-hex".to_string(), "CBOR hex".to_string()),
            ],
            disabled: false,
        },
    )?;
    builder.push(
        "raw-command",
        "raw-payload",
        50,
        UiNodeKind::Input {
            label: "Payload".to_string(),
            value: state.raw_payload.clone(),
            placeholder: "{} or a0".to_string(),
            disabled: false,
        },
    )?;
    builder.dangerous_button(
        "raw-command",
        "raw.execute",
        60,
        "Execute raw request",
        "Send the configured arbitrary SMP request? Raw writes can mutate or erase device state.",
    )?;
    builder.dangerous_button(
        "raw-command",
        "zephyr.erase-storage",
        70,
        "Erase Zephyr storage",
        "Erase all application storage exposed by the Zephyr management group? This is destructive and cannot be undone.",
    )?;
    output_group(&mut builder, state, 30)?;
    builder.build()
}

fn automation(state: &ClientState) -> Result<SurfaceDocument> {
    let mut builder = root("automation", state.revision)?;
    builder.push(
        "root",
        "automation-contributions",
        10,
        UiNodeKind::Group {
            title: "Native BBCOM contributions".to_string(),
        },
    )?;
    builder.text("automation-contributions", "automation-note", 10,
        "Create workspace-native quick commands and macros. BBCOM namespaces them to this plugin; they can continue running while the plugin is disabled.")?;
    builder.button(
        "automation-contributions",
        "automation.quick-command",
        20,
        "Create echo quick command",
    )?;
    builder.button(
        "automation-contributions",
        "automation.macro",
        30,
        "Create MCUmgr preparation macro",
    )?;
    builder.push(
        "automation-contributions",
        "automation-values",
        40,
        UiNodeKind::KeyValue {
            entries: vec![
                (
                    "Quick command local ID".to_string(),
                    "mcumgr-echo".to_string(),
                ),
                ("Macro local ID".to_string(), "mcumgr-prepare".to_string()),
            ],
        },
    )?;
    output_group(&mut builder, state, 20)?;
    builder.build()
}

fn root(surface_id: &str, revision: u64) -> Result<SurfaceBuilder> {
    SurfaceBuilder::new(surface_id, revision, UiNodeKind::Column)
}

fn output_group(builder: &mut SurfaceBuilder, state: &ClientState, order: u32) -> Result<()> {
    builder.push(
        "root",
        "output",
        order,
        UiNodeKind::Group {
            title: "Result".to_string(),
        },
    )?;
    builder.push(
        "output",
        "last-output",
        10,
        UiNodeKind::Code {
            text: surface_safe_output(&state.last_output),
            language: Some("cbor".to_string()),
        },
    )?;
    Ok(())
}

fn progress(state: &ClientState) -> (u32, u32) {
    if state.transfer_total == 0 {
        return (0, 1);
    }
    if state.transfer_total <= u64::from(u32::MAX) {
        return (
            state.transfer_completed.min(state.transfer_total) as u32,
            state.transfer_total as u32,
        );
    }
    let completed = state
        .transfer_completed
        .min(state.transfer_total)
        .saturating_mul(10_000)
        / state.transfer_total;
    (completed as u32, 10_000)
}

/// Encode only presentation-sensitive characters. The stored command result
/// remains unchanged, while the host-rendered copy cannot be mistaken for
/// markup, a URL, or an absolute native path. Escaping backslashes first makes
/// this representation unambiguous and reversible.
fn surface_safe_output(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut leading_www_prefix = 0_u8;
    for character in value.chars() {
        if character.is_ascii_whitespace() {
            if matches!(character, ' ' | '\t' | '\n' | '\r') {
                output.push(character);
            } else {
                push_unicode_escape(&mut output, character);
            }
            leading_www_prefix = 0;
            continue;
        }
        let is_www_dot = character == '.' && leading_www_prefix == 3;
        if matches!(character, '<' | '>' | ':' | '/' | '\\') || is_www_dot || character.is_control()
        {
            push_unicode_escape(&mut output, character);
        } else {
            output.push(character);
        }
        leading_www_prefix = match (leading_www_prefix, character) {
            (0..=2, 'w' | 'W') => leading_www_prefix + 1,
            _ => 4,
        };
    }
    output
}

fn push_unicode_escape(output: &mut String, character: char) {
    use core::fmt::Write;

    let _ = write!(output, "\\u{:04x}", u32::from(character));
}

#[derive(Clone, Debug, PartialEq)]
pub enum InteractionValue {
    Text(String),
    Number(f64),
    Toggle(bool),
    Selection(String),
    Action,
}

/// Apply an editable field or return the command contribution associated with
/// an action node. Unknown/forged nodes are rejected, never ignored.
pub fn apply_interaction<'a>(
    state: &mut ClientState,
    node_id: &'a str,
    value: InteractionValue,
) -> Result<Option<&'a str>> {
    match (node_id, value) {
        ("session-id", InteractionValue::Selection(value) | InteractionValue::Text(value)) => {
            state.session_id = value
        }
        ("transport", InteractionValue::Selection(value)) => {
            state.transport = TransportMode::parse(&value)?
        }
        ("smp-version", InteractionValue::Selection(value)) => {
            state.smp_v2 = match value.as_str() {
                "1" => false,
                "2" => true,
                _ => return Err(ContractError::InvalidInput),
            }
        }
        ("frame-size", InteractionValue::Number(value)) => {
            state.frame_size = checked_integer(value, 64, 65_535)? as u32
        }
        ("timeout-ms", InteractionValue::Number(value)) => {
            state.timeout_ms = checked_integer(value, 1, 10_000)? as u32
        }
        ("retries", InteractionValue::Number(value)) => {
            state.retries = checked_integer(value, 0, 5)? as u8
        }
        ("image-index", InteractionValue::Number(value)) => {
            state.image = checked_integer(value, 0, u32::MAX as u64)? as u32
        }
        ("image-hash", InteractionValue::Text(value)) => state.image_hash_hex = value,
        ("remote-path", InteractionValue::Text(value)) => {
            state.remote_path = device_path_from_ui(&value)?
        }
        ("echo-text", InteractionValue::Text(value)) => state.echo_text = value,
        ("datetime", InteractionValue::Text(value)) => state.datetime = value,
        ("stats-name", InteractionValue::Text(value)) => state.stats_name = value,
        ("setting-name", InteractionValue::Text(value)) => state.setting_name = value,
        ("setting-value", InteractionValue::Text(value)) => state.setting_value = value,
        ("shell-line", InteractionValue::Text(value)) => state.shell_line = value,
        ("raw-op", InteractionValue::Selection(value)) => {
            state.raw_op_write = match value.as_str() {
                "read" => false,
                "write" => true,
                _ => return Err(ContractError::InvalidInput),
            }
        }
        ("raw-group", InteractionValue::Number(value)) => {
            state.raw_group = checked_integer(value, 0, 65_535)? as u16
        }
        ("raw-command-id", InteractionValue::Number(value)) => {
            state.raw_command = checked_integer(value, 0, 255)? as u8
        }
        ("raw-format", InteractionValue::Selection(value)) => {
            state.raw_format = RawInputFormat::parse(&value)?
        }
        ("raw-payload", InteractionValue::Text(value)) => state.raw_payload = value,
        (id, InteractionValue::Action) if COMMANDS.iter().any(|command| command.id == id) => {
            return Ok(Some(id));
        }
        _ => return Err(ContractError::InvalidInput),
    }
    state.validate()?;
    Ok(None)
}

fn checked_integer(value: f64, minimum: u64, maximum: u64) -> Result<u64> {
    if !value.is_finite()
        || value < minimum as f64
        || value > maximum as f64
        || (value as u64) as f64 != value
    {
        Err(ContractError::InvalidInput)
    } else {
        Ok(value as u64)
    }
}

#[cfg(test)]
mod tests {
    use alloc::collections::BTreeSet;

    use bbcom_plugin_sdk::ui::{validate_document, UiNodeKind};

    use super::*;

    #[test]
    fn all_nine_surface_models_are_valid_and_have_stable_unique_nodes() {
        let state = ClientState::default();
        let documents = build_all(
            &state,
            &[SessionChoice {
                id: "s1".to_string(),
                label: "Device".to_string(),
                connected: true,
            }],
        )
        .unwrap();
        assert_eq!(documents.len(), 9);
        assert_eq!(
            documents
                .iter()
                .map(|document| document.surface_id.as_str())
                .collect::<Vec<_>>(),
            [
                "overview",
                "firmware",
                "files",
                "os",
                "stats",
                "settings",
                "shell",
                "groups-raw",
                "automation"
            ]
        );
        for document in &documents {
            validate_document(document).unwrap();
            let ids: BTreeSet<_> = document.nodes.iter().map(|node| &node.id).collect();
            assert_eq!(ids.len(), document.nodes.len());
        }
    }

    #[test]
    fn destructive_operations_are_host_rendered_dangerous_buttons() {
        let documents = build_all(&ClientState::default(), &[]).unwrap();
        for required in [
            "image.test",
            "image.confirm",
            "image.erase",
            "os.reset",
            "settings.delete",
            "raw.execute",
            "zephyr.erase-storage",
        ] {
            let node = documents
                .iter()
                .flat_map(|document| &document.nodes)
                .find(|node| node.id == required)
                .unwrap();
            assert!(
                matches!(node.kind, UiNodeKind::DangerousButton { .. }),
                "{required}"
            );
        }
    }

    #[test]
    fn session_selector_has_a_valid_disabled_placeholder_and_repairs_stale_selection() {
        let empty = build_surface("overview", &ClientState::default(), &[]).unwrap();
        let selector = empty
            .nodes
            .iter()
            .find(|node| node.id == "session-id")
            .unwrap();
        assert!(matches!(
            &selector.kind,
            UiNodeKind::Select { value, options, disabled, .. }
                if value == "none"
                    && options == &vec![("none".to_string(), "No BBCOM sessions available".to_string())]
                    && *disabled
        ));

        let stale = ClientState {
            session_id: "removed-session".to_string(),
            ..ClientState::default()
        };
        let repaired = build_surface(
            "overview",
            &stale,
            &[SessionChoice {
                id: "session-1".to_string(),
                label: "Device".to_string(),
                connected: true,
            }],
        )
        .unwrap();
        let selector = repaired
            .nodes
            .iter()
            .find(|node| node.id == "session-id")
            .unwrap();
        assert!(matches!(
            &selector.kind,
            UiNodeKind::Select { value, disabled, .. }
                if value == "session-1" && !*disabled
        ));
    }

    #[test]
    fn interactions_are_typed_bounded_and_action_nodes_map_to_commands() {
        let mut state = ClientState::default();
        assert_eq!(
            apply_interaction(
                &mut state,
                "transport",
                InteractionValue::Selection("raw-uart".to_string())
            ),
            Ok(None)
        );
        assert_eq!(state.transport, TransportMode::RawUart);
        assert_eq!(
            apply_interaction(&mut state, "timeout-ms", InteractionValue::Number(10_001.0)),
            Err(ContractError::InvalidInput)
        );
        assert_eq!(
            apply_interaction(&mut state, "image.upload", InteractionValue::Action),
            Ok(Some("image.upload"))
        );
        assert_eq!(
            apply_interaction(&mut state, "forged", InteractionValue::Action),
            Err(ContractError::InvalidInput)
        );
    }

    #[test]
    fn device_paths_use_a_safe_root_relative_ui_encoding() {
        let mut state = ClientState::default();
        let files = build_all(&state, &[])
            .unwrap()
            .into_iter()
            .find(|document| document.surface_id == "files")
            .unwrap();
        let remote_path = files
            .nodes
            .into_iter()
            .find(|node| node.id == "remote-path")
            .unwrap();
        assert!(matches!(
            remote_path.kind,
            UiNodeKind::Input { value, placeholder, .. }
                if value == "lfs1/upload.bin" && placeholder == "lfs1/file.bin"
        ));

        apply_interaction(
            &mut state,
            "remote-path",
            InteractionValue::Text("lfs1/space%20name%3A1.bin".to_string()),
        )
        .unwrap();
        assert_eq!(state.remote_path, "/lfs1/space name:1.bin");
        for forged in [
            "/etc/passwd",
            "lfs1/../secret",
            "lfs1/%2E%2E/secret",
            "lfs1\\secret",
            "lfs1//secret",
            "lfs1/%00secret",
            "lfs1/%GG",
        ] {
            assert_eq!(
                device_path_from_ui(forged),
                Err(ContractError::InvalidInput),
                "{forged}"
            );
        }
    }

    #[test]
    fn device_and_command_output_is_escaped_before_host_presentation() {
        let displayed = surface_safe_output(
            "opened /lfs1/a.bin; https://device.invalid; C:\\host; www.example; <tag>",
        );
        assert_eq!(
            displayed,
            "opened \\u002flfs1\\u002fa.bin; https\\u003a\\u002f\\u002fdevice.invalid; C\\u003a\\u005chost; www\\u002eexample; \\u003ctag\\u003e"
        );
        assert!(!displayed.contains("/lfs1"));
        assert!(!displayed.contains("://"));
    }

    #[test]
    fn every_command_id_is_unique_and_surface_actions_are_registered() {
        let ids: BTreeSet<_> = COMMANDS.iter().map(|command| command.id).collect();
        assert_eq!(ids.len(), COMMANDS.len());
        let action_ids: BTreeSet<_> = build_all(&ClientState::default(), &[])
            .unwrap()
            .into_iter()
            .flat_map(|document| document.nodes)
            .filter_map(|node| match node.kind {
                UiNodeKind::Button { .. } | UiNodeKind::DangerousButton { .. } => Some(node.id),
                _ => None,
            })
            .collect();
        assert!(action_ids.iter().all(|id| ids.contains(id.as_str())));
    }
}
