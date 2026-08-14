import type {
  ApplyWorkspaceBatchRequest,
  CreateWorkspaceCommandResponse,
  FlushWorkspaceResponse,
  OpenWorkspaceResponse,
  ProjectEncryptionOptions,
  WorkspaceMutation,
  WorkspaceSaveHealth,
} from '../../generated/ipc-contracts';
import { createProjectLibraryViewModel } from './project-library-view-model';
import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionOutcome,
  WorkspaceCoordinatorListener,
  WorkspaceCoordinatorOptions,
  WorkspaceCoordinatorPort,
  WorkspaceCoordinatorSnapshot,
  WorkspaceExportCancellationStatus,
  WorkspaceLibraryStatus,
  WorkspaceMutationCommand,
  WorkspaceNavigationAction,
  WorkspacePortCallContext,
  WorkspaceProjectViewModel,
} from './types';
import {
  InvalidWorkspaceResponseError,
  createSequencedMutation,
  isWorkspaceReadOnlyError,
  requireMatchingRequestId,
  safeFailure,
  sanitizeCatalog,
  sanitizeHeader,
  sanitizeWorkspaceSummary,
  sanitizeWorkspaceLayout,
  validateCommittedRevision,
  validateProjectFileDisplayName,
  validateProjectName,
  validateRequestId,
  validateResponseOpaqueId,
  validateSuggestedProjectFileName,
  validateWorkspaceId,
  workspaceGrantId,
} from './validation';

interface MutableActiveWorkspace {
  workspaceId: string;
  name: string;
  revision: number;
  activeSessionId: string | null;
  sessionIds: readonly string[];
  saveHealth: WorkspaceSaveHealth;
  layout: import('./types').WorkspaceLayoutV1;
}

interface PendingCall {
  readonly generation: number;
  readonly requestId: string;
  readonly controller: AbortController;
  cancelledByUser: boolean;
  operationId: string | null;
  operationSettlement: NativeOperationSettlement | null;
  nativeCancellation: Promise<boolean> | null;
  nativeOutcome: 'completed' | 'cancelled' | 'failed' | null;
}

interface NativeOperationSettlement {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface WriteEpoch {
  readonly number: number;
  readonly workspaceId: string;
  readonly controller: AbortController;
  tail: Promise<void>;
  pending: number;
  inFlight: boolean;
  sequence: number;
}

interface MutationTicket {
  readonly workspaceId: string;
  readonly epoch: WriteEpoch;
  readonly mutations: readonly WorkspaceMutation[];
  readonly clientBatchId: string;
}

type ActivationResponse = OpenWorkspaceResponse | CreateWorkspaceCommandResponse;

interface ActivationEnvelope {
  readonly response: ActivationResponse;
  readonly expectedRequestId: string;
  readonly expectedWorkspaceId?: string;
  readonly expectedName?: string;
}

let fallbackIdSequence = 0;

/**
 * The main renderer's sole logical workspace writer.
 *
 * Every write is serialized through the current WriteEpoch. No caller receives
 * the physical persistence port, and switching workspaces invalidates all old
 * responses before they can alter the active document.
 */
export class WorkspaceCoordinator {
  private readonly listeners = new Set<WorkspaceCoordinatorListener>();
  private readonly idFactory: NonNullable<WorkspaceCoordinatorOptions['idFactory']>;
  private operations: WorkspaceCoordinatorOptions['operations'];
  private projects: readonly WorkspaceProjectViewModel[] = Object.freeze([]);
  private libraryStatus: WorkspaceLibraryStatus = 'idle';
  private libraryMessageKey: string | null = null;
  private catalogActiveWorkspaceId: string | null = null;
  private active: MutableActiveWorkspace | null = null;
  private navigationAction: WorkspaceNavigationAction | null = null;
  private catalogGeneration = 0;
  private activationGeneration = 0;
  private exportGeneration = 0;
  private writeEpochNumber = 0;
  private catalogCall: PendingCall | null = null;
  private activationCall: PendingCall | null = null;
  private exportCall: PendingCall | null = null;
  private writeEpoch: WriteEpoch | null = null;

  constructor(
    private readonly port: WorkspaceCoordinatorPort,
    options: WorkspaceCoordinatorOptions = {},
  ) {
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.operations = options.operations;
  }

