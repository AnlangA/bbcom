import type {
  WorkspaceMutation,
  WorkspacePortHint,
  WorkspaceSessionKind,
} from '../../generated/ipc-contracts';
import type { SerialSession } from '../../types';
import type { WorkspaceSessionChangeEvent, WorkspaceSessionPort } from '../sessions';
import { projectWorkspaceSessionMutations, projectWorkspaceWaveformPreferences } from './adapters';
import type { WorkspaceApplicationService } from './application';
import type {
  WorkspaceConfigMutationCommand,
  WorkspaceRuntimePersistenceDrain,
  WorkspaceSessionFacade,
} from './application';

/** Bridges the temporary Pinia compatibility facade to the application-owned
 * workspace service. The bridge never sees a native path and only submits
 * Rust-generated mutation variants. */
export class SessionStoreWorkspaceAdapter implements WorkspaceSessionFacade {
  private detach: (() => void) | null = null;
  private detachApplication: (() => void) | null = null;
  private projectionInFlight = new Set<string>();
  private projectedSessionIds = new Set<string>();
  private projectedSortOrders = new Map<string, number>();
  private projectedActiveSessionId: string | null = null;
  private persistenceDrain: WorkspaceRuntimePersistenceDrain | null = null;

  constructor(
    private readonly store: WorkspaceSessionPort,
    private readonly application: WorkspaceApplicationService,
  ) {}

  start(): void {
    if (this.detach) return;
    this.detach = this.store.subscribeWorkspaceChanges((event) => {
      try {
        this.onChange(event);
      } catch {
        // Store observers are isolated by design, so the persistence bridge must
        // translate every projection/clone failure into the application's
        // fail-closed save state before that isolation boundary swallows it.
        this.application.rejectPersistence('workspace.mutation.invalid');
      }
    });
    this.detachApplication = this.application.subscribe((snapshot) => {
      if (
        snapshot.currentWorkspace &&
        snapshot.saveHealth === 'clean' &&
        snapshot.unsavedMutationCount === 0
      ) {
        this.store.markWorkspacePersisted();
      }
    });
  }

  stop(): void {
    this.detach?.();
    this.detachApplication?.();
    this.detach = null;
    this.detachApplication = null;
    this.persistenceDrain = null;
  }

  beginPersistenceDrain(drain: WorkspaceRuntimePersistenceDrain): void {
    if (this.persistenceDrain && this.persistenceDrain !== drain) {
      throw new Error('workspace persistence drain already active');
    }
    this.persistenceDrain = drain;
  }

  endPersistenceDrain(drain: WorkspaceRuntimePersistenceDrain): void {
    if (this.persistenceDrain === drain) this.persistenceDrain = null;
  }

  replaceWorkspace(snapshot: Parameters<WorkspaceSessionFacade['replaceWorkspace']>[0]): void {
    this.store.replaceWorkspaceSessions(snapshot.sessions, snapshot.activeSessionId);
    this.projectedSessionIds = new Set(snapshot.sessions.map((entry) => entry.session.id));
    this.projectedSortOrders = new Map(
      snapshot.sessions.map((entry) => [entry.session.id, entry.sortOrder]),
    );
    this.projectedActiveSessionId = snapshot.activeSessionId;
  }

  private onChange(event: WorkspaceSessionChangeEvent): void {
    if (this.persistenceDrain && !this.persistenceDrain.accepting) {
      this.persistenceDrain = null;
    }
    switch (event.kind) {
      case 'frame-added':
        this.queueFrame(event.sessionId, event.frame);
        return;
      case 'capture-cleared':
        this.queueCaptureReset(event.sessionId);
        return;
      case 'capture-trimmed':
        this.queueCaptureTrim(event.sessionId, event.droppedFrames, event.droppedBytes);
        return;
      case 'waveform-replaced':
        this.queueWaveformReplacement(event.sessionId, event.waveform);
        return;
      case 'waveform-samples-appended':
        this.queueWaveformSamples(event.sessionId, event.samples);
        return;
      case 'waveform-cursor-changed':
        this.queueWaveformCursor(event.sessionId, event.cursor);
        return;
      case 'waveform-channel-config-changed':
        this.queueWaveformPreferences(event.sessionId, event.waveform);
        return;
      case 'waveform-frame-ingested':
        this.queueWaveformFrameIngest(event);
        return;
      case 'session-changed':
        this.projectSession(event.sessionId);
        return;
      case 'ai-message-appended':
        this.queueAiMessage(event.sessionId, event.message, event.startPosition);
        return;
      case 'ai-messages-cleared':
        this.queueAiMessagesCleared(event.sessionId);
        return;
      case 'session-restored':
        this.projectRestoredSession(event.sessionId);
        return;
      case 'catalog-changed':
        this.projectCatalog();
        return;
      default:
        event satisfies never;
    }
  }

  private queueFrame(sessionId: string, frame: import('../../types').DataFrame): void {
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueCapturedFrame({ sessionId, frame })
      : this.application.queueCapturedFrame(sessionId, frame);
    this.requireAccepted(outcome);
  }

