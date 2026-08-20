//! Native ingress validation for renderer-facing plugin protocol-v2 state.
//!
//! The WebView repeats these checks for defense in depth, but native code must
//! reject hostile guest presentation data before it crosses the IPC boundary.

use std::collections::HashSet;

use bbcom_contracts::{
    PluginAuthorizationRequestV2, PluginCenterData, PluginCommandContributionV2,
    PluginDetachedSurfaceEventRequestV2, PluginDetachedSurfaceViewV2, PluginFailureV2,
    PluginSurfaceEventKind, PluginSurfacePlacement, PluginSurfaceSnapshot, PluginTaskStatusV2,
    PluginTaskViewV2, PluginUiNode, RuntimeInstanceKey,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SURFACES: usize = 32;
const MAX_TASKS: usize = 128;
const MAX_AUTHORIZATION_REQUESTS: usize = 32;
const MAX_COMMAND_CONTRIBUTIONS: usize = 256;
const MAX_SURFACE_BYTES: usize = 512 * 1024;
const MAX_SURFACE_NODES: usize = 1024;
const MAX_SURFACE_DEPTH: usize = 32;
const MAX_CHILDREN: usize = 256;
const MAX_TABS: usize = 32;
const MAX_TABLE_COLUMNS: usize = 32;
const MAX_TABLE_ROWS: usize = 256;
const MAX_SHORT_TEXT_BYTES: usize = 1024;
const MAX_LONG_TEXT_BYTES: usize = 256 * 1024;

/// Validate every optional v2 projection in a plugin-center snapshot.
///
/// The returned field is stable and renderer-safe; guest text is never
/// reflected in the error.
pub fn validate_plugin_center_extensions_v2(data: &PluginCenterData) -> Result<(), &'static str> {
    let surfaces = data.surfaces.as_deref().unwrap_or_default();
    require_limit(surfaces.len(), MAX_SURFACES, "data.surfaces")?;
    let mut surface_keys = HashSet::new();
    for surface in surfaces {
        validate_surface(surface)?;
        if !surface_keys.insert((runtime_key(&surface.runtime), surface.surface_id.as_str())) {
            return Err("data.surfaces.surfaceId");
        }
    }

    let tasks = data.tasks.as_deref().unwrap_or_default();
    require_limit(tasks.len(), MAX_TASKS, "data.tasks")?;
    let mut task_keys = HashSet::new();
    for task in tasks {
        validate_task(task)?;
        if !task_keys.insert((runtime_key(&task.runtime), task.task_id.as_str())) {
            return Err("data.tasks.taskId");
        }
    }

    let requests = data.authorization_requests.as_deref().unwrap_or_default();
    require_limit(
        requests.len(),
        MAX_AUTHORIZATION_REQUESTS,
        "data.authorizationRequests",
    )?;
    let mut authorization_plugins = HashSet::new();
    for request in requests {
        validate_authorization_request(request)?;
        if !authorization_plugins.insert(request.plugin_id.as_str()) {
            return Err("data.authorizationRequests.pluginId");
        }
    }

    let commands = data.command_contributions.as_deref().unwrap_or_default();
    require_limit(
        commands.len(),
        MAX_COMMAND_CONTRIBUTIONS,
        "data.commandContributions",
    )?;
    let mut command_keys = HashSet::new();
    for command in commands {
        validate_command(command)?;
        if !command_keys.insert((runtime_key(&command.runtime), command.command_id.as_str())) {
            return Err("data.commandContributions.commandId");
        }
    }
    Ok(())
}

pub(crate) fn validate_surface_projection_v2(
    surface: &PluginSurfaceSnapshot,
) -> Result<(), &'static str> {
    validate_surface(surface)
}

pub(crate) fn validate_task_projection_v2(task: &PluginTaskViewV2) -> Result<(), &'static str> {
    validate_task(task)
}

pub(crate) fn validate_command_projection_v2(
    command: &PluginCommandContributionV2,
) -> Result<(), &'static str> {
    validate_command(command)
}