  get activeWorkspaceId(): string | null {
    return this.active?.workspaceId ?? null;
  }

  get acceptsMutations(): boolean {
    return Boolean(this.active && this.active.saveHealth !== 'readOnly');
  }

  /** Attach the application registry bridge once; it remains owned by the app. */
  attachOperationLifecycle(
    operations: NonNullable<WorkspaceCoordinatorOptions['operations']>,
  ): void {
    if (this.operations && this.operations !== operations) {
      throw new Error('workspace operation lifecycle is already attached');
    }
    this.operations = operations;
  }

  snapshot(): WorkspaceCoordinatorSnapshot {
    const activeWorkspace = this.active ? freezeActive(this.active) : null;
    const activeWorkspaceId = activeWorkspace?.workspaceId ?? this.catalogActiveWorkspaceId;
    return Object.freeze({
      library: createProjectLibraryViewModel({
        status: this.libraryStatus,
        projects: this.projects,
        activeWorkspaceId,
        navigationAction: this.navigationAction,
        messageKey: this.libraryMessageKey,
      }),
      activeWorkspace,
      navigationAction: this.navigationAction,
      exporting: this.exportCall !== null,
      acceptsMutations: this.acceptsMutations,
    });
  }

  subscribe(listener: WorkspaceCoordinatorListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // View observers cannot influence workspace state transitions.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refreshCatalog(): Promise<WorkspaceActionOutcome<WorkspaceCoordinatorSnapshot>> {
    const call = this.beginCall('catalog', ++this.catalogGeneration);
    this.catalogCall?.controller.abort();
    this.catalogCall = call;
    this.libraryStatus = 'loading';
    this.libraryMessageKey = null;
    this.notify();
    try {
      const response = await this.port.loadCatalog({ requestId: call.requestId }, contextFor(call));
      if (!this.isCurrentCatalog(call)) return staleOutcome(call);
      const catalog = sanitizeCatalog(response, call.requestId);
      this.projects = catalog.projects;
      this.catalogActiveWorkspaceId = this.active?.workspaceId ?? catalog.activeWorkspaceId;
      this.mergeActiveIntoProjects();
      this.libraryStatus = 'ready';
      this.libraryMessageKey = null;
      this.catalogCall = null;
      this.notify();
      return completed(this.snapshot());
    } catch (error) {
      if (!this.isCurrentCatalog(call)) return staleOutcome(call);
      this.catalogCall = null;
      this.libraryStatus = 'failed';
      const failure = safeFailure(error, 'workspace.catalog.load_failed');
      this.libraryMessageKey = failure.messageKey;
      this.notify();
      return failure;
    }
  }

  cancelCatalogRefresh(): boolean {
    const call = this.catalogCall;
    if (!call) return false;
    call.cancelledByUser = true;
    call.controller.abort();
    this.catalogCall = null;
    this.catalogGeneration += 1;
    this.libraryStatus = this.projects.length > 0 ? 'ready' : 'idle';
    this.libraryMessageKey = null;
    this.notify();
    return true;
  }

  openWorkspace(workspaceId: string): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    const validatedWorkspaceId = validateWorkspaceId(workspaceId);
    return this.activate('open', async (call) => {
      const response = await this.port.openWorkspace(
        { requestId: call.requestId, workspaceId: validatedWorkspaceId },
        contextFor(call),
      );
      return {
        response,
        expectedRequestId: call.requestId,
        expectedWorkspaceId: validatedWorkspaceId,
      };
    });
  }

