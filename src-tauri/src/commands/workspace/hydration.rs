//! Workspace page-hydration command pairs.
//!
//! Pure mapping over [`bbcom_workspace::WorkspaceService`] page reads into
//! wire DTOs; every command validates the window label, the opaque request
//! id, and the exact active-workspace identity before reading a page.

use bbcom_contracts::{
    Direction, HydrateWorkspaceAiMessagesRequest, HydrateWorkspaceAiMessagesResponse,
    HydrateWorkspaceCollectionsRequest, HydrateWorkspaceCollectionsResponse,
    HydrateWorkspaceFramesRequest, HydrateWorkspaceFramesResponse, HydrateWorkspaceSessionsRequest,
    HydrateWorkspaceSessionsResponse, HydrateWorkspaceWaveformRequest,
    HydrateWorkspaceWaveformResponse, IpcError, WorkspaceHydratedFrame, WorkspaceSessionKind,
    WorkspaceSessionSnapshot,
};
use tauri::WebviewWindow;

use crate::utils::window::require_main_window_label;

use super::{
    WorkspaceManager, active_workspace, corrupt, dispatch_workspace_core, validate_opaque_id,
};

#[tauri::command]
pub async fn hydrate_workspace_sessions(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: HydrateWorkspaceSessionsRequest,
) -> Result<HydrateWorkspaceSessionsResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_sessions";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        hydrate_workspace_sessions_from_label(manager, label, request)
    })
    .await
}

fn hydrate_workspace_sessions_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: HydrateWorkspaceSessionsRequest,
) -> Result<HydrateWorkspaceSessionsResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_sessions";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    let service = active.as_ref().expect("active workspace checked");
    let revision = service
        .header()
        .map_err(|error| error.to_ipc_error(OPERATION))?
        .revision;
    let page = service
        .hydrate_sessions(request.offset as usize, request.limit as usize)
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    let sessions = page
        .sessions
        .into_iter()
        .map(|session| {
            Ok(WorkspaceSessionSnapshot {
                id: session.id,
                sort_order: session.sort_order,
                kind: match session.kind.as_str() {
                    "live" => WorkspaceSessionKind::Live,
                    "offline" => WorkspaceSessionKind::Offline,
                    _ => return Err(corrupt(OPERATION)),
                },
                name: session.name,
                needs_rebind: true,
                last_port_hint: session.last_port_hint,
                port_config: session.port_config,
                document: session.document,
                display_preferences: session.display_preferences,
                send_preferences: session.send_preferences,
                parser_state: session.parser_state,
                feature_state: session.feature_state,
                modbus_config: session.modbus_config,
                mcumgr_config: session.mcumgr_config,
            })
        })
        .collect::<Result<Vec<_>, IpcError>>()?;
    Ok(HydrateWorkspaceSessionsResponse {
        request_id: request.request_id,
        workspace_id: request.workspace_id,
        revision,
        sessions,
        next_offset: page
            .next_offset
            .map(|value| u32::try_from(value).map_err(|_| corrupt(OPERATION)))
            .transpose()?,
    })
}

#[tauri::command]
pub async fn hydrate_workspace_frames(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: HydrateWorkspaceFramesRequest,
) -> Result<HydrateWorkspaceFramesResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_frames";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        hydrate_workspace_frames_from_label(manager, label, request)
    })
    .await
}

fn hydrate_workspace_frames_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: HydrateWorkspaceFramesRequest,
) -> Result<HydrateWorkspaceFramesResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_frames";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    let service = active.as_ref().expect("active workspace checked");
    let revision = service
        .header()
        .map_err(|error| error.to_ipc_error(OPERATION))?
        .revision;
    let page = service
        .hydrate_frames(
            &request.session_id,
            request.from_seq,
            request.limit as usize,
        )
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    let frames = page
        .frames
        .into_iter()
        .map(|frame| {
            Ok(WorkspaceHydratedFrame {
                seq: frame.seq,
                id: frame.id,
                direction: match frame.direction.as_str() {
                    "TX" => Direction::Tx,
                    "RX" => Direction::Rx,
                    _ => return Err(corrupt(OPERATION)),
                },
                timestamp_ms: frame.timestamp_ms,
                // Hydrate responses carry frame bytes only over the base64
                // channel; `data` stays an empty array for wire-shape stability.
                data: Vec::new(),
                data_b64: Some(bbcom_contracts::encode_data_b64(&frame.data)),
                tx_status: frame.tx_status,
                requested_bytes: frame.requested_bytes,
                omitted_bytes: frame.omitted_bytes,
            })
        })
        .collect::<Result<Vec<_>, IpcError>>()?;
    Ok(HydrateWorkspaceFramesResponse {
        request_id: request.request_id,
        workspace_id: request.workspace_id,
        session_id: request.session_id,
        revision,
        frames,
        next_seq: page.next_seq,
    })
}