pub fn validate_detached_surface_view_v2(
    view: &PluginDetachedSurfaceViewV2,
) -> Result<(), &'static str> {
    if view.center_revision > MAX_SAFE_INTEGER
        || view.surface.placement != PluginSurfacePlacement::DetachedWindow
        || !view.surface.detached_allowed
        || !view.surface.editable
    {
        return Err("detached.surface");
    }
    validate_surface(&view.surface)?;
    require_limit(view.tasks.len(), MAX_TASKS, "detached.tasks")?;
    let mut task_ids = HashSet::new();
    for task in &view.tasks {
        validate_task(task)?;
        if task.runtime != view.surface.runtime || !task_ids.insert(task.task_id.as_str()) {
            return Err("detached.tasks");
        }
    }
    Ok(())
}

pub fn validate_detached_surface_interaction_v2(
    surface: &PluginSurfaceSnapshot,
    request: &PluginDetachedSurfaceEventRequestV2,
) -> Result<(), &'static str> {
    validate_surface_interaction_v2(
        surface,
        request.surface_revision,
        &request.node_id,
        request.event,
        request.value.as_deref(),
    )
    .map(|_| ())
}

#[derive(Clone, Debug, PartialEq)]
pub enum ValidatedSurfaceInteractionV2 {
    Action,
    Text(String),
    Number(f64),
    Toggle(bool),
    Selection(String),
}

pub fn validate_surface_interaction_v2(
    surface: &PluginSurfaceSnapshot,
    revision: u64,
    node_id: &str,
    event: PluginSurfaceEventKind,
    value: Option<&str>,
) -> Result<ValidatedSurfaceInteractionV2, &'static str> {
    if revision != surface.revision
        || !valid_node_id(node_id)
        || value.is_some_and(|value| !safe_text(value, MAX_SHORT_TEXT_BYTES, true, false))
    {
        return Err("detached.event");
    }
    let node = find_node(&surface.root, node_id).ok_or("detached.event")?;
    if !event_allowed(node, event, value) {
        return Err("detached.event");
    }
    match node {
        PluginUiNode::Button { .. } => Ok(ValidatedSurfaceInteractionV2::Action),
        PluginUiNode::TextInput { .. } => Ok(ValidatedSurfaceInteractionV2::Text(
            value.ok_or("detached.event")?.to_owned(),
        )),
        PluginUiNode::NumberInput { .. } | PluginUiNode::Table { .. } => {
            Ok(ValidatedSurfaceInteractionV2::Number(
                value
                    .ok_or("detached.event")?
                    .parse()
                    .map_err(|_| "detached.event")?,
            ))
        }
        PluginUiNode::Toggle { .. } => {
            Ok(ValidatedSurfaceInteractionV2::Toggle(value == Some("true")))
        }
        PluginUiNode::Select { .. } | PluginUiNode::Tabs { .. } => Ok(
            ValidatedSurfaceInteractionV2::Selection(value.ok_or("detached.event")?.to_owned()),
        ),
        _ => Err("detached.event"),
    }
}

fn validate_surface(surface: &PluginSurfaceSnapshot) -> Result<(), &'static str> {
    validate_runtime(&surface.runtime)?;
    if !valid_node_id(&surface.surface_id)
        || !safe_text(&surface.title, MAX_SHORT_TEXT_BYTES, false, false)
        || surface.revision == 0
        || surface.revision > MAX_SAFE_INTEGER
        || (surface.placement == PluginSurfacePlacement::DetachedWindow
            && !surface.detached_allowed)
    {
        return Err("data.surfaces");
    }
    let encoded = serde_json::to_vec(surface).map_err(|_| "data.surfaces")?;
    require_limit(encoded.len(), MAX_SURFACE_BYTES, "data.surfaces")?;
    let mut ids = HashSet::new();
    let mut nodes = 0;
    validate_node(&surface.root, &mut ids, &mut nodes, 1)
}

