//! Main-window-only plugin-center boundary.
//!
//! This module owns validation and correlation, but deliberately does not own
//! a concrete plugin service. Application setup injects one implementation of
//! [`PluginCommandService`] into [`PluginCommandState`].

use std::collections::HashSet;
use std::sync::Arc;

use bbcom_contracts::{
    AppErrorCode, CancelPluginOperationRequest, DismissPluginAuthorizationRequest,
    EmitPluginPanelEventRequest, InstallPluginRequest, InstalledPluginView, IpcError,
    MAX_INSTALLED_PLUGINS, MAX_PLUGIN_AUTHORIZATION_PERMISSIONS, MAX_PLUGIN_CATALOG_ITEMS,
    MAX_PLUGIN_DESCRIPTION_BYTES, MAX_PLUGIN_DISPLAY_NAME_BYTES, MAX_PLUGIN_HEX_PREVIEW_BYTES,
    MAX_PLUGIN_ID_BYTES, MAX_PLUGIN_PANEL_FIELD_ID_BYTES, MAX_PLUGIN_PANEL_FIELDS,
    MAX_PLUGIN_PANEL_LABEL_BYTES, MAX_PLUGIN_PANEL_OPTION_BYTES, MAX_PLUGIN_PANEL_OPTIONS,
    MAX_PLUGIN_PANEL_TEXT_BYTES, MAX_PLUGIN_PANEL_TITLE_BYTES, MAX_PLUGIN_PANEL_VALUE_BYTES,
    MAX_PLUGIN_PANELS, MAX_PLUGIN_SERIAL_PROPOSALS, MAX_PLUGIN_VERSION_BYTES,
    MAX_WORKSPACE_FRAME_BYTES, PluginAuthorizationReview, PluginCatalogItem, PluginCenterData,
    PluginCommandResponse, PluginDeclarativePanel, PluginPanelEvent, PluginPanelField,
    PluginPanelFieldKind, PluginPermission, PluginPermissionDecision, PluginRiskCombination,
    PluginSerialProposal, PluginSnapshotRequest, PluginUnavailableCapability,
    ResolvePluginSerialProposalRequest, SetPluginEnabledRequest, SubmitPluginAuthorizationRequest,
};
use tauri::{State, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Fully typed command passed to the injected application service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginCommand {
    Snapshot(PluginSnapshotRequest),
    Install(InstallPluginRequest),
    SetEnabled(SetPluginEnabledRequest),
    SubmitAuthorization(SubmitPluginAuthorizationRequest),
    DismissAuthorization(DismissPluginAuthorizationRequest),
    ResolveSerialProposal(ResolvePluginSerialProposalRequest),
    EmitPanelEvent(EmitPluginPanelEventRequest),
    CancelOperation(CancelPluginOperationRequest),
}

impl PluginCommand {
    fn correlation(&self) -> (&str, u64, &str) {
        match self {
            Self::Snapshot(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::Install(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::SetEnabled(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::SubmitAuthorization(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::DismissAuthorization(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::ResolveSerialProposal(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::EmitPanelEvent(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
            Self::CancelOperation(request) => {
                (&request.request_id, request.revision, &request.operation_id)
            }
        }
    }
}

/// Injection port. The boundary has no dependency on `PluginService` or a
/// repository/host implementation.
pub trait PluginCommandService: Send + Sync + 'static {
    fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError>;
}

/// Fail-closed service installed until the native repository, authorization,
/// host and broker graph has passed the platform release gate. Keeping an
/// explicit state object avoids Tauri leaking an unstructured missing-state
/// error while still exposing no partial plugin behavior.
pub struct UnavailablePluginCommandService;

impl PluginCommandService for UnavailablePluginCommandService {
    fn execute(&self, _command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
        Err(IpcError::new(
            AppErrorCode::SecurityDenied,
            "error.plugin_permission_denied",
            false,
            "plugin_command",
        ))
    }
}

#[derive(Clone)]
pub struct PluginCommandState {
    service: Arc<dyn PluginCommandService>,
}

impl PluginCommandState {
    pub fn new(service: Arc<dyn PluginCommandService>) -> Self {
        Self { service }
    }
}

#[tauri::command]
pub fn plugin_center_snapshot(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: PluginSnapshotRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_center_snapshot",
        PluginCommand::Snapshot(request),
    )
}

#[tauri::command]
pub fn plugin_install(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: InstallPluginRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_install",
        PluginCommand::Install(request),
    )
}

#[tauri::command]
pub fn plugin_set_enabled(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: SetPluginEnabledRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_set_enabled",
        PluginCommand::SetEnabled(request),
    )
}

#[tauri::command]
pub fn plugin_submit_authorization(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: SubmitPluginAuthorizationRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_submit_authorization",
        PluginCommand::SubmitAuthorization(request),
    )
}

#[tauri::command]
pub fn plugin_dismiss_authorization(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: DismissPluginAuthorizationRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_dismiss_authorization",
        PluginCommand::DismissAuthorization(request),
    )
}

#[tauri::command]
pub fn plugin_resolve_serial_proposal(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: ResolvePluginSerialProposalRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_resolve_serial_proposal",
        PluginCommand::ResolveSerialProposal(request),
    )
}

#[tauri::command]
pub fn plugin_emit_panel_event(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: EmitPluginPanelEventRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_emit_panel_event",
        PluginCommand::EmitPanelEvent(request),
    )
}

