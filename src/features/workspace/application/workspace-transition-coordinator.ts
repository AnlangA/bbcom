import type { DataFrame, SerialSession } from '../../../types';
import type { ApplicationRuntimeRegistry, RuntimeDisposalReason } from '../../application';
import type {
  WorkspaceRuntimeCommitContext,
  WorkspaceRuntimeDisposeContext,
  WorkspaceRuntimeLifecycle,
  WorkspaceRuntimeQuiesceContext,
  WorkspaceRuntimeRestoreContext,
  WorkspaceStoppedRuntimeActivationContext,
} from './types';

export interface WorkspaceTransitionParticipant {
  readonly id: string;
  quiesce(context: WorkspaceRuntimeQuiesceContext): void | Promise<void>;
  dispose(context: WorkspaceRuntimeDisposeContext): void | Promise<void>;
  restore(context: WorkspaceRuntimeRestoreContext): void | Promise<void>;
  activateStopped(context: WorkspaceStoppedRuntimeActivationContext): void | Promise<void>;
  commit(context: WorkspaceRuntimeCommitContext): void;
}

export interface SessionRuntimeStatusTransitionPort {
  reconcile(sessionIds: readonly string[]): void;
}

interface ParticipantProgress {
  quiesced: Set<string>;
  disposed: Set<string>;
  activated: Set<string>;
  committed: Set<string>;
  restored: Set<string>;
}

/** Fixed-order, idempotent runtime transaction used by workspace activation. */
export class WorkspaceTransitionCoordinator implements WorkspaceRuntimeLifecycle {
  private readonly progress = new Map<string, ParticipantProgress>();

  constructor(private readonly participants: readonly WorkspaceTransitionParticipant[]) {
    const ids = new Set<string>();
    for (const participant of participants) {
      if (!participant.id || ids.has(participant.id)) {
        throw new Error(`duplicate workspace transition participant: ${participant.id}`);
      }
      ids.add(participant.id);
    }
  }

  async quiesce(context: WorkspaceRuntimeQuiesceContext): Promise<void> {
    const progress = this.forTransition(context.transitionId);
    for (const participant of this.participants) {
      if (progress.quiesced.has(participant.id)) continue;
      await participant.quiesce(context);
      progress.quiesced.add(participant.id);
    }
  }

  async dispose(context: WorkspaceRuntimeDisposeContext): Promise<void> {
    const progress = this.forTransition(context.transitionId);
    for (const participant of this.participants) {
      if (progress.disposed.has(participant.id)) continue;
      await participant.dispose(context);
      progress.disposed.add(participant.id);
    }
  }