fn validate_node<'a>(
    node: &'a PluginUiNode,
    ids: &mut HashSet<&'a str>,
    nodes: &mut usize,
    depth: usize,
) -> Result<(), &'static str> {
    if depth > MAX_SURFACE_DEPTH {
        return Err("data.surfaces.root.depth");
    }
    *nodes += 1;
    require_limit(*nodes, MAX_SURFACE_NODES, "data.surfaces.root.nodes")?;
    let id = node_id(node);
    if !valid_node_id(id) || !ids.insert(id) {
        return Err("data.surfaces.root.id");
    }

    match node {
        PluginUiNode::Column { children, .. } | PluginUiNode::Row { children, .. } => {
            validate_children(children, ids, nodes, depth)
        }
        PluginUiNode::Group {
            label, children, ..
        } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)?;
            validate_children(children, ids, nodes, depth)
        }
        PluginUiNode::Tabs {
            selected_id, tabs, ..
        } => {
            if tabs.is_empty() || tabs.len() > MAX_TABS {
                return Err("data.surfaces.root.tabs");
            }
            let mut tab_ids = HashSet::new();
            for tab in tabs {
                if !valid_node_id(&tab.id) || !tab_ids.insert(tab.id.as_str()) {
                    return Err("data.surfaces.root.tabs.id");
                }
                require_text(&tab.label, MAX_SHORT_TEXT_BYTES, false, false)?;
                validate_children(&tab.children, ids, nodes, depth)?;
            }
            if !tab_ids.contains(selected_id.as_str()) {
                return Err("data.surfaces.root.tabs.selectedId");
            }
            Ok(())
        }
        PluginUiNode::Text { text, .. } | PluginUiNode::Badge { text, .. } => {
            require_text(text, MAX_SHORT_TEXT_BYTES, true, false)
        }
        PluginUiNode::KeyValueList { entries, .. } => {
            require_limit(entries.len(), MAX_CHILDREN, "data.surfaces.root.entries")?;
            for entry in entries {
                require_text(&entry.key, MAX_SHORT_TEXT_BYTES, false, false)?;
                require_text(&entry.value, MAX_SHORT_TEXT_BYTES, true, false)?;
            }
            Ok(())
        }
        PluginUiNode::Progress {
            label,
            completed,
            total,
            ..
        } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)?;
            if *completed > *total || *completed > MAX_SAFE_INTEGER || *total > MAX_SAFE_INTEGER {
                return Err("data.surfaces.root.progress");
            }
            Ok(())
        }
        PluginUiNode::Log {
            text, max_lines, ..
        } => {
            require_text(text, MAX_LONG_TEXT_BYTES, true, true)?;
            if *max_lines == 0 || *max_lines > 10_000 {
                return Err("data.surfaces.root.maxLines");
            }
            Ok(())
        }
        PluginUiNode::Code { text, language, .. } => {
            require_text(text, MAX_LONG_TEXT_BYTES, true, true)?;
            if !valid_language(language) {
                return Err("data.surfaces.root.language");
            }
            Ok(())
        }
        PluginUiNode::Table {
            columns,
            rows,
            page,
            page_count,
            ..
        } => {
            if columns.is_empty()
                || columns.len() > MAX_TABLE_COLUMNS
                || rows.len() > MAX_TABLE_ROWS
                || *page_count == 0
                || *page >= *page_count
            {
                return Err("data.surfaces.root.table");
            }
            let mut column_ids = HashSet::new();
            for column in columns {
                if !valid_node_id(&column.id) || !column_ids.insert(column.id.as_str()) {
                    return Err("data.surfaces.root.table.columnId");
                }
                require_text(&column.label, MAX_SHORT_TEXT_BYTES, false, false)?;
            }
            for row in rows {
                if row.len() != columns.len() {
                    return Err("data.surfaces.root.table.row");
                }
                for cell in row {
                    require_text(cell, MAX_SHORT_TEXT_BYTES, true, false)?;
                }
            }
            Ok(())
        }
        PluginUiNode::TextInput { label, value, .. } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)?;
            require_text(value, MAX_SHORT_TEXT_BYTES, true, false)
        }
        PluginUiNode::NumberInput {
            label,
            value,
            min,
            max,
            step,
            ..
        } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)?;
            finite_number(value)?;
            let min = min.as_deref().map(finite_number).transpose()?;
            let max = max.as_deref().map(finite_number).transpose()?;
            let step = step.as_deref().map(finite_number).transpose()?;
            if min.zip(max).is_some_and(|(min, max)| min > max)
                || step.is_some_and(|step| step <= 0.0)
            {
                return Err("data.surfaces.root.number");
            }
            Ok(())
        }
        PluginUiNode::Select {
            label,
            value,
            options,
            ..
        } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)?;
            if options.is_empty() || options.len() > MAX_CHILDREN {
                return Err("data.surfaces.root.options");
            }
            let mut values = HashSet::new();
            for option in options {
                require_text(&option.value, MAX_SHORT_TEXT_BYTES, false, false)?;
                require_text(&option.label, MAX_SHORT_TEXT_BYTES, false, false)?;
                if !values.insert(option.value.as_str()) {
                    return Err("data.surfaces.root.options.value");
                }
            }
            if !values.contains(value.as_str()) {
                return Err("data.surfaces.root.select.value");
            }
            Ok(())
        }
        PluginUiNode::Toggle { label, .. } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)
        }
        PluginUiNode::Button {
            label,
            dangerous,
            confirmation,
            ..
        } => {
            require_text(label, MAX_SHORT_TEXT_BYTES, false, false)?;
            if *dangerous != confirmation.is_some() {
                return Err("data.surfaces.root.button.confirmation");
            }
            if let Some(confirmation) = confirmation {
                require_text(confirmation, MAX_SHORT_TEXT_BYTES, false, false)?;
            }
            Ok(())
        }
    }
}

