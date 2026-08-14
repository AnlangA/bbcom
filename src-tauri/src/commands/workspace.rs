//! Main-window workspace command boundary.
//!
//! Rust owns the managed project directory, the single active SQLite writer,
//! and all native file paths. The renderer receives only generated DTOs and
//! short-lived opaque grants.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicU8, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bbcom_contracts::{
    AppErrorCode, ApplyWorkspaceBatchRequest, ApplyWorkspaceBatchResponse,
    CancelWorkspaceOperationRequest, CancelWorkspaceOperationResponse,
    CreateWorkspaceCommandRequest, CreateWorkspaceCommandResponse, Direction, ExportProjectRequest,
    ExportProjectResponse, FlushWorkspaceRequest, FlushWorkspaceResponse,
    HydrateWorkspaceAiMessagesRequest, HydrateWorkspaceAiMessagesResponse,
    HydrateWorkspaceCollectionsRequest, HydrateWorkspaceCollectionsResponse,
    HydrateWorkspaceFramesRequest, HydrateWorkspaceFramesResponse, HydrateWorkspaceSessionsRequest,
    HydrateWorkspaceSessionsResponse, HydrateWorkspaceWaveformRequest,
    HydrateWorkspaceWaveformResponse, ImportProjectRequest, ImportProjectResponse, IpcError,
    OpenWorkspaceRequest, OpenWorkspaceResponse, ProjectEncryptionMode, ProjectEncryptionOptions,
    ProjectSourceGrantResponse, ProjectTargetGrantResponse, RequestProjectSourceGrantRequest,
    RequestProjectTargetGrantRequest, WorkspaceCatalogRequest, WorkspaceCatalogResponse,
    WorkspaceHydratedFrame, WorkspaceSessionKind, WorkspaceSessionSnapshot,
};
use bbcom_workspace::WorkspaceService;
use bbcom_workspace::container::{
    AgeScryptPassphraseStreams, ContainerCheckpoint, NativeProjectDestination, NativeProjectSource,
    ProjectContainerError, ProjectLibrary, WorkspaceUuid,
};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex as AsyncMutex;

const MAIN_WINDOW_LABEL: &str = "main";
const PROJECT_GRANT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PROJECT_GRANTS: usize = 16;
const MAX_PASSPHRASE_CHARS: usize = 1_024;
const ACTIVE_WORKSPACE_FILE: &str = ".active-workspace-v1";
const MAX_ACTIVE_WORKSPACE_FILE_BYTES: u64 = 256;
const MAX_CONCURRENT_WORKSPACE_OPERATIONS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum WorkspaceOperationPhase {
    Cancellable = 0,
    CancelRequested = 1,
    Committing = 2,
    Finished = 3,
}

#[derive(Debug)]
struct WorkspaceOperationControl {
    phase: AtomicU8,
}

impl WorkspaceOperationControl {
    const fn new() -> Self {
        Self {
            phase: AtomicU8::new(WorkspaceOperationPhase::Cancellable as u8),
        }
    }

    fn request_cancel(&self) -> bool {
        loop {
            match self.phase() {
                WorkspaceOperationPhase::Cancellable => {
                    if self
                        .phase
                        .compare_exchange(
                            WorkspaceOperationPhase::Cancellable as u8,
                            WorkspaceOperationPhase::CancelRequested as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return true;
                    }
                }
                WorkspaceOperationPhase::CancelRequested => return true,
                WorkspaceOperationPhase::Committing | WorkspaceOperationPhase::Finished => {
                    return false;
                }
            }
        }
    }

    fn is_cancelled(&self, checkpoint: ContainerCheckpoint) -> bool {
        if matches!(
            checkpoint,
            ContainerCheckpoint::ImportBeforeCommit | ContainerCheckpoint::ExportBeforeCommit
        ) {
            loop {
                match self.phase() {
                    WorkspaceOperationPhase::Cancellable => {
                        if self
                            .phase
                            .compare_exchange(
                                WorkspaceOperationPhase::Cancellable as u8,
                                WorkspaceOperationPhase::Committing as u8,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            )
                            .is_ok()
                        {
                            return false;
                        }
                    }
                    WorkspaceOperationPhase::CancelRequested => return true,
                    WorkspaceOperationPhase::Committing | WorkspaceOperationPhase::Finished => {
                        return false;
                    }
                }
            }
        }

        self.phase() == WorkspaceOperationPhase::CancelRequested
    }

    fn finish(&self) {
        self.phase
            .store(WorkspaceOperationPhase::Finished as u8, Ordering::Release);
    }

    fn phase(&self) -> WorkspaceOperationPhase {
        match self.phase.load(Ordering::Acquire) {
            value if value == WorkspaceOperationPhase::Cancellable as u8 => {
                WorkspaceOperationPhase::Cancellable
            }
            value if value == WorkspaceOperationPhase::CancelRequested as u8 => {
                WorkspaceOperationPhase::CancelRequested
            }
            value if value == WorkspaceOperationPhase::Committing as u8 => {
                WorkspaceOperationPhase::Committing
            }
            _ => WorkspaceOperationPhase::Finished,
        }
    }
}

#[derive(Debug)]
pub struct WorkspaceManager {
    library: ProjectLibrary,
    active: Mutex<Option<WorkspaceService>>,
    active_marker: PathBuf,
    grants: AsyncMutex<HashMap<String, ProjectGrant>>,
    operations: Mutex<HashMap<String, Arc<WorkspaceOperationControl>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectGrantKind {
    Source,
    Target,
}

#[derive(Debug)]
struct ProjectGrant {
    kind: ProjectGrantKind,
    path: PathBuf,
    issued_at: Instant,
}

impl WorkspaceManager {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, ProjectContainerError> {
        let root = root.as_ref().to_path_buf();
        let library = ProjectLibrary::open(&root)?;
        let root = fs::canonicalize(&root)?;
        let active_marker = root.join(ACTIVE_WORKSPACE_FILE);
        let active = read_active_workspace(&library, &active_marker)?;
        Ok(Self {
            library,
            active: Mutex::new(active),
            active_marker,
            grants: AsyncMutex::new(HashMap::new()),
            operations: Mutex::new(HashMap::new()),
        })
    }

