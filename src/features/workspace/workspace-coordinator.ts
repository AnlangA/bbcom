import type {
  CreateWorkspaceCommandResponse,
  OpenWorkspaceResponse,
  ProjectEncryptionOptions,
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
  requireMatchingRequestId,
  safeFailure,
  sanitizeCatalog,
  sanitizeHeader,
  sanitizeWorkspaceSummary,
  validateProjectFileDisplayName,
  validateProjectName,
  validateRequestId,
  validateResponseOpaqueId,
  validateSuggestedProjectFileName,
  validateWorkspaceId,
  workspaceGrantId,
} from './validation';
import {
  WorkspaceWriteEpochEngine,
  type MutableActiveWorkspace,
  completed,
  failed,
  freezeActive,
} from './workspace-write-epoch';
import { ValidatedWorkspaceGateway } from './validated-workspace-gateway';

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

type ActivationResponse = OpenWorkspaceResponse | CreateWorkspaceCommandResponse;

interface ActivationEnvelope {
  readonly response: ActivationResponse;
  readonly expectedRequestId: string;
  readonly expectedWorkspaceId?: string;
  readonly expectedName?: string;
}

interface SanitizedActivation {
  readonly active: ActiveWorkspaceViewModel;
  readonly project: WorkspaceProjectViewModel;
}

let fallbackIdSequence = 0;

/**
 * The main renderer's sole logical workspace writer.
 *
 * Every write is serialized through the current write epoch (owned by
 * `WorkspaceWriteEpochEngine`). No caller receives the physical persistence
 * port, and switching workspaces invalidates all old responses before they
 * can alter the active document.
 */
export class WorkspaceCoordinator {
  private readonly port: WorkspaceCoordinatorPort;
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
  private deleteGeneration = 0;
  private exportGeneration = 0;
  private catalogCall: PendingCall | null = null;
  private activationCall: PendingCall | null = null;
  private deleteCall: PendingCall | null = null;
  private exportCall: PendingCall | null = null;
  private readonly writeEngine: WorkspaceWriteEpochEngine;