fn node_id(node: &PluginUiNode) -> &str {
    match node {
        PluginUiNode::Column { id, .. }
        | PluginUiNode::Row { id, .. }
        | PluginUiNode::Group { id, .. }
        | PluginUiNode::Tabs { id, .. }
        | PluginUiNode::Text { id, .. }
        | PluginUiNode::Badge { id, .. }
        | PluginUiNode::KeyValueList { id, .. }
        | PluginUiNode::Progress { id, .. }
        | PluginUiNode::Log { id, .. }
        | PluginUiNode::Code { id, .. }
        | PluginUiNode::Table { id, .. }
        | PluginUiNode::TextInput { id, .. }
        | PluginUiNode::NumberInput { id, .. }
        | PluginUiNode::Select { id, .. }
        | PluginUiNode::Toggle { id, .. }
        | PluginUiNode::Button { id, .. } => id,
    }
}

fn find_node<'a>(node: &'a PluginUiNode, id: &str) -> Option<&'a PluginUiNode> {
    if node_id(node) == id {
        return Some(node);
    }
    match node {
        PluginUiNode::Column { children, .. }
        | PluginUiNode::Row { children, .. }
        | PluginUiNode::Group { children, .. } => {
            children.iter().find_map(|child| find_node(child, id))
        }
        PluginUiNode::Tabs { tabs, .. } => tabs
            .iter()
            .flat_map(|tab| &tab.children)
            .find_map(|child| find_node(child, id)),
        _ => None,
    }
}

fn event_allowed(node: &PluginUiNode, event: PluginSurfaceEventKind, value: Option<&str>) -> bool {
    match node {
        PluginUiNode::Button { disabled, .. } => {
            !disabled && event == PluginSurfaceEventKind::Activate && value.is_none()
        }
        PluginUiNode::TextInput { disabled, .. } => {
            !disabled
                && matches!(
                    event,
                    PluginSurfaceEventKind::Input | PluginSurfaceEventKind::Change
                )
                && value.is_some()
        }
        PluginUiNode::NumberInput { disabled, .. } => {
            !disabled
                && matches!(
                    event,
                    PluginSurfaceEventKind::Input | PluginSurfaceEventKind::Change
                )
                && value.is_some_and(|value| finite_number(value).is_ok())
        }
        PluginUiNode::Select {
            disabled, options, ..
        } => {
            !disabled
                && event == PluginSurfaceEventKind::Change
                && value.is_some_and(|value| options.iter().any(|option| option.value == value))
        }
        PluginUiNode::Toggle { disabled, .. } => {
            !disabled
                && event == PluginSurfaceEventKind::Change
                && matches!(value, Some("true" | "false"))
        }
        PluginUiNode::Tabs { tabs, .. } => {
            event == PluginSurfaceEventKind::SelectTab
                && value.is_some_and(|value| tabs.iter().any(|tab| tab.id == value))
        }
        PluginUiNode::Table { page_count, .. } => {
            event == PluginSurfaceEventKind::RequestPage
                && value
                    .and_then(|value| value.parse::<u32>().ok())
                    .is_some_and(|page| page < *page_count)
        }
        _ => false,
    }
}

