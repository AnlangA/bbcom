import type {
  ApplyWorkspaceBatchRequest,
  ApplyWorkspaceBatchResponse,
  CancelWorkspaceOperationRequest,
  CancelWorkspaceOperationResponse,
  CreateWorkspaceCommandRequest,
  CreateWorkspaceCommandResponse,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  ExportProjectRequest,
  ExportProjectResponse,
  FlushWorkspaceRequest,
  FlushWorkspaceResponse,
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
  WorkspaceSaveHealth,
} from '@/generated/ipc-contracts';
import type { WorkspaceCoordinatorPort, WorkspacePortCallContext } from './types';
import {
  InvalidWorkspaceResponseError,
  requireMatchingRequestId,
  sanitizeCatalog,
  sanitizeHeader,
  sanitizeWorkspaceSummary,
  validateCommittedRevision,
  validateProjectFileDisplayName,
  validateProjectName,
  validateRequestId,
  validateResponseOpaqueId,
  validateSuggestedProjectFileName,
  validateWorkspaceId,
  workspaceGrantId,
} from './validation';

const SAVE_HEALTHS: ReadonlySet<WorkspaceSaveHealth> = new Set([
  'clean',
  'pending',
  'saving',
  'degraded',
  'readOnly',
]);

/**
 * Stateless validation/cancellation boundary in front of the native workspace
 * transport. It deliberately owns no active workspace, revision, save health,
 * catalog state, or activation state.
 */
export class ValidatedWorkspaceGateway implements WorkspaceCoordinatorPort {
  constructor(private readonly transport: WorkspaceCoordinatorPort) {}

  async loadCatalog(
    request: WorkspaceCatalogRequest,
    context: WorkspacePortCallContext,
  ): Promise<WorkspaceCatalogResponse> {
    const requestId = validateRequestId(request.requestId);
    const response = await this.call(
      () => this.transport.loadCatalog({ requestId }, context),
      context,
    );
    sanitizeCatalog(response, requestId);
    return response;
  }