  createWorkspace(name: string): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    const validatedName = validateProjectName(name);
    return this.activate('create', async (call) => {
      const response = await this.port.createWorkspace(
        { requestId: call.requestId, name: validatedName },
        contextFor(call),
      );
      return { response, expectedRequestId: call.requestId, expectedName: validatedName };
    });
  }

  /** Select, stage, import, and then open a `.bbcom` project through opaque grants only. */
  importWorkspace(
    encryption: ProjectEncryptionOptions = { mode: 'plaintext' },
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    let safeEncryption: ProjectEncryptionOptions;
    try {
      safeEncryption = validateEncryption(encryption);
    } catch {
      return Promise.resolve(failed('workspace.encryption.invalid'));
    }
    return this.activate('import', async (call) => {
      const grant = await this.port.requestProjectSourceGrant(
        { requestId: call.requestId },
        contextFor(call),
      );
      requireMatchingRequestId(grant.requestId, call.requestId);
      validateProjectFileDisplayName(grant.displayName);
      const sourceGrantId = workspaceGrantId(grant.sourceGrantId);
      if (!this.isCurrentActivation(call)) throw new StaleWorkspaceResponseError();

      const importRequestId = this.nextId('activate');
      const operationId = importRequestId;
      this.beginOperation(
        call,
        operationId,
        'workspace-import',
        this.active?.workspaceId ?? 'workspace-library',
      );
      let importedSummary: WorkspaceProjectViewModel;
      try {
        const imported = await this.port.importProject(
          {
            requestId: importRequestId,
            operationId,
            sourceGrantId,
            encryption: safeEncryption,
          },
          contextFor(call),
        );
        requireMatchingRequestId(imported.requestId, importRequestId);
        if (validateResponseOpaqueId(imported.operationId, 'operationId') !== operationId) {
          throw new InvalidWorkspaceResponseError('operationId');
        }
        importedSummary = sanitizeWorkspaceSummary(imported.workspace);
        this.operations?.complete(operationId);
        call.nativeOutcome = 'completed';
      } catch (error) {
        const cancelled = isCancelledError(error);
        call.nativeOutcome = cancelled ? 'cancelled' : 'failed';
        if (!cancelled) {
          this.operations?.fail(operationId, safeFailure(error, 'workspace.import.failed'));
        }
        throw error;
      } finally {
        call.operationSettlement?.resolve();
      }
      if (!this.isCurrentActivation(call)) throw new StaleWorkspaceResponseError();

      const openRequestId = this.nextId('activate');
      const opened = await this.port.openWorkspace(
        { requestId: openRequestId, workspaceId: importedSummary.workspaceId },
        contextFor(call),
      );
      requireMatchingRequestId(opened.requestId, openRequestId);
      const openedSummary = sanitizeWorkspaceSummary(opened.workspace);
      if (
        openedSummary.workspaceId !== importedSummary.workspaceId ||
        openedSummary.revision !== importedSummary.revision
      ) {
        throw new InvalidWorkspaceResponseError('workspace');
      }
      return {
        response: opened,
        expectedRequestId: openRequestId,
        expectedWorkspaceId: importedSummary.workspaceId,
      };
    });
  }

  cancelActivation(): boolean {
    const call = this.activationCall;
    if (!call) return false;
    this.abortPendingCall(call, 'user');
    this.activationCall = null;
    this.activationGeneration += 1;
    this.navigationAction = null;
    this.libraryStatus = this.projects.length > 0 ? 'ready' : 'idle';
    this.libraryMessageKey = null;
    this.notify();
    return true;
  }

  async exportWorkspace(
    suggestedName: string,
    encryption: ProjectEncryptionOptions = { mode: 'plaintext' },
  ): Promise<WorkspaceActionOutcome<{ operationId: string; displayName: string }>> {
    const active = this.active;
    if (!active) return failed('workspace.no_active_project');
    let safeSuggestedName: string;
    let safeEncryption: ProjectEncryptionOptions;
    try {
      safeSuggestedName = validateSuggestedProjectFileName(suggestedName);
      safeEncryption = validateEncryption(encryption);
    } catch {
      return failed('workspace.export.invalid');
    }
    const call = this.beginCall('export', ++this.exportGeneration);
    this.abortPendingCall(this.exportCall, 'superseded');
    this.exportCall = call;
    this.notify();
    try {
      const grant = await this.port.requestProjectTargetGrant(
        {
          requestId: call.requestId,
          suggestedName: safeSuggestedName,
          encryptionMode: safeEncryption.mode,
        },
        contextFor(call),
      );
      requireMatchingRequestId(grant.requestId, call.requestId);
      const targetGrantId = workspaceGrantId(grant.targetGrantId);
      validateProjectFileDisplayName(grant.displayName);
      if (!this.isCurrentExport(call) || this.active?.workspaceId !== active.workspaceId) {
        return staleOutcome(call);
      }
      const exportRequestId = this.nextId('export');
      const operationId = exportRequestId;
      this.beginOperation(call, operationId, 'workspace-export', active.workspaceId);
      let displayName: string;
      try {
        const response = await this.port.exportProject(
          {
            requestId: exportRequestId,
            operationId,
            workspaceId: active.workspaceId,
            targetGrantId,
            encryption: safeEncryption,
          },
          contextFor(call),
        );
        requireMatchingRequestId(response.requestId, exportRequestId);
        if (validateResponseOpaqueId(response.operationId, 'operationId') !== operationId) {
          throw new InvalidWorkspaceResponseError('operationId');
        }
        displayName = validateProjectFileDisplayName(response.displayName);
        this.operations?.complete(operationId);
        call.nativeOutcome = 'completed';
      } catch (error) {
        const cancelled = isCancelledError(error);
        call.nativeOutcome = cancelled ? 'cancelled' : 'failed';
        if (!cancelled) {
          this.operations?.fail(operationId, safeFailure(error, 'workspace.export.failed'));
        }
        throw error;
      } finally {
        call.operationSettlement?.resolve();
      }
      if (!this.isCurrentExport(call) || this.active?.workspaceId !== active.workspaceId) {
        return staleOutcome(call);
      }
      this.exportCall = null;
      this.notify();
      return completed(Object.freeze({ operationId, displayName }));
    } catch (error) {
      if (call.operationId && !isCancelledError(error)) {
        this.operations?.fail(call.operationId, safeFailure(error, 'workspace.export.failed'));
      }
      if (!this.isCurrentExport(call) || this.active?.workspaceId !== active.workspaceId) {
        return staleOutcome(call);
      }
      this.exportCall = null;
      this.notify();
      if (isCancelledError(error)) return Object.freeze({ outcome: 'cancelled' });
      return safeFailure(error, 'workspace.export.failed');
    }
  }

  async cancelExport(): Promise<WorkspaceExportCancellationStatus> {
    const call = this.exportCall;
    if (!call) return 'not-active';
    call.cancelledByUser = true;
    if (!call.operationId || !call.operationSettlement) {
      call.controller.abort();
      return 'cancelled';
    }
    this.notify();
    try {
      if (this.operations) {
        await this.operations.cancel(call.operationId);
      } else {
        await this.requestNativeOperationCancellation(call, 'workspace-export');
        await call.operationSettlement.promise;
      }
    } catch {
      return 'failed';
    }
    return call.nativeOutcome ?? 'failed';
  }

  private beginOperation(
    call: PendingCall,
    operationId: string,
    kind: 'workspace-import' | 'workspace-export',
    workspaceId: string,
  ): void {
    const settlement = createNativeOperationSettlement();
    call.operationId = operationId;
    call.operationSettlement = settlement;
    this.operations?.begin({
      operationId,
      kind,
      workspaceId,
      cancel: async () => {
        await this.requestNativeOperationCancellation(call, kind);
        await settlement.promise;
      },
    });
  }

  private requestNativeOperationCancellation(
    call: PendingCall,
    kind: 'workspace-import' | 'workspace-export',
  ): Promise<boolean> {
    if (!call.operationId) return Promise.resolve(false);
    if (call.nativeCancellation) return call.nativeCancellation;
    const operationId = call.operationId;
    const requestId = this.nextId(kind === 'workspace-import' ? 'activate' : 'export');
    call.nativeCancellation = this.port
      .cancelWorkspaceOperation(
        { requestId, operationId },
        { signal: new AbortController().signal },
      )
      .then((response) => {
        requireMatchingRequestId(response.requestId, requestId);
        if (validateResponseOpaqueId(response.operationId, 'operationId') !== operationId) {
          throw new InvalidWorkspaceResponseError('operationId');
        }
        return response.cancellationRequested;
      });
    return call.nativeCancellation;
  }

  commit(
    command: Readonly<WorkspaceMutationCommand>,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    return this.commitBatch([command]);
  }

  commitBatch(
    commands: readonly Readonly<WorkspaceMutationCommand>[],
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    const active = this.active;
    const epoch = this.writeEpoch;
    if (!active || !epoch) return Promise.resolve(failed('workspace.no_active_project'));
    if (active.saveHealth === 'readOnly') {
      return Promise.resolve(failed('error.workspace_read_only', 'WORKSPACE_READ_ONLY'));
    }

    if (!Array.isArray(commands) || commands.length === 0) {
      return Promise.resolve(failed('workspace.mutation.invalid'));
    }

    let mutations: readonly WorkspaceMutation[];
    try {
      mutations = Object.freeze(
        commands.map((command, index) => createSequencedMutation(command, epoch.sequence + index)),
      );
    } catch {
      return Promise.resolve(failed('workspace.mutation.invalid'));
    }
    let clientBatchId: string;
    try {
      clientBatchId = this.nextId('batch');
    } catch {
      return Promise.resolve(failed('workspace.mutation.invalid'));
    }
    epoch.sequence += mutations.length;
    const ticket: MutationTicket = {
      workspaceId: active.workspaceId,
      epoch,
      mutations,
      clientBatchId,
    };
    epoch.pending += 1;
    if (!epoch.inFlight) this.setSaveHealth('pending');
    this.notify();

    const result = epoch.tail.then(
      () => this.executeBatch(ticket),
      () => this.executeBatch(ticket),
    );
    epoch.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  flush(): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    const active = this.active;
    const epoch = this.writeEpoch;
    if (!active || !epoch) return Promise.resolve(failed('workspace.no_active_project'));
    if (active.saveHealth === 'readOnly') {
      return Promise.resolve(failed('error.workspace_read_only', 'WORKSPACE_READ_ONLY'));
    }
    const result = epoch.tail.then(
      () => this.executeFlush(epoch),
      () => this.executeFlush(epoch),
    );
    epoch.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async activate(
    action: WorkspaceNavigationAction,
    invoke: (call: PendingCall) => Promise<ActivationEnvelope>,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    const call = this.beginCall('activate', ++this.activationGeneration);
    this.abortPendingCall(this.activationCall, 'superseded');
    this.activationCall = call;
    this.navigationAction = action;
    this.libraryStatus = 'loading';
    this.libraryMessageKey = null;
    this.notify();
    try {
      const envelope = await invoke(call);
      if (!this.isCurrentActivation(call)) return staleOutcome(call);
      const active = sanitizeActivationResponse(envelope);
      this.activateHeader(active);
      this.activationCall = null;
      this.navigationAction = null;
      this.libraryStatus = 'ready';
      this.libraryMessageKey = null;
      this.notify();
      return completed(freezeActive(this.active!));
    } catch (error) {
      if (call.operationId && !isCancelledError(error)) {
        this.operations?.fail(call.operationId, safeFailure(error, `workspace.${action}.failed`));
      }
      if (!this.isCurrentActivation(call) || error instanceof StaleWorkspaceResponseError) {
        return staleOutcome(call);
      }
      this.activationCall = null;
      this.navigationAction = null;
      if (isCancelledError(error)) {
        this.libraryStatus = this.projects.length > 0 ? 'ready' : 'idle';
        this.libraryMessageKey = null;
        this.notify();
        return Object.freeze({ outcome: 'cancelled' });
      }
      this.libraryStatus = this.projects.length > 0 ? 'ready' : 'failed';
      const failure = safeFailure(error, `workspace.${action}.failed`);
      this.libraryMessageKey = failure.messageKey;
      this.notify();
      return failure;
    }
  }

  private activateHeader(header: ActiveWorkspaceViewModel): void {
    if (this.active?.workspaceId === header.workspaceId && header.revision < this.active.revision) {
      throw new InvalidWorkspaceResponseError('revision');
    }
    this.writeEpoch?.controller.abort();
    this.active = {
      workspaceId: header.workspaceId,
      name: header.name,
      revision: header.revision,
      activeSessionId: header.activeSessionId,
      sessionIds: header.sessionIds,
      saveHealth: header.saveHealth,
      layout: header.layout,
    };
    this.catalogActiveWorkspaceId = header.workspaceId;
    this.writeEpoch = {
      number: ++this.writeEpochNumber,
      workspaceId: header.workspaceId,
      controller: new AbortController(),
      tail: Promise.resolve(),
      pending: 0,
      inFlight: false,
      sequence: 0,
    };
    this.mergeActiveIntoProjects();
  }

  private async executeBatch(
    ticket: MutationTicket,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    if (!this.isCurrentEpoch(ticket.epoch, ticket.workspaceId)) {
      this.finishWrite(ticket.epoch);
      return stale();
    }
    if (this.active?.saveHealth === 'readOnly') {
      this.finishWrite(ticket.epoch, 'readOnly');
      return failed('error.workspace_read_only', 'WORKSPACE_READ_ONLY');
    }
    ticket.epoch.inFlight = true;
    this.setSaveHealth('saving');
    this.notify();
    const baseRevision = this.active!.revision;
    const request: ApplyWorkspaceBatchRequest = {
      workspaceId: ticket.workspaceId,
      clientBatchId: ticket.clientBatchId,
      baseRevision,
      mutations: [...ticket.mutations],
    };
    try {
      const response = await this.port.applyWorkspaceBatch(request, {
        signal: ticket.epoch.controller.signal,
      });
      if (!this.isCurrentEpoch(ticket.epoch, ticket.workspaceId)) {
        this.finishWrite(ticket.epoch);
        return stale();
      }
      const committedRevision = validateCommittedRevision(response.committedRevision);
      if (
        response.clientBatchId !== ticket.clientBatchId ||
        committedRevision !== baseRevision + 1 ||
        committedRevision <= this.active!.revision
      ) {
        throw new InvalidWorkspaceResponseError('committedRevision');
      }
      const committedDocument = cloneMutableActive(this.active!);
      for (const mutation of ticket.mutations) {
        this.applyCommittedDocumentMutation(committedDocument, mutation);
      }
      committedDocument.revision = committedRevision;
      this.active = committedDocument;
      this.finishWrite(ticket.epoch, 'clean');
      this.mergeActiveIntoProjects();
      this.notify();
      return completed(freezeActive(this.active!));
    } catch (error) {
      if (!this.isCurrentEpoch(ticket.epoch, ticket.workspaceId)) {
        this.finishWrite(ticket.epoch);
        return stale();
      }
      const readOnly = isWorkspaceReadOnlyError(error);
      this.finishWrite(ticket.epoch, readOnly ? 'readOnly' : 'degraded');
      this.mergeActiveIntoProjects();
      this.notify();
      return safeFailure(error, readOnly ? 'error.workspace_read_only' : 'workspace.save.failed');
    }
  }

  private async executeFlush(
    epoch: WriteEpoch,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    if (!this.isCurrentEpoch(epoch, epoch.workspaceId)) return stale();
    if (this.active?.saveHealth === 'readOnly') {
      return failed('error.workspace_read_only', 'WORKSPACE_READ_ONLY');
    }
    epoch.inFlight = true;
    this.setSaveHealth('saving');
    this.notify();
    const targetRevision = this.active!.revision;
    try {
      const response = await this.port.flushWorkspace(
        { workspaceId: epoch.workspaceId, targetRevision },
        { signal: epoch.controller.signal },
      );
      if (!this.isCurrentEpoch(epoch, epoch.workspaceId)) return stale();
      this.applyFlushResponse(response, targetRevision, epoch.pending);
      epoch.inFlight = false;
      this.mergeActiveIntoProjects();
      this.notify();
      return completed(freezeActive(this.active!));
    } catch (error) {
      if (!this.isCurrentEpoch(epoch, epoch.workspaceId)) return stale();
      const readOnly = isWorkspaceReadOnlyError(error);
      epoch.inFlight = false;
      this.setSaveHealth(readOnly ? 'readOnly' : 'degraded');
      this.mergeActiveIntoProjects();
      this.notify();
      return safeFailure(error, readOnly ? 'error.workspace_read_only' : 'workspace.flush.failed');
    }
  }

  private applyFlushResponse(
    response: FlushWorkspaceResponse,
    targetRevision: number,
    queuedMutations: number,
  ): void {
    const committedRevision = validateCommittedRevision(response.committedRevision);
    if (committedRevision < targetRevision || committedRevision < this.active!.revision) {
      throw new InvalidWorkspaceResponseError('committedRevision');
    }
    if (!isSaveHealth(response.saveHealth)) {
      throw new InvalidWorkspaceResponseError('saveHealth');
    }
    this.active!.revision = committedRevision;
    this.setSaveHealth(
      response.saveHealth === 'clean' && queuedMutations > 0 ? 'pending' : response.saveHealth,
    );
  }

  private finishWrite(epoch: WriteEpoch, terminalHealth?: WorkspaceSaveHealth): void {
    epoch.pending = Math.max(0, epoch.pending - 1);
    epoch.inFlight = false;
    if (this.writeEpoch !== epoch || !this.active) return;
    if (terminalHealth === 'readOnly' || terminalHealth === 'degraded') {
      this.setSaveHealth(terminalHealth);
      return;
    }
    this.setSaveHealth(epoch.pending > 0 ? 'pending' : (terminalHealth ?? 'clean'));
  }

  private setSaveHealth(health: WorkspaceSaveHealth): void {
    if (this.active) this.active.saveHealth = health;
  }

  private applyCommittedDocumentMutation(
    active: MutableActiveWorkspace,
    mutation: WorkspaceMutation,
  ): void {
    switch (mutation.kind) {
      case 'set-metadata':
        if (mutation.payload.name !== undefined) active.name = mutation.payload.name;
        if (mutation.payload.layout !== undefined) {
          active.layout = sanitizeWorkspaceLayout(mutation.payload.layout);
        }
        return;
      case 'set-active-session':
        active.activeSessionId = mutation.sessionId;
        return;
      case 'upsert-session':
        if (!active.sessionIds.includes(mutation.sessionId)) {
          active.sessionIds = Object.freeze([...active.sessionIds, mutation.sessionId]);
        }
        return;
      case 'remove-session':
        active.sessionIds = Object.freeze(
          active.sessionIds.filter((sessionId) => sessionId !== mutation.sessionId),
        );
        if (active.activeSessionId === mutation.sessionId) active.activeSessionId = null;
        return;
      case 'append-frames':
      case 'replace-capture':
      case 'trim-capture':
      case 'upsert-feature-state':
      case 'replace-session-collections':
      case 'append-ai-messages':
      case 'clear-ai-messages':
      case 'replace-waveform-channels':
      case 'append-waveform-samples':
        return;
      default:
        mutation satisfies never;
    }
  }

  private mergeActiveIntoProjects(): void {
    const active = this.active;
    if (!active) return;
    const existing = this.projects.find((project) => project.workspaceId === active.workspaceId);
    const merged: WorkspaceProjectViewModel = Object.freeze({
      workspaceId: active.workspaceId,
      name: active.name,
      revision: Math.max(active.revision, existing?.revision ?? 0),
      updatedAtMs: Math.max(existing?.updatedAtMs ?? 0, Date.now()),
      saveHealth: active.saveHealth,
      active: true,
    });
    this.projects = Object.freeze([
      merged,
      ...this.projects.filter((project) => project.workspaceId !== active.workspaceId),
    ]);
  }

  private beginCall(scope: 'catalog' | 'activate' | 'export', generation: number): PendingCall {
    return {
      generation,
      requestId: this.nextId(scope),
      controller: new AbortController(),
      cancelledByUser: false,
      operationId: null,
      operationSettlement: null,
      nativeCancellation: null,
      nativeOutcome: null,
    };
  }

  private abortPendingCall(call: PendingCall | null, reason: 'user' | 'superseded'): void {
    if (!call) return;
    if (reason === 'user') call.cancelledByUser = true;
    if (call.operationId) {
      void this.operations?.cancel(call.operationId).catch(() => undefined);
    }
    call.controller.abort();
  }

  private nextId(scope: 'catalog' | 'activate' | 'export' | 'batch' | 'flush'): string {
    return validateRequestId(this.idFactory(scope));
  }

  private isCurrentCatalog(call: PendingCall): boolean {
    return this.catalogCall === call && call.generation === this.catalogGeneration;
  }

  private isCurrentActivation(call: PendingCall): boolean {
    return this.activationCall === call && call.generation === this.activationGeneration;
  }

  private isCurrentExport(call: PendingCall): boolean {
    return this.exportCall === call && call.generation === this.exportGeneration;
  }

  private isCurrentEpoch(epoch: WriteEpoch, workspaceId: string): boolean {
    return (
      this.writeEpoch === epoch &&
      this.active?.workspaceId === workspaceId &&
      !epoch.controller.signal.aborted
    );
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // View observers cannot influence workspace state transitions.
      }
    }
  }
}

