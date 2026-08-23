export interface ActivationAttempt {
  readonly generation: number;
  readonly controller: AbortController;
  previousWorkspaceId: string | null;
  nativeActivationStarted: boolean;
  cancelledByUser: boolean;
  activatedWorkspaceId: string | null;
  phase:
    'queued' | 'draining' | 'activating' | 'hydrating' | 'committing' | 'rolling-back' | 'terminal';
}

export type ActivationPhase = ActivationAttempt['phase'];

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

/** Named activation state-machine owner used by the application façade. */
export class WorkspaceActivationEngine extends ActivationTracker {}