fn validate_children<'a>(
    children: &'a [PluginUiNode],
    ids: &mut HashSet<&'a str>,
    nodes: &mut usize,
    parent_depth: usize,
) -> Result<(), &'static str> {
    require_limit(children.len(), MAX_CHILDREN, "data.surfaces.root.children")?;
    for child in children {
        validate_node(child, ids, nodes, parent_depth + 1)?;
    }
    Ok(())
}

fn validate_task(task: &PluginTaskViewV2) -> Result<(), &'static str> {
    validate_runtime(&task.runtime)?;
    if !valid_identity(&task.task_id)
        || !valid_identity(&task.command_id)
        || !safe_text(&task.title, 256, false, false)
        || task.completed > MAX_SAFE_INTEGER
        || task.total > MAX_SAFE_INTEGER
        || (task.total == 0 && task.completed != 0)
        || (task.total != 0 && task.completed > task.total)
        || !safe_text(&task.status_text, 1024, true, true)
        || (task.cancellable
            && !matches!(
                task.status,
                PluginTaskStatusV2::Running | PluginTaskStatusV2::Cancelling
            ))
    {
        return Err("data.tasks");
    }
    if let Some(failure) = &task.failure {
        validate_failure(failure)?;
    }
    Ok(())
}

fn validate_failure(failure: &PluginFailureV2) -> Result<(), &'static str> {
    if !valid_message_key(&failure.message_key)
        || failure
            .detail
            .as_deref()
            .is_some_and(|detail| !safe_text(detail, 4096, true, true))
    {
        return Err("data.tasks.failure");
    }
    Ok(())
}

fn validate_authorization_request(
    request: &PluginAuthorizationRequestV2,
) -> Result<(), &'static str> {
    if !valid_identity(&request.plugin_id)
        || !safe_text(&request.display_name, 256, false, false)
        || !valid_version(&request.version)
        || !valid_sha256(&request.digest_sha256)
        || !canonical_capabilities(&request.requested_capabilities)
        || !canonical_capabilities(&request.added_capabilities)
        || !request
            .added_capabilities
            .iter()
            .all(|capability| request.requested_capabilities.contains(capability))
    {
        return Err("data.authorizationRequests");
    }
    Ok(())
}

fn validate_command(command: &PluginCommandContributionV2) -> Result<(), &'static str> {
    validate_runtime(&command.runtime)?;
    if !valid_identity(&command.command_id)
        || !safe_text(&command.title, 256, false, false)
        || !safe_text(&command.description, 1024, true, true)
        || command.dangerous != command.confirmation.is_some()
        || command
            .confirmation
            .as_deref()
            .is_some_and(|value| !safe_text(value, 1024, false, true))
    {
        return Err("data.commandContributions");
    }
    Ok(())
}

fn validate_runtime(runtime: &RuntimeInstanceKey) -> Result<(), &'static str> {
    if valid_identity(&runtime.workspace_id)
        && valid_identity(&runtime.plugin_id)
        && (1..=MAX_SAFE_INTEGER).contains(&runtime.instance_id)
        && (1..=MAX_SAFE_INTEGER).contains(&runtime.generation)
    {
        Ok(())
    } else {
        Err("data.runtime")
    }
}

fn runtime_key(runtime: &RuntimeInstanceKey) -> (&str, &str, u64, u64) {
    (
        &runtime.workspace_id,
        &runtime.plugin_id,
        runtime.instance_id,
        runtime.generation,
    )
}

fn valid_identity(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 128
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_node_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (matches!(byte, b'-' | b'_' | b'.' | b':')
                    && index > 0
                    && index + 1 < bytes.len()
                    && (bytes[index + 1].is_ascii_lowercase() || bytes[index + 1].is_ascii_digit()))
        })
}

fn valid_language(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 32
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'+' | b'_' | b'.' | b'-')
        })
}

fn valid_message_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 256
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 || !safe_text(value, 128, false, false) {
        return false;
    }
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let mut parts = value[..core_end].split('.');
    let core_valid = (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
    }) && parts.next().is_none();
    let suffix = &value[core_end.min(value.len())..];
    core_valid
        && (suffix.is_empty()
            || (suffix.len() > 1
                && suffix[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))))
}