#[tauri::command]
pub fn plugin_cancel_operation(
    window: WebviewWindow,
    state: State<'_, PluginCommandState>,
    request: CancelPluginOperationRequest,
) -> Result<PluginCommandResponse, IpcError> {
    dispatch(
        window.label(),
        state.inner(),
        "plugin_cancel_operation",
        PluginCommand::CancelOperation(request),
    )
}

fn dispatch(
    label: &str,
    state: &PluginCommandState,
    operation: &'static str,
    command: PluginCommand,
) -> Result<PluginCommandResponse, IpcError> {
    require_main_window(label, operation)?;
    validate_command(&command, operation)?;
    let (request_id, revision, operation_id) = command.correlation();
    let request_id = request_id.to_owned();
    let operation_id = operation_id.to_owned();
    let response =
        state
            .service
            .execute(command)
            .map_err(|error| match error.request_id.as_deref() {
                None => error.with_request_id(&request_id),
                Some(error_request_id) if error_request_id == request_id.as_str() => error,
                Some(_) => invalid_response(operation, "error.requestId", &request_id),
            })?;
    validate_response(&response, &request_id, revision, &operation_id, operation)?;
    Ok(response)
}

fn require_main_window(label: &str, operation: &'static str) -> Result<(), IpcError> {
    if label == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(IpcError::security_denied(operation))
    }
}

fn validate_command(command: &PluginCommand, operation: &'static str) -> Result<(), IpcError> {
    let (request_id, revision, operation_id) = command.correlation();
    validate_identity(request_id, "requestId", operation)?;
    validate_identity(operation_id, "operationId", operation)?;
    validate_revision(revision, "revision", operation)?;
    match command {
        PluginCommand::Snapshot(_) | PluginCommand::CancelOperation(_) => Ok(()),
        PluginCommand::Install(request) => {
            validate_identity(&request.catalog_id, "catalogId", operation)
        }
        PluginCommand::SetEnabled(request) => {
            validate_identity(&request.plugin_id, "pluginId", operation)
        }
        PluginCommand::SubmitAuthorization(request) => {
            validate_identity(&request.review_id, "reviewId", operation)?;
            validate_permission_decisions(&request.decisions, operation)?;
            validate_unique_permissions(
                &request.per_request_capabilities_acknowledged,
                "perRequestCapabilitiesAcknowledged",
                operation,
            )
        }
        PluginCommand::DismissAuthorization(request) => {
            validate_identity(&request.review_id, "reviewId", operation)
        }
        PluginCommand::ResolveSerialProposal(request) => {
            validate_identity(&request.proposal_id, "proposalId", operation)
        }
        PluginCommand::EmitPanelEvent(request) => validate_panel_event(&request.event, operation),
    }
}

fn validate_response(
    response: &PluginCommandResponse,
    request_id: &str,
    request_revision: u64,
    operation_id: &str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if response.request_id() != request_id {
        return Err(invalid_response(
            operation,
            "response.requestId",
            request_id,
        ));
    }
    if response.operation_id() != operation_id {
        return Err(invalid_response(
            operation,
            "response.operationId",
            request_id,
        ));
    }
    validate_revision(response.revision(), "response.revision", operation)
        .map_err(|error| error.with_request_id(request_id))?;
    if response.revision() < request_revision {
        return Err(invalid_response(operation, "response.revision", request_id));
    }
    if let Some(data) = response.data() {
        if data.revision != response.revision() {
            return Err(invalid_response(
                operation,
                "response.data.revision",
                request_id,
            ));
        }
        validate_center_data(data, operation).map_err(|error| error.with_request_id(request_id))?;
    }
    Ok(())
}

