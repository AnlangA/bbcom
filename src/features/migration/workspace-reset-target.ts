import type { WorkspaceApplicationActivation } from '../workspace';
import type { LegacyReadContext, WorkspaceResetTarget } from './types';

/** Opens and verifies the fixed workspace already committed by native reset. */
export class WorkspaceApplicationResetTarget implements WorkspaceResetTarget {
  constructor(private readonly application: WorkspaceApplicationActivation) {}

  async activateEmptyV1(
    workspaceId: string,
    expectedRevision: number,
    context: LegacyReadContext,
  ): Promise<void> {
    const active = await this.open(workspaceId, context);
    if (
      active.revision !== expectedRevision ||
      active.sessionIds.length !== 0 ||
      active.activeSessionId !== null
    ) {
      throw new Error('reset target is not an empty workspace');
    }
  }

  async activateCompletedV1(workspaceId: string, context: LegacyReadContext): Promise<void> {
    const restore = this.application.restoreLastActiveWorkspace;
    if (!restore) {
      await this.open(workspaceId, context);
      return;
    }
    const active = await this.activate(
      () => restore.call(this.application, workspaceId, context.signal),
      'last active workspace activation failed',
      context,
    );
    if (!active) throw new Error('last active workspace is missing');
    // Mirror open(): recovery must land on the workspace the reset journal
    // committed, never release the gate against different data.
    if (active.workspaceId !== workspaceId) {
      throw new Error('restored workspace mismatch');
    }
  }

  private async open(workspaceId: string, context: LegacyReadContext) {
    const active = await this.activate(
      () => this.application.openWorkspace(workspaceId),
      'empty workspace activation failed',
      context,
    );
    if (!active || active.workspaceId !== workspaceId) throw new Error('reset workspace mismatch');
    return active;
  }

  private async activate(
    activate: () => ReturnType<WorkspaceApplicationActivation['openWorkspace']>,
    failureMessage: string,
    context: LegacyReadContext,
  ) {
    throwIfAborted(context.signal);
    let cancellationAccepted = false;
    const cancelActivation = (): void => {
      cancellationAccepted = this.application.cancelActivation() || cancellationAccepted;
    };
    context.signal.addEventListener('abort', cancelActivation, { once: true });
    try {
      const outcome = await activate();
      if (outcome.outcome === 'cancelled' || cancellationAccepted) throw abortError();
      if (outcome.outcome !== 'completed') throw new Error(failureMessage);
      // An abort rejected after the application crossed its synchronous commit
      // point cannot undo the activated workspace and must not falsify success.
      return outcome.value.currentWorkspace;
    } finally {
      context.signal.removeEventListener('abort', cancelActivation);
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('workspace reset aborted');
  error.name = 'AbortError';
  return error;
}