fn canonical_capabilities(capabilities: &[bbcom_contracts::PluginCapabilityV2]) -> bool {
    capabilities.len() <= bbcom_contracts::PluginCapabilityV2::ALL.len()
        && capabilities
            .windows(2)
            .all(|pair| pair[0].as_str() < pair[1].as_str())
}

fn finite_number(value: &str) -> Result<f64, &'static str> {
    if value.trim().is_empty() || value.len() > 64 {
        return Err("data.surfaces.root.number");
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or("data.surfaces.root.number")
}

fn require_text(
    value: &str,
    limit: usize,
    allow_empty: bool,
    multiline: bool,
) -> Result<(), &'static str> {
    if safe_text(value, limit, allow_empty, multiline) {
        Ok(())
    } else {
        Err("data.surfaces.root.text")
    }
}

fn safe_text(value: &str, limit: usize, allow_empty: bool, multiline: bool) -> bool {
    if (!allow_empty && value.is_empty()) || value.len() > limit {
        return false;
    }
    if value.chars().any(|character| {
        let point = u32::from(character);
        point == 0 || point == 127 || (point < 32 && !(multiline && matches!(point, 9 | 10 | 13)))
    }) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if value.contains(['<', '>'])
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
            .split_ascii_whitespace()
            .any(|part| part.starts_with("www."))
    {
        return false;
    }
    !looks_like_system_path(value)
}

fn looks_like_system_path(value: &str) -> bool {
    value.split_ascii_whitespace().any(|word| {
        word.starts_with('/')
            || word.starts_with("\\\\")
            || (word.len() >= 3
                && word.as_bytes()[0].is_ascii_alphabetic()
                && word.as_bytes()[1] == b':'
                && matches!(word.as_bytes()[2], b'\\' | b'/'))
    })
}

