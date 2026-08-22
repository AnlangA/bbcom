import type {
  ApplyWorkspaceBatchRequest,
  FlushWorkspaceResponse,
  WorkspaceMutation,
  WorkspaceSaveHealth,
} from '@/generated/ipc-contracts';
import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionOutcome,
  WorkspaceCoordinatorPort,
  WorkspaceLayoutV1,
  WorkspaceMutationCommand,
} from './types';
import {
  InvalidWorkspaceResponseError,
  createSequencedMutation,
  isWorkspaceReadOnlyError,
  safeFailure,
  sanitizeWorkspaceLayout,
  validateCommittedRevision,
} from './validation';

/**
 * Write-epoch serialization engine behind the workspace coordinator.
 *
 * Every mutation batch and flush is serialized through the current epoch's
 * tail promise, so writes to one workspace document commit in submission
 * order. Starting a new epoch (workspace activation) aborts the old epoch's
 * in-flight port calls and orphans its queued tickets, which then resolve as
 * `stale` instead of altering the newly active document. The engine owns all
 * epoch state; the coordinator only supplies the port, the active document,
 * and view-notification hooks.
 */

export interface MutableActiveWorkspace {
  workspaceId: string;
  name: string;
  revision: number;
  activeSessionId: string | null;
  sessionIds: readonly string[];
  saveHealth: WorkspaceSaveHealth;
  layout: WorkspaceLayoutV1;
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

/** The persistence calls the engine needs; a subset of the coordinator port. */
export type WorkspaceWriteEpochPort = Pick<
  WorkspaceCoordinatorPort,
  'applyWorkspaceBatch' | 'flushWorkspace'
>;

/** Coordinator-owned state and notifications the engine drives. */
export interface WorkspaceWriteEpochHost {
  /** The current mutable workspace document, or null when none is active. */
  activeDocument(): MutableActiveWorkspace | null;
  /** Replace the active document reference after a committed mutation batch. */
  replaceActiveDocument(document: MutableActiveWorkspace): void;
  setSaveHealth(health: WorkspaceSaveHealth): void;
  mergeActiveIntoProjects(): void;
  notify(): void;
  /** Generate (and validate) the next client batch id; may throw. */
  nextBatchId(): string;
}

export class WorkspaceWriteEpochEngine {
  private writeEpoch: WriteEpoch | null = null;
  private writeEpochNumber = 0;

  constructor(
    private readonly port: WorkspaceWriteEpochPort,
    private readonly host: WorkspaceWriteEpochHost,
  ) {}

  /** Invalidate the previous epoch and start a fresh one for `workspaceId`. */
  beginEpoch(workspaceId: string): void {
    this.writeEpoch?.controller.abort();
    this.writeEpoch = {
      number: ++this.writeEpochNumber,
      workspaceId,
      controller: new AbortController(),
      tail: Promise.resolve(),
      pending: 0,
      inFlight: false,
      sequence: 0,
    };
  }

  /** Abort every queued write when the active project is permanently removed. */
  clearEpoch(): void {
    this.writeEpoch?.controller.abort();
    this.writeEpoch = null;
    this.writeEpochNumber += 1;
  }

  commitBatch(
    commands: readonly Readonly<WorkspaceMutationCommand>[],
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    const active = this.host.activeDocument();
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
      clientBatchId = this.host.nextBatchId();
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
    if (!epoch.inFlight) this.host.setSaveHealth('pending');
    this.host.notify();

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
    const active = this.host.activeDocument();
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

  private async executeBatch(
    ticket: MutationTicket,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    if (!this.isCurrentEpoch(ticket.epoch, ticket.workspaceId)) {
      this.finishWrite(ticket.epoch);
      return stale();
    }
    if (this.host.activeDocument()?.saveHealth === 'readOnly') {
      this.finishWrite(ticket.epoch, 'readOnly');
      return failed('error.workspace_read_only', 'WORKSPACE_READ_ONLY');
    }
    ticket.epoch.inFlight = true;
    this.host.setSaveHealth('saving');
    this.host.notify();
    const baseRevision = this.host.activeDocument()!.revision;
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
        committedRevision <= this.host.activeDocument()!.revision
      ) {
        throw new InvalidWorkspaceResponseError('committedRevision');
      }
      const committedDocument = cloneMutableActive(this.host.activeDocument()!);
      for (const mutation of ticket.mutations) {
        this.applyCommittedDocumentMutation(committedDocument, mutation);
      }
      committedDocument.revision = committedRevision;
      this.host.replaceActiveDocument(committedDocument);
      this.finishWrite(ticket.epoch, 'clean');
      this.host.mergeActiveIntoProjects();
      this.host.notify();
      return completed(freezeActive(this.host.activeDocument()!));
    } catch (error) {
      if (!this.isCurrentEpoch(ticket.epoch, ticket.workspaceId)) {
        this.finishWrite(ticket.epoch);
        return stale();
      }
      const readOnly = isWorkspaceReadOnlyError(error);
      this.finishWrite(ticket.epoch, readOnly ? 'readOnly' : 'degraded');
      this.host.mergeActiveIntoProjects();
      this.host.notify();
      return safeFailure(error, readOnly ? 'error.workspace_read_only' : 'workspace.save.failed');
    }
  }

