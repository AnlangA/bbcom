import type {
  WorkspaceFramePayload,
  WorkspaceSaveHealth,
  WorkspaceWaveformChannel,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import type { DataFrame } from '../../../types/serial';
import {
  projectWorkspaceFrame,
  stageWorkspaceHydration,
  type WorkspaceHydrationPort,
  type WorkspaceHydrationStaging,
} from '../adapters';
import type {
  ActiveWorkspaceViewModel,
  ProjectEncryptionOptions,
  WorkspaceActionFailure,
  WorkspaceActionOutcome,
  WorkspaceMutationCommand,
} from '../types';
import { WorkspaceCoordinator } from '../workspace-coordinator';
import {
  abortableWorkspaceHydrationPort,
  isWorkspaceHydrationAbort,
  observeWorkspaceFrameSequences,
} from './abortable-hydration-port';
import {
  WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES,
  WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES,
  WORKSPACE_STOPPED_ACTIVITY_POLICY,
  type WorkspaceApplicationListener,
  type WorkspaceApplicationOptions,
  type WorkspaceApplicationOutcome,
  type WorkspaceApplicationStatus,
  type WorkspaceApplicationViewModel,
  type WorkspaceConfigMutationCommand,
  type WorkspaceFacadeSnapshot,
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

interface ActivationAttempt {
  readonly generation: number;
  readonly controller: AbortController;
  previousWorkspaceId: string | null;
  nativeActivationStarted: boolean;
  cancelledByUser: boolean;
  activatedWorkspaceId: string | null;
  phase:
    'queued' | 'draining' | 'activating' | 'hydrating' | 'committing' | 'rolling-back' | 'terminal';
}

interface RuntimeTransition {
  readonly id: string;
  readonly previousWorkspaceId: string | null;
  quiesceStarted: boolean;
  quiesceFailure: WorkspaceActionFailure | null;
  disposeStarted: boolean;
  disposeCompleted: boolean;
  stoppedWorkspaceId: string | null;
}

interface SaveContext {
  readonly epoch: number;
  readonly workspaceId: string;
}

type WorkspaceBufferedMutationCommand =
  | WorkspaceConfigMutationCommand
  | Extract<WorkspaceMutationCommand, { readonly kind: 'append-waveform-samples' }>;

interface PendingConfigMutation {
  readonly context: SaveContext;
  readonly command: WorkspaceBufferedMutationCommand;
}

interface PendingFrame {
  readonly context: SaveContext;
  readonly sessionId: string;
  readonly sequence: number;
  readonly payload: WorkspaceFramePayload;
}

interface UndoCaptureState {
  readonly sessionId: string;
  readonly nextSequence: number;
  readonly frameCount: number;
  readonly captureBytes: number;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type ActivateWorkspace = () => Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>>;

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
  private exportAttempt: {
    readonly id: number;
    cancelled: boolean;
    nativeStarted: boolean;
    result: Promise<WorkspaceProjectExportOutcome> | null;
  } | null = null;
  private exportGeneration = 0;
  private activationGeneration = 0;
  private activationAttempt: ActivationAttempt | null = null;
  private activationTail: Promise<void> = Promise.resolve();
  private switchDrain: Promise<WorkspaceActionFailure | null> | null = null;
  private runtimeTransition: RuntimeTransition | null = null;
  private internalDrainTransition: RuntimeTransition | null = null;
  private runtimeLifecycleTail: Promise<void> = Promise.resolve();

  private workspaceEpoch = 0;
  private readonly nextFrameSequence = new Map<string, number>();
  private readonly sessionFrameCounts = new Map<string, number>();
  private readonly sessionCaptureBytes = new Map<string, number>();
  private workspaceFrameCount = 0;
  private workspaceCaptureBytes = 0;
  private undoCaptureState: UndoCaptureState | null = null;

  private configQueue: PendingConfigMutation[] = [];
  private configTimer: TimerHandle | null = null;
  private frameQueue: PendingFrame[] = [];
  private frameQueueBytes = 0;
  private frameTimer: TimerHandle | null = null;

  private saveTail: Promise<void> = Promise.resolve();
  private scheduledSaveGroups = 0;
  private saveInFlight = false;
  private lastSaveFailure: WorkspaceLatchedSaveFailure | null = null;
  private retainedUnsavedMutations = 0;

  constructor(
    private readonly coordinator: WorkspaceCoordinator,
    private readonly hydrationPort: WorkspaceHydrationPort,
    private readonly sessionFacade: WorkspaceSessionFacade,
    options: WorkspaceApplicationOptions = {},
  ) {
    this.requestId = options.requestId ?? defaultRequestId;
    this.runtimeLifecycle = options.runtimeLifecycle ?? NOOP_RUNTIME_LIFECYCLE;
    this.onPersistenceFailure = options.onPersistenceFailure ?? (() => undefined);
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
      exporting: this.exportAttempt !== null,
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
    return this.activate(() => this.coordinator.openWorkspace(workspaceId));
  }

  async restoreLastActiveWorkspace(
    fallbackWorkspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceApplicationOutcome> {
    if (signal?.aborted) return Object.freeze({ outcome: 'cancelled' });
    if (this.current) return { outcome: 'completed', value: this.snapshot() };
    const refreshed = await this.coordinator.refreshCatalog();
    if (signal?.aborted) return Object.freeze({ outcome: 'cancelled' });
    if (refreshed.outcome !== 'completed') return refreshed;
    const workspaceId = refreshed.value.library.activeWorkspaceId ?? fallbackWorkspaceId;
    return this.openWorkspace(workspaceId);
  }

  createWorkspace(name: string): Promise<WorkspaceApplicationOutcome> {
    return this.activate(() => this.coordinator.createWorkspace(name));
  }

  importWorkspace(
    encryption: ProjectEncryptionOptions = { mode: 'plaintext' },
  ): Promise<WorkspaceApplicationOutcome> {
    return this.activate(() => this.coordinator.importWorkspace(encryption));
  }

  /**
   * Export one durable point-in-time revision. The barrier is installed on
   * `saveTail` synchronously, so mutations accepted after this call remain
   * queued behind the native backup instead of racing into its SQLite image.
   */
  exportWorkspace(
    suggestedName: string,
    encryption: ProjectEncryptionOptions = { mode: 'plaintext' },
  ): Promise<WorkspaceProjectExportOutcome> {
    if (this.exportAttempt) return Promise.resolve(failed('workspace.export.in_progress'));
    const context = this.acceptingSaveContext();
    if (!context) return Promise.resolve(failed(this.queueRejectionMessage()));
    const attempt = {
      id: ++this.exportGeneration,
      cancelled: false,
      nativeStarted: false,
      result: null as Promise<WorkspaceProjectExportOutcome> | null,
    };
    this.exportAttempt = attempt;

    this.releaseAllQueues();
    const predecessor = this.saveTail;
    const exportAtBarrier = predecessor.then(async (): Promise<WorkspaceProjectExportOutcome> => {
      if (attempt.cancelled) return Object.freeze({ outcome: 'cancelled' });
      if (this.lastSaveFailure) return this.lastSaveFailure;
      if (!this.isCurrentSaveContext(context)) return failed('workspace.activation.incomplete');

      const flushed = await this.coordinator.flush();
      this.applySaveOutcome(flushed);
      if (flushed.outcome !== 'completed') return flushed;
      if (attempt.cancelled) return Object.freeze({ outcome: 'cancelled' });
      this.syncCurrentFromCoordinator();
      if (!this.isCurrentSaveContext(context)) return failed('workspace.activation.incomplete');
      const nativeExport = this.coordinator.exportWorkspace(suggestedName, encryption);
      attempt.nativeStarted = true;
      if (attempt.cancelled) void this.coordinator.cancelExport();
      return nativeExport;
    });
    this.saveTail = exportAtBarrier.then(
      () => undefined,
      () => undefined,
    );
    this.notify();
    const result = exportAtBarrier
      .catch(() => failed('workspace.export.failed'))
      .finally(() => {
        if (this.exportAttempt === attempt) {
          this.exportAttempt = null;
          this.notify();
        }
      });
    attempt.result = result;
    return result;
  }

  async cancelExport(): Promise<WorkspaceProjectExportOutcome | null> {
    const attempt = this.exportAttempt;
    if (!attempt) return null;
    attempt.cancelled = true;
    this.notify();
    if (attempt.nativeStarted) {
      const cancellation = await this.coordinator.cancelExport();
      if (cancellation === 'failed') return failed('workspace.export.cancel_failed');
    }
    return attempt.result ?? Object.freeze({ outcome: 'cancelled' });
  }

  /**
   * Cancels native activation or renderer hydration. If native activation
   * already committed, the serialized activation owner rolls it back before a
   * later request may enter the native activation phase.
   */
  cancelActivation(): boolean {
    const attempt = this.activationAttempt;
    if (!attempt) return this.coordinator.cancelActivation();
    if (attempt.phase === 'committing' || attempt.phase === 'terminal') return false;
    attempt.cancelledByUser = true;
    attempt.controller.abort();
    if (attempt.phase === 'activating') this.coordinator.cancelActivation();
    this.switching = true;
    this.hydrating = false;
    this.applicationStatus = 'loading';
    this.applicationMessageKey = null;
    this.notify();
    return true;
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
    for (const command of clonedCommands) this.configQueue.push({ context, command });
    if (clonedCommands.length === 0) return acceptedQueue();
    if (this.configTimer !== null) globalThis.clearTimeout(this.configTimer);
    this.configTimer = globalThis.setTimeout(() => {
      this.configTimer = null;
      this.releaseConfigQueue();
    }, WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS);
    this.notify();
    return acceptedQueue();
  }

  queueWaveformReplacement(
    sessionId: string,
    channels: readonly WorkspaceWaveformChannel[],
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.nextFrameSequence.has(sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    return this.enqueueWaveformReplacement(context, sessionId, channels, samples);
  }

  queueWaveformSamples(
    sessionId: string,
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.nextFrameSequence.has(sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    return this.enqueueWaveformSamples(context, sessionId, samples);
  }

  queueWaveformFrameIngest(ingest: Readonly<WorkspaceWaveformFrameIngest>): WorkspaceQueueOutcome {
    const context = this.acceptingSaveContext();
    if (!context || !this.nextFrameSequence.has(ingest.sessionId)) {
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
    this.releaseAllQueues();
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
    this.releaseAllQueues();
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
    this.releaseAllQueues();
    this.scheduleSaveGroup(context, clonedCommands);
    this.notify();
    return acceptedQueue();
  }

  /** Register a newly-created renderer session before it can emit frames. */
  registerSession(sessionId: string): WorkspaceQueueOutcome {
    if (this.nextFrameSequence.has(sessionId)) return acceptedQueue();
    const restored = this.undoCaptureState?.sessionId === sessionId ? this.undoCaptureState : null;
    const preflight = this.preflightSessionRegistration(
      sessionId,
      restored?.frameCount ?? 0,
      restored?.captureBytes ?? 0,
    );
    if (!preflight.accepted) return preflight;
    if (!this.nextFrameSequence.has(sessionId)) {
      const frameCount = restored?.frameCount ?? 0;
      const captureBytes = restored?.captureBytes ?? 0;
      this.nextFrameSequence.set(sessionId, restored?.nextSequence ?? 0);
      this.sessionFrameCounts.set(sessionId, frameCount);
      this.sessionCaptureBytes.set(sessionId, captureBytes);
      this.workspaceFrameCount += frameCount;
      this.workspaceCaptureBytes += captureBytes;
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
      this.nextFrameSequence.has(sessionId) ||
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
    if (
      this.nextFrameSequence.size + 1 > IPC_LIMITS.MAX_WORKSPACE_SESSIONS ||
      frameCount > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION ||
      this.workspaceFrameCount + frameCount > IPC_LIMITS.MAX_WORKSPACE_FRAMES ||
      this.workspaceCaptureBytes + captureBytes > IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES
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
    if (!context || !this.nextFrameSequence.has(sessionId)) {
      return rejectedQueue(this.queueRejectionMessage());
    }
    // Attach all accepted work to saveTail, then schedule clear immediately.
    // New frames can be queued synchronously after this call, but their save
    // groups are necessarily appended after this replacement barrier.
    const outcome = this.queueOrderedMutations([
      { kind: 'replace-capture', sessionId, payload: { frames: [] } },
    ]);
    if (!outcome.accepted) return outcome;
    const removedFrames = this.sessionFrameCounts.get(sessionId) ?? 0;
    const removedBytes = this.sessionCaptureBytes.get(sessionId) ?? 0;
    this.workspaceFrameCount = Math.max(0, this.workspaceFrameCount - removedFrames);
    this.workspaceCaptureBytes = Math.max(0, this.workspaceCaptureBytes - removedBytes);
    this.sessionFrameCounts.set(sessionId, 0);
    this.sessionCaptureBytes.set(sessionId, 0);
    this.nextFrameSequence.set(sessionId, 0);
    return outcome;
  }

  /** Stop accepting frames for a removed session and release its aggregate
   * accounting. The caller still submits the generated remove-session command. */
  forgetSession(sessionId: string): void {
    const removedFrames = this.sessionFrameCounts.get(sessionId) ?? 0;
    const removedBytes = this.sessionCaptureBytes.get(sessionId) ?? 0;
    const nextSequence = this.nextFrameSequence.get(sessionId) ?? 0;
    if (this.nextFrameSequence.has(sessionId)) {
      this.undoCaptureState = Object.freeze({
        sessionId,
        nextSequence,
        frameCount: removedFrames,
        captureBytes: removedBytes,
      });
    }
    this.workspaceFrameCount = Math.max(0, this.workspaceFrameCount - removedFrames);
    this.workspaceCaptureBytes = Math.max(0, this.workspaceCaptureBytes - removedBytes);
    this.nextFrameSequence.delete(sessionId);
    this.sessionFrameCounts.delete(sessionId);
    this.sessionCaptureBytes.delete(sessionId);
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
    const frameCount = this.sessionFrameCounts.get(sessionId);
    const captureBytes = this.sessionCaptureBytes.get(sessionId);
    if (
      frameCount === undefined ||
      captureBytes === undefined ||
      !Number.isSafeInteger(droppedFrames) ||
      droppedFrames < 1 ||
      droppedFrames > frameCount ||
      droppedFrames > 0xffff_ffff ||
      !Number.isSafeInteger(droppedBytes) ||
      droppedBytes < 0 ||
      droppedBytes > captureBytes
    ) {
      return rejectedQueue('workspace.capture.invalid_trim');
    }
    const outcome = this.enqueueOrderedMutations(context, [
      { kind: 'trim-capture', sessionId, payload: { frameCount: droppedFrames } },
    ]);
    if (!outcome.accepted) return outcome;
    this.sessionFrameCounts.set(sessionId, frameCount - droppedFrames);
    this.sessionCaptureBytes.set(sessionId, captureBytes - droppedBytes);
    this.workspaceFrameCount = Math.max(0, this.workspaceFrameCount - droppedFrames);
    this.workspaceCaptureBytes = Math.max(0, this.workspaceCaptureBytes - droppedBytes);
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
      !this.nextFrameSequence.has(sessionId) ||
      !(frame?.data instanceof Uint8Array) ||
      (frame.direction !== 'RX' && frame.direction !== 'TX') ||
      frame.data.byteLength > IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES
    ) {
      return rejectedQueue('workspace.capture.invalid');
    }
    const sessionCount = this.sessionFrameCounts.get(sessionId) ?? 0;
    if (
      sessionCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION ||
      this.workspaceFrameCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES ||
      this.workspaceCaptureBytes + frame.data.byteLength > IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES
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
    if (!capture.frame || !this.nextFrameSequence.has(capture.sessionId)) {
      return rejectedQueue('workspace.capture.invalid_session');
    }
    const sequence = this.nextFrameSequence.get(capture.sessionId)!;
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(sequence + 1)) {
      return rejectedQueue('workspace.capture.sequence_exhausted');
    }
    let payload: WorkspaceFramePayload;
    try {
      payload = projectWorkspaceFrame(capture.frame);
    } catch {
      return rejectedQueue('workspace.capture.invalid');
    }
    const sessionCount = this.sessionFrameCounts.get(capture.sessionId) ?? 0;
    if (
      sessionCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION ||
      this.workspaceFrameCount + 1 > IPC_LIMITS.MAX_WORKSPACE_FRAMES ||
      this.workspaceCaptureBytes + payload.data.length > IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES
    ) {
      return rejectedQueue('workspace.capture.limit_exceeded');
    }

    if (
      this.frameQueue.length > 0 &&
      (this.frameQueue.length + 1 > WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES ||
        this.frameQueueBytes + payload.data.length > WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES)
    ) {
      this.releaseFrameQueue();
    }

    this.nextFrameSequence.set(capture.sessionId, sequence + 1);
    this.sessionFrameCounts.set(capture.sessionId, sessionCount + 1);
    this.sessionCaptureBytes.set(
      capture.sessionId,
      (this.sessionCaptureBytes.get(capture.sessionId) ?? 0) + payload.data.length,
    );
    this.workspaceFrameCount += 1;
    this.workspaceCaptureBytes += payload.data.length;
    this.frameQueue.push({ context, sessionId: capture.sessionId, sequence, payload });
    this.frameQueueBytes += payload.data.length;
    if (this.frameQueue.length === 1) {
      this.frameTimer = globalThis.setTimeout(() => {
        this.frameTimer = null;
        this.releaseFrameQueue();
      }, WORKSPACE_FRAME_AUTOSAVE_DELAY_MS);
    }
    if (
      this.frameQueue.length >= WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES ||
      this.frameQueueBytes >= WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES
    ) {
      this.releaseFrameQueue();
    }
    this.notify();
    return acceptedQueue();
  }

  /**
   * Flushes every mutation accepted before this call, then checkpoints the
   * coordinator revision. Mutations accepted later belong to a later barrier.
   */
  async flush(): Promise<WorkspaceSaveOutcome> {
    this.releaseAllQueues();
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

  private activate(invoke: ActivateWorkspace): Promise<WorkspaceApplicationOutcome> {
    const predecessor = this.activationAttempt;
    if (predecessor && predecessor.phase !== 'committing' && predecessor.phase !== 'terminal') {
      predecessor.controller.abort();
      if (predecessor.phase === 'activating') this.coordinator.cancelActivation();
    }
    const attempt: ActivationAttempt = {
      generation: ++this.activationGeneration,
      controller: new AbortController(),
      // The predecessor may still commit before this queued attempt starts.
      // Capture the rollback target only after the serialized hand-off.
      previousWorkspaceId: null,
      nativeActivationStarted: false,
      cancelledByUser: false,
      activatedWorkspaceId: null,
      phase: 'queued',
    };
    this.activationAttempt = attempt;
    this.switching = true;
    this.hydrating = false;
    this.applicationStatus = 'loading';
    this.applicationMessageKey = null;
    this.notify();

    const execution = this.activationTail.then(
      () => this.performActivation(attempt, invoke),
      () => this.performActivation(attempt, invoke),
    );
    this.activationTail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private async performActivation(
    attempt: ActivationAttempt,
    invoke: ActivateWorkspace,
  ): Promise<WorkspaceApplicationOutcome> {
    if (this.recoveryRequired) {
      attempt.phase = 'terminal';
      const failure = failed('workspace.activation.rollback_failed');
      this.finishActivationFailure(attempt, failure);
      return failure;
    }
    if (attempt.controller.signal.aborted) {
      attempt.phase = 'terminal';
      this.finishAbortedQueuedAttempt(attempt);
      return staleOrCancelled(attempt);
    }

    attempt.previousWorkspaceId = this.current?.workspaceId ?? null;
    this.ensureRuntimeTransition(attempt.previousWorkspaceId);
    attempt.phase = 'draining';

    const drainFailure = await this.drainBeforeActivation();
    if (!this.isAttemptActive(attempt)) return this.abortAndRecoverActivation(attempt);
    if (drainFailure) {
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      if (!this.isAttemptActive(attempt)) return this.abortAndRecoverActivation(attempt);
      const failure = restored ? drainFailure : failed('workspace.activation.rollback_failed');
      if (!restored) this.markRecoveryRequired(attempt);
      this.finishActivationFailure(attempt, failure);
      return failure;
    }

    let activation: WorkspaceActionOutcome<ActiveWorkspaceViewModel>;
    attempt.phase = 'activating';
    attempt.nativeActivationStarted = true;
    try {
      activation = await invoke();
    } catch {
      if (!this.isAttemptActive(attempt)) return this.abortAndRecoverActivation(attempt);
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      const failure = restored
        ? failed('workspace.activation.failed')
        : failed('workspace.activation.rollback_failed');
      if (!restored) this.markRecoveryRequired(attempt);
      this.finishActivationFailure(attempt, failure);
      return failure;
    }
    if (activation.outcome === 'completed') {
      attempt.activatedWorkspaceId = activation.value.workspaceId;
    }
    if (!this.isAttemptActive(attempt)) return this.abortAndRecoverActivation(attempt);
    if (activation.outcome !== 'completed') {
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      if (!restored) {
        const failure = failed('workspace.activation.rollback_failed');
        this.markRecoveryRequired(attempt);
        this.finishActivationFailure(attempt, failure);
        return failure;
      }
      this.finishActivationOutcome(attempt, activation);
      return activation;
    }

    attempt.phase = 'hydrating';
    this.hydrating = true;
    this.notify();
    try {
      const header = activation.value;
      const frameNextSequences = new Map<string, number>();
      const cancellablePort = abortableWorkspaceHydrationPort(
        this.hydrationPort,
        attempt.controller.signal,
      );
      const staging = await raceActivationAbort(
        stageWorkspaceHydration({
          port: observeWorkspaceFrameSequences(cancellablePort, frameNextSequences),
          workspaceId: header.workspaceId,
          revision: header.revision,
          ...(header.activeSessionId ? { activeSessionId: header.activeSessionId } : {}),
          requestId: this.requestId,
          sessionPageSize: 64,
          framePageSize: 256,
          aiPageSize: 256,
          waveformPageSize: 2_048,
          concurrency: 3,
        }),
        attempt.controller.signal,
      );
      this.assertCurrentHydration(attempt, header, staging);
      const facadeSnapshot = this.createFacadeSnapshot(header, staging);
      await this.prepareRuntimeFacadeSwap(attempt, facadeSnapshot);
      this.assertCurrentHydration(attempt, header, staging);
      // From this point replacement and application commit are synchronous.
      // A re-entrant activation may queue, but cannot revoke this owner halfway
      // through the facade's linearization point.
      attempt.phase = 'committing';
      this.sessionFacade.replaceWorkspace(facadeSnapshot);
      this.installHydratedWorkspace(attempt, header, staging, frameNextSequences);
      return completed(this.snapshot());
    } catch (error) {
      if (!this.isAttemptActive(attempt) || isWorkspaceHydrationAbort(error)) {
        return this.abortAndRecoverActivation(attempt);
      }
      const failure = failed('workspace.hydration.failed');
      const rollback = await this.rollbackFailedActivation(attempt, failure);
      if (this.recoveryRequired) return failed('workspace.activation.rollback_failed');
      if (rollback === 'stale') return staleOrCancelled(attempt);
      return failure;
    }
  }

  private ensureRuntimeTransition(previousWorkspaceId: string | null): RuntimeTransition {
    const existing = this.runtimeTransition;
    if (existing) {
      if (existing.previousWorkspaceId !== previousWorkspaceId) {
        throw new Error('workspace runtime transition owner changed before completion');
      }
      return existing;
    }
    const transition: RuntimeTransition = {
      id: `workspace-transition-${this.activationGeneration}`,
      previousWorkspaceId,
      quiesceStarted: false,
      quiesceFailure: null,
      disposeStarted: false,
      disposeCompleted: false,
      stoppedWorkspaceId: null,
    };
    this.runtimeTransition = transition;
    return transition;
  }

  /**
   * Permanently detach old runtimes only after the next document has staged.
   * Superseding requests cannot enter here until their predecessor has either
   * committed or restored its transition, so a transition id has one owner and
   * old runtimes are never reused merely because session ids overlap.
   */
  private async prepareRuntimeFacadeSwap(
    attempt: ActivationAttempt,
    workspace: WorkspaceFacadeSnapshot,
  ): Promise<void> {
    const transition = this.ensureRuntimeTransition(attempt.previousWorkspaceId);
    const stage = this.runtimeLifecycleTail.then(async () => {
      this.assertAttemptOwnsRuntimeTransition(attempt, transition);
      if (transition.previousWorkspaceId && !transition.disposeCompleted) {
        transition.disposeStarted = true;
        await this.runtimeLifecycle.dispose({
          transitionId: transition.id,
          previousWorkspaceId: transition.previousWorkspaceId,
          nextWorkspaceId: workspace.workspaceId,
        });
        transition.disposeCompleted = true;
      }
      this.assertAttemptOwnsRuntimeTransition(attempt, transition);
      transition.stoppedWorkspaceId = workspace.workspaceId;
      await this.runtimeLifecycle.activateStopped({ transitionId: transition.id, workspace });
      this.assertAttemptOwnsRuntimeTransition(attempt, transition);
    });
    this.runtimeLifecycleTail = stage.then(
      () => undefined,
      () => undefined,
    );
    await stage;
  }

  private assertAttemptOwnsRuntimeTransition(
    attempt: ActivationAttempt,
    transition: RuntimeTransition,
  ): void {
    if (!this.isAttemptActive(attempt) || this.runtimeTransition !== transition) {
      const error = new Error('stale workspace runtime transition');
      error.name = 'AbortError';
      throw error;
    }
  }

  /** Restore is called only after native state is known to be the previous
   * workspace (or no previous workspace existed). It also clears any stopped
   * next-workspace staging owned by the transition. */
  private async restoreRuntimeAfterAbortedTransition(
    failedWorkspaceId: string | null,
  ): Promise<boolean> {
    const transition = this.runtimeTransition;
    if (!transition) return true;
    const lifecycleWasTouched =
      transition.quiesceStarted ||
      transition.disposeStarted ||
      transition.stoppedWorkspaceId !== null;
    const restore = this.runtimeLifecycleTail.then(async () => {
      if (!lifecycleWasTouched) return;
      await this.runtimeLifecycle.restore({
        transitionId: transition.id,
        previousWorkspaceId: transition.previousWorkspaceId,
        failedWorkspaceId,
      });
    });
    this.runtimeLifecycleTail = restore.then(
      () => undefined,
      () => undefined,
    );
    try {
      await restore;
    } catch {
      return false;
    }
    if (this.runtimeTransition === transition) this.runtimeTransition = null;
    if (this.internalDrainTransition === transition) this.internalDrainTransition = null;
    return true;
  }

  /**
   * `WorkspaceCoordinator.open/create/import` commits the native writer before
   * renderer hydration begins. A failed stage therefore has to reactivate the
   * previous native workspace before the unchanged facade may accept saves.
   */
  private async rollbackFailedActivation(
    attempt: ActivationAttempt,
    failure: WorkspaceActionFailure,
  ): Promise<'recovered' | 'failed' | 'stale'> {
    const recovered = await this.recoverActivationOwner(attempt);
    attempt.phase = 'terminal';
    if (!recovered) {
      this.markRecoveryRequired(attempt);
      return 'failed';
    }
    if (!this.isLatestAttempt(attempt)) return 'stale';
    this.finishActivationFailure(attempt, failure);
    return 'recovered';
  }

  /**
   * The attempt that crossed native activation remains the sole rollback owner,
   * even after a newer request has become the UI-visible latest request. The
   * activation tail does not release its successor until this method reaches a
   * terminal native/runtime state.
   */
  private async recoverActivationOwner(attempt: ActivationAttempt): Promise<boolean> {
    attempt.phase = 'rolling-back';
    const previousWorkspaceId = attempt.previousWorkspaceId;
    let rollbackView: ActiveWorkspaceViewModel | null = null;
    if (!previousWorkspaceId) {
      // With no installed facade there are no renderer writes to protect. A
      // failed first hydration may leave a native project selected, but must
      // remain retryable instead of permanently locking this process.
      return this.restoreRuntimeAfterAbortedTransition(attempt.activatedWorkspaceId);
    }
    if (
      attempt.nativeActivationStarted ||
      this.coordinator.activeWorkspaceId !== previousWorkspaceId
    ) {
      // Once an invoke has started, renderer cancellation cannot prove that
      // native activation did not commit. Re-open the prior project
      // unconditionally; consulting the stale coordinator cache is unsafe.
      let rollback: WorkspaceActionOutcome<ActiveWorkspaceViewModel>;
      try {
        rollback = await this.coordinator.openWorkspace(previousWorkspaceId);
      } catch {
        return false;
      }
      if (
        rollback.outcome !== 'completed' ||
        rollback.value.workspaceId !== previousWorkspaceId ||
        this.coordinator.activeWorkspaceId !== previousWorkspaceId
      ) {
        return false;
      }
      rollbackView = rollback.value;
    }
    const restored = await this.restoreRuntimeAfterAbortedTransition(attempt.activatedWorkspaceId);
    if (!restored) return false;
    if (rollbackView && this.current?.workspaceId === previousWorkspaceId) {
      this.current = freezeActive(rollbackView);
    }
    return true;
  }

  private async abortAndRecoverActivation(
    attempt: ActivationAttempt,
  ): Promise<WorkspaceApplicationOutcome> {
    const recovered = await this.recoverActivationOwner(attempt);
    attempt.phase = 'terminal';
    if (!recovered) {
      this.markRecoveryRequired(attempt);
      return failed('workspace.activation.rollback_failed');
    }
    this.finishAbortedQueuedAttempt(attempt);
    return staleOrCancelled(attempt);
  }

  private finishAbortedQueuedAttempt(attempt: ActivationAttempt): void {
    if (!this.isLatestAttempt(attempt)) return;
    this.activationAttempt = null;
    this.switching = false;
    this.hydrating = false;
    this.applicationStatus = this.current ? 'ready' : 'idle';
    this.applicationMessageKey = null;
    this.notify();
  }

  private markRecoveryRequired(owner: ActivationAttempt): void {
    this.recoveryRequired = true;
    const latest = this.activationAttempt;
    if (latest && latest !== owner && latest.phase !== 'committing') {
      latest.controller.abort();
    }
    this.switching = false;
    this.hydrating = false;
    this.applicationStatus = 'failed';
    this.applicationMessageKey = 'workspace.activation.rollback_failed';
    if (latest === owner) this.activationAttempt = null;
    this.notify();
  }

  private drainBeforeActivation(): Promise<WorkspaceActionFailure | null> {
    if (this.switchDrain) return this.switchDrain;
    const drain = this.performActivationDrain();
    this.switchDrain = drain;
    const clear = (): void => {
      if (this.switchDrain === drain) this.switchDrain = null;
    };
    void drain.then(clear, clear);
    return drain;
  }

  private async performActivationDrain(): Promise<WorkspaceActionFailure | null> {
    const transition = this.runtimeTransition;
    let quiesceFailure = transition?.quiesceFailure ?? null;
    if (transition?.previousWorkspaceId && !transition.quiesceStarted) {
      transition.quiesceStarted = true;
      this.internalDrainTransition = transition;
      try {
        await this.runtimeLifecycle.quiesce({
          transitionId: transition.id,
          previousWorkspaceId: transition.previousWorkspaceId,
          persistence: this.createRuntimePersistenceDrain(transition),
        });
      } catch {
        quiesceFailure = failed('workspace.runtime.quiesce_failed');
        transition.quiesceFailure = quiesceFailure;
      } finally {
        if (this.internalDrainTransition === transition) this.internalDrainTransition = null;
      }
    }
    // The internal persistence capability is closed before the queues are
    // released. No producer can add old-workspace events behind this barrier.
    this.releaseAllQueues();
    const barrier = this.saveTail;
    await barrier;
    if (this.lastSaveFailure) return this.lastSaveFailure;
    const current = this.current;
    if (!current || this.coordinator.activeWorkspaceId !== current.workspaceId) {
      return quiesceFailure;
    }
    const outcome = await this.coordinator.flush();
    this.applySaveOutcome(outcome);
    const saveFailure =
      outcome.outcome === 'failed'
        ? outcome
        : outcome.outcome === 'completed'
          ? null
          : failed('workspace.save.interrupted');
    return saveFailure ?? quiesceFailure;
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

  private assertCurrentHydration(
    attempt: ActivationAttempt,
    header: ActiveWorkspaceViewModel,
    staging: WorkspaceHydrationStaging,
  ): void {
    if (
      !this.isAttemptActive(attempt) ||
      this.coordinator.activeWorkspaceId !== header.workspaceId ||
      staging.workspaceId !== header.workspaceId ||
      staging.revision !== header.revision
    ) {
      const error = new Error('stale workspace hydration');
      error.name = 'AbortError';
      throw error;
    }
    const coordinatorHeader = this.coordinator.snapshot().activeWorkspace;
    if (!coordinatorHeader || coordinatorHeader.revision !== header.revision) {
      throw new Error('workspace revision changed during hydration');
    }
    assertSameSessionSet(
      header.sessionIds,
      staging.sessions.map((entry) => entry.session.id),
    );
    for (const entry of staging.sessions) {
      if (
        entry.rebind.required !== true ||
        entry.session.isConnected !== false ||
        entry.session.autoLogEnabled !== false ||
        entry.session.logPath !== null
      ) {
        throw new Error('hydrated workspace contains active runtime state');
      }
    }
  }

  private createFacadeSnapshot(
    header: ActiveWorkspaceViewModel,
    staging: WorkspaceHydrationStaging,
  ): WorkspaceFacadeSnapshot {
    return Object.freeze({
      workspaceId: header.workspaceId,
      name: header.name,
      revision: header.revision,
      activeSessionId: staging.activeSessionId,
      sessions: staging.sessions,
      layout: header.layout,
      activityPolicy: WORKSPACE_STOPPED_ACTIVITY_POLICY,
    });
  }

  private installHydratedWorkspace(
    attempt: ActivationAttempt,
    header: ActiveWorkspaceViewModel,
    staging: WorkspaceHydrationStaging,
    frameNextSequences: ReadonlyMap<string, number>,
  ): void {
    const transition = this.runtimeTransition;
    this.current = freezeActive(header);
    this.workspaceEpoch += 1;
    this.nextFrameSequence.clear();
    this.sessionFrameCounts.clear();
    this.sessionCaptureBytes.clear();
    this.workspaceFrameCount = 0;
    this.workspaceCaptureBytes = 0;
    this.undoCaptureState = null;
    for (const entry of staging.sessions) {
      const frameCount = entry.session.frames.length;
      this.nextFrameSequence.set(entry.session.id, frameNextSequences.get(entry.session.id) ?? 0);
      this.sessionFrameCounts.set(entry.session.id, frameCount);
      this.sessionCaptureBytes.set(
        entry.session.id,
        entry.session.frames.reduce((total, frame) => total + frame.data.byteLength, 0),
      );
      this.workspaceFrameCount += frameCount;
      this.workspaceCaptureBytes += entry.session.frames.reduce(
        (total, frame) => total + frame.data.byteLength,
        0,
      );
    }
    this.configQueue = [];
    this.frameQueue = [];
    this.frameQueueBytes = 0;
    this.saveTail = Promise.resolve();
    this.scheduledSaveGroups = 0;
    this.saveInFlight = false;
    this.lastSaveFailure = null;
    this.retainedUnsavedMutations = 0;
    this.recoveryRequired = false;
    this.hydrating = false;
    attempt.phase = 'terminal';
    if (transition && transition.stoppedWorkspaceId === header.workspaceId) {
      try {
        this.runtimeLifecycle.commit?.({
          transitionId: transition.id,
          workspaceId: header.workspaceId,
        });
      } catch {
        // Commit is rollback-snapshot cleanup only. The facade and native
        // workspace are already authoritative and must not be rolled back for
        // a cleanup observer failure.
      }
      this.runtimeTransition = null;
      if (this.internalDrainTransition === transition) this.internalDrainTransition = null;
    }
    if (this.activationAttempt === attempt) {
      this.activationAttempt = null;
      this.applicationStatus = 'ready';
      this.applicationMessageKey = null;
      this.switching = false;
    } else {
      // A re-entrant successor was queued at the synchronous facade commit.
      // Keep the public save gate closed until that successor owns the tail.
      this.applicationStatus = 'loading';
      this.applicationMessageKey = null;
      this.switching = true;
    }
    this.notify();
  }

  private finishActivationOutcome(
    attempt: ActivationAttempt,
    outcome: Exclude<WorkspaceActionOutcome<ActiveWorkspaceViewModel>, { outcome: 'completed' }>,
  ): void {
    attempt.phase = 'terminal';
    if (!this.isLatestAttempt(attempt)) return;
    if (outcome.outcome === 'failed') {
      this.finishActivationFailure(attempt, outcome);
      return;
    }
    this.switching = false;
    this.hydrating = false;
    this.applicationStatus = this.current ? 'ready' : 'idle';
    this.applicationMessageKey = null;
    if (this.activationAttempt === attempt) this.activationAttempt = null;
    this.notify();
  }

  private finishActivationFailure(
    attempt: ActivationAttempt,
    failure: WorkspaceActionFailure,
  ): void {
    attempt.phase = 'terminal';
    if (!this.isLatestAttempt(attempt)) return;
    this.switching = false;
    this.hydrating = false;
    this.applicationStatus =
      this.current && this.coordinator.activeWorkspaceId === this.current.workspaceId
        ? 'ready'
        : 'failed';
    this.applicationMessageKey = failure.messageKey;
    if (failure.messageKey === 'workspace.activation.rollback_failed') {
      this.recoveryRequired = true;
    }
    if (this.activationAttempt === attempt) this.activationAttempt = null;
    this.notify();
  }

  private releaseAllQueues(): void {
    this.releaseConfigQueue();
    this.releaseFrameQueue();
  }

  private releaseConfigQueue(): void {
    if (this.configTimer !== null) {
      globalThis.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    if (this.configQueue.length === 0) return;
    const queued = this.configQueue;
    this.configQueue = [];
    for (const group of groupConfigMutationsByContext(queued)) {
      this.scheduleSaveGroup(group.context, group.commands);
    }
    this.notify();
  }

  private releaseFrameQueue(): void {
    if (this.frameTimer !== null) {
      globalThis.clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.frameQueue.length === 0) return;
    const queued = this.frameQueue;
    this.frameQueue = [];
    this.frameQueueBytes = 0;
    for (const group of groupFramesByContext(queued)) {
      this.scheduleSaveGroup(group.context, frameAppendCommands(group.frames));
    }
    this.notify();
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
    if (this.configTimer !== null) globalThis.clearTimeout(this.configTimer);
    if (this.frameTimer !== null) globalThis.clearTimeout(this.frameTimer);
    this.configTimer = null;
    this.frameTimer = null;
    this.retainedUnsavedMutations += this.configQueue.length;
    this.retainedUnsavedMutations += frameAppendCommands(this.frameQueue).length;
    this.configQueue = [];
    this.frameQueue = [];
    this.frameQueueBytes = 0;
  }

  private acceptingSaveContext(): SaveContext | null {
    const snapshot = this.snapshot();
    const current = snapshot.currentWorkspace;
    if (!snapshot.acceptsSaves || !current) return null;
    return Object.freeze({ epoch: this.workspaceEpoch, workspaceId: current.workspaceId });
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
    if (this.configQueue.length > 0 || this.frameQueue.length > 0 || this.scheduledSaveGroups > 0) {
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
    return (
      this.retainedUnsavedMutations +
      this.configQueue.length +
      frameAppendCommands(this.frameQueue).length
    );
  }

  private isAttemptActive(attempt: ActivationAttempt): boolean {
    return (
      !attempt.controller.signal.aborted &&
      attempt.phase !== 'rolling-back' &&
      attempt.phase !== 'terminal'
    );
  }

  private isLatestAttempt(attempt: ActivationAttempt): boolean {
    return this.activationAttempt === attempt && attempt.generation === this.activationGeneration;
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
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

function frameAppendCommands(frames: readonly PendingFrame[]): WorkspaceMutationCommand[] {
  if (frames.length === 0) return [];
  const commands: WorkspaceMutationCommand[] = [];
  let sessionId = frames[0].sessionId;
  let startSeq = frames[0].sequence;
  let previousSeq = startSeq - 1;
  let payloads: WorkspaceFramePayload[] = [];
  const release = (): void => {
    if (payloads.length === 0) return;
    commands.push({
      kind: 'append-frames',
      sessionId,
      payload: { startSeq, frames: payloads },
    });
  };
  for (const frame of frames) {
    if (frame.sessionId !== sessionId || frame.sequence !== previousSeq + 1) {
      release();
      sessionId = frame.sessionId;
      startSeq = frame.sequence;
      payloads = [];
    }
    payloads.push(frame.payload);
    previousSeq = frame.sequence;
  }
  release();
  return commands;
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

function groupConfigMutationsByContext(
  queued: readonly PendingConfigMutation[],
): Array<{ context: SaveContext; commands: WorkspaceBufferedMutationCommand[] }> {
  const groups: Array<{ context: SaveContext; commands: WorkspaceBufferedMutationCommand[] }> = [];
  for (const item of queued) {
    const last = groups.at(-1);
    if (
      last &&
      last.context.epoch === item.context.epoch &&
      last.context.workspaceId === item.context.workspaceId
    ) {
      last.commands.push(item.command);
    } else {
      groups.push({ context: item.context, commands: [item.command] });
    }
  }
  return groups;
}

function groupFramesByContext(
  queued: readonly PendingFrame[],
): Array<{ context: SaveContext; frames: PendingFrame[] }> {
  const groups: Array<{ context: SaveContext; frames: PendingFrame[] }> = [];
  for (const item of queued) {
    const last = groups.at(-1);
    if (
      last &&
      last.context.epoch === item.context.epoch &&
      last.context.workspaceId === item.context.workspaceId
    ) {
      last.frames.push(item);
    } else {
      groups.push({ context: item.context, frames: [item] });
    }
  }
  return groups;
}

interface WorkspaceMutationLogicalWeight {
  readonly bytes: number;
  readonly frames: number;
  readonly singleLargeFrame: boolean;
}

/**
 * Mirror the native logical batch budget: raw bytes for capture mutations and
 * compact UTF-8 JSON for every structured mutation. A conservative maximum
 * sequence value makes the estimate safe for every coordinator epoch.
 */
function partitionWorkspaceMutationCommands(
  commands: readonly WorkspaceMutationCommand[],
): WorkspaceMutationCommand[][] | null {
  const batches: WorkspaceMutationCommand[][] = [];
  let batch: WorkspaceMutationCommand[] = [];
  let batchBytes = 0;
  let batchFrames = 0;
  const release = (): void => {
    if (batch.length === 0) return;
    batches.push(batch);
    batch = [];
    batchBytes = 0;
    batchFrames = 0;
  };

  for (const command of commands) {
    const weight = workspaceMutationLogicalWeight(command);
    if (!weight) return null;
    if (weight.singleLargeFrame) {
      release();
      batches.push([command]);
      continue;
    }
    if (
      weight.bytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES ||
      weight.frames > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_BATCH
    ) {
      return null;
    }
    if (
      batch.length > 0 &&
      (batch.length + 1 > IPC_LIMITS.MAX_WORKSPACE_MUTATIONS_PER_BATCH ||
        batchBytes + weight.bytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES ||
        batchFrames + weight.frames > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_BATCH)
    ) {
      release();
    }
    batch.push(command);
    batchBytes += weight.bytes;
    batchFrames += weight.frames;
  }
  release();
  return batches;
}

function workspaceMutationLogicalWeight(
  command: WorkspaceMutationCommand,
): WorkspaceMutationLogicalWeight | null {
  if (command.kind === 'append-frames' || command.kind === 'replace-capture') {
    const frames = command.payload.frames;
    if (!Array.isArray(frames)) return null;
    let bytes = 0;
    for (const frame of frames) {
      if (!Array.isArray(frame.data)) return null;
      bytes += frame.data.length;
      if (!Number.isSafeInteger(bytes)) return null;
    }
    const singleLargeFrame =
      frames.length === 1 &&
      bytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES &&
      bytes <= IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES;
    return { bytes, frames: frames.length, singleLargeFrame };
  }

  try {
    const { kind, ...fields } = command;
    const encoded = JSON.stringify({
      kind,
      sequence: Number.MAX_SAFE_INTEGER,
      ...fields,
    });
    if (encoded === undefined) return null;
    return {
      bytes: new TextEncoder().encode(encoded).byteLength,
      frames: 0,
      singleLargeFrame: false,
    };
  } catch {
    return null;
  }
}

function assertSameSessionSet(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length) throw new Error('workspace session header mismatch');
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    expectedSet.size !== expected.length ||
    actualSet.size !== actual.length ||
    expected.some((sessionId) => !actualSet.has(sessionId))
  ) {
    throw new Error('workspace session header mismatch');
  }
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

function freezeActive(active: ActiveWorkspaceViewModel): ActiveWorkspaceViewModel {
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

function completed<T>(value: T): WorkspaceActionOutcome<T> {
  return Object.freeze({ outcome: 'completed', value });
}

function failed(messageKey: string, code?: string): WorkspaceActionFailure {
  return Object.freeze({ outcome: 'failed', messageKey, ...(code ? { code } : {}) });
}

function staleOrCancelled(attempt: ActivationAttempt): WorkspaceApplicationOutcome {
  return attempt.cancelledByUser
    ? Object.freeze({ outcome: 'cancelled' })
    : Object.freeze({ outcome: 'stale' });
}

/** Stop awaiting renderer hydration as soon as ownership is revoked. The
 * underlying read-only page request may still settle later, but both branches
 * have handlers attached and it can no longer delay rollback or reach the
 * facade commit point. */
function raceActivationAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(activationAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(activationAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function activationAbortError(): Error {
  const error = new Error('workspace activation ownership revoked');
  error.name = 'AbortError';
  return error;
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