function sanitizeActivationResponse(envelope: ActivationEnvelope): ActiveWorkspaceViewModel {
  requireMatchingRequestId(envelope.response.requestId, envelope.expectedRequestId);
  const summary = sanitizeWorkspaceSummary(envelope.response.workspace);
  const header = sanitizeHeader(envelope.response.header);
  if (
    summary.workspaceId !== header.workspaceId ||
    summary.name !== header.name ||
    summary.revision !== header.revision
  ) {
    throw new InvalidWorkspaceResponseError('workspace');
  }
  if (
    envelope.expectedWorkspaceId !== undefined &&
    summary.workspaceId !== envelope.expectedWorkspaceId
  ) {
    throw new InvalidWorkspaceResponseError('workspaceId');
  }
  if (envelope.expectedName !== undefined && summary.name !== envelope.expectedName) {
    throw new InvalidWorkspaceResponseError('name');
  }
  return Object.freeze({ ...header, saveHealth: summary.saveHealth });
}

function validateEncryption(encryption: ProjectEncryptionOptions): ProjectEncryptionOptions {
  if (encryption.mode === 'plaintext') {
    if (encryption.passphrase !== undefined) {
      throw new Error('plaintext project encryption must not include a passphrase');
    }
    return Object.freeze({ mode: 'plaintext' });
  }
  if (
    encryption.mode !== 'age-passphrase' ||
    typeof encryption.passphrase !== 'string' ||
    encryption.passphrase.length === 0
  ) {
    throw new Error('age-passphrase encryption requires a non-empty passphrase');
  }
  return Object.freeze({ mode: 'age-passphrase', passphrase: encryption.passphrase });
}

