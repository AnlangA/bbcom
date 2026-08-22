import type { WorkspaceSaveCoordinator } from '../workspace-save-coordinator';
import type { WorkspaceCoordinator } from '../../workspace-coordinator';
import type { WorkspaceProjectExportOutcome, WorkspaceSaveOutcome } from '../types';
import type { SaveContext } from '../save-queues/index';

export interface ExportRouterState {
  exportAttempt: {
    readonly id: number;
    cancelled: boolean;
    nativeStarted: boolean;
    result: Promise<WorkspaceProjectExportOutcome> | null;
  } | null;
  exportGeneration: number;
}

export interface ExportCommandRouterDeps {
  readonly coordinator: WorkspaceCoordinator;
  readonly saves: WorkspaceSaveCoordinator;
  readonly state: ExportRouterState;
  acceptingSaveContext(): SaveContext | null;
  isCurrentSaveContext(context: SaveContext): boolean;
  queueRejectionMessage(): string;
  syncCurrentFromCoordinator(): void;
  applySaveOutcome(outcome: WorkspaceSaveOutcome): void;
  notify(): void;
}

export class ExportCommandRouter {
  constructor(private readonly deps: ExportCommandRouterDeps) {}

  exportWorkspace(suggestedName: string): Promise<WorkspaceProjectExportOutcome> {
    if (this.deps.state.exportAttempt) return Promise.resolve(failed('workspace.export.in_progress'));
    const context = this.deps.acceptingSaveContext();
    if (!context) return Promise.resolve(failed(this.deps.queueRejectionMessage()));
    const attempt = {
      id: ++this.deps.state.exportGeneration,
      cancelled: false,
      nativeStarted: false,
      result: null as Promise<WorkspaceProjectExportOutcome> | null,
    };
    this.deps.state.exportAttempt = attempt;
    this.deps.saves.queues.releaseAll();
    const predecessor = this.deps.saves.saveTail;
    const exportAtBarrier = predecessor.then(async (): Promise<WorkspaceProjectExportOutcome> => {
      if (attempt.cancelled) return Object.freeze({ outcome: 'cancelled' });
      if (this.deps.saves.lastSaveFailure) return this.deps.saves.lastSaveFailure;
      if (!this.deps.isCurrentSaveContext(context)) return failed('workspace.activation.incomplete');
      const flushed = await this.deps.coordinator.flush();
      this.deps.applySaveOutcome(flushed);
      if (flushed.outcome !== 'completed') return flushed;
      if (attempt.cancelled) return Object.freeze({ outcome: 'cancelled' });
      this.deps.syncCurrentFromCoordinator();
      if (!this.deps.isCurrentSaveContext(context)) return failed('workspace.activation.incomplete');
      const nativeExport = this.deps.coordinator.exportWorkspace(suggestedName);
      attempt.nativeStarted = true;
      if (attempt.cancelled) void this.deps.coordinator.cancelExport();
      return nativeExport;
    });
    this.deps.saves.saveTail = exportAtBarrier.then(() => undefined, () => undefined);
    this.deps.notify();
    const result = exportAtBarrier
      .catch(() => failed('workspace.export.failed'))
      .finally(() => {
        if (this.deps.state.exportAttempt === attempt) {
          this.deps.state.exportAttempt = null;
          this.deps.notify();
        }
      });
    attempt.result = result;
    return result;
  }

  async cancelExport(): Promise<WorkspaceProjectExportOutcome | null> {
    const attempt = this.deps.state.exportAttempt;
    if (!attempt) return null;
    attempt.cancelled = true;
    this.deps.notify();
    if (attempt.nativeStarted) {
      const cancellation = await this.deps.coordinator.cancelExport();
      if (cancellation === 'failed') return failed('workspace.export.cancel_failed');
    }
    return attempt.result ?? Object.freeze({ outcome: 'cancelled' });
  }
}

function failed(messageKey: string): import('@/features/workspace/types').WorkspaceActionFailure {
  return Object.freeze({ outcome: 'failed', messageKey });
}
