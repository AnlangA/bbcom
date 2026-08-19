//! Generated WIT adapter. Business logic remains in testable `alloc` modules.

#![allow(clippy::too_many_arguments)]

wit_bindgen::generate!({
    path: "../../wit/bbcom-plugin-v2",
    world: "plugin",
    std_feature,
});

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use bbcom_plugin_sdk::serial::{WriteOutcome, WriteResult};
use bbcom_plugin_sdk::ui::{SurfaceDocument, UiNode, UiNodeKind};
use bbcom_plugin_sdk::ContractError as SdkError;

use self::bbcom::plugin::{host, types};
use crate::model::{migrate, CounterState, STATE_SCHEMA};
use crate::surface::{
    apply_interaction, build_surface, CommandSpec, InteractionValue, SessionChoice, COMMANDS,
};
use crate::workflow::{counter_payload, send_counter, CounterLease};

struct CounterGuest;

impl Guest for CounterGuest {
    fn initialize(context: types::HostContext) -> Result<types::PluginModel, types::ContractError> {
        let mut state = load_state()?;
        if state.session_id.is_empty() {
            if let Some(session) = context
                .sessions
                .iter()
                .find(|session| session.connected)
                .or_else(|| context.sessions.first())
            {
                state.session_id = session.session_id.clone();
            }
        }
        state.validate().map_err(to_wit_error)?;
        persist_state(&state)?;
        let model = plugin_model();
        register_model(&model)?;
        publish(&state)?;
        Ok(model)
    }

    fn handle_event(event: types::PluginEvent) -> Result<types::EventResult, types::ContractError> {
        let mut state = load_state()?;
        match event {
            types::PluginEvent::Surface(interaction) => {
                if interaction.surface_id != "counter" || interaction.revision != state.revision {
                    return Err(types::ContractError::StaleHandle);
                }
                let action = apply_interaction(
                    &mut state,
                    &interaction.node_id,
                    from_wit_value(interaction.value),
                )
                .map_err(to_wit_error)?;
                if let Some(command) = action {
                    execute(command, &[], &mut state)?;
                }
                state.bump_revision();
                persist_state(&state)?;
                publish(&state)?;
            }
            types::PluginEvent::PortCatalogChanged => publish(&state)?,
            types::PluginEvent::LocaleChanged(_) | types::PluginEvent::ThemeChanged(_) => {
                state.bump_revision();
                persist_state(&state)?;
                publish(&state)?;
            }
            types::PluginEvent::CancelTask(_) => {}
        }
        Ok(types::EventResult { accepted: true })
    }

    fn run_command(
        invocation: types::CommandInvocation,
    ) -> Result<types::CommandResult, types::ContractError> {
        let mut state = load_state()?;
        let message = execute(&invocation.command_id, &invocation.arguments, &mut state)?;
        state.bump_revision();
        persist_state(&state)?;
        publish(&state)?;
        Ok(types::CommandResult { message })
    }

    fn migrate_state(
        previous_api: String,
        state: Vec<u8>,
    ) -> Result<types::MigratedState, types::ContractError> {
        let state = migrate(&previous_api, &state).map_err(to_wit_error)?;
        Ok(types::MigratedState {
            schema_version: STATE_SCHEMA,
            state: state.encode().map_err(to_wit_error)?,
        })
    }

    fn shutdown() {}
}

fn execute(
    command_id: &str,
    arguments: &[String],
    state: &mut CounterState,
) -> Result<String, types::ContractError> {
    if !COMMANDS.iter().any(|command| command.id == command_id) {
        return Err(types::ContractError::NotFound);
    }
    if let Some(session_id) = arguments.first().filter(|value| !value.is_empty()) {
        state.session_id = session_id.clone();
    }
    match command_id {
        "counter.increment" => {
            state.increment();
            Ok(format!("Counter is now {}", state.count))
        }
        "counter.reset" => {
            state.reset();
            Ok("Counter reset to zero".to_string())
        }
        "counter.send" => send_with_host_lease(state),
        "counter.create-quick-command" => create_quick_command(state),
        "counter.create-macro" => create_macro(state),
        _ => Err(types::ContractError::NotFound),
    }
}

fn send_with_host_lease(state: &mut CounterState) -> Result<String, types::ContractError> {
    if state.session_id.is_empty() {
        return Err(types::ContractError::InvalidInput);
    }
    let lease = host::acquire_serial_lease(
        &state.session_id,
        types::SerialLeaseOptions {
            pause_automation: true,
            rx_buffer_bytes: 4_096,
        },
    )?;
    let mut lease = HostLease(lease);
    let sent = send_counter(&mut lease, state.count).map_err(to_wit_error)?;
    state.last_status = format!("Sent {sent} bytes under an exclusive lease");
    Ok(state.last_status.clone())
}

fn create_quick_command(state: &mut CounterState) -> Result<String, types::ContractError> {
    if state.session_id.is_empty() {
        return Err(types::ContractError::InvalidInput);
    }
    let owner_id = host::upsert_quick_command(&types::QuickCommand {
        local_id: "send-current-count".to_string(),
        title: "Send current counter".to_string(),
        session_id: state.session_id.clone(),
        payload: counter_payload(state.count),
        append_newline: false,
    })?;
    state.last_status = format!("Created native quick command {owner_id}");
    Ok(state.last_status.clone())
}