function contextFor(call: PendingCall): WorkspacePortCallContext {
  return Object.freeze({ signal: call.controller.signal });
}

function freezeActive(active: MutableActiveWorkspace): ActiveWorkspaceViewModel {
  return Object.freeze({
    workspaceId: active.workspaceId,
    name: active.name,
    revision: active.revision,
    activeSessionId: active.activeSessionId,
    sessionIds: Object.freeze([...active.sessionIds]),
    saveHealth: active.saveHealth,
    layout: active.layout,
  });
}

function cloneMutableActive(active: MutableActiveWorkspace): MutableActiveWorkspace {
  return {
    workspaceId: active.workspaceId,
    name: active.name,
    revision: active.revision,
    activeSessionId: active.activeSessionId,
    sessionIds: Object.freeze([...active.sessionIds]),
    saveHealth: active.saveHealth,
    layout: active.layout,
  };
}

function completed<T>(value: T): WorkspaceActionOutcome<T> {
  return Object.freeze({ outcome: 'completed', value });
}

function stale(): WorkspaceActionOutcome<never> {
  return Object.freeze({ outcome: 'stale' });
}

function staleOutcome(call: PendingCall): WorkspaceActionOutcome<never> {
  return call.cancelledByUser && (call.nativeOutcome === null || call.nativeOutcome === 'cancelled')
    ? Object.freeze({ outcome: 'cancelled' })
    : Object.freeze({ outcome: 'stale' });
}

function failed(messageKey: string, code?: string): WorkspaceActionOutcome<never> {
  return Object.freeze({ outcome: 'failed', messageKey, ...(code ? { code } : {}) });
}

function isSaveHealth(value: string): value is WorkspaceSaveHealth {
  return (
    value === 'clean' ||
    value === 'pending' ||
    value === 'saving' ||
    value === 'degraded' ||
    value === 'readOnly'
  );
}

function defaultIdFactory(scope: string): string {
  fallbackIdSequence += 1;
  return `${scope}-${Date.now()}-${fallbackIdSequence}`;
}

function createNativeOperationSettlement(): NativeOperationSettlement {
  let settled = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve(): void {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  });
}

class StaleWorkspaceResponseError extends Error {}

function isCancelledError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'CANCELLED',
  );
}
