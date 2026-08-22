import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionFailure,
  WorkspaceActionOutcome,
} from '@/features/workspace/types';
import type { WorkspaceApplicationOutcome } from '../types';
import type { ActivationAttempt, ActivationTracker } from './activation-coordinator';

/** Facade capabilities the activation rollback/recovery paths rely on. */
export interface ActivationRecoveryHost {
  /** Active native workspace while probing/reactivating the rollback target. */
  readonly activeWorkspaceId: string | null;
  openWorkspace(workspaceId: string): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>>;
  /** Restore staged runtimes after an aborted native activation. */
  restoreRuntimeAfterAbortedTransition(failedWorkspaceId: string | null): Promise<boolean>;
  /** Install the rollback view as the current workspace when the facade still
   * shows the previous workspace id. */
  adoptRollbackView(view: ActiveWorkspaceViewModel, previousWorkspaceId: string): void;
  /** Enter the permanent recovery lockout; the latest attempt is dropped when
   * it is the failed owner. */
  enterRecoveryLockout(latestIsOwner: boolean): void;
  finishActivationFailure(attempt: ActivationAttempt, failure: WorkspaceActionFailure): void;
  finishAbortedQueuedAttempt(attempt: ActivationAttempt): void;
}

/**
 * The attempt that crossed native activation remains the sole rollback owner,
 * even after a newer request has become the UI-visible latest request. The
 * activation tail does not release its successor until this method reaches a
 * terminal native/runtime state.
 */
export async function recoverActivationOwner(
  attempt: ActivationAttempt,
  host: ActivationRecoveryHost,
): Promise<boolean> {
  attempt.phase = 'rolling-back';
  const previousWorkspaceId = attempt.previousWorkspaceId;
  let rollbackView: ActiveWorkspaceViewModel | null = null;
  if (!previousWorkspaceId) {
    // With no installed facade there are no renderer writes to protect. A
    // failed first hydration may leave a native project selected, but must
    // remain retryable instead of permanently locking this process.
    return host.restoreRuntimeAfterAbortedTransition(attempt.activatedWorkspaceId);
  }
  if (attempt.nativeActivationStarted || host.activeWorkspaceId !== previousWorkspaceId) {
    // Once an invoke has started, renderer cancellation cannot prove that
    // native activation did not commit. Re-open the prior project
    // unconditionally; consulting the stale coordinator cache is unsafe.
    let rollback: WorkspaceActionOutcome<ActiveWorkspaceViewModel>;
    try {
      rollback = await host.openWorkspace(previousWorkspaceId);
    } catch {
      return false;
    }
    if (
      rollback.outcome !== 'completed' ||
      rollback.value.workspaceId !== previousWorkspaceId ||
      host.activeWorkspaceId !== previousWorkspaceId
    ) {
      return false;
    }
    rollbackView = rollback.value;
  }
  const restored = await host.restoreRuntimeAfterAbortedTransition(attempt.activatedWorkspaceId);
  if (!restored) return false;
  if (rollbackView) host.adoptRollbackView(rollbackView, previousWorkspaceId);
  return true;
}

/** Recover an aborted/superseded attempt and report its terminal outcome. */
export async function abortAndRecoverActivation(
  attempt: ActivationAttempt,
  tracker: ActivationTracker,
  host: ActivationRecoveryHost,
): Promise<WorkspaceApplicationOutcome> {
  const recovered = await recoverActivationOwner(attempt, host);
  attempt.phase = 'terminal';
  if (!recovered) {
    markRecoveryRequired(attempt, tracker, host);
    return failed('workspace.activation.rollback_failed');
  }
  host.finishAbortedQueuedAttempt(attempt);
  return staleOrCancelled(attempt);
}

/**
 * Latch the permanent recovery lockout: no renderer writes are allowed until
 * the process restarts, and any queued successor that has not reached its
 * commit point is aborted.
 */
export function markRecoveryRequired(
  owner: ActivationAttempt,
  tracker: ActivationTracker,
  host: ActivationRecoveryHost,
): void {
  const latest = tracker.attempt;
  if (latest && latest !== owner && latest.phase !== 'committing') {
    latest.controller.abort();
  }
  host.enterRecoveryLockout(latest === owner);
}

export function staleOrCancelled(attempt: ActivationAttempt): WorkspaceApplicationOutcome {
  return attempt.cancelledByUser
    ? Object.freeze({ outcome: 'cancelled' })
    : Object.freeze({ outcome: 'stale' });
}

function failed(messageKey: string): WorkspaceActionFailure {
  return Object.freeze({ outcome: 'failed', messageKey });
}


export async function rollbackFailedActivation(
  attempt: ActivationAttempt,
  failure: WorkspaceActionFailure,
  tracker: ActivationTracker,
  host: ActivationRecoveryHost,
  isLatest: (attempt: ActivationAttempt) => boolean,
  onRecoveryRequired: () => void,
  onFinishFailure: (attempt: ActivationAttempt, failure: WorkspaceActionFailure) => void,
): Promise<'recovered' | 'failed' | 'stale'> {
  const recovered = await recoverActivationOwner(attempt, host);
  attempt.phase = 'terminal';
  if (!recovered) {
    markRecoveryRequired(attempt, tracker, host);
    onRecoveryRequired();
    return 'failed';
  }
  if (!isLatest(attempt)) return 'stale';
  onFinishFailure(attempt, failure);
  return 'recovered';
}
