import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionFailure,
  WorkspaceActionOutcome,
} from '@/features/workspace/types';
import type { WorkspaceCoordinator } from '../../workspace-coordinator';
import type {
  WorkspaceApplicationOutcome,
  WorkspaceApplicationViewModel,
  WorkspaceConfigMutationCommand,
  WorkspaceFrameCapture,
  WorkspaceRuntimeLifecycle,
  WorkspaceRuntimePersistenceDrain,
  WorkspaceSaveOutcome,
  WorkspaceSessionFacade,
  WorkspaceWaveformFrameIngest,
  WorkspaceFacadeSnapshot,
} from '../types';
import type { WorkspaceWaveformChannel, WorkspaceWaveformSample } from '../../../../generated/ipc-contracts';
import type { WorkspaceSaveCoordinator } from '../workspace-save-coordinator';
import type { SaveContext } from '../save-queues/index';
import {
  abortAndRecoverActivation,
  markRecoveryRequired,
  type ActivationRecoveryHost,
} from './recovery-handler';
import {
  type ActivationAttempt,
  type ActivationPhase,
  ActivationTracker,
  WorkspaceActivationEngine,
} from './activation-types';

export type { ActivationAttempt, ActivationPhase, WorkspaceActivationEngine } from './activation-types';
export { ActivationTracker } from './activation-types';

export interface RuntimeTransition {
  readonly id: string;
  readonly previousWorkspaceId: string | null;
  quiesceStarted: boolean;
  quiesceFailure: WorkspaceActionFailure | null;
  disposeStarted: boolean;
  disposeCompleted: boolean;
  stoppedWorkspaceId: string | null;
}

/**
 * Serialized activation ownership: the generation counter, the latest
 * attempt, and the activation tail that hands execution from one attempt to
 * the next only after its predecessor reached a terminal native/runtime
 * state.
 */
export class ActivationTracker {
  private generationCounter = 0;
  /** Latest activation request (the only one allowed to commit). */
  attempt: ActivationAttempt | null = null;
  /** Serialized hand-off chain behind every queued activation. */
  tail: Promise<void> = Promise.resolve();

  get generation(): number {
    return this.generationCounter;
  }

  nextGeneration(): number {
    this.generationCounter += 1;
    return this.generationCounter;
  }

  /** True while the attempt may still commit: not aborted, not rolling back,
   * and not terminal. */
  isActive(attempt: ActivationAttempt): boolean {
    return (
      !attempt.controller.signal.aborted &&
      attempt.phase !== 'rolling-back' &&
      attempt.phase !== 'terminal'
    );
  }

  isLatest(attempt: ActivationAttempt): boolean {
    return this.attempt === attempt && attempt.generation === this.generationCounter;
  }
}

/**
 * Named activation state-machine owner used by the application façade.
 * Native activation, hydration and participant callbacks remain injected
 * effects; their serialization/generation authority lives in this engine.
 */
export class WorkspaceActivationEngine extends ActivationTracker {}



export interface ActivationHydrationPort {
  hydrateAfterNativeActivation(
    attempt: ActivationAttempt,
    header: ActiveWorkspaceViewModel,
  ): Promise<WorkspaceApplicationOutcome>;
}

export interface ActivationCoordinatorDeps {
  readonly coordinator: WorkspaceCoordinator;
  readonly sessionFacade: WorkspaceSessionFacade;
  readonly saves: WorkspaceSaveCoordinator;
  readonly hydration: ActivationHydrationPort;
  readonly runtimeLifecycle: WorkspaceRuntimeLifecycle;
  readonly activations: WorkspaceActivationEngine;
  getRecoveryHost(): ActivationRecoveryHost;
  snapshot(): WorkspaceApplicationViewModel;
  notify(): void;
  syncCurrentFromCoordinator(): void;
  applySaveOutcome(outcome: WorkspaceSaveOutcome): void;
  clearUndoCaptureState(): void;
  createRuntimePersistenceDrain(transition: RuntimeTransition): WorkspaceRuntimePersistenceDrain;
  internalSaveContext(transition: RuntimeTransition): SaveContext | null;
  enqueueConfigMutations(context: SaveContext, commands: readonly Readonly<WorkspaceConfigMutationCommand>[]): import('../types').WorkspaceQueueOutcome;
  enqueueOrderedMutations(context: SaveContext, commands: readonly Readonly<WorkspaceConfigMutationCommand>[]): import('../types').WorkspaceQueueOutcome;
  enqueueCapturedFrame(context: SaveContext, capture: WorkspaceFrameCapture): import('../types').WorkspaceQueueOutcome;
  enqueueCaptureTrim(context: SaveContext, sessionId: string, droppedFrames: number, droppedBytes: number): import('../types').WorkspaceQueueOutcome;
  enqueueWaveformReplacement(context: SaveContext, sessionId: string, channels: readonly WorkspaceWaveformChannel[], samples: readonly WorkspaceWaveformSample[]): import('../types').WorkspaceQueueOutcome;
  enqueueWaveformSamples(context: SaveContext, sessionId: string, samples: readonly WorkspaceWaveformSample[]): import('../types').WorkspaceQueueOutcome;
  enqueueWaveformFrameIngest(context: SaveContext, ingest: Readonly<WorkspaceWaveformFrameIngest>): import('../types').WorkspaceQueueOutcome;
}