    fn begin_operation(
        &self,
        operation_id: &str,
        operation: &'static str,
    ) -> Result<Arc<WorkspaceOperationControl>, IpcError> {
        validate_opaque_id(operation_id, "operationId", operation)?;
        let mut operations = self.operations.lock().map_err(|_| {
            IpcError::new(AppErrorCode::Busy, "error.busy", true, operation)
                .with_field("operationId")
        })?;
        if operations.contains_key(operation_id) {
            return Err(
                IpcError::new(AppErrorCode::Busy, "error.busy", true, operation)
                    .with_field("operationId"),
            );
        }
        if operations.len() >= MAX_CONCURRENT_WORKSPACE_OPERATIONS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field("operationId")
            .with_size(
                MAX_CONCURRENT_WORKSPACE_OPERATIONS,
                operations.len().saturating_add(1),
            ));
        }
        let cancellation = Arc::new(WorkspaceOperationControl::new());
        operations.insert(operation_id.to_owned(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    fn finish_operation(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            if let Some(operation) = operations.get(operation_id) {
                operation.finish();
            }
            operations.remove(operation_id);
        }
    }

    fn cancel_operation(
        &self,
        operation_id: &str,
        operation: &'static str,
    ) -> Result<bool, IpcError> {
        validate_opaque_id(operation_id, "operationId", operation)?;
        let cancellation = self
            .operations
            .lock()
            .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))?
            .get(operation_id)
            .cloned();
        Ok(cancellation.is_some_and(|operation| operation.request_cancel()))
    }

    async fn issue_grant(
        &self,
        kind: ProjectGrantKind,
        path: PathBuf,
        operation: &'static str,
    ) -> Result<String, IpcError> {
        let mut grants = self.grants.lock().await;
        grants.retain(|_, grant| grant.issued_at.elapsed() <= PROJECT_GRANT_TTL);
        if grants.len() >= MAX_PROJECT_GRANTS {
            return Err(IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field("grantId")
            .with_size(MAX_PROJECT_GRANTS, grants.len().saturating_add(1)));
        }
        for _ in 0..4 {
            let grant_id = random_opaque_id("project-grant", operation)?;
            if grants.contains_key(&grant_id) {
                continue;
            }
            grants.insert(
                grant_id.clone(),
                ProjectGrant {
                    kind,
                    path: path.clone(),
                    issued_at: Instant::now(),
                },
            );
            return Ok(grant_id);
        }
        Err(IpcError::new(
            AppErrorCode::Busy,
            "error.busy",
            true,
            operation,
        ))
    }

    async fn consume_grant(
        &self,
        grant_id: &str,
        expected_kind: ProjectGrantKind,
        operation: &'static str,
    ) -> Result<PathBuf, IpcError> {
        validate_opaque_id(grant_id, "grantId", operation)?;
        let mut grants = self.grants.lock().await;
        grants.retain(|_, grant| grant.issued_at.elapsed() <= PROJECT_GRANT_TTL);
        let grant = grants
            .remove(grant_id)
            .ok_or_else(|| IpcError::invalid_input(operation, "grantId"))?;
        if grant.kind != expected_kind {
            return Err(IpcError::security_denied(operation));
        }
        Ok(grant.path)
    }

    /// Native reset-only primitive. The durable reset journal supplies the
    /// fixed UUID; renderer commands can never select it. Re-entry after a
    /// crash either creates that exact project or validates the already
    /// created empty schema-v1 project without replacing it.
    pub(crate) fn ensure_empty_reset_workspace(
        &self,
        workspace_id: &str,
        name: &str,
        expected_revision: u64,
        created_at_ms: u64,
        operation: &'static str,
    ) -> Result<(), IpcError> {
        let workspace_id =
            WorkspaceUuid::parse(workspace_id).map_err(|error| project_error(error, operation))?;
        let service = if self.library.contains(&workspace_id) {
            self.library.open_project(&workspace_id)
        } else {
            match self
                .library
                .create_project(&workspace_id, name.to_owned(), created_at_ms)
            {
                Ok(service) => Ok(service),
                // A competing/resumed prepare may have committed between the
                // contains check and create. Validate the winner below.
                Err(ProjectContainerError::AlreadyExists) => {
                    self.library.open_project(&workspace_id)
                }
                Err(error) => Err(error),
            }
        }
        .map_err(|error| project_error(error, operation))?;
        validate_empty_reset_workspace(
            &service,
            workspace_id.as_str(),
            name,
            expected_revision,
            operation,
        )
    }

    pub(crate) fn verify_empty_reset_workspace(
        &self,
        workspace_id: &str,
        name: &str,
        expected_revision: u64,
        operation: &'static str,
    ) -> Result<(), IpcError> {
        let workspace_id =
            WorkspaceUuid::parse(workspace_id).map_err(|error| project_error(error, operation))?;
        let service = self
            .library
            .open_project(&workspace_id)
            .map_err(|error| project_error(error, operation))?;
        validate_empty_reset_workspace(
            &service,
            workspace_id.as_str(),
            name,
            expected_revision,
            operation,
        )
    }
}

