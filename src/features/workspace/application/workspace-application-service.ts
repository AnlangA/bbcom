import type {
  WorkspaceSaveHealth,
  WorkspaceWaveformChannel,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import type { DataFrame } from '@/types/serial';
import { projectWorkspaceFrame, type WorkspaceHydrationPort, type WorkspaceQueuedFramePayload } from '../adapters';
import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionFailure,
  WorkspaceActionOutcome,
  WorkspaceMutationCommand,
} from '@/features/workspace/types';
import { WorkspaceCoordinator } from '../workspace-coordinator';
import {
  WorkspaceActivationCoordinator,
  WorkspaceActivationEngine,
  type ActivationRecoveryHost,
  type ActivationState,
  type RuntimeTransition,
} from './activation';
import { ExportCommandRouter, type ExportRouterState } from './export-routing';
import { WorkspaceHydrationPipeline } from './hydration';
import { freezeActive } from './hydration/staging-adapter';
import {
  partitionWorkspaceMutationCommands,
  type SaveContext,
  type WorkspaceBufferedMutationCommand,
} from './save-queues';
import { WorkspaceSaveCoordinator } from './workspace-save-coordinator';
import {
  type WorkspaceApplicationListener,
  type WorkspaceApplicationOptions,
  type WorkspaceApplicationOutcome,
  type WorkspaceApplicationStatus,
  type WorkspaceApplicationViewModel,
  type WorkspaceConfigMutationCommand,
  type WorkspaceFrameCapture,
  type WorkspaceLatchedSaveFailure,
  type WorkspaceQueueOutcome,
  type WorkspaceProjectExportOutcome,
  type WorkspaceRuntimeLifecycle,
  type WorkspaceRuntimePersistenceDrain,
  type WorkspaceSaveOutcome,
  type WorkspaceSessionFacade,
  type WorkspaceWaveformFrameIngest,
} from './types';

interface UndoCaptureState {
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly frameCount: number;
  readonly captureBytes: number;
}

let fallbackRequestSequence = 0;

/**
 * Application-owned workspace lifecycle and save boundary.
 *
 * The coordinator remains the only renderer writer. This service adds an
 * atomic hydration stage, cancellation/generation checks, a stopped-runtime
 * restore policy, and the two fixed autosave clocks used by the session facade.
 */
export class WorkspaceApplicationService {
  private readonly listeners = new Set<WorkspaceApplicationListener>();
  private readonly requestId: () => string;
  private readonly runtimeLifecycle: WorkspaceRuntimeLifecycle;
  private readonly onPersistenceFailure: (
    failure: WorkspaceLatchedSaveFailure,
  ) => void | Promise<void>;
  private applicationStatus: WorkspaceApplicationStatus = 'idle';
  private applicationMessageKey: string | null = null;
  private current: ActiveWorkspaceViewModel | null = null;
  private recoveryRequired = false;
  private switching = false;
  private hydrating = false;
  private readonly exportState: ExportRouterState = { exportAttempt: null, exportGeneration: 0 };
  private readonly activations = new WorkspaceActivationEngine();
  private switchDrain: Promise<WorkspaceActionFailure | null> | null = null;
  private runtimeTransition: RuntimeTransition | null = null;
  private internalDrainTransition: RuntimeTransition | null = null;
  private runtimeLifecycleTail: Promise<void> = Promise.resolve();

  private undoCaptureState: UndoCaptureState | null = null;
  private readonly saves: WorkspaceSaveCoordinator;
  private readonly activationCoordinator: WorkspaceActivationCoordinator;
  private readonly hydrationPipeline: WorkspaceHydrationPipeline;
  private readonly exportRouter: ExportCommandRouter;

  constructor(
    private readonly coordinator: WorkspaceCoordinator,
    private readonly hydrationPort: WorkspaceHydrationPort,
    private readonly sessionFacade: WorkspaceSessionFacade,
    options: WorkspaceApplicationOptions = {},
  ) {
    this.requestId = options.requestId ?? defaultRequestId;
    this.runtimeLifecycle = options.runtimeLifecycle ?? NOOP_RUNTIME_LIFECYCLE;
    this.onPersistenceFailure = options.onPersistenceFailure ?? (() => undefined);
    this.saves = new WorkspaceSaveCoordinator({
      scheduleSaveGroup: (context, commands) => this.scheduleSaveGroup(context, commands),
      emitNotify: () => this.emitNotify(),
    });
    this.activationCoordinator = new WorkspaceActivationCoordinator(this.activationDeps(), this.activationState());
    this.hydrationPipeline = new WorkspaceHydrationPipeline({
      coordinator: this.coordinator, hydrationPort: this.hydrationPort, sessionFacade: this.sessionFacade,
      saves: this.saves, runtimeLifecycle: this.runtimeLifecycle, activations: this.activations,
      activationCoordinator: this.activationCoordinator, requestId: this.requestId,
      getRecoveryHost: () => this.activationRecoveryHost(), notify: () => this.notify(),
      snapshot: () => this.snapshot(),
      getState: () => this.activationState(),
    });
    this.exportRouter = new ExportCommandRouter({
      coordinator: this.coordinator, saves: this.saves, state: this.exportState,
      acceptingSaveContext: () => this.acceptingSaveContext(),
      isCurrentSaveContext: (c) => this.isCurrentSaveContext(c),
      queueRejectionMessage: () => this.queueRejectionMessage(),
      syncCurrentFromCoordinator: () => this.syncCurrentFromCoordinator(),
      applySaveOutcome: (o) => this.applySaveOutcome(o), notify: () => this.notify(),
    });

  }