  async openWorkspace(
    request: OpenWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<OpenWorkspaceResponse> {
    const safe = {
      requestId: validateRequestId(request.requestId),
      workspaceId: validateWorkspaceId(request.workspaceId),
    };
    const response = await this.nativeCall(
      () => this.transport.openWorkspace(safe, context),
      context,
    );
    this.validateActivationResponse(response, safe.requestId, safe.workspaceId);
    return response;
  }

  async createWorkspace(
    request: CreateWorkspaceCommandRequest,
    context: WorkspacePortCallContext,
  ): Promise<CreateWorkspaceCommandResponse> {
    const safe = {
      requestId: validateRequestId(request.requestId),
      name: validateProjectName(request.name),
    };
    const response = await this.nativeCall(
      () => this.transport.createWorkspace(safe, context),
      context,
    );
    this.validateActivationResponse(response, safe.requestId);
    if (response.workspace.name !== safe.name || response.header.name !== safe.name) {
      throw new InvalidWorkspaceResponseError('name');
    }
    return response;
  }

  async deleteWorkspace(
    request: DeleteWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<DeleteWorkspaceResponse> {
    const safe = {
      requestId: validateRequestId(request.requestId),
      workspaceId: validateWorkspaceId(request.workspaceId),
    };
    const response = await this.nativeCall(
      () => this.transport.deleteWorkspace(safe, context),
      context,
    );
    requireMatchingRequestId(response.requestId, safe.requestId);
    if (validateWorkspaceId(response.workspaceId) !== safe.workspaceId) {
      throw new InvalidWorkspaceResponseError('workspaceId');
    }
    return response;
  }

  async requestProjectSourceGrant(
    request: RequestProjectSourceGrantRequest,
    context: WorkspacePortCallContext,
  ): Promise<ProjectSourceGrantResponse> {
    const requestId = validateRequestId(request.requestId);
    const response = await this.call(
      () => this.transport.requestProjectSourceGrant({ requestId }, context),
      context,
    );
    requireMatchingRequestId(response.requestId, requestId);
    workspaceGrantId(response.sourceGrantId);
    validateProjectFileDisplayName(response.displayName);
    return response;
  }

  async requestProjectTargetGrant(
    request: RequestProjectTargetGrantRequest,
    context: WorkspacePortCallContext,
  ): Promise<ProjectTargetGrantResponse> {
    const safe = {
      requestId: validateRequestId(request.requestId),
      suggestedName: validateSuggestedProjectFileName(request.suggestedName),
    };
    const response = await this.call(
      () => this.transport.requestProjectTargetGrant(safe, context),
      context,
    );
    requireMatchingRequestId(response.requestId, safe.requestId);
    workspaceGrantId(response.targetGrantId);
    validateProjectFileDisplayName(response.displayName);
    return response;
  }

  async importProject(
    request: ImportProjectRequest,
    context: WorkspacePortCallContext,
  ): Promise<ImportProjectResponse> {
    const requestId = validateRequestId(request.requestId);
    const operationId = validateRequestId(request.operationId);
    workspaceGrantId(request.sourceGrantId);
    const response = await this.nativeCall(
      () => this.transport.importProject(request, context),
      context,
    );
    requireMatchingRequestId(response.requestId, requestId);
    requireEqualOpaqueId(response.operationId, operationId, 'operationId');
    sanitizeWorkspaceSummary(response.workspace);
    return response;
  }

  async exportProject(
    request: ExportProjectRequest,
    context: WorkspacePortCallContext,
  ): Promise<ExportProjectResponse> {
    const requestId = validateRequestId(request.requestId);
    const operationId = validateRequestId(request.operationId);
    validateWorkspaceId(request.workspaceId);
    workspaceGrantId(request.targetGrantId);
    const response = await this.nativeCall(
      () => this.transport.exportProject(request, context),
      context,
    );
    requireMatchingRequestId(response.requestId, requestId);
    requireEqualOpaqueId(response.operationId, operationId, 'operationId');
    validateProjectFileDisplayName(response.displayName);
    return response;
  }

  async cancelWorkspaceOperation(
    request: CancelWorkspaceOperationRequest,
    context: WorkspacePortCallContext,
  ): Promise<CancelWorkspaceOperationResponse> {
    const safe = {
      requestId: validateRequestId(request.requestId),
      operationId: validateRequestId(request.operationId),
    };
    const response = await this.call(
      () => this.transport.cancelWorkspaceOperation(safe, context),
      context,
    );
    requireMatchingRequestId(response.requestId, safe.requestId);
    requireEqualOpaqueId(response.operationId, safe.operationId, 'operationId');
    if (typeof response.cancellationRequested !== 'boolean') {
      throw new InvalidWorkspaceResponseError('cancellationRequested');
    }
    return response;
  }

  async applyWorkspaceBatch(
    request: ApplyWorkspaceBatchRequest,
    context: WorkspacePortCallContext,
  ): Promise<ApplyWorkspaceBatchResponse> {
    validateWorkspaceId(request.workspaceId);
    validateRequestId(request.clientBatchId);
    validateCommittedRevision(request.baseRevision, 'baseRevision');
    if (!Array.isArray(request.mutations)) throw new TypeError('invalid workspace mutations');
    const response = await this.call(
      () => this.transport.applyWorkspaceBatch(request, context),
      context,
    );
    requireEqualOpaqueId(response.clientBatchId, request.clientBatchId, 'clientBatchId');
    validateCommittedRevision(response.committedRevision);
    return response;
  }

  async flushWorkspace(
    request: FlushWorkspaceRequest,
    context: WorkspacePortCallContext,
  ): Promise<FlushWorkspaceResponse> {
    validateWorkspaceId(request.workspaceId);
    validateCommittedRevision(request.targetRevision, 'targetRevision');
    const response = await this.call(
      () => this.transport.flushWorkspace(request, context),
      context,
    );
    validateCommittedRevision(response.committedRevision);
    if (!SAVE_HEALTHS.has(response.saveHealth)) {
      throw new InvalidWorkspaceResponseError('saveHealth');
    }
    return response;
  }

  private validateActivationResponse(
    response: OpenWorkspaceResponse | CreateWorkspaceCommandResponse,
    requestId: string,
    workspaceId?: string,
  ): void {
    requireMatchingRequestId(response.requestId, requestId);
    const summary = sanitizeWorkspaceSummary(response.workspace);
    const header = sanitizeHeader(response.header);
    if (summary.workspaceId !== header.workspaceId || summary.revision !== header.revision) {
      throw new InvalidWorkspaceResponseError('workspace');
    }
    if (workspaceId && summary.workspaceId !== workspaceId) {
      throw new InvalidWorkspaceResponseError('workspaceId');
    }
  }

  private async call<T>(run: () => Promise<T>, context: WorkspacePortCallContext): Promise<T> {
    throwIfAborted(context.signal);
    const response = await run();
    throwIfAborted(context.signal);
    return response;
  }

  /** Native import/export/activation responses remain authoritative after dispatch. */
  private async nativeCall<T>(
    run: () => Promise<T>,
    context: WorkspacePortCallContext,
  ): Promise<T> {
    throwIfAborted(context.signal);
    return run();
  }
}

function requireEqualOpaqueId(actual: unknown, expected: string, field: string): void {
  const value = validateResponseOpaqueId(actual, field);
  if (value !== expected) throw new InvalidWorkspaceResponseError(field);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('workspace operation aborted');
  error.name = 'AbortError';
  throw error;
}