fn validate_empty_reset_workspace(
    service: &WorkspaceService,
    workspace_id: &str,
    name: &str,
    expected_revision: u64,
    operation: &'static str,
) -> Result<(), IpcError> {
    let header = service
        .header()
        .map_err(|error| error.to_ipc_error(operation))?;
    if header.workspace_id != workspace_id
        || header.name != name
        || header.revision != expected_revision
        || header.active_session_id.is_some()
        || !header.session_ids.is_empty()
    {
        return Err(IpcError::new(
            AppErrorCode::WorkspaceCorrupt,
            "error.workspace_corrupt",
            false,
            operation,
        )
        .with_field("workspaceId"));
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_catalog(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: WorkspaceCatalogRequest,
) -> Result<WorkspaceCatalogResponse, IpcError> {
    const OPERATION: &str = "workspace_catalog";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;

    let active_summary = {
        let active = lock_active(&manager, OPERATION)?;
        active
            .as_ref()
            .map(WorkspaceService::summary)
            .transpose()
            .map_err(|error| error.to_ipc_error(OPERATION))?
    };
    let active_workspace_id = active_summary
        .as_ref()
        .map(|summary| summary.workspace_id.clone());
    let mut workspaces = Vec::new();
    for workspace_id in manager
        .library
        .list_workspace_ids()
        .map_err(|error| project_error(error, OPERATION))?
    {
        if active_workspace_id.as_deref() == Some(workspace_id.as_str()) {
            workspaces.push(active_summary.clone().expect("active summary exists"));
        } else {
            let summary = manager
                .library
                .open_project(&workspace_id)
                .and_then(|service| service.summary().map_err(ProjectContainerError::from));
            match summary {
                Ok(summary) => workspaces.push(summary),
                Err(_) => {
                    // One damaged managed file must not make every healthy
                    // workspace inaccessible. Keep its opaque UUID out of the
                    // renderer catalog and leave the file untouched for a
                    // future recovery flow.
                    tracing::warn!(workspace_id = %workspace_id.as_str(), "skipping unreadable managed workspace");
                }
            }
        }
    }
    workspaces.sort_by(|left, right| {
        right
            .updated_at_ms
            .total_cmp(&left.updated_at_ms)
            .then_with(|| left.workspace_id.cmp(&right.workspace_id))
    });
    Ok(WorkspaceCatalogResponse {
        request_id: request.request_id,
        workspaces,
        active_workspace_id,
    })
}

#[tauri::command]
pub fn create_workspace(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: CreateWorkspaceCommandRequest,
) -> Result<CreateWorkspaceCommandResponse, IpcError> {
    const OPERATION: &str = "create_workspace";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let now = current_time_millis(OPERATION)?;
    let mut created = None;
    for _ in 0..4 {
        let workspace_id = random_workspace_uuid(OPERATION)?;
        match manager
            .library
            .create_project(&workspace_id, request.name.clone(), now)
        {
            Ok(service) => {
                created = Some(service);
                break;
            }
            Err(ProjectContainerError::AlreadyExists) => continue,
            Err(error) => return Err(project_error(error, OPERATION)),
        }
    }
    let service =
        created.ok_or_else(|| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))?;
    let workspace = service
        .summary()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    let header = service
        .header()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    commit_active_workspace(&manager, &workspace.workspace_id, service, OPERATION)?;
    Ok(CreateWorkspaceCommandResponse {
        request_id: request.request_id,
        workspace,
        header,
    })
}

#[tauri::command]
pub fn open_workspace(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: OpenWorkspaceRequest,
) -> Result<OpenWorkspaceResponse, IpcError> {
    const OPERATION: &str = "open_workspace";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let workspace_id = WorkspaceUuid::parse(&request.workspace_id)
        .map_err(|error| project_error(error, OPERATION))?;
    let service = manager
        .library
        .open_project(&workspace_id)
        .map_err(|error| project_error(error, OPERATION))?;
    let workspace = service
        .summary()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    let header = service
        .header()
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    commit_active_workspace(&manager, &workspace.workspace_id, service, OPERATION)?;
    Ok(OpenWorkspaceResponse {
        request_id: request.request_id,
        workspace,
        header,
    })
}

#[tauri::command]
pub fn apply_workspace_batch(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: ApplyWorkspaceBatchRequest,
) -> Result<ApplyWorkspaceBatchResponse, IpcError> {
    const OPERATION: &str = "apply_workspace_batch";
    ensure_main_window(&window, OPERATION)?;
    let mut active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
    active
        .as_mut()
        .expect("active workspace checked")
        .apply_batch(request)
        .map_err(|error| error.to_ipc_error(OPERATION))
}

#[tauri::command]
pub fn flush_workspace(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: FlushWorkspaceRequest,
) -> Result<FlushWorkspaceResponse, IpcError> {
    const OPERATION: &str = "flush_workspace";
    ensure_main_window(&window, OPERATION)?;
    let mut active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
    let (committed_revision, save_health) = active
        .as_mut()
        .expect("active workspace checked")
        .flush(request.target_revision)
        .map_err(|error| error.to_ipc_error(OPERATION))?;
    Ok(FlushWorkspaceResponse {
        committed_revision,
        save_health,
    })
}

#[tauri::command]
pub fn hydrate_workspace_sessions(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: HydrateWorkspaceSessionsRequest,
) -> Result<HydrateWorkspaceSessionsResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_sessions";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
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
pub fn hydrate_workspace_frames(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: HydrateWorkspaceFramesRequest,
) -> Result<HydrateWorkspaceFramesResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_frames";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
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
                data: frame.data,
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
pub fn hydrate_workspace_collections(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: HydrateWorkspaceCollectionsRequest,
) -> Result<HydrateWorkspaceCollectionsResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_collections";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
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
pub fn hydrate_workspace_ai_messages(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: HydrateWorkspaceAiMessagesRequest,
) -> Result<HydrateWorkspaceAiMessagesResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_ai_messages";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
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
pub fn hydrate_workspace_waveform(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: HydrateWorkspaceWaveformRequest,
) -> Result<HydrateWorkspaceWaveformResponse, IpcError> {
    const OPERATION: &str = "hydrate_workspace_waveform";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let active = active_workspace(&manager, &request.workspace_id, OPERATION)?;
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

#[tauri::command]
pub async fn request_project_source_grant(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: RequestProjectSourceGrantRequest,
) -> Result<ProjectSourceGrantResponse, IpcError> {
    const OPERATION: &str = "request_project_source_grant";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let selected = window
        .dialog()
        .file()
        .add_filter("bbcom project", &["bbcom"])
        .blocking_pick_file()
        .ok_or_else(|| cancelled(OPERATION))?;
    let path = selected
        .into_path()
        .map_err(|_| IpcError::invalid_input(OPERATION, "source"))?;
    validate_project_path(&path, true, OPERATION)?;
    let display_name = project_display_name(&path, OPERATION)?;
    let source_grant_id = manager
        .issue_grant(ProjectGrantKind::Source, path, OPERATION)
        .await?;
    Ok(ProjectSourceGrantResponse {
        request_id: request.request_id,
        source_grant_id,
        display_name,
    })
}

#[tauri::command]
pub async fn request_project_target_grant(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: RequestProjectTargetGrantRequest,
) -> Result<ProjectTargetGrantResponse, IpcError> {
    const OPERATION: &str = "request_project_target_grant";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    validate_project_file_name(&request.suggested_name, OPERATION)?;
    let selected = window
        .dialog()
        .file()
        .add_filter("bbcom project", &["bbcom"])
        .set_file_name(&request.suggested_name)
        .blocking_save_file()
        .ok_or_else(|| cancelled(OPERATION))?;
    let mut path = selected
        .into_path()
        .map_err(|_| IpcError::invalid_input(OPERATION, "destination"))?;
    if path.extension().is_none() {
        path.set_extension("bbcom");
    }
    validate_project_path(&path, false, OPERATION)?;
    let display_name = project_display_name(&path, OPERATION)?;
    let target_grant_id = manager
        .issue_grant(ProjectGrantKind::Target, path, OPERATION)
        .await?;
    Ok(ProjectTargetGrantResponse {
        request_id: request.request_id,
        target_grant_id,
        display_name,
    })
}

#[tauri::command]
pub async fn import_project(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: ImportProjectRequest,
) -> Result<ImportProjectResponse, IpcError> {
    const OPERATION: &str = "import_project";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let operation_id = request.operation_id.clone();
    let cancellation = manager.begin_operation(&operation_id, OPERATION)?;
    let result = async {
        let encryption = validate_encryption(request.encryption, OPERATION)?;
        let source = manager
            .consume_grant(
                &request.source_grant_id,
                ProjectGrantKind::Source,
                OPERATION,
            )
            .await?;
        let source = NativeProjectSource::from_native_path(source);
        let cancellation_check = |checkpoint| cancellation.is_cancelled(checkpoint);
        let imported = match encryption.as_ref() {
            None => manager
                .library
                .import_plaintext(&source, &cancellation_check),
            Some(passphrase) => {
                manager
                    .library
                    .import_encrypted(&source, passphrase, &cancellation_check)
            }
        }
        .map_err(|error| project_error(error, OPERATION))?;
        let service = manager
            .library
            .open_project(&imported.workspace_id)
            .map_err(|error| project_error(error, OPERATION))?;
        let workspace = service
            .summary()
            .map_err(|error| error.to_ipc_error(OPERATION))?;
        Ok(ImportProjectResponse {
            request_id: request.request_id,
            operation_id: operation_id.clone(),
            workspace,
        })
    }
    .await;
    manager.finish_operation(&operation_id);
    result
}

#[tauri::command]
pub async fn export_project(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: ExportProjectRequest,
) -> Result<ExportProjectResponse, IpcError> {
    const OPERATION: &str = "export_project";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let operation_id = request.operation_id.clone();
    let cancellation = manager.begin_operation(&operation_id, OPERATION)?;
    let result = async {
        let workspace_id = WorkspaceUuid::parse(&request.workspace_id)
            .map_err(|error| project_error(error, OPERATION))?;
        if !manager.library.contains(&workspace_id) {
            return Err(IpcError::invalid_input(OPERATION, "workspaceId"));
        }
        let encryption = validate_encryption(request.encryption, OPERATION)?;
        let target = manager
            .consume_grant(
                &request.target_grant_id,
                ProjectGrantKind::Target,
                OPERATION,
            )
            .await?;
        let display_name = project_display_name(&target, OPERATION)?;
        let target = NativeProjectDestination::from_native_path(target);
        let cancellation_check = |checkpoint| cancellation.is_cancelled(checkpoint);
        match encryption.as_ref() {
            None => manager
                .library
                .export_plaintext(&workspace_id, &target, &cancellation_check),
            Some(passphrase) => manager.library.export_encrypted(
                &workspace_id,
                &target,
                passphrase,
                &cancellation_check,
            ),
        }
        .map_err(|error| project_error(error, OPERATION))?;
        Ok(ExportProjectResponse {
            request_id: request.request_id,
            operation_id: operation_id.clone(),
            display_name,
        })
    }
    .await;
    manager.finish_operation(&operation_id);
    result
}

#[tauri::command]
pub fn cancel_workspace_operation(
    window: WebviewWindow,
    manager: State<'_, WorkspaceManager>,
    request: CancelWorkspaceOperationRequest,
) -> Result<CancelWorkspaceOperationResponse, IpcError> {
    const OPERATION: &str = "cancel_workspace_operation";
    ensure_main_window(&window, OPERATION)?;
    validate_opaque_id(&request.request_id, "requestId", OPERATION)?;
    let cancellation_requested = manager.cancel_operation(&request.operation_id, OPERATION)?;
    Ok(CancelWorkspaceOperationResponse {
        request_id: request.request_id,
        operation_id: request.operation_id,
        cancellation_requested,
    })
}

fn active_workspace<'a>(
    manager: &'a WorkspaceManager,
    workspace_id: &str,
    operation: &'static str,
) -> Result<MutexGuard<'a, Option<WorkspaceService>>, IpcError> {
    let active = lock_active(manager, operation)?;
    let header = active
        .as_ref()
        .ok_or_else(|| IpcError::invalid_input(operation, "workspaceId"))?
        .header()
        .map_err(|error| error.to_ipc_error(operation))?;
    if header.workspace_id != workspace_id {
        return Err(IpcError::invalid_input(operation, "workspaceId"));
    }
    Ok(active)
}

