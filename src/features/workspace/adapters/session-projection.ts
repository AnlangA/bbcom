import type {
  WorkspaceMutation,
  WorkspacePortHint,
  WorkspaceSessionKind,
} from '@/generated/ipc-contracts';
import type { SerialSession } from '@/types';
import type { WorkspaceSessionPort } from '../../sessions';
import { projectWorkspaceSessionMutations } from '../adapters';
import type { WorkspaceApplicationService } from '../application';
import type { WorkspaceConfigMutationCommand, WorkspaceQueueOutcome } from '../application';

export function projectSessionCommands(
  session: SerialSession,
  store: WorkspaceSessionPort,
  sortOrder: number,
): WorkspaceConfigMutationCommand[] {
  const rebind = store.workspaceRebindBySessionId[session.id];
  const lastPortHint = safePortHint(rebind?.lastPortHint, session.portName);
  const projection = projectWorkspaceSessionMutations(session, {
    sequenceStart: 0,
    sortOrder,
    name: rebind?.displayName || displaySessionName(session, sortOrder),
    kind: (rebind?.kind ?? 'live') as WorkspaceSessionKind,
    ...(lastPortHint ? { lastPortHint } : {}),
    waveformFrameCursor: store.workspaceWaveformBySessionId[session.id]?.frameCursor ?? {
      consumed: 0,
      lastFrameId: null,
    },
    waveformChannelVisibility: store.workspaceWaveformBySessionId[session.id]?.channels.map(
      (channel) => ({
        channelIndex: channel.channelIndex,
        visible: channel.config.visible !== false,
      }),
    ),
  });
  return projection.mutations.flatMap((mutation) => {
    if (mutation.kind === 'clear-ai-messages' || mutation.kind === 'append-ai-messages') return [];
    const command = stripSequence(mutation);
    return command ? [command] : [];
  });
}

export function persistentSessions(store: WorkspaceSessionPort): readonly SerialSession[] {
  return store.sessions.filter((session) => store.isPersistentSession(session.id));
}

export function persistentActiveSessionId(
  store: WorkspaceSessionPort,
  sessions: readonly SerialSession[],
  projectedActiveSessionId: string | null,
): string | null {
  const active = store.activeSessionId;
  if (active && store.isPersistentSession(active)) return active;
  if (
    projectedActiveSessionId &&
    sessions.some((session) => session.id === projectedActiveSessionId)
  ) {
    return projectedActiveSessionId;
  }
  return sessions[0]?.id ?? null;
}

export interface SessionProjectionState {
  projectionInFlight: Set<string>;
  projectedSessionIds: Set<string>;
  projectedSortOrders: Map<string, number>;
  projectedActiveSessionId: string | null;
}

export class SessionProjection {
  constructor(
    private readonly store: WorkspaceSessionPort,
    private readonly application: WorkspaceApplicationService,
    private readonly state: SessionProjectionState,
    private readonly routeOrderedMutations: (
      commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
    ) => WorkspaceQueueOutcome,
    private readonly routeConfigMutations: (
      commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
    ) => WorkspaceQueueOutcome,
    private readonly onRejected: (messageKey: string) => void,
  ) {}

  projectRestoredSession(sessionId: string): void {
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const registration = this.application.registerSession(sessionId);
    this.requireAccepted(registration);
    if (!registration.accepted) return;
    const commands: WorkspaceConfigMutationCommand[] = [];
    const sessions = persistentSessions(this.store);
    for (const [sortOrder, candidate] of sessions.entries()) {
      if (candidate.id !== sessionId && this.state.projectedSortOrders.get(candidate.id) === sortOrder) continue;
      if (candidate.id === sessionId) {
        commands.push(...projectSessionCommands(candidate, this.store, sortOrder));
      } else {
        const upsert = projectSessionCommands(candidate, this.store, sortOrder).find(
          (c): c is Extract<WorkspaceConfigMutationCommand, { kind: 'upsert-session' }> => c.kind === 'upsert-session',
        );
        if (upsert) commands.push(upsert);
      }
    }
    const activeSessionId = persistentActiveSessionId(this.store, sessions, this.state.projectedActiveSessionId);
    if (this.state.projectedActiveSessionId !== activeSessionId) {
      commands.push({ kind: 'set-active-session', sessionId: activeSessionId });
    }
    const outcome = this.routeOrderedMutations(commands);
    if (!outcome.accepted) {
      this.application.unregisterSession(sessionId);
      this.requireAccepted(outcome);
      return;
    }
    this.state.projectedSessionIds.add(sessionId);
    this.state.projectedSortOrders = new Map(sessions.map((c, i) => [c.id, i]));
    this.state.projectedActiveSessionId = activeSessionId;
  }