  private queueCaptureReset(sessionId: string): void {
    const commands: WorkspaceConfigMutationCommand[] = [
      { kind: 'replace-capture', sessionId, payload: { frames: [] } },
    ];
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueOrderedMutations(commands)
      : this.application.queueCaptureReset(sessionId);
    this.requireAccepted(outcome);
  }

  private queueCaptureTrim(sessionId: string, droppedFrames: number, droppedBytes: number): void {
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueCaptureTrim(sessionId, droppedFrames, droppedBytes)
      : this.application.queueCaptureTrim(sessionId, droppedFrames, droppedBytes);
    this.requireAccepted(outcome);
  }

  private queueWaveformReplacement(
    sessionId: string,
    waveform: import('../../types').SessionWaveformState,
  ): void {
    const channels = waveform.channels.map((channel) => ({
      channelIndex: channel.channelIndex,
      config: structuredClone(channel.config),
    }));
    const samples = waveform.samples.map((sample) => ({ ...sample }));
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueWaveformReplacement(sessionId, channels, samples)
      : this.application.queueWaveformReplacement(sessionId, channels, samples);
    this.requireAccepted(outcome);
  }

  private queueWaveformSamples(
    sessionId: string,
    samples: readonly import('../../types').SessionWaveformSample[],
  ): void {
    const payload = samples.map((sample) => ({ ...sample }));
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueWaveformSamples(sessionId, payload)
      : this.application.queueWaveformSamples(sessionId, payload);
    this.requireAccepted(outcome);
  }

  private queueWaveformCursor(
    sessionId: string,
    cursor: import('../../types').SessionWaveformFrameCursor,
  ): void {
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const command: WorkspaceConfigMutationCommand = {
      kind: 'upsert-feature-state',
      entityId: sessionId,
      payload: {
        feature: 'waveform',
        state: projectWorkspaceWaveformPreferences(
          session,
          cursor,
          this.store.workspaceWaveformBySessionId[sessionId]?.channels,
        ),
      },
    };
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueConfigMutation(command)
      : this.application.queueConfigMutation(command);
    this.requireAccepted(outcome);
  }

  private queueWaveformPreferences(
    sessionId: string,
    waveform: import('../../types').SessionWaveformState,
  ): void {
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const command: WorkspaceConfigMutationCommand = {
      kind: 'upsert-feature-state',
      entityId: sessionId,
      payload: {
        feature: 'waveform',
        state: projectWorkspaceWaveformPreferences(
          session,
          waveform.frameCursor,
          waveform.channels,
        ),
      },
    };
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueConfigMutation(command)
      : this.application.queueConfigMutation(command);
    this.requireAccepted(outcome);
  }

  private queueWaveformFrameIngest(
    event: Extract<WorkspaceSessionChangeEvent, { kind: 'waveform-frame-ingested' }>,
  ): void {
    const session = this.store.sessions.find((candidate) => candidate.id === event.sessionId);
    if (!session) return;
    const channels = event.waveform.channels.map((channel) => ({
      channelIndex: channel.channelIndex,
      config: structuredClone(channel.config),
    }));
    const samples = event.samples.map((sample) => ({ ...sample }));
    const ingest = {
      sessionId: event.sessionId,
      mode: event.mode,
      channels,
      samples,
      featureState: projectWorkspaceWaveformPreferences(
        session,
        event.waveform.frameCursor,
        event.waveform.channels,
      ),
    } as const;
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueWaveformFrameIngest(ingest)
      : this.application.queueWaveformFrameIngest(ingest);
    this.requireAccepted(outcome);
  }

  private queueAiMessage(
    sessionId: string,
    message: import('../../types/ai').AiChatMessage,
    startPosition: number,
  ): void {
    const command: WorkspaceConfigMutationCommand = {
      kind: 'append-ai-messages',
      sessionId,
      payload: {
        startPosition,
        messages: [
          {
            id: message.id,
            role: message.role,
            content: message.content,
            timestampMs: message.timestamp,
          },
        ],
      },
    };
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueConfigMutation(command)
      : this.application.queueConfigMutation(command);
    this.requireAccepted(outcome);
  }

  private queueAiMessagesCleared(sessionId: string): void {
    const command: WorkspaceConfigMutationCommand = { kind: 'clear-ai-messages', sessionId };
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueConfigMutation(command)
      : this.application.queueConfigMutation(command);
    this.requireAccepted(outcome);
  }

  private projectRestoredSession(sessionId: string): void {
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const registration = this.application.registerSession(sessionId);
    this.requireAccepted(registration);
    if (!registration.accepted) return;
    const commands: WorkspaceConfigMutationCommand[] = [];
    for (const [sortOrder, candidate] of this.store.sessions.entries()) {
      if (candidate.id !== sessionId && this.projectedSortOrders.get(candidate.id) === sortOrder) {
        continue;
      }
      if (candidate.id === sessionId) {
        commands.push(...projectSessionCommands(candidate, this.store, sortOrder));
      } else {
        const upsert = projectSessionCommands(candidate, this.store, sortOrder).find(
          (
            command,
          ): command is Extract<WorkspaceConfigMutationCommand, { kind: 'upsert-session' }> =>
            command.kind === 'upsert-session',
        );
        if (upsert) commands.push(upsert);
      }
    }
    if (this.projectedActiveSessionId !== this.store.activeSessionId) {
      commands.push({ kind: 'set-active-session', sessionId: this.store.activeSessionId });
    }
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueOrderedMutations(commands)
      : this.application.queueOrderedMutations(commands);
    if (!outcome.accepted) {
      this.application.unregisterSession(sessionId);
      this.requireAccepted(outcome);
      return;
    }
    this.projectedSessionIds.add(sessionId);
    this.projectedSortOrders = new Map(
      this.store.sessions.map((candidate, sortOrder) => [candidate.id, sortOrder]),
    );
    this.projectedActiveSessionId = this.store.activeSessionId;
  }