fn lock_active<'a>(
    manager: &'a WorkspaceManager,
    operation: &'static str,
) -> Result<MutexGuard<'a, Option<WorkspaceService>>, IpcError> {
    manager
        .active
        .lock()
        .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, operation))
}

fn commit_active_workspace(
    manager: &WorkspaceManager,
    workspace_id: &str,
    service: WorkspaceService,
    operation: &'static str,
) -> Result<(), IpcError> {
    let workspace_id =
        WorkspaceUuid::parse(workspace_id).map_err(|error| project_error(error, operation))?;
    let mut active = lock_active(manager, operation)?;
    persist_active_workspace(&manager.active_marker, &workspace_id)
        .map_err(|error| io_error_kind(error.kind(), operation))?;
    *active = Some(service);
    Ok(())
}

fn read_active_workspace(
    library: &ProjectLibrary,
    marker: &Path,
) -> Result<Option<WorkspaceService>, ProjectContainerError> {
    let mut file = match File::open(marker) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            tracing::warn!(kind = ?error.kind(), "ignoring unreadable last-active workspace marker");
            let _ = fs::remove_file(marker);
            return Ok(None);
        }
    };
    let marker_len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            tracing::warn!(kind = ?error.kind(), "ignoring invalid last-active workspace marker metadata");
            let _ = fs::remove_file(marker);
            return Ok(None);
        }
    };
    if marker_len > MAX_ACTIVE_WORKSPACE_FILE_BYTES {
        let _ = fs::remove_file(marker);
        return Ok(None);
    }
    let mut encoded = String::new();
    if let Err(error) = file.read_to_string(&mut encoded) {
        tracing::warn!(kind = ?error.kind(), "ignoring malformed last-active workspace marker");
        let _ = fs::remove_file(marker);
        return Ok(None);
    }
    let Ok(workspace_id) = WorkspaceUuid::parse(encoded.trim()) else {
        let _ = fs::remove_file(marker);
        return Ok(None);
    };
    if !library.contains(&workspace_id) {
        let _ = fs::remove_file(marker);
        return Ok(None);
    }
    match library.open_project(&workspace_id) {
        Ok(service) => Ok(Some(service)),
        Err(_) => {
            // A stale/corrupt last-active pointer must not prevent the catalog
            // from opening so the user can choose another recoverable project.
            let _ = fs::remove_file(marker);
            Ok(None)
        }
    }
}