fn validate_center_data(data: &PluginCenterData, operation: &'static str) -> Result<(), IpcError> {
    validate_revision(data.revision, "data.revision", operation)?;
    validate_limit(
        data.catalog.len(),
        MAX_PLUGIN_CATALOG_ITEMS,
        "data.catalog",
        operation,
    )?;
    validate_limit(
        data.installed.len(),
        MAX_INSTALLED_PLUGINS,
        "data.installed",
        operation,
    )?;
    validate_limit(
        data.serial_proposals.len(),
        MAX_PLUGIN_SERIAL_PROPOSALS,
        "data.serialProposals",
        operation,
    )?;
    validate_limit(
        data.panels.len(),
        MAX_PLUGIN_PANELS,
        "data.panels",
        operation,
    )?;

    let mut catalog_ids = HashSet::new();
    for item in &data.catalog {
        validate_catalog_item(item, operation)?;
        if !catalog_ids.insert(item.catalog_id.as_str()) {
            return Err(IpcError::invalid_input(operation, "data.catalog.catalogId"));
        }
    }
    let mut installed_ids = HashSet::new();
    for plugin in &data.installed {
        validate_installed_plugin(plugin, operation)?;
        if !installed_ids.insert(plugin.plugin_id.as_str()) {
            return Err(IpcError::invalid_input(
                operation,
                "data.installed.pluginId",
            ));
        }
    }
    if let Some(review) = &data.authorization_review {
        validate_authorization_review(review, operation)?;
    }
    let mut proposal_ids = HashSet::new();
    for proposal in &data.serial_proposals {
        validate_serial_proposal(proposal, operation)?;
        if !proposal_ids.insert(proposal.proposal_id.as_str()) {
            return Err(IpcError::invalid_input(
                operation,
                "data.serialProposals.proposalId",
            ));
        }
    }
    let mut panel_plugin_ids = HashSet::new();
    for panel in &data.panels {
        validate_panel(panel, operation)?;
        if !panel_plugin_ids.insert(panel.plugin_id.as_str()) {
            return Err(IpcError::invalid_input(operation, "data.panels.pluginId"));
        }
    }
    Ok(())
}

fn validate_catalog_item(
    item: &PluginCatalogItem,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(&item.catalog_id, "catalog.catalogId", operation)?;
    validate_identity(&item.plugin_id, "catalog.pluginId", operation)?;
    validate_display_text(
        &item.display_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "catalog.displayName",
        operation,
    )?;
    validate_display_text(
        &item.description,
        MAX_PLUGIN_DESCRIPTION_BYTES,
        true,
        "catalog.description",
        operation,
    )?;
    validate_version(&item.version, "catalog.version", operation)?;
    validate_display_text(
        &item.publisher_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "catalog.publisherName",
        operation,
    )?;
    if let Some(version) = &item.installed_version {
        validate_version(version, "catalog.installedVersion", operation)?;
    }
    Ok(())
}

fn validate_installed_plugin(
    plugin: &InstalledPluginView,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(&plugin.plugin_id, "installed.pluginId", operation)?;
    validate_display_text(
        &plugin.display_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "installed.displayName",
        operation,
    )?;
    validate_version(&plugin.version, "installed.version", operation)?;
    if let Some(version) = &plugin.pending_version {
        validate_version(version, "installed.pendingVersion", operation)?;
    }
    validate_unique_permissions(
        &plugin.requested_permissions,
        "installed.requestedPermissions",
        operation,
    )
}

fn validate_authorization_review(
    review: &PluginAuthorizationReview,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(&review.review_id, "authorizationReview.reviewId", operation)?;
    validate_identity(&review.plugin_id, "authorizationReview.pluginId", operation)?;
    validate_display_text(
        &review.display_name,
        MAX_PLUGIN_DISPLAY_NAME_BYTES,
        false,
        "authorizationReview.displayName",
        operation,
    )?;
    validate_version(&review.version, "authorizationReview.version", operation)?;
    validate_unique_permissions(
        &review.persistent_permissions,
        "authorizationReview.persistentPermissions",
        operation,
    )?;
    validate_unique_permissions(
        &review.per_request_permissions,
        "authorizationReview.perRequestPermissions",
        operation,
    )?;
    if review
        .persistent_permissions
        .contains(&PluginPermission::SerialWriteProposal)
    {
        return Err(IpcError::invalid_input(
            operation,
            "authorizationReview.persistentPermissions",
        ));
    }
    validate_unique(
        &review.unavailable_capabilities,
        MAX_PLUGIN_AUTHORIZATION_PERMISSIONS,
        "authorizationReview.unavailableCapabilities",
        operation,
    )?;
    validate_unique(
        &review.extra_confirmation_reasons,
        MAX_PLUGIN_AUTHORIZATION_PERMISSIONS,
        "authorizationReview.extraConfirmationReasons",
        operation,
    )?;
    validate_required_risks(review, operation)
}

