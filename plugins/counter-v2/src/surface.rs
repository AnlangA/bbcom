use alloc::string::{String, ToString};
use alloc::vec;

use bbcom_plugin_sdk::ui::{SurfaceBuilder, SurfaceDocument, UiNodeKind};
use bbcom_plugin_sdk::{ContractError, Result};

use crate::model::CounterState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionChoice {
    pub id: String,
    pub label: String,
    pub connected: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
}

pub const COMMANDS: &[CommandSpec] = &[
    command(
        "counter.increment",
        "Counter: increment",
        "Increment the persisted counter",
    ),
    command(
        "counter.reset",
        "Counter: reset",
        "Reset the persisted counter to zero",
    ),
    command(
        "counter.send",
        "Counter: send over leased serial session",
        "Acquire a transaction lease, write the counter once, and release it",
    ),
    command(
        "counter.create-quick-command",
        "Counter: create quick command",
        "Create a plugin-owned native quick command with the current value",
    ),
    command(
        "counter.create-macro",
        "Counter: create macro",
        "Create a plugin-owned native two-step macro",
    ),
];

const fn command(id: &'static str, title: &'static str, description: &'static str) -> CommandSpec {
    CommandSpec {
        id,
        title,
        description,
    }
}

pub fn build_surface(state: &CounterState, sessions: &[SessionChoice]) -> Result<SurfaceDocument> {
    let mut builder = SurfaceBuilder::new("counter", state.revision, UiNodeKind::Column)?;
    builder.push(
        "root",
        "summary",
        10,
        UiNodeKind::Group {
            title: "Protocol v2 counter".to_string(),
        },
    )?;
    builder.push(
        "summary",
        "values",
        10,
        UiNodeKind::KeyValue {
            entries: vec![
                ("Count".to_string(), state.count.to_string()),
                (
                    "Selected session".to_string(),
                    session_label(&state.session_id, sessions),
                ),
                ("Last result".to_string(), state.last_status.clone()),
            ],
        },
    )?;
    builder.push(
        "root",
        "controls",
        20,
        UiNodeKind::Group {
            title: "Host-rendered actions".to_string(),
        },
    )?;
    builder.push(
        "controls",
        "session",
        10,
        UiNodeKind::Select {
            label: "Serial session".to_string(),
            value: state.session_id.clone(),
            options: sessions
                .iter()
                .map(|session| {
                    let suffix = if session.connected {
                        "connected"
                    } else {
                        "offline"
                    };
                    (
                        session.id.clone(),
                        alloc::format!("{} ({suffix})", session.label),
                    )
                })
                .collect(),
            disabled: sessions.is_empty(),
        },
    )?;
    builder.button("controls", "counter.increment", 20, "Increment")?;
    builder.button("controls", "counter.send", 30, "Send using serial lease")?;
    builder.button(
        "controls",
        "counter.create-quick-command",
        40,
        "Create native quick command",
    )?;
    builder.button(
        "controls",
        "counter.create-macro",
        50,
        "Create native macro",
    )?;
    builder.dangerous_button(
        "controls",
        "counter.reset",
        60,
        "Reset counter",
        "Reset the persisted example counter to zero? This cannot be undone.",
    )?;
    builder.text(
        "root",
        "explanation",
        30,
        "The guest never opens a serial device. BBCOM grants a scoped transaction lease and owns the native quick command and macro entries.",
    )?;
    builder.build()
}

pub fn apply_interaction(
    state: &mut CounterState,
    node_id: &str,
    value: InteractionValue,
) -> Result<Option<&'static str>> {
    match (node_id, value) {
        ("session", InteractionValue::Selection(value))
            if !value.is_empty() && value.len() <= 128 =>
        {
            state.session_id = value;
            state.last_status = "Serial session selected".to_string();
            Ok(None)
        }
        (id, InteractionValue::Action) => COMMANDS
            .iter()
            .find(|command| command.id == id)
            .map(|command| Some(command.id))
            .ok_or(ContractError::NotFound),
        _ => Err(ContractError::InvalidInput),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum InteractionValue {
    Selection(String),
    Action,
    Unsupported,
}

fn session_label(session_id: &str, sessions: &[SessionChoice]) -> String {
    sessions
        .iter()
        .find(|session| session.id == session_id)
        .map(|session| session.label.clone())
        .unwrap_or_else(|| {
            if session_id.is_empty() {
                "None".to_string()
            } else {
                "Unavailable".to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> Vec<SessionChoice> {
        vec![SessionChoice {
            id: "s1".to_string(),
            label: "Device".to_string(),
            connected: true,
        }]
    }

    #[test]
    fn surface_has_stable_actions_and_host_confirmation() {
        let document = build_surface(&CounterState::default(), &sessions()).unwrap();
        bbcom_plugin_sdk::ui::validate_document(&document).unwrap();
        for command in COMMANDS {
            assert!(document.nodes.iter().any(|node| node.id == command.id));
        }
        let reset = document
            .nodes
            .iter()
            .find(|node| node.id == "counter.reset")
            .unwrap();
        assert!(matches!(
            &reset.kind,
            UiNodeKind::DangerousButton { confirmation, .. }
                if confirmation.contains("persisted example counter")
        ));
    }

    #[test]
    fn interactions_are_typed_and_unknown_actions_fail_closed() {
        let mut state = CounterState::default();
        assert_eq!(
            apply_interaction(
                &mut state,
                "session",
                InteractionValue::Selection("s1".to_string())
            ),
            Ok(None)
        );
        assert_eq!(state.session_id, "s1");
        assert_eq!(
            apply_interaction(&mut state, "counter.increment", InteractionValue::Action),
            Ok(Some("counter.increment"))
        );
        assert_eq!(
            apply_interaction(&mut state, "forged", InteractionValue::Action),
            Err(ContractError::NotFound)
        );
    }
}