  private async executeFlush(
    epoch: WriteEpoch,
  ): Promise<WorkspaceActionOutcome<ActiveWorkspaceViewModel>> {
    if (!this.isCurrentEpoch(epoch, epoch.workspaceId)) return stale();
    if (this.host.activeDocument()?.saveHealth === 'readOnly') {
      return failed('error.workspace_read_only', 'WORKSPACE_READ_ONLY');
    }
    epoch.inFlight = true;
    this.host.setSaveHealth('saving');
    this.host.notify();
    const targetRevision = this.host.activeDocument()!.revision;
    try {
      const response = await this.port.flushWorkspace(
        { workspaceId: epoch.workspaceId, targetRevision },
        { signal: epoch.controller.signal },
      );
      if (!this.isCurrentEpoch(epoch, epoch.workspaceId)) return stale();
      this.applyFlushResponse(response, targetRevision, epoch.pending);
      epoch.inFlight = false;
      this.host.mergeActiveIntoProjects();
      this.host.notify();
      return completed(freezeActive(this.host.activeDocument()!));
    } catch (error) {
      if (!this.isCurrentEpoch(epoch, epoch.workspaceId)) return stale();
      const readOnly = isWorkspaceReadOnlyError(error);
      epoch.inFlight = false;
      this.host.setSaveHealth(readOnly ? 'readOnly' : 'degraded');
      this.host.mergeActiveIntoProjects();
      this.host.notify();
      return safeFailure(error, readOnly ? 'error.workspace_read_only' : 'workspace.flush.failed');
    }
  }

  private applyFlushResponse(
    response: FlushWorkspaceResponse,
    targetRevision: number,
    queuedMutations: number,
  ): void {
    const committedRevision = validateCommittedRevision(response.committedRevision);
    const active = this.host.activeDocument()!;
    if (committedRevision < targetRevision || committedRevision < active.revision) {
      throw new InvalidWorkspaceResponseError('committedRevision');
    }
    if (!isSaveHealth(response.saveHealth)) {
      throw new InvalidWorkspaceResponseError('saveHealth');
    }
    active.revision = committedRevision;
    this.host.setSaveHealth(
      response.saveHealth === 'clean' && queuedMutations > 0 ? 'pending' : response.saveHealth,
    );
  }

  private finishWrite(epoch: WriteEpoch, terminalHealth?: WorkspaceSaveHealth): void {
    epoch.pending = Math.max(0, epoch.pending - 1);
    epoch.inFlight = false;
    if (this.writeEpoch !== epoch || !this.host.activeDocument()) return;
    if (terminalHealth === 'readOnly' || terminalHealth === 'degraded') {
      this.host.setSaveHealth(terminalHealth);
      return;
    }
    this.host.setSaveHealth(epoch.pending > 0 ? 'pending' : (terminalHealth ?? 'clean'));
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

  private isCurrentEpoch(epoch: WriteEpoch, workspaceId: string): boolean {
    return (
      this.writeEpoch === epoch &&
      this.host.activeDocument()?.workspaceId === workspaceId &&
      !epoch.controller.signal.aborted
    );
  }
}

export function freezeActive(active: MutableActiveWorkspace): ActiveWorkspaceViewModel {
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

export function completed<T>(value: T): WorkspaceActionOutcome<T> {
  return Object.freeze({ outcome: 'completed', value });
}

export function stale(): WorkspaceActionOutcome<never> {
  return Object.freeze({ outcome: 'stale' });
}

export function failed(messageKey: string, code?: string): WorkspaceActionOutcome<never> {
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