  private get workspaceEpoch(): number {
    return this.saves.workspaceEpoch;
  }

  private get captureAccounting() {
    return this.saves.captureAccounting;
  }

  private get saveQueues() {
    return this.saves.queues;
  }

  private get saveGate() {
    return this.saves.gate;
  }

  private get saveTail(): Promise<void> {
    return this.saves.saveTail;
  }

  private set saveTail(value: Promise<void>) {
    this.saves.saveTail = value;
  }

  private get scheduledSaveGroups(): number {
    return this.saves.scheduledSaveGroups;
  }

  private set scheduledSaveGroups(value: number) {
    this.saves.scheduledSaveGroups = value;
  }

  private get saveInFlight(): boolean {
    return this.saves.saveInFlight;
  }

  private set saveInFlight(value: boolean) {
    this.saves.saveInFlight = value;
  }

  private get lastSaveFailure(): WorkspaceLatchedSaveFailure | null {
    return this.saves.lastSaveFailure;
  }

  private set lastSaveFailure(value: WorkspaceLatchedSaveFailure | null) {
    this.saves.lastSaveFailure = value;
  }

  private get retainedUnsavedMutations(): number {
    return this.saves.retainedUnsavedMutations;
  }

  private set retainedUnsavedMutations(value: number) {
    this.saves.retainedUnsavedMutations = value;
  }

  /**
   * Next append sequence for one session (last assigned seq + 1). DB-sourced
   * exports use it as the exclusive durability ceiling. Null for sessions the
   * capture accounting does not know.
   */
  captureSeqCeiling(sessionId: string): number | null {
    return this.captureAccounting.nextFrameSequence(sessionId) ?? null;
  }

  snapshot(): WorkspaceApplicationViewModel {
    const currentWorkspace = this.currentWorkspaceView();
    const saveHealth = this.currentSaveHealth(currentWorkspace);
    return Object.freeze({
      status: this.applicationStatus,
      currentWorkspace,
      saveHealth,
      acceptsSaves: this.canAcceptSaves(currentWorkspace, saveHealth),
      acceptsPersistenceEvents:
        this.canAcceptSaves(currentWorkspace, saveHealth) || this.internalDrainTransition !== null,
      readOnly: saveHealth === 'readOnly' || this.recoveryRequired,
      recoveryRequired: this.recoveryRequired,
      hydrating: this.hydrating,
      exporting: this.exportState.exportAttempt !== null,
      messageKey: this.applicationMessageKey,
      unsavedMutationCount: this.unsavedMutationCount(),
    });
  }

  subscribe(listener: WorkspaceApplicationListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // A renderer observer cannot influence persistence or activation state.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  openWorkspace(workspaceId: string): Promise<WorkspaceApplicationOutcome> {
    return this.activationCoordinator.activate(() => this.coordinator.openWorkspace(workspaceId));
  }

  async deleteWorkspace(workspaceId: string): Promise<WorkspaceApplicationOutcome> {
    // Prefer the installed facade, but a failed first hydration can leave only the
    // native coordinator selection — that project must still be deletable.
    const isCurrent =
      this.current?.workspaceId === workspaceId ||
      this.coordinator.activeWorkspaceId === workspaceId;
    if (!isCurrent) {
      const outcome = await this.coordinator.deleteWorkspace(workspaceId);
      return outcome.outcome === 'completed' ? completed(this.snapshot()) : outcome;
    }

    // Delete the active project first. Opening a replacement before delete used
    // to abort deletion whenever hydration failed ("无法完整恢复项目"), which left
    // broken projects stuck in the sidebar.
    const replacement = this.coordinator
      .snapshot()
      .library.projects.find((project) => project.workspaceId !== workspaceId);
    const deleted = await this.activationCoordinator.deleteCurrentWorkspace(workspaceId);
    if (deleted.outcome !== 'completed' || !replacement) return deleted;
    return this.openWorkspace(replacement.workspaceId);
  }