fn persist_active_workspace(marker: &Path, workspace_id: &WorkspaceUuid) -> std::io::Result<()> {
    let parent = marker
        .parent()
        .ok_or_else(|| std::io::Error::other("active workspace marker has no parent"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staged = parent.join(format!(
        ".active-workspace-{}-{nonce}.part",
        std::process::id()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staged)?;
        file.write_all(workspace_id.as_str().as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        atomic_replace_file(&staged, marker)?;
        sync_native_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

#[cfg(windows)]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
    source_wide.push(0);
    let mut destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
    destination_wide.push(0);
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn sync_native_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn validate_encryption(
    encryption: ProjectEncryptionOptions,
    operation: &'static str,
) -> Result<Option<AgeScryptPassphraseStreams>, IpcError> {
    match (encryption.mode, encryption.passphrase) {
        (ProjectEncryptionMode::Plaintext, None) => Ok(None),
        (ProjectEncryptionMode::AgePassphrase, Some(passphrase)) => {
            let length = passphrase.chars().count();
            if !(12..=MAX_PASSPHRASE_CHARS).contains(&length) {
                return Err(IpcError::invalid_input(operation, "passphrase"));
            }
            AgeScryptPassphraseStreams::new(passphrase)
                .map(Some)
                .map_err(|error| project_error(error, operation))
        }
        _ => Err(IpcError::invalid_input(operation, "encryption")),
    }
}

fn ensure_main_window(window: &WebviewWindow, operation: &'static str) -> Result<(), IpcError> {
    if window.label() == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(IpcError::security_denied(operation))
    }
}

fn validate_project_path(
    path: &Path,
    must_exist: bool,
    operation: &'static str,
) -> Result<(), IpcError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("bbcom"))
        || (must_exist && !path.is_file())
        || (!must_exist && (path.is_dir() || path.parent().is_none_or(|parent| !parent.is_dir())))
    {
        return Err(IpcError::invalid_input(
            operation,
            if must_exist { "source" } else { "destination" },
        ));
    }
    Ok(())
}

fn validate_project_file_name(value: &str, operation: &'static str) -> Result<(), IpcError> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || !value.to_ascii_lowercase().ends_with(".bbcom")
    {
        return Err(IpcError::invalid_input(operation, "suggestedName"));
    }
    Ok(())
}

fn project_display_name(path: &Path, operation: &'static str) -> Result<String, IpcError> {
    let value = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| IpcError::invalid_input(operation, "displayName"))?;
    validate_project_file_name(value, operation)?;
    Ok(value.to_owned())
}

fn validate_opaque_id(
    value: &str,
    field: &'static str,
    operation: &'static str,
) -> Result<(), IpcError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(IpcError::invalid_input(operation, field));
    }
    Ok(())
}

fn random_workspace_uuid(operation: &'static str) -> Result<WorkspaceUuid, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation, true))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let value = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    );
    WorkspaceUuid::parse(&value).map_err(|error| project_error(error, operation))
}