  private requireAccepted(
    outcome: ReturnType<WorkspaceApplicationService['queueConfigMutation']>,
  ): void {
    if (!outcome.accepted) this.application.rejectPersistence(outcome.messageKey);
  }

  private projectCatalog(): void {
    const activeWorkspace = this.application.snapshot().currentWorkspace;
    if (!activeWorkspace) return;
    const liveIds = new Set(this.store.sessions.map((session) => session.id));
    const commands: WorkspaceConfigMutationCommand[] = [];
    const removedIds: string[] = [];
    const addedIds: string[] = [];

    for (const persistedId of this.projectedSessionIds) {
      if (!liveIds.has(persistedId)) {
        commands.push({ kind: 'remove-session', sessionId: persistedId });
        removedIds.push(persistedId);
      }
    }
    for (const [sortOrder, session] of this.store.sessions.entries()) {
      const commandsForSession = projectSessionCommands(session, this.store, sortOrder);
      if (!this.projectedSessionIds.has(session.id)) {
        commands.push(...commandsForSession);
        addedIds.push(session.id);
      } else if (this.projectedSortOrders.get(session.id) !== sortOrder) {
        const catalogCommand = commandsForSession.find(
          (
            command,
          ): command is Extract<WorkspaceConfigMutationCommand, { kind: 'upsert-session' }> =>
            command.kind === 'upsert-session',
        );
        if (catalogCommand) commands.push(catalogCommand);
      }
    }
    if (this.projectedActiveSessionId !== this.store.activeSessionId) {
      commands.push({ kind: 'set-active-session', sessionId: this.store.activeSessionId });
    }
    const registeredIds: string[] = [];
    for (const sessionId of addedIds) {
      const registration = this.application.registerSession(sessionId);
      if (!registration.accepted) {
        for (const registeredId of registeredIds) {
          this.application.unregisterSession(registeredId);
        }
        this.requireAccepted(registration);
        return;
      }
      registeredIds.push(sessionId);
    }
    const outcome = this.persistenceDrain
      ? this.persistenceDrain.queueOrderedMutations(commands)
      : this.application.queueOrderedMutations(commands);
    if (!outcome.accepted) {
      for (const registeredId of registeredIds) this.application.unregisterSession(registeredId);
      this.requireAccepted(outcome);
      return;
    }

    for (const sessionId of removedIds) this.application.forgetSession(sessionId);
    this.projectedSessionIds = liveIds;
    this.projectedSortOrders = new Map(
      this.store.sessions.map((session, sortOrder) => [session.id, sortOrder]),
    );
    this.projectedActiveSessionId = this.store.activeSessionId;
  }

  private projectSession(sessionId: string): void {
    if (this.projectionInFlight.has(sessionId)) return;
    const session = this.store.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    this.projectionInFlight.add(sessionId);
    try {
      const commands = projectSessionCommands(
        session,
        this.store,
        this.store.sessions.findIndex((candidate) => candidate.id === sessionId),
      );
      const outcome = this.persistenceDrain
        ? this.persistenceDrain.queueConfigMutations(commands)
        : this.application.queueConfigMutations(commands);
      this.requireAccepted(outcome);
    } finally {
      this.projectionInFlight.delete(sessionId);
    }
  }
}

function projectSessionCommands(
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

function stripSequence(mutation: WorkspaceMutation): WorkspaceConfigMutationCommand | null {
  const { sequence: _sequence, ...command } = mutation;
  void _sequence;
  return isConfigCommand(command) ? command : null;
}

function isConfigCommand(
  command: import('./types').WorkspaceMutationCommand,
): command is WorkspaceConfigMutationCommand {
  return command.kind !== 'append-frames' && command.kind !== 'append-waveform-samples';
}

function safePortHint(
  persisted: WorkspacePortHint | null | undefined,
  portName: string,
): WorkspacePortHint | undefined {
  if (persisted) return persisted;
  const displayName = portName.trim();
  if (!displayName || displayName.startsWith('/') || /^\\\\[.?]\\/u.test(displayName)) {
    return undefined;
  }
  return { displayName: displayName.slice(0, 256) };
}

function displaySessionName(session: SerialSession, sortOrder: number): string {
  const portName = session.portName.trim();
  if (portName && !portName.startsWith('/') && !/^\\\\[.?]\\/u.test(portName)) return portName;
  return `Session ${sortOrder + 1}`;
}
