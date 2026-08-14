use std::collections::BTreeSet;

use bbcom_plugin_contracts::AuthorizationKey;

use crate::{
    AuditEvent, AuditOperation, AuditSink, BrokerError, LimitKind, Result,
    validate_authorization_key,
};

pub const MAX_PANEL_NODES: usize = 256;
pub const MAX_PANEL_DEPTH: usize = 1;
pub const MAX_PANEL_OPTIONS: usize = 64;
pub const MAX_PANEL_TEXT_BYTES: usize = 64 * 1024;
const MAX_TITLE_BYTES: usize = 128;
const MAX_ID_BYTES: usize = 64;
const MAX_LABEL_BYTES: usize = 256;
const MAX_VALUE_BYTES: usize = 4 * 1024;
const MAX_OPTION_BYTES: usize = 256;

/// Exact whitelist from the v1 WIT `field-kind` enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelControlKind {
    Text,
    Number,
    Toggle,
    Select,
    Button,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelField {
    pub id: String,
    pub label: String,
    pub kind: PanelControlKind,
    pub value: String,
    pub options: Vec<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarativePanel {
    pub title: String,
    pub fields: Vec<PanelField>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelEvent {
    pub field_id: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanelValidation {
    pub node_count: usize,
    pub depth: usize,
    pub option_count: usize,
    pub text_bytes: usize,
}

/// A validated panel associated with one cryptographically-scoped plugin.
/// Fields remain declarative data; the trusted application owns rendering.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedPanel {
    plugin_id: String,
    panel: DeclarativePanel,
    validation: PanelValidation,
}

impl HostedPanel {
    #[must_use]
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    #[must_use]
    pub const fn panel(&self) -> &DeclarativePanel {
        &self.panel
    }

    #[must_use]
    pub const fn validation(&self) -> PanelValidation {
        self.validation
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelEventAction {
    pub plugin_id: String,
    pub event: PanelEvent,
}

pub struct DeclarativePanelBroker<'a, A> {
    audit: &'a A,
}

impl<'a, A: AuditSink> DeclarativePanelBroker<'a, A> {
    #[must_use]
    pub const fn new(audit: &'a A) -> Self {
        Self { audit }
    }

    pub fn publish(&self, key: &AuthorizationKey, panel: DeclarativePanel) -> Result<HostedPanel> {
        validate_authorization_key(key)?;
        let result = validate_panel(&panel);
        self.audit.record(AuditEvent {
            plugin_id: key.plugin_id.clone(),
            operation: AuditOperation::PanelPublish,
            error_code: result.as_ref().err().copied().map(BrokerError::code),
            byte_count: result
                .as_ref()
                .map_or(0, |validation| validation.text_bytes as u64),
        });
        Ok(HostedPanel {
            plugin_id: key.plugin_id.clone(),
            panel,
            validation: result?,
        })
    }

    pub fn event(&self, hosted: &HostedPanel, event: PanelEvent) -> Result<PanelEventAction> {
        let result = validate_panel_event(&hosted.panel, &event);
        self.audit.record(AuditEvent {
            plugin_id: hosted.plugin_id.clone(),
            operation: AuditOperation::PanelEvent,
            error_code: result.as_ref().err().copied().map(BrokerError::code),
            byte_count: event.value.len() as u64,
        });
        result?;
        Ok(PanelEventAction {
            plugin_id: hosted.plugin_id.clone(),
            event,
        })
    }
}

/// Validate the flat v1 WIT panel. Its fixed depth is one; plugins cannot
/// construct DOM trees, HTML, scripts, URLs, or arbitrary widget types.
pub fn validate_panel(panel: &DeclarativePanel) -> Result<PanelValidation> {
    validate_safe_text(&panel.title, MAX_TITLE_BYTES, false)?;
    if panel.fields.is_empty() || panel.fields.len() > MAX_PANEL_NODES {
        return Err(BrokerError::PanelLimitExceeded(LimitKind::PanelNodes));
    }
    if MAX_PANEL_DEPTH < 1 {
        return Err(BrokerError::PanelLimitExceeded(LimitKind::PanelDepth));
    }
    let mut ids = BTreeSet::new();
    let mut option_count = 0usize;
    let mut text_bytes = panel.title.len();
    for field in &panel.fields {
        if !valid_id(&field.id) || !ids.insert(field.id.as_str()) {
            return Err(BrokerError::PanelInvalid);
        }
        validate_safe_text(&field.label, MAX_LABEL_BYTES, false)?;
        validate_safe_text(&field.value, MAX_VALUE_BYTES, true)?;
        if field.options.len() > MAX_PANEL_OPTIONS {
            return Err(BrokerError::PanelLimitExceeded(LimitKind::PanelOptions));
        }
        let mut unique_options = BTreeSet::new();
        for option in &field.options {
            validate_safe_text(option, MAX_OPTION_BYTES, false)?;
            if !unique_options.insert(option.as_str()) {
                return Err(BrokerError::PanelInvalid);
            }
            text_bytes = text_bytes.saturating_add(option.len());
        }
        validate_control(field)?;
        option_count = option_count.saturating_add(field.options.len());
        if option_count > MAX_PANEL_OPTIONS {
            return Err(BrokerError::PanelLimitExceeded(LimitKind::PanelOptions));
        }
        text_bytes = text_bytes
            .saturating_add(field.id.len())
            .saturating_add(field.label.len())
            .saturating_add(field.value.len());
        if text_bytes > MAX_PANEL_TEXT_BYTES {
            return Err(BrokerError::PanelLimitExceeded(LimitKind::PanelText));
        }
    }
    Ok(PanelValidation {
        node_count: panel.fields.len(),
        depth: 1,
        option_count,
        text_bytes,
    })
}

pub fn validate_panel_event(panel: &DeclarativePanel, event: &PanelEvent) -> Result<()> {
    validate_panel(panel)?;
    let field = panel
        .fields
        .iter()
        .find(|field| field.id == event.field_id)
        .ok_or(BrokerError::PanelInvalid)?;
    if field.disabled {
        return Err(BrokerError::PermissionDenied);
    }
    validate_safe_text(&event.value, MAX_VALUE_BYTES, true)?;
    match field.kind {
        PanelControlKind::Select if !field.options.contains(&event.value) => {
            Err(BrokerError::PanelInvalid)
        }
        PanelControlKind::Toggle if !matches!(event.value.as_str(), "true" | "false") => {
            Err(BrokerError::PanelInvalid)
        }
        PanelControlKind::Number
            if event
                .value
                .parse::<f64>()
                .map_or(true, |value| !value.is_finite()) =>
        {
            Err(BrokerError::PanelInvalid)
        }
        PanelControlKind::Button if !event.value.is_empty() => Err(BrokerError::PanelInvalid),
        _ => Ok(()),
    }
}

fn validate_control(field: &PanelField) -> Result<()> {
    match field.kind {
        PanelControlKind::Text if field.options.is_empty() => Ok(()),
        PanelControlKind::Number
            if field.options.is_empty()
                && field
                    .value
                    .parse::<f64>()
                    .is_ok_and(|value| value.is_finite()) =>
        {
            Ok(())
        }
        PanelControlKind::Toggle
            if field.options.is_empty() && matches!(field.value.as_str(), "true" | "false") =>
        {
            Ok(())
        }
        PanelControlKind::Select
            if !field.options.is_empty() && field.options.contains(&field.value) =>
        {
            Ok(())
        }
        PanelControlKind::Button if field.options.is_empty() && field.value.is_empty() => Ok(()),
        _ => Err(BrokerError::PanelInvalid),
    }
}

fn validate_safe_text(value: &str, maximum: usize, allow_empty: bool) -> Result<()> {
    if (!allow_empty && value.is_empty()) || value.len() > maximum {
        return Err(BrokerError::PanelLimitExceeded(LimitKind::PanelText));
    }
    let lower = value.to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || value.contains('<')
        || value.contains('>')
        || lower.contains("://")
        || lower.contains("javascript:")
        || lower.contains("data:")
        || lower.contains("file:")
        || lower.contains("mailto:")
        || lower.contains("tel:")
        || lower.contains("ftp:")
        || lower.contains("ws:")
        || lower.contains("wss:")
        || lower.contains("urn:")
        || lower
            .split_whitespace()
            .any(|part| part.starts_with("www."))
    {
        return Err(BrokerError::PanelInvalid);
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'-' | b'_' => index > 0 && index + 1 < value.len(),
            _ => false,
        })
}