fn validate_required_risks(
    review: &PluginAuthorizationReview,
    operation: &'static str,
) -> Result<(), IpcError> {
    let has_permission = |permission| {
        review.persistent_permissions.contains(&permission)
            || review.per_request_permissions.contains(&permission)
    };
    let network = review
        .unavailable_capabilities
        .contains(&PluginUnavailableCapability::Network);
    let external_sink = [
        PluginPermission::FileOpenSave,
        PluginPermission::Clipboard,
        PluginPermission::AiRequest,
    ]
    .into_iter()
    .any(&has_permission);
    let mut required = Vec::new();
    if has_permission(PluginPermission::SessionCaptureRead) && network {
        required.push(PluginRiskCombination::CaptureWithNetwork);
    }
    if has_permission(PluginPermission::AiConversationRead) && network {
        required.push(PluginRiskCombination::ConversationWithNetwork);
    }
    if has_permission(PluginPermission::SessionCaptureRead) && external_sink {
        required.push(PluginRiskCombination::CaptureWithExternalSink);
    }
    if has_permission(PluginPermission::AiConversationRead) && external_sink {
        required.push(PluginRiskCombination::ConversationWithExternalSink);
    }
    if has_permission(PluginPermission::SerialControl)
        && has_permission(PluginPermission::SerialWriteProposal)
    {
        required.push(PluginRiskCombination::SerialControlAndWriteProposal);
    }
    if required
        .iter()
        .all(|risk| review.extra_confirmation_reasons.contains(risk))
    {
        Ok(())
    } else {
        Err(IpcError::invalid_input(
            operation,
            "authorizationReview.extraConfirmationReasons",
        ))
    }
}

fn validate_serial_proposal(
    proposal: &PluginSerialProposal,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_identity(
        &proposal.proposal_id,
        "serialProposal.proposalId",
        operation,
    )?;
    validate_identity(&proposal.plugin_id, "serialProposal.pluginId", operation)?;
    for (value, field) in [
        (&proposal.plugin_name, "serialProposal.pluginName"),
        (&proposal.session_label, "serialProposal.sessionLabel"),
        (&proposal.display_label, "serialProposal.displayLabel"),
    ] {
        validate_display_text(
            value,
            MAX_PLUGIN_DISPLAY_NAME_BYTES,
            false,
            field,
            operation,
        )?;
    }
    if proposal.byte_count == 0 || proposal.byte_count > MAX_WORKSPACE_FRAME_BYTES {
        return Err(IpcError::invalid_input(
            operation,
            "serialProposal.byteCount",
        ));
    }
    validate_display_text(
        &proposal.hex_preview,
        MAX_PLUGIN_HEX_PREVIEW_BYTES,
        false,
        "serialProposal.hexPreview",
        operation,
    )?;
    if !valid_hex_preview(&proposal.hex_preview) {
        return Err(IpcError::invalid_input(
            operation,
            "serialProposal.hexPreview",
        ));
    }
    validate_revision(
        proposal.expires_at_ms,
        "serialProposal.expiresAtMs",
        operation,
    )
}

fn validate_panel(panel: &PluginDeclarativePanel, operation: &'static str) -> Result<(), IpcError> {
    validate_identity(&panel.plugin_id, "panel.pluginId", operation)?;
    validate_display_text(
        &panel.title,
        MAX_PLUGIN_PANEL_TITLE_BYTES,
        false,
        "panel.title",
        operation,
    )?;
    if panel.fields.is_empty() {
        return Err(IpcError::invalid_input(operation, "panel.fields"));
    }
    validate_limit(
        panel.fields.len(),
        MAX_PLUGIN_PANEL_FIELDS,
        "panel.fields",
        operation,
    )?;
    let mut field_ids = HashSet::new();
    let mut option_count = 0usize;
    let mut text_bytes = panel.title.len();
    for field in &panel.fields {
        validate_panel_field(field, operation)?;
        if !field_ids.insert(field.id.as_str()) {
            return Err(IpcError::invalid_input(operation, "panel.fields.id"));
        }
        option_count = option_count.saturating_add(field.options.len());
        text_bytes = text_bytes
            .saturating_add(field.id.len())
            .saturating_add(field.label.len())
            .saturating_add(field.value.len())
            .saturating_add(field.options.iter().map(String::len).sum::<usize>());
    }
    validate_limit(
        option_count,
        MAX_PLUGIN_PANEL_OPTIONS,
        "panel.options",
        operation,
    )?;
    validate_limit(
        text_bytes,
        MAX_PLUGIN_PANEL_TEXT_BYTES,
        "panel.text",
        operation,
    )
}