fn create_macro(state: &mut CounterState) -> Result<String, types::ContractError> {
    if state.session_id.is_empty() {
        return Err(types::ContractError::InvalidInput);
    }
    let owner_id = host::upsert_macro(&types::MacroContribution {
        local_id: "announce-current-count".to_string(),
        title: "Announce current counter".to_string(),
        session_id: state.session_id.clone(),
        steps: vec![
            types::MacroStep {
                delay_ms: 0,
                payload: b"counter-begin\n".to_vec(),
            },
            types::MacroStep {
                delay_ms: 100,
                payload: counter_payload(state.count),
            },
        ],
    })?;
    state.last_status = format!("Created native macro {owner_id}");
    Ok(state.last_status.clone())
}

fn load_state() -> Result<CounterState, types::ContractError> {
    if let Some(state) = host::project_state_get()? {
        return decode_project_state(state);
    }
    Ok(CounterState::default())
}

fn persist_state(state: &CounterState) -> Result<(), types::ContractError> {
    host::project_state_set(&types::ProjectState {
        schema_version: STATE_SCHEMA,
        value: state.encode().map_err(to_wit_error)?,
    })
}

fn decode_project_state(state: types::ProjectState) -> Result<CounterState, types::ContractError> {
    if state.schema_version != STATE_SCHEMA {
        return Err(types::ContractError::InvalidInput);
    }
    CounterState::decode(&state.value).map_err(to_wit_error)
}

fn plugin_model() -> types::PluginModel {
    types::PluginModel {
        surfaces: vec![types::PluginSurface {
            surface_id: "counter".to_string(),
            title: "Counter v2".to_string(),
            location: types::SurfaceLocation::Workspace,
        }],
        commands: COMMANDS.iter().map(wit_command).collect(),
    }
}

/// Initial declarations must reach the capability gateway before the first
/// snapshot. The returned model remains the guest-export contract; explicit
/// registration also makes initialization ordering unambiguous for hosts that
/// process guest imports while `initialize` is still executing.
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
        long_running: false,
        confirmation: (command.id == "counter.reset")
            .then(|| "Reset the persisted counter to zero?".to_string()),
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

fn publish(state: &CounterState) -> Result<(), types::ContractError> {
    let document = build_surface(state, &sessions()?).map_err(to_wit_error)?;
    host::publish_surface_snapshot(&wit_snapshot(document)?)
}

fn wit_snapshot(document: SurfaceDocument) -> Result<types::SurfaceSnapshot, types::ContractError> {
    Ok(types::SurfaceSnapshot {
        surface_id: document.surface_id,
        revision: document.revision,
        root_node_id: document.root_node_id,
        nodes: document
            .nodes
            .into_iter()
            .map(wit_node)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn wit_node(node: UiNode) -> Result<types::UiNode, types::ContractError> {
    let kind = match node.kind {
        UiNodeKind::Column => types::UiNodeKind::Column,
        UiNodeKind::Group { title } => types::UiNodeKind::Group(types::GroupNode { title }),
        UiNodeKind::Text { text } => types::UiNodeKind::Text(types::TextNode { text }),
        UiNodeKind::KeyValue { entries } => types::UiNodeKind::KeyValue(types::KeyValueNode {
            entries: entries
                .into_iter()
                .map(|(key, value)| types::KeyValueEntry { key, value })
                .collect(),
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
        UiNodeKind::Button { label, disabled } => types::UiNodeKind::Button(types::ButtonNode {
            label,
            disabled,
            confirmation: None,
        }),
        UiNodeKind::DangerousButton {
            label,
            disabled,
            confirmation,
        } => types::UiNodeKind::DangerousButton(types::ButtonNode {
            label,
            disabled,
            confirmation: Some(confirmation),
        }),
        _ => return Err(types::ContractError::ProtocolError),
    };
    Ok(types::UiNode {
        id: node.id,
        parent_id: node.parent_id,
        order: node.order,
        kind,
    })
}

fn from_wit_value(value: types::UiValue) -> InteractionValue {
    match value {
        types::UiValue::Selection(value) => InteractionValue::Selection(value),
        types::UiValue::Action => InteractionValue::Action,
        _ => InteractionValue::Unsupported,
    }
}

struct HostLease(host::SerialLease);

impl CounterLease for HostLease {
    fn write(&mut self, payload: &[u8]) -> bbcom_plugin_sdk::Result<WriteResult> {
        self.0
            .write(payload)
            .map(|result| WriteResult {
                requested: result.requested,
                sent: result.sent,
                outcome: match result.outcome {
                    types::WriteOutcome::Completed => WriteOutcome::Completed,
                    types::WriteOutcome::PartialWrite => WriteOutcome::PartialWrite,
                    types::WriteOutcome::UnknownOutcome => WriteOutcome::UnknownOutcome,
                },
            })
            .map_err(from_wit_error)
    }

    fn release(&mut self) -> bbcom_plugin_sdk::Result<()> {
        self.0.release().map_err(from_wit_error)
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

#[cfg(test)]
mod component_tests {
    use super::*;

    #[test]
    fn project_state_accepts_only_the_counter_schema() {
        let encoded = CounterState::default().encode().unwrap();
        assert!(decode_project_state(types::ProjectState {
            schema_version: STATE_SCHEMA,
            value: encoded.clone(),
        })
        .is_ok());
        for schema_version in [0, STATE_SCHEMA + 1, 73] {
            assert!(matches!(
                decode_project_state(types::ProjectState {
                    schema_version,
                    value: encoded.clone(),
                }),
                Err(types::ContractError::InvalidInput)
            ));
        }
    }
}

export!(CounterGuest);