fn require_limit(actual: usize, limit: usize, field: &'static str) -> Result<(), &'static str> {
    if actual <= limit { Ok(()) } else { Err(field) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bbcom_contracts::{
        PluginSelectOption, PluginSurfaceEventKind, PluginSurfacePlacement, PluginTextTone,
    };

    fn runtime() -> RuntimeInstanceKey {
        RuntimeInstanceKey {
            workspace_id: "workspace-1".to_owned(),
            plugin_id: "dev.bbcom.mcumgr".to_owned(),
            instance_id: 1,
            generation: 1,
        }
    }

    fn surface(root: PluginUiNode) -> PluginSurfaceSnapshot {
        PluginSurfaceSnapshot {
            runtime: runtime(),
            surface_id: "main".to_owned(),
            revision: 1,
            title: "MCUmgr".to_owned(),
            placement: PluginSurfacePlacement::Workspace,
            detached_allowed: true,
            editable: true,
            root,
        }
    }

    #[test]
    fn accepts_a_bounded_host_rendered_surface() {
        let surface = surface(PluginUiNode::Column {
            id: "root".to_owned(),
            children: vec![PluginUiNode::Text {
                id: "status".to_owned(),
                text: "Ready".to_owned(),
                tone: PluginTextTone::Success,
            }],
        });
        assert!(validate_surface(&surface).is_ok());
    }

    #[test]
    fn main_surface_interactions_are_node_typed_and_forgery_resistant() {
        let surface = surface(PluginUiNode::Column {
            id: "root".to_owned(),
            children: vec![
                PluginUiNode::Button {
                    id: "run".to_owned(),
                    label: "Run".to_owned(),
                    disabled: false,
                    dangerous: false,
                    confirmation: None,
                },
                PluginUiNode::Button {
                    id: "disabled".to_owned(),
                    label: "Disabled".to_owned(),
                    disabled: true,
                    dangerous: false,
                    confirmation: None,
                },
                PluginUiNode::NumberInput {
                    id: "count".to_owned(),
                    label: "Count".to_owned(),
                    value: "1".to_owned(),
                    min: None,
                    max: None,
                    step: None,
                    disabled: false,
                },
                PluginUiNode::TextInput {
                    id: "name".to_owned(),
                    label: "Name".to_owned(),
                    value: String::new(),
                    disabled: false,
                },
                PluginUiNode::Select {
                    id: "mode".to_owned(),
                    label: "Mode".to_owned(),
                    value: "a".to_owned(),
                    options: vec![PluginSelectOption {
                        value: "a".to_owned(),
                        label: "A".to_owned(),
                    }],
                    disabled: false,
                },
            ],
        });
        assert_eq!(
            validate_surface_interaction_v2(
                &surface,
                1,
                "count",
                PluginSurfaceEventKind::Change,
                Some("2.5"),
            ),
            Ok(ValidatedSurfaceInteractionV2::Number(2.5))
        );
        assert_eq!(
            validate_surface_interaction_v2(
                &surface,
                1,
                "name",
                PluginSurfaceEventKind::Change,
                Some("2.5"),
            ),
            Ok(ValidatedSurfaceInteractionV2::Text("2.5".to_owned()))
        );
        for (node, event, value) in [
            ("unknown", PluginSurfaceEventKind::Activate, None),
            ("disabled", PluginSurfaceEventKind::Activate, None),
            ("run", PluginSurfaceEventKind::Activate, Some("forged")),
            ("mode", PluginSurfaceEventKind::Change, Some("forged")),
        ] {
            assert!(validate_surface_interaction_v2(&surface, 1, node, event, value).is_err());
        }
    }

    #[test]
    fn native_display_text_rejects_markup_urls_and_any_absolute_path_token() {
        for value in [
            "<b>unsafe</b>",
            "https://example.invalid",
            "/etc/passwd",
            "log line\nopened /private/secret.bin",
        ] {
            assert!(!safe_text(value, 1024, false, true), "{value}");
        }
    }

    #[test]
    fn encoded_device_paths_are_displayable_without_weakening_native_path_guards() {
        assert!(safe_text("lfs1/upload.bin", 1024, false, false));
        assert!(safe_text(
            "opened \\u002flfs1\\u002fa.bin; https\\u003a\\u002f\\u002fdevice.invalid",
            1024,
            false,
            true,
        ));
        assert!(!safe_text("/lfs1/upload.bin", 1024, false, false));
        assert!(!safe_text("opened /lfs1/upload.bin", 1024, false, true,));
    }

    #[test]
    fn rejects_duplicate_nodes_paths_and_unconfirmed_dangerous_actions() {
        let duplicate = surface(PluginUiNode::Column {
            id: "root".to_owned(),
            children: vec![
                PluginUiNode::Text {
                    id: "same".to_owned(),
                    text: "one".to_owned(),
                    tone: PluginTextTone::Default,
                },
                PluginUiNode::Button {
                    id: "same".to_owned(),
                    label: "/Users/alice/secret.bin".to_owned(),
                    disabled: false,
                    dangerous: true,
                    confirmation: None,
                },
            ],
        });
        assert!(validate_surface(&duplicate).is_err());

        let dangerous = surface(PluginUiNode::Button {
            id: "erase".to_owned(),
            label: "Erase".to_owned(),
            disabled: false,
            dangerous: true,
            confirmation: None,
        });
        assert_eq!(
            validate_surface(&dangerous),
            Err("data.surfaces.root.button.confirmation")
        );
    }

    #[test]
    fn authorization_capabilities_must_be_canonical_and_added_is_a_subset() {
        let mut requested = vec![
            bbcom_contracts::PluginCapabilityV2::UiWorkspace,
            bbcom_contracts::PluginCapabilityV2::SerialIo,
        ];
        let mut request = PluginAuthorizationRequestV2 {
            plugin_id: "dev.bbcom.mcumgr".to_owned(),
            display_name: "MCUmgr".to_owned(),
            version: "1.0.0".to_owned(),
            digest_sha256: "a".repeat(64),
            development_source: false,
            requested_capabilities: requested.clone(),
            added_capabilities: vec![bbcom_contracts::PluginCapabilityV2::SerialIo],
        };
        assert!(validate_authorization_request(&request).is_err());

        requested.sort_unstable_by_key(|capability| capability.as_str());
        request.requested_capabilities = requested;
        assert!(validate_authorization_request(&request).is_ok());
        request.added_capabilities = vec![bbcom_contracts::PluginCapabilityV2::FileOpenRead];
        assert!(validate_authorization_request(&request).is_err());
    }
}