  constructor(port: WorkspaceCoordinatorPort, options: WorkspaceCoordinatorOptions = {}) {
    this.port =
      port instanceof ValidatedWorkspaceGateway ? port : new ValidatedWorkspaceGateway(port);
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.operations = options.operations;
    this.writeEngine = new WorkspaceWriteEpochEngine(port, {
      activeDocument: () => this.active,
      replaceActiveDocument: (document) => {
        this.active = document;
      },
      setSaveHealth: (health) => this.setSaveHealth(health),
      mergeActiveIntoProjects: () => this.mergeActiveIntoProjects(),
      notify: () => this.notify(),
      nextBatchId: () => this.nextId('batch'),
    });
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
    if (this.navigationAction !== null) return failed('workspace.activation.in_progress');
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

  async deleteWorkspace(workspaceId: string): Promise<WorkspaceActionOutcome<string>> {
    const validatedWorkspaceId = validateWorkspaceId(workspaceId);
    if (
      validatedWorkspaceId === this.active?.workspaceId ||
      validatedWorkspaceId === this.catalogActiveWorkspaceId
    ) {
      return failed('workspace.delete.failed');
    }
    if (this.navigationAction !== null) return failed('workspace.activation.in_progress');

    const call = this.beginCall('delete', ++this.deleteGeneration);
    this.deleteCall = call;
    this.navigationAction = 'delete';
    this.libraryStatus = 'loading';
    this.libraryMessageKey = null;
    this.catalogCall?.controller.abort();
    this.catalogCall = null;
    this.catalogGeneration += 1;
    this.notify();
    try {
      const response = await this.port.deleteWorkspace(
        { requestId: call.requestId, workspaceId: validatedWorkspaceId },
        contextFor(call),
      );
      if (!this.isCurrentDelete(call)) return staleOutcome(call);
      requireMatchingRequestId(response.requestId, call.requestId);
      if (validateWorkspaceId(response.workspaceId) !== validatedWorkspaceId) {
        throw new InvalidWorkspaceResponseError('workspaceId');
      }
      this.projects = Object.freeze(
        this.projects.filter((project) => project.workspaceId !== validatedWorkspaceId),
      );
      this.deleteCall = null;
      this.navigationAction = null;
      this.libraryStatus = 'ready';
      this.libraryMessageKey = null;
      this.notify();
      return completed(validatedWorkspaceId);
    } catch (error) {
      if (!this.isCurrentDelete(call)) return staleOutcome(call);
      this.deleteCall = null;
      this.navigationAction = null;
      this.libraryStatus = this.projects.length > 0 ? 'ready' : 'failed';
      const failure = safeFailure(error, 'workspace.delete.failed');
      this.libraryMessageKey = failure.messageKey;
      this.notify();
      return failure;
    }
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

  commit(
    command: Readonly<WorkspaceMutationCommand>,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    return this.writeEngine.commitBatch([command]);
  }

  commitBatch(
    commands: readonly Readonly<WorkspaceMutationCommand>[],
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    return this.writeEngine.commitBatch(commands);
  }

  flush(): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    return this.writeEngine.flush();
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
      const activation = sanitizeActivationResponse(envelope);
      this.activateHeader(activation.active, activation.project);
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

  private activateHeader(
    header: ActiveWorkspaceViewModel,
    project: WorkspaceProjectViewModel,
  ): void {
    if (this.active?.workspaceId === header.workspaceId && header.revision < this.active.revision) {
      throw new InvalidWorkspaceResponseError('revision');
    }
    this.writeEngine.beginEpoch(header.workspaceId);
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
    this.mergeActiveIntoProjects(project);
  }

  private setSaveHealth(health: WorkspaceSaveHealth): void {
    if (this.active) this.active.saveHealth = health;
  }

  private mergeActiveIntoProjects(summary?: WorkspaceProjectViewModel): void {
    const active = this.active;
    if (!active) return;
    const existingIndex = this.projects.findIndex(
      (project) => project.workspaceId === active.workspaceId,
    );
    const existing = existingIndex >= 0 ? this.projects[existingIndex] : undefined;
    const merged: WorkspaceProjectViewModel = Object.freeze({
      workspaceId: active.workspaceId,
      name: active.name,
      revision: Math.max(active.revision, existing?.revision ?? 0),
      // Activation is not a project edit. Preserve the catalog timestamp, or
      // use the authoritative activation summary for a newly created/imported
      // project, instead of manufacturing recency with Date.now().
      updatedAtMs: summary?.updatedAtMs ?? existing?.updatedAtMs ?? 0,
      saveHealth: active.saveHealth,
      active: true,
    });
    if (existingIndex < 0) {
      this.projects = Object.freeze([...this.projects, merged]);
      return;
    }
    const projects = [...this.projects];
    projects[existingIndex] = merged;
    this.projects = Object.freeze(projects);
  }

  private beginCall(
    scope: 'catalog' | 'activate' | 'delete' | 'export',
    generation: number,
  ): PendingCall {
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

  private nextId(scope: 'catalog' | 'activate' | 'delete' | 'export' | 'batch' | 'flush'): string {
    return validateRequestId(this.idFactory(scope));
  }

  private isCurrentCatalog(call: PendingCall): boolean {
    return this.catalogCall === call && call.generation === this.catalogGeneration;
  }

  private isCurrentActivation(call: PendingCall): boolean {
    return this.activationCall === call && call.generation === this.activationGeneration;
  }

  private isCurrentDelete(call: PendingCall): boolean {
    return this.deleteCall === call && call.generation === this.deleteGeneration;
  }

  private isCurrentExport(call: PendingCall): boolean {
    return this.exportCall === call && call.generation === this.exportGeneration;
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

function sanitizeActivationResponse(envelope: ActivationEnvelope): SanitizedActivation {
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
  return Object.freeze({
    active: Object.freeze({ ...header, saveHealth: summary.saveHealth }),
    project: summary,
  });
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

function staleOutcome(call: PendingCall): WorkspaceActionOutcome<never> {
  return call.cancelledByUser && (call.nativeOutcome === null || call.nativeOutcome === 'cancelled')
    ? Object.freeze({ outcome: 'cancelled' })
    : Object.freeze({ outcome: 'stale' });
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