  async restoreLastActiveWorkspace(
    fallbackWorkspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceApplicationOutcome> {
    if (signal?.aborted) return Object.freeze({ outcome: 'cancelled' });
    // Short-circuit only when the requested workspace is already active; a
    // caller restoring a specific workspace (legacy reset recovery) must never
    // be told "completed" while a different workspace is on screen.
    if (this.current?.workspaceId === fallbackWorkspaceId) {
      return { outcome: 'completed', value: this.snapshot() };
    }
    const refreshed = await this.coordinator.refreshCatalog();
    if (signal?.aborted) return Object.freeze({ outcome: 'cancelled' });
    if (refreshed.outcome !== 'completed') return refreshed;
    const library = refreshed.value.library;
    const fallbackExists = library.projects.some(
      (project) => project.workspaceId === fallbackWorkspaceId,
    );
    const workspaceId =
      library.activeWorkspaceId ??
      (fallbackExists ? fallbackWorkspaceId : library.projects[0]?.workspaceId);
    // A completed legacy-reset journal may outlive its bootstrap workspace.
    // Deleting the final project is a valid idle state, so startup must not
    // reopen that deleted fallback and re-lock the app behind the reset gate.
    if (!workspaceId) return completed(this.snapshot());
    return this.openWorkspace(workspaceId);
  }

  createWorkspace(name: string): Promise<WorkspaceApplicationOutcome> {
    return this.activationCoordinator.activate(() => this.coordinator.createWorkspace(name));
  }

  importWorkspace(): Promise<WorkspaceApplicationOutcome> {
    return this.activationCoordinator.activate(() => this.coordinator.importWorkspace());
  }

  exportWorkspace(suggestedName: string): Promise<WorkspaceProjectExportOutcome> {
    return this.exportRouter.exportWorkspace(suggestedName);
  }
  async cancelExport(): Promise<WorkspaceProjectExportOutcome | null> {
    return this.exportRouter.cancelExport();
  }
  cancelActivation(): boolean {
    return this.activationCoordinator.cancelActivation();
  }


  queueConfigMutation(command: Readonly<WorkspaceConfigMutationCommand>): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context) return rejectedQueue(this.queueRejectionMessage());
    return this.enqueueConfigMutations(context, [command]);
  }

  queueConfigMutations(
    commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context) return rejectedQueue(this.queueRejectionMessage());
    return this.enqueueConfigMutations(context, commands);
  }

  /**
   * Enqueue a structural document transition on the single save tail now.
   * Existing debounced work is released first, so callers can establish a
   * hard happens-before edge for create/remove/reorder/clear operations.
   */
  queueOrderedMutations(
    commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context) return rejectedQueue(this.queueRejectionMessage());
    return this.enqueueOrderedMutations(context, commands);
  }

  private enqueueConfigMutations(
    context: SaveContext,
    commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
  ): WorkspaceQueueOutcome {
    return this.enqueueBufferedMutations(context, commands);
  }

  private enqueueBufferedMutations(
    context: SaveContext,
    commands: readonly Readonly<WorkspaceBufferedMutationCommand>[],
  ): WorkspaceQueueOutcome {
    let clonedCommands: WorkspaceBufferedMutationCommand[];
    try {
      clonedCommands = commands.map((command) => cloneAndFreeze(command));
    } catch {
      return rejectedQueue('workspace.mutation.invalid');
    }
    this.saveQueues.enqueueConfigMutations(context, clonedCommands);
    return acceptedQueue();
  }

  queueWaveformReplacement(
    sessionId: string,
    channels: readonly WorkspaceWaveformChannel[],
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.captureAccounting.hasSession(sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    return this.enqueueWaveformReplacement(context, sessionId, channels, samples);
  }

  queueWaveformSamples(
    sessionId: string,
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.captureAccounting.hasSession(sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    return this.enqueueWaveformSamples(context, sessionId, samples);
  }

  queueWaveformFrameIngest(ingest: Readonly<WorkspaceWaveformFrameIngest>): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.captureAccounting.hasSession(ingest.sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    return this.enqueueWaveformFrameIngest(context, ingest);
  }

  private enqueueWaveformReplacement(
    context: SaveContext,
    sessionId: string,
    channels: readonly WorkspaceWaveformChannel[],
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome {
    const commands: WorkspaceMutationCommand[] = [
      {
        kind: 'replace-waveform-channels',
        sessionId,
        payload: { channels: [...channels] },
      },
      ...waveformAppendCommands(sessionId, samples),
    ];
    let clonedCommands: WorkspaceMutationCommand[];
    try {
      clonedCommands = commands.map((command) => cloneAndFreeze(command));
    } catch {
      return rejectedQueue('workspace.mutation.invalid');
    }
    // Replacement deletes channel rows (and their samples) by contract, so it
    // is a hard ordering barrier before the complete shared snapshot append.
    this.saveQueues.releaseAll();
    this.scheduleSaveGroup(context, clonedCommands);
    this.notify();
    return acceptedQueue();
  }

  private enqueueWaveformSamples(
    context: SaveContext,
    sessionId: string,
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome {
    if (samples.length === 0) return acceptedQueue();
    return this.enqueueBufferedMutations(context, waveformAppendCommands(sessionId, samples));
  }

  private enqueueWaveformFrameIngest(
    context: SaveContext,
    ingest: Readonly<WorkspaceWaveformFrameIngest>,
  ): WorkspaceQueueOutcome {
    // A cursor-only append tick committed no new samples, so there is nothing
    // that must stay atomic with the cursor: persist it through the regular
    // 300 ms config debounce instead of releasing every queue and forcing an
    // immediate native batch on every UI tick while streaming. Ordering is
    // preserved because sample-bearing ingests and ordered mutations release
    // the config queue before committing their own group.
    if (ingest.mode === 'append' && ingest.samples.length === 0) {
      const cursorCommand: Extract<WorkspaceMutationCommand, { kind: 'upsert-feature-state' }> = {
        kind: 'upsert-feature-state',
        entityId: ingest.sessionId,
        payload: { feature: 'waveform', state: { ...ingest.featureState } },
      };
      let clonedCommand: WorkspaceConfigMutationCommand;
      try {
        clonedCommand = cloneAndFreeze(cursorCommand);
      } catch {
        return rejectedQueue('workspace.mutation.invalid');
      }
      return this.enqueueBufferedMutations(context, [clonedCommand]);
    }
    const commands: WorkspaceMutationCommand[] = [];
    if (ingest.mode === 'replace') {
      commands.push({
        kind: 'replace-waveform-channels',
        sessionId: ingest.sessionId,
        payload: { channels: [...ingest.channels] },
      });
    }
    commands.push(...waveformAppendCommands(ingest.sessionId, ingest.samples));
    commands.push({
      kind: 'upsert-feature-state',
      entityId: ingest.sessionId,
      payload: { feature: 'waveform', state: { ...ingest.featureState } },
    });

    let clonedCommands: WorkspaceMutationCommand[];
    try {
      clonedCommands = commands.map((command) => cloneAndFreeze(command));
    } catch {
      return rejectedQueue('workspace.mutation.invalid');
    }
    // Samples and the cursor form one recovery unit. Reject before scheduling
    // if it cannot fit in exactly one native batch; splitting would permit a
    // crash to replay samples with a stale cursor (or skip samples with a new
    // cursor).
    const batches = partitionWorkspaceMutationCommands(clonedCommands);
    if (!batches || batches.length !== 1) {
      return rejectedQueue('workspace.mutation.limit_exceeded');
    }
    this.saveQueues.releaseAll();
    this.scheduleSaveGroup(context, clonedCommands, true);
    this.notify();
    return acceptedQueue();
  }

  private enqueueOrderedMutations(
    context: SaveContext,
    commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
  ): WorkspaceQueueOutcome {
    let clonedCommands: WorkspaceConfigMutationCommand[];
    try {
      clonedCommands = commands.map((command) => cloneAndFreeze(command));
    } catch {
      return rejectedQueue('workspace.mutation.invalid');
    }
    if (clonedCommands.length === 0) return acceptedQueue();
    this.saveQueues.releaseAll();
    this.scheduleSaveGroup(context, clonedCommands);
    this.notify();
    return acceptedQueue();
  }

  /** Register a newly-created renderer session before it can emit frames. */
  registerSession(sessionId: string): WorkspaceQueueOutcome {
    if (this.captureAccounting.hasSession(sessionId)) return acceptedQueue();
    const restored = this.undoCaptureState?.sessionId === sessionId ? this.undoCaptureState : null;
    const preflight = this.preflightSessionRegistration(
      sessionId,
      restored?.frameCount ?? 0,
      restored?.captureBytes ?? 0,
    );
    if (!preflight.accepted) return preflight;
    if (!this.captureAccounting.hasSession(sessionId)) {
      this.captureAccounting.registerSession(sessionId, {
        nextSequence: restored?.nextSequence ?? 0,
        frameCount: restored?.frameCount ?? 0,
        captureBytes: restored?.captureBytes ?? 0,
      });
      if (restored) this.undoCaptureState = null;
    }
    return acceptedQueue();
  }

  /** Validate create/undo aggregate limits before the compatibility store
   * performs its in-memory mutation. This keeps the facade and SQLite writer
   * on the same side of every hard workspace limit. */
  preflightSessionRegistration(
    sessionId: string,
    frameCount: number,
    captureBytes: number,
  ): WorkspaceQueueOutcome {
    if (!this.acceptingSaveContext()) return rejectedQueue(this.queueRejectionMessage());
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId) ||
      this.captureAccounting.hasSession(sessionId) ||
      !Number.isSafeInteger(frameCount) ||
      frameCount < 0 ||
      !Number.isSafeInteger(captureBytes) ||
      captureBytes < 0
    ) {
      return rejectedQueue('workspace.capture.invalid_session');
    }
    const restored = this.undoCaptureState?.sessionId === sessionId ? this.undoCaptureState : null;
    if (
      (restored &&
        (restored.frameCount !== frameCount || restored.captureBytes !== captureBytes)) ||
      (!restored && (frameCount !== 0 || captureBytes !== 0))
    ) {
      return rejectedQueue('workspace.capture.invalid_restore');
    }
    const workspaceTotals = this.captureAccounting.workspaceTotals();
    if (
      this.captureAccounting.sessionCount + 1 > IPC_LIMITS.MAX_WORKSPACE_SESSIONS ||
      frameCount > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION ||
      workspaceTotals.frameCount + frameCount > IPC_LIMITS.MAX_WORKSPACE_FRAMES ||
      workspaceTotals.captureBytes + captureBytes > IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES
    ) {
      return rejectedQueue('workspace.capture.limit_exceeded');
    }
    return acceptedQueue();
  }

  /** Roll back optimistic capture accounting when a structural projection was
   * rejected before it entered saveTail. */
  unregisterSession(sessionId: string): void {
    this.forgetSession(sessionId);
  }

  /** Persist a user-visible capture clear and reset append accounting atomically
   * at the application boundary. The queued replace is an empty, bounded DTO. */
  queueCaptureReset(sessionId: string): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.captureAccounting.hasSession(sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    // Attach all accepted work to saveTail, then schedule clear immediately.
    // New frames can be queued synchronously after this call, but their save
    // groups are necessarily appended after this replacement barrier.
    const outcome = this.queueOrderedMutations([
      { kind: 'replace-capture', sessionId, payload: { frames: [] } },
    ]);
    if (!outcome.accepted) return outcome;
    // resetSession zeroes the row (sequence, frames, bytes) and releases its
    // previous totals from the workspace aggregates in one step.
    this.captureAccounting.resetSession(sessionId);
    return outcome;
  }

  /** Stop accepting frames for a removed session and release its aggregate
   * accounting. The caller still submits the generated remove-session command. */
  forgetSession(sessionId: string): void {
    const removed = this.captureAccounting.removeSession(sessionId);
    if (removed) {
      this.undoCaptureState = Object.freeze({
        sessionId,
        nextSequence: removed.nextSequence,
        frameCount: removed.frameCount,
        captureBytes: removed.captureBytes,
      });
    }
  }

  queueCaptureTrim(
    sessionId: string,
    droppedFrames: number,
    droppedBytes: number,
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context) return rejectedQueue(this.queueRejectionMessage());
    return this.enqueueCaptureTrim(context, sessionId, droppedFrames, droppedBytes);
  }

  private enqueueCaptureTrim(
    context: SaveContext,
    sessionId: string,
    droppedFrames: number,
    droppedBytes: number,
  ): WorkspaceQueueOutcome {
    const totals = this.captureAccounting.sessionTotals(sessionId);
    if (
      totals === null ||
      !Number.isSafeInteger(droppedFrames) ||
      droppedFrames < 1 ||
      droppedFrames > totals.frameCount ||
      droppedFrames > 0xffff_ffff ||
      !Number.isSafeInteger(droppedBytes) ||
      droppedBytes < 0 ||
      droppedBytes > totals.captureBytes
    ) {
      return rejectedQueue('workspace.capture.invalid_trim');
    }
    const outcome = this.enqueueOrderedMutations(context, [
      { kind: 'trim-capture', sessionId, payload: { frameCount: droppedFrames } },
    ]);
    if (!outcome.accepted) return outcome;
    // Negative recordFrames writes the row exactly (validated above) while
    // clamping the workspace aggregates at zero.
    this.captureAccounting.recordFrames(sessionId, -droppedFrames, -droppedBytes);
    return outcome;
  }

  queueCapturedFrame(capture: WorkspaceFrameCapture): WorkspaceQueueOutcome;
  queueCapturedFrame(sessionId: string, frame: DataFrame): WorkspaceQueueOutcome;
  queueCapturedFrame(
    captureOrSessionId: WorkspaceFrameCapture | string,
    suppliedFrame?: DataFrame,
  ): WorkspaceQueueOutcome {
    const capture: WorkspaceFrameCapture =
      typeof captureOrSessionId === 'string'
        ? { sessionId: captureOrSessionId, frame: suppliedFrame! }
        : captureOrSessionId;
    const context = this.acceptingSaveContext();
    if (!context) return rejectedQueue(this.queueRejectionMessage());
    return this.enqueueCapturedFrame(context, capture);
  }

  /** Synchronous, non-reserving preflight used before the compatibility store
   * mutates its in-memory capture. JavaScript execution is single-threaded and
   * the caller immediately emits the matching frame event in the same turn. */
  preflightCapturedFrame(
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ): WorkspaceQueueOutcome {
    const context =
      this.acceptingSaveContext() ??
      (this.internalDrainTransition
        ? this.internalSaveContext(this.internalDrainTransition)
        : null);
    if (!context) return rejectedQueue(this.queueRejectionMessage());
    if (
      !this.captureAccounting.hasSession(sessionId) ||
      !(frame?.data instanceof Uint8Array) ||
      (frame.direction !== 'RX' && frame.direction !== 'TX') ||
      frame.data.byteLength > IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES
    ) {
      return rejectedQueue('workspace.capture.invalid');
    }
    const sessionCount = this.captureAccounting.sessionTotals(sessionId)?.frameCount ?? 0;
    const workspaceTotals = this.captureAccounting.workspaceTotals();
    if (
      sessionCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION ||
      workspaceTotals.frameCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES ||
      workspaceTotals.captureBytes + frame.data.byteLength > IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES
    ) {
      return rejectedQueue('workspace.capture.limit_exceeded');
    }
    return acceptedQueue();
  }

  /** Convert a rejected compatibility-facade projection into an explicit
   * fail-closed workspace state instead of allowing the observer exception to
   * disappear into a log entry. */
  rejectPersistence(messageKey: string): void {
    if (this.lastSaveFailure) return;
    this.latchSaveFailure(failed(messageKey));
  }

  private enqueueCapturedFrame(
    context: SaveContext,
    capture: WorkspaceFrameCapture,
  ): WorkspaceQueueOutcome {
    if (!capture.frame || !this.captureAccounting.hasSession(capture.sessionId)) {
      return rejectedQueue('workspace.capture.invalid_session');
    }
    const sequence = this.captureAccounting.nextFrameSequence(capture.sessionId)!;
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(sequence + 1)) {
      return rejectedQueue('workspace.capture.sequence_exhausted');
    }
    let payload: WorkspaceQueuedFramePayload;
    try {
      payload = projectWorkspaceFrame(capture.frame);
    } catch {
      return rejectedQueue('workspace.capture.invalid');
    }
    const sessionCount = this.captureAccounting.sessionTotals(capture.sessionId)?.frameCount ?? 0;
    const workspaceTotals = this.captureAccounting.workspaceTotals();
    if (
      sessionCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION ||
      workspaceTotals.frameCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES ||
      workspaceTotals.captureBytes + payload.data.length > IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES
    ) {
      return rejectedQueue('workspace.capture.limit_exceeded');
    }

    this.saveQueues.enqueueFrame({ context, sessionId: capture.sessionId, sequence, payload });
    this.captureAccounting.setNextFrameSequence(capture.sessionId, sequence + 1);
    this.captureAccounting.recordFrames(capture.sessionId, 1, payload.data.length);
    this.notify();
    return acceptedQueue();
  }

  /**
   * Flushes every mutation accepted before this call, then checkpoints the
   * coordinator revision. Mutations accepted later belong to a later barrier.
   */
  async flush(): Promise<WorkspaceSaveOutcome> {
    this.saveQueues.releaseAll();
    const barrier = this.saveTail;
    await barrier;
    if (this.lastSaveFailure) return this.lastSaveFailure;
    const current = this.current;
    if (!current) return failed('workspace.no_active_project');
    if (this.coordinator.activeWorkspaceId !== current.workspaceId) {
      return failed('workspace.activation.incomplete');
    }
    const outcome = await this.coordinator.flush();
    this.applySaveOutcome(outcome);
    return outcome;
  }

  private activationState(): ActivationState {
    /* eslint-disable @typescript-eslint/no-this-alias -- proxy getters must close over the service instance */
    const svc = this;
    /* eslint-enable @typescript-eslint/no-this-alias */
    return {
      get current() { return svc.current; }, set current(v) { svc.current = v; },
      get recoveryRequired() { return svc.recoveryRequired; }, set recoveryRequired(v) { svc.recoveryRequired = v; },
      get switching() { return svc.switching; }, set switching(v) { svc.switching = v; },
      get hydrating() { return svc.hydrating; }, set hydrating(v) { svc.hydrating = v; },
      get applicationStatus() { return svc.applicationStatus; }, set applicationStatus(v) { svc.applicationStatus = v; },
      get applicationMessageKey() { return svc.applicationMessageKey; }, set applicationMessageKey(v) { svc.applicationMessageKey = v; },
      get runtimeTransition() { return svc.runtimeTransition; }, set runtimeTransition(v) { svc.runtimeTransition = v; },
      get internalDrainTransition() { return svc.internalDrainTransition; }, set internalDrainTransition(v) { svc.internalDrainTransition = v; },
      get runtimeLifecycleTail() { return svc.runtimeLifecycleTail; }, set runtimeLifecycleTail(v) { svc.runtimeLifecycleTail = v; },
      get switchDrain() { return svc.switchDrain; }, set switchDrain(v) { svc.switchDrain = v; },
    };
  }
  private activationDeps() {
    /* eslint-disable @typescript-eslint/no-this-alias -- lazy hydration getter closes over the service instance */
    const s = this;
    /* eslint-enable @typescript-eslint/no-this-alias */
    return {
      coordinator: this.coordinator, sessionFacade: this.sessionFacade, saves: this.saves,
      get hydration() { return s.hydrationPipeline; }, runtimeLifecycle: this.runtimeLifecycle, activations: this.activations,
      getRecoveryHost: () => this.activationRecoveryHost(), snapshot: () => this.snapshot(), notify: () => this.notify(),
      syncCurrentFromCoordinator: () => this.syncCurrentFromCoordinator(),
      applySaveOutcome: (o: WorkspaceSaveOutcome) => this.applySaveOutcome(o),
      clearUndoCaptureState: () => { this.undoCaptureState = null; },
      createRuntimePersistenceDrain: (t: RuntimeTransition) => this.createRuntimePersistenceDrain(t),
      internalSaveContext: (t: RuntimeTransition) => this.internalSaveContext(t),
      enqueueConfigMutations: (c: SaveContext, cmds: readonly Readonly<WorkspaceConfigMutationCommand>[]) =>
        this.enqueueConfigMutations(c, cmds),
      enqueueOrderedMutations: (c: SaveContext, cmds: readonly Readonly<WorkspaceConfigMutationCommand>[]) =>
        this.enqueueOrderedMutations(c, cmds),
      enqueueCapturedFrame: (c: SaveContext, cap: WorkspaceFrameCapture) => this.enqueueCapturedFrame(c, cap),
      enqueueCaptureTrim: (c: SaveContext, sid: string, df: number, db: number) =>
        this.enqueueCaptureTrim(c, sid, df, db),
      enqueueWaveformReplacement: (
        c: SaveContext,
        sid: string,
        ch: readonly WorkspaceWaveformChannel[],
        sa: readonly WorkspaceWaveformSample[],
      ) => this.enqueueWaveformReplacement(c, sid, ch, sa),
      enqueueWaveformSamples: (c: SaveContext, sid: string, sa: readonly WorkspaceWaveformSample[]) =>
        this.enqueueWaveformSamples(c, sid, sa),
      enqueueWaveformFrameIngest: (c: SaveContext, ing: Readonly<WorkspaceWaveformFrameIngest>) =>
        this.enqueueWaveformFrameIngest(c, ing),
    };
  }
  private activationRecoveryHost(): ActivationRecoveryHost {
    const c = this.coordinator;
    return {
      get activeWorkspaceId() { return c.activeWorkspaceId; },
      openWorkspace: (id) => c.openWorkspace(id),
      restoreRuntimeAfterAbortedTransition: (id) => this.activationCoordinator.restoreRuntimeAfterAbortedTransition(id),
      adoptRollbackView: (v, pid) => { if (this.current?.workspaceId === pid) this.current = freezeActive(v); },
      enterRecoveryLockout: (o) => this.activationCoordinator.enterRecoveryLockout(o),
      finishActivationFailure: (a, f) => this.activationCoordinator.finishActivationFailure(a, f),
      finishAbortedQueuedAttempt: (a) => this.activationCoordinator.finishAbortedQueuedAttempt(a),
    };
  }
  private createRuntimePersistenceDrain(
    transition: RuntimeTransition,
  ): WorkspaceRuntimePersistenceDrain {
    const context = (): SaveContext | null => this.internalSaveContext(transition);
    return Object.freeze({
      workspaceId: transition.previousWorkspaceId!,
      get accepting(): boolean {
        return context() !== null;
      },
      queueConfigMutation: (command: Readonly<WorkspaceConfigMutationCommand>) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueConfigMutations(saveContext, [command])
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueConfigMutations: (commands: readonly Readonly<WorkspaceConfigMutationCommand>[]) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueConfigMutations(saveContext, commands)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueOrderedMutations: (commands: readonly Readonly<WorkspaceConfigMutationCommand>[]) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueOrderedMutations(saveContext, commands)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueCapturedFrame: (capture: WorkspaceFrameCapture) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueCapturedFrame(saveContext, capture)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueCaptureTrim: (sessionId: string, droppedFrames: number, droppedBytes: number) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueCaptureTrim(saveContext, sessionId, droppedFrames, droppedBytes)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueWaveformReplacement: (
        sessionId: string,
        channels: readonly WorkspaceWaveformChannel[],
        samples: readonly WorkspaceWaveformSample[],
      ) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueWaveformReplacement(saveContext, sessionId, channels, samples)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueWaveformSamples: (sessionId: string, samples: readonly WorkspaceWaveformSample[]) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueWaveformSamples(saveContext, sessionId, samples)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
      queueWaveformFrameIngest: (ingest: Readonly<WorkspaceWaveformFrameIngest>) => {
        const saveContext = context();
        return saveContext
          ? this.enqueueWaveformFrameIngest(saveContext, ingest)
          : rejectedQueue('workspace.persistence.drain_closed');
      },
    });
  }

  private internalSaveContext(transition: RuntimeTransition): SaveContext | null {
    const current = this.current;
    if (
      this.internalDrainTransition !== transition ||
      this.runtimeTransition !== transition ||
      !current ||
      current.workspaceId !== transition.previousWorkspaceId ||
      this.coordinator.activeWorkspaceId !== transition.previousWorkspaceId ||
      this.lastSaveFailure ||
      this.recoveryRequired ||
      !this.coordinator.acceptsMutations
    ) {
      return null;
    }
    return Object.freeze({ epoch: this.workspaceEpoch, workspaceId: current.workspaceId });
  }

  private scheduleSaveGroup(
    context: SaveContext,
    commands: readonly WorkspaceMutationCommand[],
    atomic = false,
  ): void {
    if (commands.length === 0) return;
    this.scheduledSaveGroups += 1;
    const run = async (): Promise<void> => {
      this.saveInFlight = true;
      this.notify();
      try {
        if (!this.isCurrentSaveContext(context) || this.lastSaveFailure) {
          this.retainedUnsavedMutations += commands.length;
          return;
        }
        const batches = partitionWorkspaceMutationCommands(commands);
        if (!batches || (atomic && batches.length !== 1)) {
          this.retainedUnsavedMutations += commands.length;
          this.latchSaveFailure(failed('workspace.mutation.limit_exceeded', 'LIMIT_EXCEEDED'));
          return;
        }
        let committedCommands = 0;
        for (const batch of batches) {
          const outcome = await this.coordinator.commitBatch(batch);
          if (outcome.outcome !== 'completed') {
            this.retainedUnsavedMutations += commands.length - committedCommands;
            this.latchSaveFailure(outcome);
            return;
          }
          committedCommands += batch.length;
          this.syncCurrentFromCoordinator();
        }
      } catch {
        this.retainedUnsavedMutations += commands.length;
        this.latchSaveFailure(failed('workspace.save.failed'));
      } finally {
        this.scheduledSaveGroups = Math.max(0, this.scheduledSaveGroups - 1);
        this.saveInFlight = false;
        this.notify();
      }
    };
    this.saveTail = this.saveTail.then(run, run);
  }

  private applySaveOutcome(outcome: WorkspaceSaveOutcome): void {
    if (outcome.outcome === 'completed') {
      this.syncCurrentFromCoordinator();
      this.notify();
      return;
    }
    this.latchSaveFailure(outcome);
  }

  private latchSaveFailure(outcome: Exclude<WorkspaceSaveOutcome, { outcome: 'completed' }>): void {
    const failure = outcome.outcome === 'failed' ? outcome : failed('workspace.save.interrupted');
    const firstFailure = this.lastSaveFailure === null;
    if (firstFailure) this.lastSaveFailure = failure;
    this.applicationMessageKey = failure.messageKey;
    this.abandonBufferedMutations();
    this.syncCurrentFromCoordinator();
    this.notify();
    if (firstFailure) {
      try {
        void Promise.resolve(this.onPersistenceFailure(failure)).catch(() => undefined);
      } catch {
        // Persistence is already latched closed. Failure handling cannot reopen
        // the writer or turn a durable error into another unhandled exception.
      }
    }
  }

  private abandonBufferedMutations(): void {
    this.retainedUnsavedMutations += this.saveQueues.abandon();
  }

  private acceptingSaveContext(): SaveContext | null {
    // The accept/reject decision only depends on local gate state (activation
    // phases, latched failures, and the queue/save-in-flight flags that drive
    // save health) plus the epoch-bumped workspace identity. Every input to
    // that decision is captured in the cache key, so while the key is stable
    // the full view-model snapshots (two coordinator.snapshot() constructions
    // per call) are skipped entirely — critical because this gate runs for
    // every captured frame batch during streaming.
    return this.saveGate.accepting(this.saveGateCacheKey(), () => {
      const snapshot = this.snapshot();
      const current = snapshot.currentWorkspace;
      return !snapshot.acceptsSaves || !current
        ? null
        : Object.freeze({ epoch: this.workspaceEpoch, workspaceId: current.workspaceId });
    });
  }

  private saveGateCacheKey(): string {
    return [
      this.current === null ? 0 : 1,
      this.workspaceEpoch,
      this.switching ? 1 : 0,
      this.hydrating ? 1 : 0,
      this.recoveryRequired ? 1 : 0,
      this.lastSaveFailure === null ? 0 : this.lastSaveFailure.code === 'REVISION_CONFLICT' ? 2 : 1,
      this.saveInFlight ? 1 : 0,
      this.scheduledSaveGroups > 0 ? 1 : 0,
      this.saveQueues.configQueued ? 1 : 0,
      this.saveQueues.framesQueued ? 1 : 0,
    ].join(':');
  }

  private isCurrentSaveContext(context: SaveContext): boolean {
    return (
      context.epoch === this.workspaceEpoch &&
      this.current?.workspaceId === context.workspaceId &&
      this.coordinator.activeWorkspaceId === context.workspaceId
    );
  }

  private currentWorkspaceView(): ActiveWorkspaceViewModel | null {
    const current = this.current;
    if (!current) return null;
    const coordinated = this.coordinator.snapshot().activeWorkspace;
    const source = coordinated?.workspaceId === current.workspaceId ? coordinated : current;
    return freezeActive({ ...source, saveHealth: this.currentSaveHealth(source) });
  }

  private currentSaveHealth(current: ActiveWorkspaceViewModel | null): WorkspaceSaveHealth {
    if (!current) return 'clean';
    const coordinated = this.coordinator.snapshot().activeWorkspace;
    const coordinatorHealth =
      coordinated?.workspaceId === current.workspaceId
        ? coordinated.saveHealth
        : current.saveHealth;
    if (
      this.recoveryRequired ||
      coordinatorHealth === 'readOnly' ||
      this.lastSaveFailure?.code === 'REVISION_CONFLICT'
    ) {
      return 'readOnly';
    }
    if (this.lastSaveFailure || coordinatorHealth === 'degraded') return 'degraded';
    if (this.saveInFlight) return 'saving';
    if (
      this.saveQueues.configQueued ||
      this.saveQueues.framesQueued ||
      this.scheduledSaveGroups > 0
    ) {
      return 'pending';
    }
    return coordinatorHealth;
  }

  private canAcceptSaves(
    current: ActiveWorkspaceViewModel | null,
    saveHealth: WorkspaceSaveHealth,
  ): boolean {
    return Boolean(
      current &&
      !this.switching &&
      !this.hydrating &&
      !this.lastSaveFailure &&
      !this.recoveryRequired &&
      saveHealth !== 'readOnly' &&
      this.coordinator.activeWorkspaceId === current.workspaceId &&
      this.coordinator.acceptsMutations,
    );
  }

  private queueRejectionMessage(): string {
    const health = this.currentSaveHealth(this.current);
    if (this.recoveryRequired) return 'workspace.activation.rollback_failed';
    if (health === 'readOnly') return 'error.workspace_read_only';
    if (this.lastSaveFailure) return this.lastSaveFailure.messageKey;
    if (this.switching || this.hydrating) return 'workspace.activation.in_progress';
    return 'workspace.no_active_project';
  }

  private syncCurrentFromCoordinator(): void {
    const coordinated = this.coordinator.snapshot().activeWorkspace;
    if (coordinated && coordinated.workspaceId === this.current?.workspaceId) {
      this.current = freezeActive(coordinated);
    }
  }

  private unsavedMutationCount(): number {
    return this.retainedUnsavedMutations + this.saveQueues.queuedMutationCount;
  }

  /**
   * State-observer notification. The 250 ms coalescing window itself lives in
   * WorkspaceSaveQueues (frame data never travels through these listeners —
   * they observe save health and pending counts); this entry point keeps the
   * zero-listener short-circuit.
   */
  private notify(): void {
    if (this.listeners.size === 0) return;
    this.saveQueues.notify();
  }

  private emitNotify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer observer cannot influence persistence or activation state.
      }
    }
  }
}