export interface ActivationState {
  current: ActiveWorkspaceViewModel | null;
  recoveryRequired: boolean;
  switching: boolean;
  hydrating: boolean;
  applicationStatus: import('../types').WorkspaceApplicationStatus;
  applicationMessageKey: string | null;
  runtimeTransition: RuntimeTransition | null;
  internalDrainTransition: RuntimeTransition | null;
  runtimeLifecycleTail: Promise<void>;
  switchDrain: Promise<WorkspaceActionFailure | null> | null;
}

export class WorkspaceActivationCoordinator {
  constructor(
    private readonly deps: ActivationCoordinatorDeps,
    private readonly state: ActivationState,
  ) {}

  cancelActivation(): boolean {
    const attempt = this.deps.activations.attempt;
    if (!attempt) return this.deps.coordinator.cancelActivation();
    if (attempt.phase === 'committing' || attempt.phase === 'terminal') return false;
    attempt.cancelledByUser = true;
    attempt.controller.abort();
    if (attempt.phase === 'activating') this.deps.coordinator.cancelActivation();
    this.state.switching = true;
    this.state.hydrating = false;
    this.state.applicationStatus = 'loading';
    this.state.applicationMessageKey = null;
    this.deps.notify();
    return true;
  }

  deleteCurrentWorkspace(workspaceId: string): Promise<WorkspaceApplicationOutcome> {
    const predecessor = this.deps.activations.attempt;
    if (predecessor && predecessor.phase !== 'committing' && predecessor.phase !== 'terminal') {
      predecessor.controller.abort();
      if (predecessor.phase === 'activating') this.deps.coordinator.cancelActivation();
    }
    const attempt: ActivationAttempt = {
      generation: this.deps.activations.nextGeneration(),
      controller: new AbortController(),
      previousWorkspaceId: null,
      nativeActivationStarted: false,
      cancelledByUser: false,
      activatedWorkspaceId: null,
      phase: 'queued',
    };
    this.deps.activations.attempt = attempt;
    this.state.switching = true;
    this.state.hydrating = false;
    this.state.applicationStatus = 'loading';
    this.state.applicationMessageKey = null;
    this.deps.notify();
    const execution = this.deps.activations.tail.then(
      () => this.performCurrentDeletion(attempt, workspaceId),
      () => this.performCurrentDeletion(attempt, workspaceId),
    );
    this.deps.activations.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  activate(invoke: () => Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>>): Promise<WorkspaceApplicationOutcome> {
    const predecessor = this.deps.activations.attempt;
    if (predecessor && predecessor.phase !== 'committing' && predecessor.phase !== 'terminal') {
      predecessor.controller.abort();
      if (predecessor.phase === 'activating') this.deps.coordinator.cancelActivation();
    }
    const attempt: ActivationAttempt = {
      generation: this.deps.activations.nextGeneration(),
      controller: new AbortController(),
      // The predecessor may still commit before this queued attempt starts.
      // Capture the rollback target only after the serialized hand-off.
      previousWorkspaceId: null,
      nativeActivationStarted: false,
      cancelledByUser: false,
      activatedWorkspaceId: null,
      phase: 'queued',
    };
    this.deps.activations.attempt = attempt;
    this.state.switching = true;
    this.state.hydrating = false;
    this.state.applicationStatus = 'loading';
    this.state.applicationMessageKey = null;
    this.deps.notify();

    const execution = this.deps.activations.tail.then(
      () => this.performActivation(attempt, invoke),
      () => this.performActivation(attempt, invoke),
    );
    this.deps.activations.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  async performActivation(
    attempt: ActivationAttempt,
    invoke: () => Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>>,
  ): Promise<WorkspaceApplicationOutcome> {
    if (this.state.recoveryRequired) {
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

    attempt.previousWorkspaceId = this.state.current?.workspaceId ?? null;
    this.ensureRuntimeTransition(attempt.previousWorkspaceId);
    attempt.phase = 'draining';

    const drainFailure = await this.drainBeforeActivation();
    if (!this.deps.activations.isActive(attempt))
      return abortAndRecoverActivation(attempt, this.deps.activations, this.deps.getRecoveryHost());
    if (drainFailure) {
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      if (!this.deps.activations.isActive(attempt))
        return abortAndRecoverActivation(attempt, this.deps.activations, this.deps.getRecoveryHost());
      const failure = restored ? drainFailure : failed('workspace.activation.rollback_failed');
      if (!restored) markRecoveryRequired(attempt, this.deps.activations, this.deps.getRecoveryHost());
      this.finishActivationFailure(attempt, failure);
      return failure;
    }

    let activation: WorkspaceActionOutcome<ActiveWorkspaceViewModel>;
    attempt.phase = 'activating';
    attempt.nativeActivationStarted = true;
    try {
      activation = await invoke();
    } catch {
      if (!this.deps.activations.isActive(attempt))
        return abortAndRecoverActivation(attempt, this.deps.activations, this.deps.getRecoveryHost());
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      const failure = restored
        ? failed('workspace.activation.failed')
        : failed('workspace.activation.rollback_failed');
      if (!restored) markRecoveryRequired(attempt, this.deps.activations, this.deps.getRecoveryHost());
      this.finishActivationFailure(attempt, failure);
      return failure;
    }
    if (activation.outcome === 'completed') {
      attempt.activatedWorkspaceId = activation.value.workspaceId;
    }
    if (!this.deps.activations.isActive(attempt))
      return abortAndRecoverActivation(attempt, this.deps.activations, this.deps.getRecoveryHost());
    if (activation.outcome !== 'completed') {
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      if (!restored) {
        const failure = failed('workspace.activation.rollback_failed');
        markRecoveryRequired(attempt, this.deps.activations, this.deps.getRecoveryHost());
        this.finishActivationFailure(attempt, failure);
        return failure;
      }
      this.finishActivationOutcome(attempt, activation);
      return activation;
    }

    return this.deps.hydration.hydrateAfterNativeActivation(attempt, activation.value);
  }

  async performCurrentDeletion(
    attempt: ActivationAttempt,
    workspaceId: string,
  ): Promise<WorkspaceApplicationOutcome> {
    const isCurrent =
      this.state.current?.workspaceId === workspaceId ||
      this.deps.coordinator.activeWorkspaceId === workspaceId;
    if (!isCurrent) {
      const failure = failed('workspace.delete.failed');
      this.finishActivationFailure(attempt, failure);
      return failure;
    }
    // recoveryRequired must not trap the last project: deletion is the escape
    // hatch from a failed activation lockout.
    attempt.previousWorkspaceId = workspaceId;

    // A stale transition from a failed open/switch (often previousWorkspaceId
    // null) would throw inside ensureRuntimeTransition and leave the project
    // undeletable. Clear it before starting the deletion transition.
    if (this.state.runtimeTransition && this.state.runtimeTransition.previousWorkspaceId !== workspaceId) {
      const cleared = await this.restoreRuntimeAfterAbortedTransition(
        this.state.runtimeTransition.stoppedWorkspaceId,
      );
      if (!cleared || this.state.runtimeTransition) {
        this.state.runtimeTransition = null;
        this.state.internalDrainTransition = null;
      }
    }

    const transition = this.ensureRuntimeTransition(workspaceId);
    attempt.phase = 'draining';
    // Best-effort drain: a broken project should still be removable even when
    // flush/quiesce cannot complete cleanly.
    await this.drainBeforeActivation();
    if (!this.deps.activations.isActive(attempt)) {
      return abortAndRecoverActivation(attempt, this.deps.activations, this.deps.getRecoveryHost());
    }

    attempt.phase = 'activating';
    try {
      const disposal = this.state.runtimeLifecycleTail.then(async () => {
        this.assertAttemptOwnsRuntimeTransition(attempt, transition);
        transition.disposeStarted = true;
        await this.deps.runtimeLifecycle.dispose({
          transitionId: transition.id,
          previousWorkspaceId: workspaceId,
          nextWorkspaceId: null,
        });
        transition.disposeCompleted = true;
      });
      this.state.runtimeLifecycleTail = disposal.then(
        () => undefined,
        () => undefined,
      );
      await disposal;
    } catch {
      // Continue: native delete + idle clear matter more than a clean runtime
      // teardown when the user is removing a stuck or partially hydrated project.
      transition.disposeStarted = true;
    }

    const deletion = await this.deps.coordinator.deleteWorkspace(workspaceId);
    if (deletion.outcome !== 'completed') {
      const restored = await this.restoreRuntimeAfterAbortedTransition(null);
      if (!restored) {
        const failure = failed('workspace.activation.rollback_failed');
        markRecoveryRequired(attempt, this.deps.activations, this.deps.getRecoveryHost());
        this.finishActivationFailure(attempt, failure);
        return failure;
      }
      this.finishActivationOutcome(attempt, deletion);
      return deletion;
    }

    attempt.phase = 'committing';
    this.deps.sessionFacade.clearWorkspace();
    this.state.current = null;
    this.deps.saves.openEpoch();
    this.deps.saves.captureAccounting.replaceWorkspace([]);
    this.deps.clearUndoCaptureState();
    this.state.recoveryRequired = false;
    this.deps.saves.lastSaveFailure = null;
    try {
      this.deps.runtimeLifecycle.commit?.({ transitionId: transition.id, workspaceId });
    } catch {
      // Commit only drops rollback snapshots; the project is already deleted.
    }
    if (this.state.runtimeTransition === transition) this.state.runtimeTransition = null;
    if (this.state.internalDrainTransition === transition) this.state.internalDrainTransition = null;
    attempt.phase = 'terminal';
    if (this.deps.activations.attempt === attempt) this.deps.activations.attempt = null;
    this.state.switching = false;
    this.state.hydrating = false;
    this.state.applicationStatus = 'idle';
    this.state.applicationMessageKey = null;
    this.deps.notify();
    return completed(this.deps.snapshot());
  }

  ensureRuntimeTransition(previousWorkspaceId: string | null): RuntimeTransition {
    const existing = this.state.runtimeTransition;
    if (existing) {
      if (existing.previousWorkspaceId !== previousWorkspaceId) {
        throw new Error('workspace runtime transition owner changed before completion');
      }
      return existing;
    }
    const transition: RuntimeTransition = {
      id: `workspace-transition-${this.deps.activations.generation}`,
      previousWorkspaceId,
      quiesceStarted: false,
      quiesceFailure: null,
      disposeStarted: false,
      disposeCompleted: false,
      stoppedWorkspaceId: null,
    };
    this.state.runtimeTransition = transition;
    return transition;
  }

  async prepareRuntimeFacadeSwap(
    attempt: ActivationAttempt,
    workspace: WorkspaceFacadeSnapshot,
  ): Promise<void> {
    const transition = this.ensureRuntimeTransition(attempt.previousWorkspaceId);
    const stage = this.state.runtimeLifecycleTail.then(async () => {
      this.assertAttemptOwnsRuntimeTransition(attempt, transition);
      if (transition.previousWorkspaceId && !transition.disposeCompleted) {
        transition.disposeStarted = true;
        await this.deps.runtimeLifecycle.dispose({
          transitionId: transition.id,
          previousWorkspaceId: transition.previousWorkspaceId,
          nextWorkspaceId: workspace.workspaceId,
        });
        transition.disposeCompleted = true;
      }
      this.assertAttemptOwnsRuntimeTransition(attempt, transition);
      transition.stoppedWorkspaceId = workspace.workspaceId;
      await this.deps.runtimeLifecycle.activateStopped({ transitionId: transition.id, workspace });
      this.assertAttemptOwnsRuntimeTransition(attempt, transition);
    });
    this.state.runtimeLifecycleTail = stage.then(
      () => undefined,
      () => undefined,
    );
    await stage;
  }

  assertAttemptOwnsRuntimeTransition(
    attempt: ActivationAttempt,
    transition: RuntimeTransition,
  ): void {
    if (!this.deps.activations.isActive(attempt) || this.state.runtimeTransition !== transition) {
      const error = new Error('stale workspace runtime transition');
      error.name = 'AbortError';
      throw error;
    }
  }

  async restoreRuntimeAfterAbortedTransition(
    failedWorkspaceId: string | null,
  ): Promise<boolean> {
    const transition = this.state.runtimeTransition;
    if (!transition) return true;
    const lifecycleWasTouched =
      transition.quiesceStarted ||
      transition.disposeStarted ||
      transition.stoppedWorkspaceId !== null;
    const restore = this.state.runtimeLifecycleTail.then(async () => {
      if (!lifecycleWasTouched) return;
      await this.deps.runtimeLifecycle.restore({
        transitionId: transition.id,
        previousWorkspaceId: transition.previousWorkspaceId,
        failedWorkspaceId,
      });
    });
    this.state.runtimeLifecycleTail = restore.then(
      () => undefined,
      () => undefined,
    );
    try {
      await restore;
    } catch {
      return false;
    }
    if (this.state.runtimeTransition === transition) this.state.runtimeTransition = null;
    if (this.state.internalDrainTransition === transition) this.state.internalDrainTransition = null;
    return true;
  }

  finishAbortedQueuedAttempt(attempt: ActivationAttempt): void {
    if (!this.deps.activations.isLatest(attempt)) return;
    this.deps.activations.attempt = null;
    this.state.switching = false;
    this.state.hydrating = false;
    this.state.applicationStatus = this.state.current ? 'ready' : 'idle';
    this.state.applicationMessageKey = null;
    this.deps.notify();
  }

  enterRecoveryLockout(latestIsOwner: boolean): void {
    this.state.recoveryRequired = true;
    this.state.switching = false;
    this.state.hydrating = false;
    this.state.applicationStatus = 'failed';
    this.state.applicationMessageKey = 'workspace.activation.rollback_failed';
    if (latestIsOwner) this.deps.activations.attempt = null;
    this.deps.notify();
  }

  finishActivationOutcome(
    attempt: ActivationAttempt,
    outcome: Exclude<WorkspaceActionOutcome<ActiveWorkspaceViewModel>, { outcome: 'completed' }>,
  ): void {
    attempt.phase = 'terminal';
    if (!this.deps.activations.isLatest(attempt)) return;
    if (outcome.outcome === 'failed') {
      this.finishActivationFailure(attempt, outcome);
      return;
    }
    this.state.switching = false;
    this.state.hydrating = false;
    this.state.applicationStatus = this.state.current ? 'ready' : 'idle';
    this.state.applicationMessageKey = null;
    if (this.deps.activations.attempt === attempt) this.deps.activations.attempt = null;
    this.deps.notify();
  }

  finishActivationFailure(
    attempt: ActivationAttempt,
    failure: WorkspaceActionFailure,
  ): void {
    attempt.phase = 'terminal';
    if (!this.deps.activations.isLatest(attempt)) return;
    this.state.switching = false;
    this.state.hydrating = false;
    this.state.applicationStatus =
      this.state.current && this.deps.coordinator.activeWorkspaceId === this.state.current.workspaceId
        ? 'ready'
        : 'failed';
    this.state.applicationMessageKey = failure.messageKey;
    if (failure.messageKey === 'workspace.activation.rollback_failed') {
      this.state.recoveryRequired = true;
    }
    if (this.deps.activations.attempt === attempt) this.deps.activations.attempt = null;
    this.deps.notify();
  }

  drainBeforeActivation(): Promise<WorkspaceActionFailure | null> {
    if (this.state.switchDrain) return this.state.switchDrain;
    const drain = this.performActivationDrain();
    this.state.switchDrain = drain;
    const clear = (): void => {
      if (this.state.switchDrain === drain) this.state.switchDrain = null;
    };
    void drain.then(clear, clear);
    return drain;
  }

  async performActivationDrain(): Promise<WorkspaceActionFailure | null> {
    const transition = this.state.runtimeTransition;
    let quiesceFailure = transition?.quiesceFailure ?? null;
    if (transition?.previousWorkspaceId && !transition.quiesceStarted) {
      transition.quiesceStarted = true;
      this.state.internalDrainTransition = transition;
      try {
        await this.deps.runtimeLifecycle.quiesce({
          transitionId: transition.id,
          previousWorkspaceId: transition.previousWorkspaceId,
          persistence: this.deps.createRuntimePersistenceDrain(transition),
        });
      } catch {
        quiesceFailure = failed('workspace.runtime.quiesce_failed');
        transition.quiesceFailure = quiesceFailure;
      } finally {
        if (this.state.internalDrainTransition === transition) this.state.internalDrainTransition = null;
      }
    }
    // The internal persistence capability is closed before the queues are
    // released. No producer can add old-workspace events behind this barrier.
    this.deps.saves.queues.releaseAll();
    const barrier = this.deps.saves.saveTail;
    await barrier;
    if (this.deps.saves.lastSaveFailure) return this.deps.saves.lastSaveFailure;
    const current = this.state.current;
    if (!current || this.deps.coordinator.activeWorkspaceId !== current.workspaceId) {
      return quiesceFailure;
    }
    const outcome = await this.deps.coordinator.flush();
    this.deps.applySaveOutcome(outcome);
    const saveFailure =
      outcome.outcome === 'failed'
        ? outcome
        : outcome.outcome === 'completed'
          ? null
          : failed('workspace.save.interrupted');
    return saveFailure ?? quiesceFailure;
  }
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

export { abortAndRecoverActivation, markRecoveryRequired } from './recovery-handler';
export type { ActivationRecoveryHost } from './recovery-handler';
