import type { ActiveWorkspaceViewModel, WorkspaceActionFailure } from '@/features/workspace/types';
import {
  stageWorkspaceHydration,
  type WorkspaceHydrationPort,
  type WorkspaceHydrationStaging,
} from '../../adapters';
import {
  abortableWorkspaceHydrationPort,
  isWorkspaceHydrationAbort,
  observeWorkspaceFrameSequences,
} from '../abortable-hydration-port';
import type { WorkspaceCoordinator } from '../../workspace-coordinator';
import type { WorkspaceSessionFacade } from '../types';
import type { WorkspaceSaveCoordinator } from '../workspace-save-coordinator';
import type { WorkspaceRuntimeLifecycle } from '../types';
import {
  abortAndRecoverActivation,
  rollbackFailedActivation,
  type ActivationAttempt,
  type ActivationRecoveryHost,
  type RuntimeTransition,
  type WorkspaceActivationEngine,
} from '../activation';
import {
  assertCurrentHydration,
  createFacadeSnapshot,
  freezeActive,
} from './staging-adapter';

export interface HydrationActivationPort {
  prepareRuntimeFacadeSwap(
    attempt: ActivationAttempt,
    workspace: import('../types').WorkspaceFacadeSnapshot,
  ): Promise<void>;
  finishActivationFailure(attempt: ActivationAttempt, failure: WorkspaceActionFailure): void;
}

export interface HydrationPipelineDeps {
  readonly coordinator: WorkspaceCoordinator;
  readonly hydrationPort: WorkspaceHydrationPort;
  readonly sessionFacade: WorkspaceSessionFacade;
  readonly saves: WorkspaceSaveCoordinator;
  readonly runtimeLifecycle: WorkspaceRuntimeLifecycle;
  readonly activations: WorkspaceActivationEngine;
  readonly activationCoordinator: HydrationActivationPort;
  readonly requestId: () => string;
  getRecoveryHost(): ActivationRecoveryHost;
  notify(): void;
  snapshot(): import('../types').WorkspaceApplicationViewModel;
  getState(): {
    current: ActiveWorkspaceViewModel | null;
    recoveryRequired: boolean;
    switching: boolean;
    hydrating: boolean;
    applicationStatus: import('../types').WorkspaceApplicationStatus;
    applicationMessageKey: string | null;
    runtimeTransition: RuntimeTransition | null;
    internalDrainTransition: RuntimeTransition | null;
  };
}

export class WorkspaceHydrationPipeline {
  constructor(private readonly deps: HydrationPipelineDeps) {}

  async hydrateAfterNativeActivation(
    attempt: ActivationAttempt,
    header: ActiveWorkspaceViewModel,
  ): Promise<import('../types').WorkspaceApplicationOutcome> {
    const state = this.deps.getState();
    attempt.phase = 'hydrating';
    state.hydrating = true;
    this.deps.notify();
    try {
      const frameNextSequences = new Map<string, number>();
      const cancellablePort = abortableWorkspaceHydrationPort(
        this.deps.hydrationPort,
        attempt.controller.signal,
      );
      const staging = await raceActivationAbort(
        stageWorkspaceHydration({
          port: observeWorkspaceFrameSequences(cancellablePort, frameNextSequences),
          workspaceId: header.workspaceId,
          revision: header.revision,
          ...(header.activeSessionId ? { activeSessionId: header.activeSessionId } : {}),
          requestId: this.deps.requestId,
          sessionPageSize: 64,
          framePageSize: 256,
          aiPageSize: 256,
          waveformPageSize: 2_048,
          concurrency: 3,
        }),
        attempt.controller.signal,
      );
      assertCurrentHydration(this.deps.coordinator, this.deps.activations, attempt, header, staging);
      const facadeSnapshot = createFacadeSnapshot(header, staging);
      await this.deps.activationCoordinator.prepareRuntimeFacadeSwap(attempt, facadeSnapshot);
      assertCurrentHydration(this.deps.coordinator, this.deps.activations, attempt, header, staging);
      attempt.phase = 'committing';
      this.deps.sessionFacade.replaceWorkspace(facadeSnapshot);
      this.installHydratedWorkspace(attempt, header, staging, frameNextSequences);
      return completed(this.deps.snapshot());
    } catch (error) {
      if (!this.deps.activations.isActive(attempt) || isWorkspaceHydrationAbort(error)) {
        return abortAndRecoverActivation(attempt, this.deps.activations, this.deps.getRecoveryHost());
      }
      const failure = failed('workspace.hydration.failed');
      const rollback = await rollbackFailedActivation(
        attempt,
        failure,
        this.deps.activations,
        this.deps.getRecoveryHost(),
        (a) => this.deps.activations.isLatest(a),
        () => {
          state.recoveryRequired = true;
        },
        (a, f) => this.deps.activationCoordinator.finishActivationFailure(a, f),
      );
      if (state.recoveryRequired) return failed('workspace.activation.rollback_failed');
      if (rollback === 'stale') return staleOrCancelled(attempt);
      return failure;
    }
  }

  private installHydratedWorkspace(
    attempt: ActivationAttempt,
    header: ActiveWorkspaceViewModel,
    staging: WorkspaceHydrationStaging,
    frameNextSequences: ReadonlyMap<string, number>,
  ): void {
    const state = this.deps.getState();
    const transition = state.runtimeTransition;
    state.current = freezeActive(header);
    this.deps.saves.openEpoch();
    this.deps.saves.captureAccounting.replaceWorkspace(
      staging.sessions.map((entry) => ({
        sessionId: entry.session.id,
        nextSequence: frameNextSequences.get(entry.session.id) ?? 0,
        frameCount: entry.session.frames.length,
        captureBytes: entry.session.frames.reduce(
          (total, frame) => total + frame.data.byteLength,
          0,
        ),
      })),
    );
    state.recoveryRequired = false;
    state.hydrating = false;
    attempt.phase = 'terminal';
    if (transition && transition.stoppedWorkspaceId === header.workspaceId) {
      try {
        this.deps.runtimeLifecycle.commit?.({
          transitionId: transition.id,
          workspaceId: header.workspaceId,
        });
      } catch {
        // Commit is rollback-snapshot cleanup only.
      }
      state.runtimeTransition = null;
      if (state.internalDrainTransition === transition) state.internalDrainTransition = null;
    }
    if (this.deps.activations.attempt === attempt) {
      this.deps.activations.attempt = null;
      state.applicationStatus = 'ready';
      state.applicationMessageKey = null;
      state.switching = false;
    } else {
      state.applicationStatus = 'loading';
      state.applicationMessageKey = null;
      state.switching = true;
    }
    this.deps.notify();
  }
}

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

function completed<T>(value: T): import('@/features/workspace/types').WorkspaceActionOutcome<T> {
  return Object.freeze({ outcome: 'completed', value });
}

function failed(messageKey: string): WorkspaceActionFailure {
  return Object.freeze({ outcome: 'failed', messageKey });
}

function staleOrCancelled(
  attempt: ActivationAttempt,
): import('../types').WorkspaceApplicationOutcome {
  return attempt.cancelledByUser
    ? Object.freeze({ outcome: 'cancelled' })
    : Object.freeze({ outcome: 'stale' });
}