fn validate_panel_field(field: &PluginPanelField, operation: &'static str) -> Result<(), IpcError> {
    validate_panel_field_id(&field.id, "panel.field.id", operation)?;
    validate_display_text(
        &field.label,
        MAX_PLUGIN_PANEL_LABEL_BYTES,
        false,
        "panel.field.label",
        operation,
    )?;
    validate_display_text(
        &field.value,
        MAX_PLUGIN_PANEL_VALUE_BYTES,
        true,
        "panel.field.value",
        operation,
    )?;
    validate_limit(
        field.options.len(),
        MAX_PLUGIN_PANEL_OPTIONS,
        "panel.field.options",
        operation,
    )?;
    let mut options = HashSet::new();
    for option in &field.options {
        validate_display_text(
            option,
            MAX_PLUGIN_PANEL_OPTION_BYTES,
            false,
            "panel.field.option",
            operation,
        )?;
        if !options.insert(option.as_str()) {
            return Err(IpcError::invalid_input(operation, "panel.field.options"));
        }
    }
    let valid = match field.kind {
        PluginPanelFieldKind::Text => field.options.is_empty(),
        PluginPanelFieldKind::Number => {
            field.options.is_empty()
                && !field.value.trim().is_empty()
                && field
                    .value
                    .parse::<f64>()
                    .is_ok_and(|value| value.is_finite())
        }
        PluginPanelFieldKind::Toggle => {
            field.options.is_empty() && matches!(field.value.as_str(), "true" | "false")
        }
        PluginPanelFieldKind::Select => {
            !field.options.is_empty() && field.options.contains(&field.value)
        }
        PluginPanelFieldKind::Button => field.options.is_empty() && field.value.is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, "panel.field"))
    }
}

fn validate_panel_event(event: &PluginPanelEvent, operation: &'static str) -> Result<(), IpcError> {
    validate_identity(&event.plugin_id, "event.pluginId", operation)?;
    validate_panel_field_id(&event.field_id, "event.fieldId", operation)?;
    validate_display_text(
        &event.value,
        MAX_PLUGIN_PANEL_VALUE_BYTES,
        true,
        "event.value",
        operation,
    )
}

fn validate_permission_decisions(
    decisions: &[PluginPermissionDecision],
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_limit(
        decisions.len(),
        MAX_PLUGIN_AUTHORIZATION_PERMISSIONS,
        "decisions",
        operation,
    )?;
    let mut permissions = HashSet::new();
    if decisions
        .iter()
        .all(|decision| permissions.insert(decision.permission))
    {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, "decisions.permission"))
    }
}

fn validate_unique_permissions(
    permissions: &[PluginPermission],
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_unique(
        permissions,
        MAX_PLUGIN_AUTHORIZATION_PERMISSIONS,
        field,
        operation,
    )
}

