import { invoke } from '@tauri-apps/api/core';
import type {
  ApplyWorkspaceBatchRequest,
  ApplyWorkspaceBatchResponse,
  CancelWorkspaceOperationRequest,
  CancelWorkspaceOperationResponse,
  CreateWorkspaceCommandRequest,
  CreateWorkspaceCommandResponse,
  ExportProjectRequest,
  ExportProjectResponse,
  FlushWorkspaceRequest,
  FlushWorkspaceResponse,
  HydrateWorkspaceAiMessagesRequest,
  HydrateWorkspaceAiMessagesResponse,
  HydrateWorkspaceCollectionsRequest,
  HydrateWorkspaceCollectionsResponse,
  HydrateWorkspaceFramesRequest,
  HydrateWorkspaceFramesResponse,
  HydrateWorkspaceSessionsRequest,
  HydrateWorkspaceSessionsResponse,
  HydrateWorkspaceWaveformRequest,
  HydrateWorkspaceWaveformResponse,
  ImportProjectRequest,
  ImportProjectResponse,
  OpenWorkspaceRequest,
  OpenWorkspaceResponse,
  ProjectSourceGrantResponse,
  ProjectTargetGrantResponse,
  RequestProjectSourceGrantRequest,
  RequestProjectTargetGrantRequest,
  WorkspaceCatalogRequest,
  WorkspaceCatalogResponse,
} from '../../generated/ipc-contracts';
import type { WorkspaceHydrationPort } from './adapters';
import type { WorkspaceCoordinatorPort, WorkspacePortCallContext } from './types';

/** Generated-DTO-only transport to the Rust-owned workspace service. */
export class TauriWorkspacePort implements WorkspaceCoordinatorPort, WorkspaceHydrationPort {
  loadCatalog(
    request: WorkspaceCatalogRequest,
    context: WorkspacePortCallContext,
  ): Promise<WorkspaceCatalogResponse> {
    return invokeGuarded('workspace_catalog', request, context);
  }

  openWorkspace(
    request: OpenWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<OpenWorkspaceResponse> {
    return invokeNativeOperation('open_workspace', request, context);
  }

  createWorkspace(
    request: CreateWorkspaceCommandRequest,
    context: WorkspacePortCallContext,
  ): Promise<CreateWorkspaceCommandResponse> {
    return invokeNativeOperation('create_workspace', request, context);
  }

  requestProjectSourceGrant(
    request: RequestProjectSourceGrantRequest,
    context: WorkspacePortCallContext,
  ): Promise<ProjectSourceGrantResponse> {
    return invokeGuarded('request_project_source_grant', request, context);
  }

  requestProjectTargetGrant(
    request: RequestProjectTargetGrantRequest,
    context: WorkspacePortCallContext,
  ): Promise<ProjectTargetGrantResponse> {
    return invokeGuarded('request_project_target_grant', request, context);
  }

  importProject(
    request: ImportProjectRequest,
    context: WorkspacePortCallContext,
  ): Promise<ImportProjectResponse> {
    return invokeNativeOperation('import_project', request, context);
  }

  exportProject(
    request: ExportProjectRequest,
    context: WorkspacePortCallContext,
  ): Promise<ExportProjectResponse> {
    return invokeNativeOperation('export_project', request, context);
  }

  cancelWorkspaceOperation(
    request: CancelWorkspaceOperationRequest,
    context: WorkspacePortCallContext,
  ): Promise<CancelWorkspaceOperationResponse> {
    return invokeGuarded('cancel_workspace_operation', request, context);
  }

  applyWorkspaceBatch(
    request: ApplyWorkspaceBatchRequest,
    context: WorkspacePortCallContext,
  ): Promise<ApplyWorkspaceBatchResponse> {
    return invokeGuarded('apply_workspace_batch', request, context);
  }

  flushWorkspace(
    request: FlushWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<FlushWorkspaceResponse> {
    return invokeGuarded('flush_workspace', request, context);
  }

  hydrateSessions(
    request: HydrateWorkspaceSessionsRequest,
  ): Promise<HydrateWorkspaceSessionsResponse> {
    return invokeWorkspace('hydrate_workspace_sessions', request);
  }

  hydrateFrames(request: HydrateWorkspaceFramesRequest): Promise<HydrateWorkspaceFramesResponse> {
    return invokeWorkspace('hydrate_workspace_frames', request);
  }

  hydrateCollections(
    request: HydrateWorkspaceCollectionsRequest,
  ): Promise<HydrateWorkspaceCollectionsResponse> {
    return invokeWorkspace('hydrate_workspace_collections', request);
  }

  hydrateAiMessages(
    request: HydrateWorkspaceAiMessagesRequest,
  ): Promise<HydrateWorkspaceAiMessagesResponse> {
    return invokeWorkspace('hydrate_workspace_ai_messages', request);
  }

  hydrateWaveform(
    request: HydrateWorkspaceWaveformRequest,
  ): Promise<HydrateWorkspaceWaveformResponse> {
    return invokeWorkspace('hydrate_workspace_waveform', request);
  }
}

async function invokeGuarded<TRequest, TResponse>(
  command: string,
  request: TRequest,
  context: WorkspacePortCallContext,
): Promise<TResponse> {
  throwIfAborted(context.signal);
  const response = await invokeWorkspace<TRequest, TResponse>(command, request);
  throwIfAborted(context.signal);
  return response;
}

/**
 * Native project operations have an explicit cancellation command and an
 * atomic commit boundary. Once invoked, always observe their actual response:
 * a renderer AbortSignal must not rewrite a completed native commit into a
 * local AbortError.
 */
function invokeNativeOperation<TRequest, TResponse>(
  command: string,
  request: TRequest,
  context: WorkspacePortCallContext,
): Promise<TResponse> {
  throwIfAborted(context.signal);
  return invokeWorkspace<TRequest, TResponse>(command, request);
}

function invokeWorkspace<TRequest, TResponse>(
  command: string,
  request: TRequest,
): Promise<TResponse> {
  return invoke<TResponse>(command, { request });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('workspace operation aborted');
  error.name = 'AbortError';
  throw error;
}