  async restore(context: WorkspaceRuntimeRestoreContext): Promise<void> {
    const progress = this.forTransition(context.transitionId);
    const failures: unknown[] = [];
    for (const participant of [...this.participants].reverse()) {
      if (
        progress.restored.has(participant.id) ||
        (!progress.quiesced.has(participant.id) && !progress.disposed.has(participant.id))
      ) {
        continue;
      }
      try {
        await participant.restore(context);
        progress.restored.add(participant.id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'workspace participant restore failed');
    }
  }

  async activateStopped(context: WorkspaceStoppedRuntimeActivationContext): Promise<void> {
    const progress = this.forTransition(context.transitionId);
    for (const participant of this.participants) {
      if (progress.activated.has(participant.id)) continue;
      await participant.activateStopped(context);
      progress.activated.add(participant.id);
    }
  }

  commit(context: WorkspaceRuntimeCommitContext): void {
    const progress = this.forTransition(context.transitionId);
    for (const participant of this.participants) {
      if (progress.committed.has(participant.id)) continue;
      participant.commit(context);
      progress.committed.add(participant.id);
    }
    this.progress.delete(context.transitionId);
  }

  private forTransition(transitionId: string): ParticipantProgress {
    let progress = this.progress.get(transitionId);
    if (!progress) {
      progress = {
        quiesced: new Set(),
        disposed: new Set(),
        activated: new Set(),
        committed: new Set(),
        restored: new Set(),
      };
      this.progress.set(transitionId, progress);
    }
    return progress;
  }
}

export interface SessionRuntimeWorkspaceParticipantOptions<TRuntime> {
  readonly registry: ApplicationRuntimeRegistry<SerialSession, TRuntime>;
  readonly statuses: SessionRuntimeStatusTransitionPort;
  readonly prepareRuntimes: () => Promise<void>;
  readonly beginPersistenceDrain: (context: WorkspaceRuntimeQuiesceContext['persistence']) => void;
  readonly endPersistenceDrain: (context: WorkspaceRuntimeQuiesceContext['persistence']) => void;
  readonly setMutationPermissions: (permissions: {
    userMutations: boolean;
    runtimeCapture: boolean;
    preflightRuntimeCapture?: (
      sessionId: string,
      frame: Pick<DataFrame, 'direction' | 'data'>,
    ) => boolean;
  }) => void;
  readonly preflightRuntimeCapture: (
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ) => boolean;
}

/** Owns rollback snapshots for resident session runtimes; main.ts owns none. */
export class SessionRuntimeWorkspaceParticipant<
  TRuntime,
> implements WorkspaceTransitionParticipant {
  readonly id = 'session-runtime';
  private readonly snapshots = new Map<
    string,
    readonly { readonly sessionId: string; readonly session: SerialSession }[]
  >();

  constructor(private readonly options: SessionRuntimeWorkspaceParticipantOptions<TRuntime>) {}

  async quiesce(context: WorkspaceRuntimeQuiesceContext): Promise<void> {
    if (!this.snapshots.has(context.transitionId)) {
      this.snapshots.set(
        context.transitionId,
        this.options.registry.list().map(({ sessionId, session }) => ({ sessionId, session })),
      );
    }
    this.options.beginPersistenceDrain(context.persistence);
    this.options.setMutationPermissions({
      userMutations: false,
      runtimeCapture: true,
      preflightRuntimeCapture: this.options.preflightRuntimeCapture,
    });
    try {
      await this.options.prepareRuntimes();
    } finally {
      this.options.setMutationPermissions({
        userMutations: false,
        runtimeCapture: false,
        preflightRuntimeCapture: this.options.preflightRuntimeCapture,
      });
      this.options.endPersistenceDrain(context.persistence);
    }
  }

  async dispose(context: WorkspaceRuntimeDisposeContext): Promise<void> {
    const snapshot = this.snapshots.get(context.transitionId) ?? [];
    await Promise.all(
      snapshot.map(({ sessionId }) =>
        this.options.registry.disposeSession(
          sessionId,
          'reconcile' satisfies RuntimeDisposalReason,
        ),
      ),
    );
    await this.options.registry.reconcile([]);
    this.options.statuses.reconcile([]);
  }

  async restore(context: WorkspaceRuntimeRestoreContext): Promise<void> {
    const snapshot = this.snapshots.get(context.transitionId) ?? [];
    await this.options.registry.reconcile([]);
    for (const { session } of snapshot) await this.options.registry.ensure(session);
    this.snapshots.delete(context.transitionId);
  }

  async activateStopped(context: WorkspaceStoppedRuntimeActivationContext): Promise<void> {
    await this.options.registry.reconcile([]);
    this.options.statuses.reconcile(context.workspace.sessions.map(({ session }) => session.id));
  }

  commit(context: WorkspaceRuntimeCommitContext): void {
    this.snapshots.delete(context.transitionId);
  }
}

export interface PluginRuntimeWorkspacePort {
  quiesce(transitionId: string): void | Promise<void>;
  dispose(transitionId: string): void | Promise<void>;
  restore(transitionId: string, workspaceId: string | null): void | Promise<void>;
  activateStopped(transitionId: string, workspaceId: string): void | Promise<void>;
  commit(transitionId: string, workspaceId: string): void;
}

export class PluginRuntimeWorkspaceParticipant implements WorkspaceTransitionParticipant {
  readonly id = 'plugin-runtime';

  constructor(private readonly port: PluginRuntimeWorkspacePort) {}

  quiesce(context: WorkspaceRuntimeQuiesceContext): void | Promise<void> {
    return this.port.quiesce(context.transitionId);
  }

  dispose(context: WorkspaceRuntimeDisposeContext): void | Promise<void> {
    return this.port.dispose(context.transitionId);
  }

  restore(context: WorkspaceRuntimeRestoreContext): void | Promise<void> {
    return this.port.restore(context.transitionId, context.previousWorkspaceId);
  }

  activateStopped(context: WorkspaceStoppedRuntimeActivationContext): void | Promise<void> {
    return this.port.activateStopped(context.transitionId, context.workspace.workspaceId);
  }

  commit(context: WorkspaceRuntimeCommitContext): void {
    this.port.commit(context.transitionId, context.workspaceId);
  }
}