#[tauri::command]
pub async fn hydrate_workspace_collections(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: HydrateWorkspaceCollectionsRequest,
) -> Result<HydrateWorkspaceCollectionsResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_collections";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        hydrate_workspace_collections_from_label(manager, label, request)
    })
    .await
}

fn hydrate_workspace_collections_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: HydrateWorkspaceCollectionsRequest,
) -> Result<HydrateWorkspaceCollectionsResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_collections";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    let service = active.as_ref().expect("active workspace checked");
    Ok(HydrateWorkspaceCollectionsResponse {
        request_id: request.request_id,
        workspace_id: request.workspace_id,
        session_id: request.session_id.clone(),
        revision: service
            .header()
            .map_err(|error| error.to_ipc_error(OPERATION))?
            .revision,
        collections: service
            .hydrate_session_collections(&request.session_id)
            .map_err(|error| error.to_ipc_error(OPERATION))?,
    })
}

#[tauri::command]
pub async fn hydrate_workspace_ai_messages(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: HydrateWorkspaceAiMessagesRequest,
) -> Result<HydrateWorkspaceAiMessagesResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_ai_messages";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        hydrate_workspace_ai_messages_from_label(manager, label, request)
    })
    .await
}

fn hydrate_workspace_ai_messages_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: HydrateWorkspaceAiMessagesRequest,
) -> Result<HydrateWorkspaceAiMessagesResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_ai_messages";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    let service = active.as_ref().expect("active workspace checked");
    let page = service
        .hydrate_ai_messages(
            &request.session_id,
            request.offset as usize,
            request.limit as usize,
        )
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    Ok(HydrateWorkspaceAiMessagesResponse {
        request_id: request.request_id,
        workspace_id: request.workspace_id,
        session_id: request.session_id,
        revision: service
            .header()
            .map_err(|error| error.to_ipc_error(OPERATION))?
            .revision,
        messages: page.messages,
        next_offset: page
            .next_offset
            .map(|value| u32::try_from(value).map_err(|_| corrupt(OPERATION)))
            .transpose()?,
    })
}

#[tauri::command]
pub async fn hydrate_workspace_waveform(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: HydrateWorkspaceWaveformRequest,
) -> Result<HydrateWorkspaceWaveformResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_waveform";
    let label = window.label().to_string();
    dispatch_workspace_core(app, label, OPERATION, |manager, label| {
        hydrate_workspace_waveform_from_label(manager, label, request)
    })
    .await
}

fn hydrate_workspace_waveform_from_label(
    manager: &WorkspaceManager,
    label: &str,
    request: HydrateWorkspaceWaveformRequest,
) -> Result<HydrateWorkspaceWaveformResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_waveform";
    require_main_window_label(label, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(manager, &request.workspace_id, OPERATION)?;
    let service = active.as_ref().expect("active workspace checked");
    let page = service
        .hydrate_waveform(
            &request.session_id,
            request.offset as usize,
            request.limit as usize,
        )
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    Ok(HydrateWorkspaceWaveformResponse {
        request_id: request.request_id,
        workspace_id: request.workspace_id,
        session_id: request.session_id,
        revision: service
            .header()
            .map_err(|error| error.to_ipc_error(OPERATION))?
            .revision,
        channels: page.channels,
        samples: page.samples,
        next_offset: page
            .next_offset
            .map(|value| u32::try_from(value).map_err(|_| corrupt(OPERATION)))
            .transpose()?,
    })
}