fn validate_unique<T: Eq + std::hash::Hash>(
    values: &[T],
    limit: usize,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_limit(values.len(), limit, field, operation)?;
    let mut seen = HashSet::new();
    if values.iter().all(|value| seen.insert(value)) {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn validate_identity(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    let mut bytes = value.bytes();
    let valid = !value.is_empty()
        && value.len() <= MAX_PLUGIN_ID_BYTES
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn validate_panel_field_id(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    let bytes = value.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= MAX_PLUGIN_PANEL_FIELD_ID_BYTES
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (matches!(byte, b'-' | b'_')
                    && index > 0
                    && index + 1 < bytes.len()
                    && (bytes[index + 1].is_ascii_lowercase() || bytes[index + 1].is_ascii_digit()))
        });
    if valid {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn validate_version(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if value.len() > MAX_PLUGIN_VERSION_BYTES || !safe_text(value, false) {
        return Err(IpcError::invalid_input(operation, field));
    }
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let core = &value[..core_end];
    let mut parts = core.split('.');
    let core_valid = (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
    }) && parts.next().is_none();
    let suffix_valid = if core_end == value.len() {
        true
    } else {
        let suffix = &value[core_end + 1..];
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    };
    if core_valid && suffix_valid {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn valid_hex_preview(value: &str) -> bool {
    let (hex, suffix_valid) = if let Some((hex, suffix)) = value.split_once(" … (+") {
        let count = suffix.strip_suffix(" bytes)");
        (
            hex,
            count.is_some_and(|count| {
                !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit())
            }),
        )
    } else {
        (value, true)
    };
    suffix_valid
        && !hex.is_empty()
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte) || byte == b' ')
}

fn validate_display_text(
    value: &str,
    limit: usize,
    allow_empty: bool,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    validate_limit(value.len(), limit, field, operation)?;
    if (allow_empty || !value.is_empty()) && safe_text(value, true) {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field))
    }
}

fn safe_text(value: &str, reject_system_path: bool) -> bool {
    let lower = value.to_ascii_lowercase();
    let has_uri = [
        "://",
        "javascript:",
        "data:",
        "file:",
        "mailto:",
        "tel:",
        "ftp:",
        "ws:",
        "wss:",
        "urn:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower
            .split_ascii_whitespace()
            .any(|part| part.starts_with("www."));
    let system_path = reject_system_path
        && (value.starts_with('/')
            || value.starts_with("\\\\")
            || (value.len() >= 3
                && value.as_bytes()[0].is_ascii_alphabetic()
                && value.as_bytes()[1] == b':'
                && matches!(value.as_bytes()[2], b'/' | b'\\')));
    !has_uri
        && !system_path
        && !value.contains(['<', '>'])
        && !value.chars().any(|character| character.is_control())
}

fn validate_revision(
    revision: u64,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if revision <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(IpcError::invalid_input(operation, field).with_size(
            MAX_SAFE_INTEGER as usize,
            usize::try_from(revision).unwrap_or(usize::MAX),
        ))
    }
}

fn validate_limit(
    actual: usize,
    limit: usize,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if actual <= limit {
        Ok(())
    } else {
        Err(IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field(field)
        .with_size(limit, actual))
    }
}

fn invalid_response(operation: &'static str, field: &'static str, request_id: &str) -> IpcError {
    IpcError::invalid_input(operation, field).with_request_id(request_id)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use bbcom_contracts::{PluginFailure, PluginFailureCode};

    use super::*;

    struct StubService {
        command: Mutex<Option<PluginCommand>>,
        response: PluginCommandResponse,
    }

    impl PluginCommandService for StubService {
        fn execute(&self, command: PluginCommand) -> Result<PluginCommandResponse, IpcError> {
            *self.command.lock().unwrap() = Some(command);
            Ok(self.response.clone())
        }
    }

    fn request() -> PluginSnapshotRequest {
        PluginSnapshotRequest {
            request_id: "request-1".to_owned(),
            revision: 3,
            operation_id: "operation-1".to_owned(),
        }
    }

    #[test]
    fn secondary_windows_are_denied_before_service_dispatch() {
        let state = PluginCommandState::new(Arc::new(StubService {
            command: Mutex::new(None),
            response: PluginCommandResponse::Failed {
                request_id: "request-1".to_owned(),
                operation_id: "operation-1".to_owned(),
                revision: 3,
                failure: PluginFailure {
                    code: PluginFailureCode::Unavailable,
                },
                data: None,
            },
        }));
        let error = dispatch(
            "ai-assistant",
            &state,
            "plugin_center_snapshot",
            PluginCommand::Snapshot(request()),
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::SecurityDenied);
    }

    #[test]
    fn response_must_keep_request_operation_and_revision_correlation() {
        let state = PluginCommandState::new(Arc::new(StubService {
            command: Mutex::new(None),
            response: PluginCommandResponse::Failed {
                request_id: "wrong-request".to_owned(),
                operation_id: "operation-1".to_owned(),
                revision: 3,
                failure: PluginFailure {
                    code: PluginFailureCode::Unavailable,
                },
                data: None,
            },
        }));
        let error = dispatch(
            "main",
            &state,
            "plugin_center_snapshot",
            PluginCommand::Snapshot(request()),
        )
        .unwrap_err();
        assert_eq!(error.field, Some("response.requestId"));
    }
}