  projectCatalog(): void {
    const activeWorkspace = this.application.snapshot().currentWorkspace;
    if (!activeWorkspace) return;
    const sessions = persistentSessions(this.store);
    const liveIds = new Set(sessions.map((s) => s.id));
    const commands: WorkspaceConfigMutationCommand[] = [];
    const removedIds: string[] = [];
    const addedIds: string[] = [];
    for (const persistedId of this.state.projectedSessionIds) {
      if (!liveIds.has(persistedId)) {
        commands.push({ kind: 'remove-session', sessionId: persistedId });
        removedIds.push(persistedId);
      }
    }
    for (const [sortOrder, session] of sessions.entries()) {
      const cmds = projectSessionCommands(session, this.store, sortOrder);
      if (!this.state.projectedSessionIds.has(session.id)) {
        commands.push(...cmds);
        addedIds.push(session.id);
      } else if (this.state.projectedSortOrders.get(session.id) !== sortOrder) {
        const upsert = cmds.find((c): c is Extract<WorkspaceConfigMutationCommand, { kind: 'upsert-session' }> => c.kind === 'upsert-session');
        if (upsert) commands.push(upsert);
      }
    }
    const activeSessionId = persistentActiveSessionId(this.store, sessions, this.state.projectedActiveSessionId);
    if (this.state.projectedActiveSessionId !== activeSessionId) {
      commands.push({ kind: 'set-active-session', sessionId: activeSessionId });
    }
    const registeredIds: string[] = [];
    for (const sessionId of addedIds) {
      const registration = this.application.registerSession(sessionId);
      if (!registration.accepted) {
        for (const id of registeredIds) this.application.unregisterSession(id);
        this.requireAccepted(registration);
        return;
      }
      registeredIds.push(sessionId);
    }
    const outcome = this.routeOrderedMutations(commands);
    if (!outcome.accepted) {
      for (const id of registeredIds) this.application.unregisterSession(id);
      this.requireAccepted(outcome);
      return;
    }
    for (const sessionId of removedIds) this.application.forgetSession(sessionId);
    this.state.projectedSessionIds = liveIds;
    this.state.projectedSortOrders = new Map(sessions.map((s, i) => [s.id, i]));
    this.state.projectedActiveSessionId = activeSessionId;
  }

  projectSession(sessionId: string): void {
    if (this.state.projectionInFlight.has(sessionId)) return;
    if (!this.store.isPersistentSession(sessionId)) return;
    const session = this.store.sessions.find((c) => c.id === sessionId);
    if (!session) return;
    this.state.projectionInFlight.add(sessionId);
    try {
      const commands = projectSessionCommands(
        session,
        this.store,
        persistentSessions(this.store).findIndex((c) => c.id === sessionId),
      );
      this.requireAccepted(this.routeConfigMutations(commands));
    } finally {
      this.state.projectionInFlight.delete(sessionId);
    }
  }

  private requireAccepted(outcome: WorkspaceQueueOutcome): void {
    if (!outcome.accepted) this.onRejected(outcome.messageKey);
  }
}

function stripSequence(mutation: WorkspaceMutation): WorkspaceConfigMutationCommand | null {
  const { sequence: _sequence, ...command } = mutation;
  void _sequence;
  return isConfigCommand(command) ? command : null;
}

function isConfigCommand(
  command: import('../types').WorkspaceMutationCommand,
): command is WorkspaceConfigMutationCommand {
  return command.kind !== 'append-frames' && command.kind !== 'append-waveform-samples';
}

function safePortHint(persisted: WorkspacePortHint | null | undefined, portName: string): WorkspacePortHint | undefined {
  if (persisted) return persisted;
  const displayName = portName.trim();
  if (!displayName || displayName.startsWith('/') || /^\\\\[.?]\\/u.test(displayName)) return undefined;
  return { displayName: displayName.slice(0, 256) };
}

function displaySessionName(session: SerialSession, sortOrder: number): string {
  if (session.displayName?.trim()) return session.displayName.trim();
  const portName = session.portName.trim();
  if (portName && !portName.startsWith('/') && !/^\\\\[.?]\\/u.test(portName)) return portName;
  return `Session ${sortOrder + 1}`;
}