fn random_opaque_id(prefix: &str, operation: &'static str) -> Result<String, IpcError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| io_failure(operation, true))?;
    let mut value = String::with_capacity(prefix.len() + 33);
    value.push_str(prefix);
    value.push('-');
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn current_time_millis(operation: &'static str) -> Result<u64, IpcError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io_failure(operation, false))?;
    u64::try_from(duration.as_millis()).map_err(|_| io_failure(operation, false))
}

fn project_error(error: ProjectContainerError, operation: &'static str) -> IpcError {
    match error {
        ProjectContainerError::InvalidInput { field } => IpcError::invalid_input(operation, field),
        ProjectContainerError::LimitExceeded {
            field,
            limit,
            actual,
        } => IpcError::new(
            AppErrorCode::LimitExceeded,
            "error.limit_exceeded",
            false,
            operation,
        )
        .with_field(field)
        .with_size(
            usize::try_from(limit).unwrap_or(usize::MAX),
            usize::try_from(actual).unwrap_or(usize::MAX),
        ),
        ProjectContainerError::Cancelled { .. } => cancelled(operation),
        ProjectContainerError::AlreadyExists => IpcError::invalid_input(operation, "workspaceId"),
        ProjectContainerError::Integrity | ProjectContainerError::AgeStream => corrupt(operation),
        ProjectContainerError::Workspace(error) => error.to_ipc_error(operation),
        ProjectContainerError::AgeIo(error) | ProjectContainerError::Io(error) => {
            io_error_kind(error.kind(), operation)
        }
    }
}

fn io_error_kind(kind: std::io::ErrorKind, operation: &'static str) -> IpcError {
    match kind {
        std::io::ErrorKind::PermissionDenied => IpcError::new(
            AppErrorCode::IoPermissionDenied,
            "error.io_permission_denied",
            false,
            operation,
        ),
        std::io::ErrorKind::StorageFull => IpcError::new(
            AppErrorCode::IoDiskFull,
            "error.io_disk_full",
            true,
            operation,
        ),
        _ => io_failure(operation, true),
    }
}

fn cancelled(operation: &'static str) -> IpcError {
    IpcError::new(AppErrorCode::Cancelled, "error.cancelled", false, operation)
}

fn corrupt(operation: &'static str) -> IpcError {
    IpcError::new(
        AppErrorCode::WorkspaceCorrupt,
        "error.workspace_corrupt",
        false,
        operation,
    )
}

fn io_failure(operation: &'static str, retryable: bool) -> IpcError {
    IpcError::new(
        AppErrorCode::WorkspaceCorrupt,
        "error.workspace_io_failed",
        retryable,
        operation,
    )
}

#[cfg(test)]
mod tests {
    use std::io;

    use bbcom_workspace::WorkspaceError;

    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let mut bytes = [0_u8; 8];
        getrandom::fill(&mut bytes).expect("test entropy");
        let suffix = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        std::env::temp_dir().join(format!("bbcom-workspace-manager-{label}-{suffix}"))
    }

    #[test]
    fn last_active_workspace_survives_manager_restart() {
        let root = temporary_root("last-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000011").expect("workspace id");
        let service = manager
            .library
            .create_project(&workspace_id, "last active", 1)
            .expect("create project");
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active");
        drop(manager);

        let reopened = WorkspaceManager::open(&root).expect("reopen manager");
        let active = lock_active(&reopened, "test").expect("active lock");
        let header = active
            .as_ref()
            .expect("restored active project")
            .header()
            .expect("active header");
        assert_eq!(header.workspace_id, workspace_id.as_str());
        drop(active);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn stale_active_marker_does_not_block_catalog_startup() {
        let root = temporary_root("stale-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        persist_active_workspace(
            &manager.active_marker,
            &WorkspaceUuid::parse("00000000-0000-4000-8000-000000000012").expect("workspace id"),
        )
        .expect("persist stale marker");
        drop(manager);

        let reopened = WorkspaceManager::open(&root).expect("reopen manager");
        assert!(
            lock_active(&reopened, "test")
                .expect("active lock")
                .is_none()
        );
        assert!(!reopened.active_marker.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn non_utf8_active_marker_does_not_block_catalog_startup() {
        let root = temporary_root("non-utf8-active");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        fs::write(&manager.active_marker, [0xff, 0xfe, 0xfd]).expect("write malformed marker");
        drop(manager);

        let reopened = WorkspaceManager::open(&root).expect("reopen manager");
        assert!(
            lock_active(&reopened, "test")
                .expect("active lock")
                .is_none()
        );
        assert!(!reopened.active_marker.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_operation_cancellation_and_commit_barrier_are_atomic() {
        let root = temporary_root("operation-cancel");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let cancellation = manager
            .begin_operation("workspace-operation-1", "test")
            .expect("begin operation");
        assert_eq!(cancellation.phase(), WorkspaceOperationPhase::Cancellable);
        assert!(
            manager
                .cancel_operation("workspace-operation-1", "test")
                .expect("cancel operation")
        );
        assert!(
            manager
                .cancel_operation("workspace-operation-1", "test")
                .expect("repeat cancellation remains acknowledged")
        );
        assert!(cancellation.is_cancelled(ContainerCheckpoint::ImportBeforeCommit));
        assert_eq!(
            cancellation.phase(),
            WorkspaceOperationPhase::CancelRequested
        );
        manager.finish_operation("workspace-operation-1");
        assert_eq!(cancellation.phase(), WorkspaceOperationPhase::Finished);
        assert!(
            !manager
                .cancel_operation("workspace-operation-1", "test")
                .expect("finished operation is absent")
        );

        let committing = manager
            .begin_operation("workspace-operation-2", "test")
            .expect("begin committing operation");
        assert!(!committing.is_cancelled(ContainerCheckpoint::ExportBeforeCommit));
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Committing);
        assert!(
            !manager
                .cancel_operation("workspace-operation-2", "test")
                .expect("committing operation rejects late cancellation")
        );
        manager.finish_operation("workspace-operation-2");
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Finished);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_operation_registry_rejects_invalid_duplicate_and_excess_ids() {
        let root = temporary_root("operation-limits");
        let manager = WorkspaceManager::open(&root).expect("open manager");

        let invalid = manager.begin_operation("bad id", "test").unwrap_err();
        assert_eq!(invalid.code, AppErrorCode::InvalidInput);
        assert_eq!(invalid.field, Some("operationId"));

        manager
            .begin_operation("operation-0", "test")
            .expect("begin first operation");
        let duplicate = manager.begin_operation("operation-0", "test").unwrap_err();
        assert_eq!(duplicate.code, AppErrorCode::Busy);
        assert_eq!(duplicate.field, Some("operationId"));

        for index in 1..MAX_CONCURRENT_WORKSPACE_OPERATIONS {
            manager
                .begin_operation(&format!("operation-{index}"), "test")
                .expect("fill operation registry");
        }
        let limited = manager
            .begin_operation("operation-overflow", "test")
            .unwrap_err();
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!(limited.limit, Some(MAX_CONCURRENT_WORKSPACE_OPERATIONS));
        assert_eq!(
            limited.actual,
            Some(MAX_CONCURRENT_WORKSPACE_OPERATIONS + 1)
        );

        assert!(!manager.cancel_operation("missing", "test").unwrap());
        assert_eq!(
            manager
                .cancel_operation("bad id", "test")
                .unwrap_err()
                .field,
            Some("operationId")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn cancellation_is_observed_before_but_not_after_the_commit_barrier() {
        let control = WorkspaceOperationControl::new();
        assert!(!control.is_cancelled(ContainerCheckpoint::ImportCopy));
        assert!(control.request_cancel());
        assert!(control.is_cancelled(ContainerCheckpoint::ImportBeforeValidation));

        let committing = WorkspaceOperationControl::new();
        assert!(!committing.is_cancelled(ContainerCheckpoint::ImportBeforeCommit));
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Committing);
        assert!(!committing.request_cancel());
        assert!(!committing.is_cancelled(ContainerCheckpoint::ExportBeforeBackup));
        committing.finish();
        assert_eq!(committing.phase(), WorkspaceOperationPhase::Finished);
    }

    #[tokio::test]
    async fn project_grants_are_kind_bound_single_use_and_capacity_limited() {
        let root = temporary_root("grant-lifecycle");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let source_path = root.join("source.bbcom");

        let wrong_kind = manager
            .issue_grant(ProjectGrantKind::Source, source_path.clone(), "test")
            .await
            .expect("issue source grant");
        let denied = manager
            .consume_grant(&wrong_kind, ProjectGrantKind::Target, "test")
            .await
            .unwrap_err();
        assert_eq!(denied.code, AppErrorCode::SecurityDenied);
        assert!(
            manager
                .consume_grant(&wrong_kind, ProjectGrantKind::Source, "test")
                .await
                .is_err(),
            "a kind mismatch must consume the capability"
        );

        let source = manager
            .issue_grant(ProjectGrantKind::Source, source_path.clone(), "test")
            .await
            .expect("issue source grant");
        assert_eq!(
            manager
                .consume_grant(&source, ProjectGrantKind::Source, "test")
                .await
                .expect("consume source grant"),
            source_path
        );
        assert!(
            manager
                .consume_grant(&source, ProjectGrantKind::Source, "test")
                .await
                .is_err()
        );

        for index in 0..MAX_PROJECT_GRANTS {
            manager
                .issue_grant(
                    ProjectGrantKind::Target,
                    root.join(format!("target-{index}.bbcom")),
                    "test",
                )
                .await
                .expect("fill grant registry");
        }
        let limited = manager
            .issue_grant(
                ProjectGrantKind::Target,
                root.join("overflow.bbcom"),
                "test",
            )
            .await
            .unwrap_err();
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!(limited.limit, Some(MAX_PROJECT_GRANTS));

        manager.grants.lock().await.clear();
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test]
    async fn expired_project_grants_are_removed_before_resolution_and_issue() {
        let root = temporary_root("grant-expiry");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let expired_id = "expired-project-grant".to_owned();
        manager.grants.lock().await.insert(
            expired_id.clone(),
            ProjectGrant {
                kind: ProjectGrantKind::Source,
                path: root.join("expired.bbcom"),
                issued_at: Instant::now()
                    .checked_sub(PROJECT_GRANT_TTL + Duration::from_secs(1))
                    .expect("past instant"),
            },
        );

        let expired = manager
            .consume_grant(&expired_id, ProjectGrantKind::Source, "test")
            .await
            .unwrap_err();
        assert_eq!(expired.code, AppErrorCode::InvalidInput);
        let replacement = manager
            .issue_grant(
                ProjectGrantKind::Source,
                root.join("replacement.bbcom"),
                "test",
            )
            .await
            .expect("expired entry no longer consumes capacity");
        assert!(replacement.starts_with("project-grant-"));

        manager.grants.lock().await.clear();
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn reset_workspace_creation_is_idempotent_and_verification_is_strict() {
        let root = temporary_root("reset-workspace");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let workspace_id = "00000000-0000-4000-8000-000000000021";

        manager
            .ensure_empty_reset_workspace(workspace_id, "reset", 0, 10, "test")
            .expect("create reset workspace");
        manager
            .ensure_empty_reset_workspace(workspace_id, "reset", 0, 20, "test")
            .expect("resume reset workspace creation");
        manager
            .verify_empty_reset_workspace(workspace_id, "reset", 0, "test")
            .expect("verify reset workspace");

        for (name, revision) in [("wrong", 0), ("reset", 1)] {
            let error = manager
                .verify_empty_reset_workspace(workspace_id, name, revision, "test")
                .unwrap_err();
            assert_eq!(error.code, AppErrorCode::WorkspaceCorrupt);
            assert_eq!(error.field, Some("workspaceId"));
        }
        assert_eq!(
            manager
                .verify_empty_reset_workspace("invalid", "reset", 0, "test")
                .unwrap_err()
                .code,
            AppErrorCode::InvalidInput
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn active_workspace_requires_an_exact_active_identity() {
        let root = temporary_root("active-identity");
        let manager = WorkspaceManager::open(&root).expect("open manager");
        let absent = active_workspace(&manager, "missing", "test").unwrap_err();
        assert_eq!(absent.field, Some("workspaceId"));

        let workspace_id =
            WorkspaceUuid::parse("00000000-0000-4000-8000-000000000022").expect("workspace id");
        let service = manager
            .library
            .create_project(&workspace_id, "active", 1)
            .expect("create active workspace");
        commit_active_workspace(&manager, workspace_id.as_str(), service, "test")
            .expect("commit active workspace");
        assert!(active_workspace(&manager, workspace_id.as_str(), "test").is_ok());
        assert_eq!(
            active_workspace(&manager, "00000000-0000-4000-8000-000000000023", "test")
                .unwrap_err()
                .field,
            Some("workspaceId")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn oversized_and_malformed_active_markers_fail_closed() {
        for (label, bytes) in [
            (
                "oversized",
                vec![b'a'; MAX_ACTIVE_WORKSPACE_FILE_BYTES as usize + 1],
            ),
            ("malformed", b"not-a-workspace-id\n".to_vec()),
        ] {
            let root = temporary_root(label);
            let manager = WorkspaceManager::open(&root).expect("open manager");
            fs::write(&manager.active_marker, bytes).expect("write invalid marker");
            drop(manager);

            let reopened = WorkspaceManager::open(&root).expect("ignore invalid marker");
            assert!(lock_active(&reopened, "test").unwrap().is_none());
            assert!(!reopened.active_marker.exists());
            fs::remove_dir_all(root).expect("remove test root");
        }
    }

    #[test]
    fn workspace_input_validators_cover_encryption_paths_and_file_targets() {
        let root = temporary_root("validators");
        fs::create_dir_all(&root).expect("create root");
        let source = root.join("source.BBCOM");
        fs::write(&source, b"project").expect("write source");
        assert!(validate_project_path(&source, true, "test").is_ok());
        assert!(validate_project_path(&root.join("target.BBCOM"), false, "test").is_ok());
        let directory_target = root.join("directory.bbcom");
        fs::create_dir(&directory_target).expect("create directory target");
        assert!(validate_project_path(&directory_target, false, "test").is_err());
        assert!(validate_project_path(&root.join("wrong.txt"), false, "test").is_err());
        assert!(validate_project_file_name("Project.BBCOM", "test").is_ok());
        for invalid in [
            "",
            "nested/project.bbcom",
            "nested\\project.bbcom",
            "project.txt",
        ] {
            assert!(validate_project_file_name(invalid, "test").is_err());
        }
        assert_eq!(
            project_display_name(&source, "test").expect("display name"),
            "source.BBCOM"
        );

        assert!(
            validate_encryption(
                ProjectEncryptionOptions {
                    mode: ProjectEncryptionMode::Plaintext,
                    passphrase: None,
                },
                "test"
            )
            .expect("plaintext")
            .is_none()
        );
        assert!(
            validate_encryption(
                ProjectEncryptionOptions {
                    mode: ProjectEncryptionMode::AgePassphrase,
                    passphrase: Some("twelve-chars".to_owned()),
                },
                "test"
            )
            .expect("encrypted")
            .is_some()
        );
        for encryption in [
            ProjectEncryptionOptions {
                mode: ProjectEncryptionMode::Plaintext,
                passphrase: Some("unexpected-secret".to_owned()),
            },
            ProjectEncryptionOptions {
                mode: ProjectEncryptionMode::AgePassphrase,
                passphrase: None,
            },
            ProjectEncryptionOptions {
                mode: ProjectEncryptionMode::AgePassphrase,
                passphrase: Some("too-short".to_owned()),
            },
        ] {
            assert!(validate_encryption(encryption, "test").is_err());
        }

        for valid in ["request", "request.id_1:value-2"] {
            assert!(validate_opaque_id(valid, "requestId", "test").is_ok());
        }
        for invalid in ["", "bad id", "bad/path"] {
            assert!(validate_opaque_id(invalid, "requestId", "test").is_err());
        }
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_error_mapping_preserves_stable_codes_and_bounds() {
        let invalid = project_error(
            ProjectContainerError::InvalidInput { field: "source" },
            "test",
        );
        assert_eq!(
            (invalid.code, invalid.field),
            (AppErrorCode::InvalidInput, Some("source"))
        );

        let limited = project_error(
            ProjectContainerError::LimitExceeded {
                field: "frames",
                limit: 4,
                actual: 5,
            },
            "test",
        );
        assert_eq!(limited.code, AppErrorCode::LimitExceeded);
        assert_eq!((limited.limit, limited.actual), (Some(4), Some(5)));
        assert_eq!(
            project_error(
                ProjectContainerError::Cancelled {
                    checkpoint: ContainerCheckpoint::ImportCopy,
                },
                "test"
            )
            .code,
            AppErrorCode::Cancelled
        );
        assert_eq!(
            project_error(ProjectContainerError::AlreadyExists, "test").field,
            Some("workspaceId")
        );
        for error in [
            ProjectContainerError::Integrity,
            ProjectContainerError::AgeStream,
        ] {
            assert_eq!(
                project_error(error, "test").code,
                AppErrorCode::WorkspaceCorrupt
            );
        }
        assert_eq!(
            project_error(
                ProjectContainerError::Workspace(WorkspaceError::ReadOnly),
                "test"
            )
            .code,
            AppErrorCode::WorkspaceReadOnly
        );
        assert_eq!(
            project_error(
                ProjectContainerError::Io(io::Error::from(io::ErrorKind::PermissionDenied)),
                "test"
            )
            .code,
            AppErrorCode::IoPermissionDenied
        );
        assert_eq!(
            project_error(
                ProjectContainerError::AgeIo(io::Error::from(io::ErrorKind::StorageFull)),
                "test"
            )
            .code,
            AppErrorCode::IoDiskFull
        );
        assert!(
            project_error(
                ProjectContainerError::Io(io::Error::from(io::ErrorKind::Other)),
                "test"
            )
            .retryable
        );
    }
}