function waveformAppendCommands(
  sessionId: string,
  samples: readonly WorkspaceWaveformSample[],
): Array<Extract<WorkspaceMutationCommand, { kind: 'append-waveform-samples' }>> {
  const commands: Array<Extract<WorkspaceMutationCommand, { kind: 'append-waveform-samples' }>> =
    [];
  // Keep each structured mutation comfortably below the native 512 KiB batch
  // budget while matching the largest supported hydration page.
  const chunkSize = 2_048;
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    commands.push({
      kind: 'append-waveform-samples',
      sessionId,
      payload: {
        samples: samples.slice(offset, offset + chunkSize).map((sample) => ({ ...sample })),
      },
    });
  }
  return commands;
}


function cloneAndFreeze<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new Error('workspace command must be acyclic');
  ancestors.add(value);
  if (Array.isArray(value)) {
    const clone = value.map((child) => cloneAndFreeze(child, ancestors));
    ancestors.delete(value);
    return Object.freeze(clone) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    clone[key] = cloneAndFreeze(child, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(clone) as T;
}


function completed<T>(value: T): WorkspaceActionOutcome<T> {
  return Object.freeze({ outcome: 'completed', value });
}

function failed(messageKey: string, code?: string): WorkspaceActionFailure {
  return Object.freeze({ outcome: 'failed', messageKey, ...(code ? { code } : {}) });
}

function acceptedQueue(): WorkspaceQueueOutcome {
  return Object.freeze({ accepted: true });
}

function rejectedQueue(messageKey: string): WorkspaceQueueOutcome {
  return Object.freeze({ accepted: false, messageKey });
}

function defaultRequestId(): string {
  fallbackRequestSequence += 1;
  return `hydrate-${fallbackRequestSequence}`;
}

const NOOP_RUNTIME_LIFECYCLE: WorkspaceRuntimeLifecycle = Object.freeze({
  quiesce: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  restore: () => Promise.resolve(),
  activateStopped: () => Promise.resolve(),
});
