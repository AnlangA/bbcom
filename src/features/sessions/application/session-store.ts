import { computed, markRaw, readonly, ref, shallowReactive, shallowRef, toRaw } from 'vue';

import { maxBufferFrames } from '@/lib/buffer-config';
import { logger } from '@/lib/logger';
import { createSessionRecord, normalizePortConfig } from '@/lib/session-persistence';
import { nowMillis } from '@/lib/time';
import { frameBuffersByteLength } from '@/lib/session-store-helpers';
import type { SerialSession } from '@/types/session';
import {
  reorderSessionCatalog,
  SessionCatalogController,
} from '@/features/sessions/catalog/session-catalog';
import { createSessionCaptureController } from '@/features/sessions/capture/session-capture-controller';
import { createSessionDocumentMutations } from '@/features/sessions/document/session-document-mutations';
import { SessionMutationRevisionTracker } from '@/features/sessions/persistence/session-mutation-revision-tracker';
import { createSessionSettingsMutations } from '@/features/sessions/settings/session-settings-mutations';
import {
  createSessionWaveformController,
  type SessionWaveformChangeEvent,
} from '@/features/sessions/waveform/session-waveform-controller';
import type { HydratedWorkspaceSession } from '@/features/workspace/adapters';
import type { DataFrame, PortConfig, SessionWaveformState } from '@/types';
import { SessionMutationGate } from '@/features/sessions/mutation/session-mutation-gate';

export type WorkspaceSessionChangeEvent =
  | Readonly<{ kind: 'session-changed'; sessionId: string }>
  | Readonly<{
      kind: 'ai-message-appended';
      sessionId: string;
      message: import('@/types/ai').AiChatMessage;
      startPosition: number;
    }>
  | Readonly<{ kind: 'ai-messages-cleared'; sessionId: string }>
  | Readonly<{ kind: 'session-restored'; sessionId: string }>
  | Readonly<{ kind: 'frame-added'; sessionId: string; frame: DataFrame }>
  | Readonly<{
      kind: 'capture-trimmed';
      sessionId: string;
      droppedFrames: number;
      droppedBytes: number;
    }>
  | Readonly<{ kind: 'capture-cleared'; sessionId: string }>
  | SessionWaveformChangeEvent
  | Readonly<{ kind: 'catalog-changed' }>;

export type WorkspaceSessionChangeListener = (event: WorkspaceSessionChangeEvent) => void;

/**
 * Synchronous permissions installed by the workspace application boundary.
 *
 * `userMutations` covers every persisted, user-visible session mutation.
 * `runtimeCapture` is deliberately separate so already-received RX bytes can
 * still enter the store while the old workspace's quiesce drain is open.
 */
export interface WorkspaceSessionMutationPermissions {
  readonly userMutations: boolean;
  readonly runtimeCapture: boolean;
  readonly preflightRuntimeCapture?: (
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ) => boolean;
  readonly preflightSessionRegistration?: (
    sessionId: string,
    frameCount: number,
    captureBytes: number,
  ) => boolean;
}

export interface SessionCreationOptions {
  readonly lifetime?: 'persistent' | 'runtime';
  readonly displayName?: string;
}

export interface DeletedSessionSnapshot {
  readonly session: SerialSession;
  readonly index: number;
  readonly wasActive: boolean;
  readonly rebind: HydratedWorkspaceSession['rebind'] | null;
  readonly waveform: SessionWaveformState;
  readonly mruSessionIds: readonly string[];
}

export type UndoDeletedSessionResult =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{
      ok: false;
      reason: 'nothing-to-undo' | 'id-conflict' | 'limit-exceeded' | 'mutation-rejected';
    }>;

export type CompleteWorkspaceRebindResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | 'session-missing'
        | 'not-required'
        | 'session-active'
        | 'invalid-port'
        | 'mutation-rejected';
    }>;

let workspacePersistenceSelected = false;

/**
 * Select the workspace writer before creating a Pinia facade. This also
 * changes the new store's mutation permissions to fail-closed; hydration uses
 * explicit internal replacement APIs and therefore does not need this gate.
 */
export function enterWorkspaceSessionPersistenceMode(): void {
  workspacePersistenceSelected = true;
}

function isWorkspacePersistenceSelected(): boolean {
  return workspacePersistenceSelected;
}

/**
 * Headless session state and mutation graph shared by every session facade.
 *
 * Catalog decisions, document/settings mutations, capture accounting,
 * waveform state and persistence orchestration live in framework-light
 * feature modules wired together here exactly once per application instance.
 */
export class SessionStore {
  readonly sessions = shallowRef<SerialSession[]>([]);
  readonly activeSessionId = ref<string | null>(null);
  readonly persistenceReadOnly = ref(false);
  readonly workspaceRebindBySessionId = shallowRef<
    Readonly<Record<string, HydratedWorkspaceSession['rebind']>>
  >({});
  readonly workspaceWaveformBySessionId = shallowRef<Readonly<Record<string, SessionWaveformState>>>(
    {},
  );
  readonly lastDeletedSession = shallowRef<DeletedSessionSnapshot | null>(null);
  readonly sessionFramesVersions = shallowReactive<Record<string, number>>({});
  readonly workspaceUserMutationsAllowed = ref(!isWorkspacePersistenceSelected());
  readonly workspaceRuntimeCaptureAllowed = ref(!isWorkspacePersistenceSelected());

  readonly userMutationsAllowed = computed(
    () => this.workspaceUserMutationsAllowed.value && !this.persistenceReadOnly.value,
  );
  readonly runtimeCaptureAllowed = computed(
    () => this.workspaceRuntimeCaptureAllowed.value && !this.persistenceReadOnly.value,
  );
  readonly activeSession = computed(
    () => this.sessions.value.find((session) => session.id === this.activeSessionId.value) ?? null,
  );

  private readonly cleanupFns = new Map<string, () => Promise<void>>();
  private readonly runtimeSessionIds = new Set<string>();
  private readonly workspaceChangeListeners = new Set<WorkspaceSessionChangeListener>();
  private readonly persistenceTracker = new SessionMutationRevisionTracker();
  private readonly catalog = new SessionCatalogController();
  private readonly mutationGate: SessionMutationGate;
  private readonly waveform: ReturnType<typeof createSessionWaveformController>;
  private readonly capture: ReturnType<typeof createSessionCaptureController>;
  private readonly documentMutations: ReturnType<typeof createSessionDocumentMutations>;
  private readonly settingsMutations: ReturnType<typeof createSessionSettingsMutations>;

  readonly appendSessionWaveformSamples: ReturnType<
    typeof createSessionWaveformController
  >['appendSessionWaveformSamples'];
  readonly replaceSessionWaveformSamples: ReturnType<
    typeof createSessionWaveformController
  >['replaceSessionWaveformSamples'];
  readonly setSessionWaveformChannelVisible: ReturnType<
    typeof createSessionWaveformController
  >['setSessionWaveformChannelVisible'];
  readonly clearSessionWaveform: ReturnType<
    typeof createSessionWaveformController
  >['clearSessionWaveform'];
  readonly resetSessionWaveform: ReturnType<
    typeof createSessionWaveformController
  >['resetSessionWaveform'];
  readonly setSessionWaveformFrameCursor: ReturnType<
    typeof createSessionWaveformController
  >['setSessionWaveformFrameCursor'];
  readonly commitSessionWaveformFrameIngest: ReturnType<
    typeof createSessionWaveformController
  >['commitSessionWaveformFrameIngest'];

  readonly getSessionFramesVersion: ReturnType<
    typeof createSessionCaptureController
  >['getSessionFramesVersion'];
  readonly onFramesCleared: ReturnType<typeof createSessionCaptureController>['onFramesCleared'];
  readonly addFrame: ReturnType<typeof createSessionCaptureController>['addFrame'];
  readonly publishSessionFrames: ReturnType<
    typeof createSessionCaptureController
  >['publishSessionFrames'];
  readonly updateDroppedBytes: ReturnType<
    typeof createSessionCaptureController
  >['updateDroppedBytes'];
  readonly clearFrames: ReturnType<typeof createSessionCaptureController>['clearFrames'];
  readonly setCapturePaused: ReturnType<typeof createSessionCaptureController>['setCapturePaused'];

  constructor() {
    // Legacy-only/test renderers retain their historical permissive behaviour.
    // The production workspace renderer calls enterWorkspaceSessionPersistenceMode
    // before constructing this store, making both paths fail closed until main
    // installs the first application snapshot.
    this.mutationGate = new SessionMutationGate(
      {
        userMutations: this.workspaceUserMutationsAllowed.value,
        runtimeCapture: this.workspaceRuntimeCaptureAllowed.value,
      },
      (permissions) => {
        this.workspaceUserMutationsAllowed.value = permissions.userMutations;
        this.workspaceRuntimeCaptureAllowed.value = permissions.runtimeCapture;
      },
    );

    this.waveform = createSessionWaveformController({
      hasSession: (sessionId) => Boolean(this.findSession(sessionId)),
      canMutateUserState: () => this.canMutateUserState(),
      canCaptureRuntimeEvents: () => this.canCaptureRuntimeEvents(),
      onStateChanged: (state) => {
        this.workspaceWaveformBySessionId.value = state;
      },
      onChange: (event) => this.notifyWorkspaceChange(event),
    });
    ({
      appendSessionWaveformSamples: this.appendSessionWaveformSamples,
      replaceSessionWaveformSamples: this.replaceSessionWaveformSamples,
      setSessionWaveformChannelVisible: this.setSessionWaveformChannelVisible,
      clearSessionWaveform: this.clearSessionWaveform,
      resetSessionWaveform: this.resetSessionWaveform,
      setSessionWaveformFrameCursor: this.setSessionWaveformFrameCursor,
      commitSessionWaveformFrameIngest: this.commitSessionWaveformFrameIngest,
    } = this.waveform);

    this.capture = createSessionCaptureController({
      getSessions: () => this.sessions.value,
      findSession: (sessionId) => this.findSession(sessionId),
      canMutateUserState: () => this.canMutateUserState(),
      canCaptureRuntimeEvents: (sessionId, frame) => this.canAddRuntimeFrame(sessionId, frame),
      frameVersions: this.sessionFramesVersions,
      getMaxBufferFrames: () => maxBufferFrames.value,
      scheduleFramesPersist: () => this.schedulePersist(),
      now: nowMillis,
      decorateFrame: (frame) => markRaw(frame),
      unwrapSession: (session) => toRaw(session),
      onListenerError: (error) => logger.warn('session frame-clear listener failed', error),
      onFrameAdded: (sessionId, frame) =>
        this.notifyWorkspaceChange(Object.freeze({ kind: 'frame-added', sessionId, frame })),
      onCaptureCleared: (sessionId) =>
        this.notifyWorkspaceChange(Object.freeze({ kind: 'capture-cleared', sessionId })),
      onCaptureTrimmed: (sessionId, droppedFrames, droppedBytes) =>
        this.notifyWorkspaceChange(
          Object.freeze({ kind: 'capture-trimmed', sessionId, droppedFrames, droppedBytes }),
        ),
    });
    ({
      getSessionFramesVersion: this.getSessionFramesVersion,
      onFramesCleared: this.onFramesCleared,
      addFrame: this.addFrame,
      publishSessionFrames: this.publishSessionFrames,
      updateDroppedBytes: this.updateDroppedBytes,
      clearFrames: this.clearFrames,
      setCapturePaused: this.setCapturePaused,
    } = this.capture);

    this.documentMutations = createSessionDocumentMutations({
      findSession: (sessionId) => this.findSession(sessionId),
      canMutateUserState: () => this.canMutateUserState(),
      schedulePersist: (sessionId) => {
        this.schedulePersist(sessionId);
      },
      onSessionChanged: (sessionId) =>
        this.notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId })),
      onAiMessageAppended: (sessionId, message, startPosition) =>
        this.notifyWorkspaceChange(
          Object.freeze({ kind: 'ai-message-appended', sessionId, message, startPosition }),
        ),
      onAiMessagesCleared: (sessionId) =>
        this.notifyWorkspaceChange(Object.freeze({ kind: 'ai-messages-cleared', sessionId })),
      decorateAiMessage: (message) => markRaw(message),
    });

    this.settingsMutations = createSessionSettingsMutations({
      findSession: (sessionId) => this.findSession(sessionId),
      canMutateUserState: () => this.canMutateUserState(),
      schedulePersist: (sessionId) => {
        this.schedulePersist(sessionId);
      },
      onSessionChanged: (sessionId) =>
        this.notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId })),
      onWaveformSourceModeChanged: (sessionId) => {
        const session = this.findSession(sessionId);
        if (!session) return;
        const lastFrame = session.frames.at(-1);
        this.resetSessionWaveform(
          sessionId,
          {
            consumed: session.frames.length,
            lastFrameId: lastFrame?.id ?? null,
          },
          true,
        );
      },
    });
  }

  findSession(sessionId: string): SerialSession | undefined {
    return this.sessions.value.find((session) => session.id === sessionId);
  }

  subscribeWorkspaceChanges(listener: WorkspaceSessionChangeListener): () => void {
    this.workspaceChangeListeners.add(listener);
    return () => this.workspaceChangeListeners.delete(listener);
  }

  setWorkspaceMutationPermissions(permissions: WorkspaceSessionMutationPermissions): void {
    this.mutationGate.set(permissions);
  }

  canMutateUserState(): boolean {
    return this.userMutationsAllowed.value;
  }

  canCaptureRuntimeEvents(): boolean {
    return this.runtimeCaptureAllowed.value;
  }

  createSession(
    portName: string,
    portConfig: SerialSession['portConfig'],
    options: SessionCreationOptions = {},
  ): string | null {
    return this.createSessionInternal(portName, portConfig, options);
  }

  createRuntimeSession(
    portName: string,
    portConfig: SerialSession['portConfig'],
    displayName?: string,
  ): string | null {
    return this.createSessionInternal(
      portName,
      portConfig,
      { lifetime: 'runtime', ...(displayName === undefined ? {} : { displayName }) },
      true,
    );
  }

  removeSession(id: string): Promise<DeletedSessionSnapshot | null> {
    return this.removeSessionInternal(id, false);
  }

  removeRuntimeSession(id: string): Promise<DeletedSessionSnapshot | null> {
    if (!this.runtimeSessionIds.has(id)) return Promise.resolve(null);
    return this.removeSessionInternal(id, true);
  }

  setActiveSession(id: string): void {
    if (!this.canMutateUserState()) return;
    if (!this.findSession(id)) return;
    this.activeSessionId.value = id;
    this.catalog.touch(id);
    this.schedulePersist();
    this.notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
  }

  registerCleanup(id: string, fn: () => Promise<void>): void {
    this.cleanupFns.set(id, fn);
  }

  setConnected(sessionId: string, connected: boolean): void {
    const session = this.findSession(sessionId);
    if (!session) return;
    session.isConnected = connected;
    if (connected) {
      if (!session.startTime) session.startTime = nowMillis();
    } else {
      session.startTime = null;
    }
  }

  reorderSessions(fromIndex: number, toIndex: number): void {
    if (!this.canMutateUserState()) return;
    const reordered = reorderSessionCatalog(this.sessions.value, fromIndex, toIndex);
    if (!reordered) return;
    this.sessions.value = reordered;
    this.schedulePersist();
    this.notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
  }

  isSessionConfigurationDirty(sessionId: string): boolean {
    return this.persistenceTracker.isDirty(sessionId);
  }

  markWorkspacePersisted(): void {
    this.persistenceTracker.markDurable();
  }

  replaceWorkspaceSessions(
    entries: readonly HydratedWorkspaceSession[],
    requestedActiveSessionId: string | null,
  ): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      const session = entry?.session;
      if (!session || typeof session.id !== 'string' || session.id.length === 0) {
        throw new Error('workspace session has an invalid identity');
      }
      if (seen.has(session.id)) throw new Error(`duplicate workspace session: ${session.id}`);
      if (!entry.rebind || entry.rebind.required !== true) {
        throw new Error(`workspace session is missing rebind metadata: ${session.id}`);
      }
      if (!Array.isArray(session.frames) || !Array.isArray(session.pausedFrames)) {
        throw new Error(`workspace session has invalid capture state: ${session.id}`);
      }
      if (
        [...session.frames, ...session.pausedFrames].some(
          (frame) => !(frame.data instanceof Uint8Array),
        )
      ) {
        throw new Error(`workspace session has invalid frame payloads: ${session.id}`);
      }
      seen.add(session.id);
    }
    if (requestedActiveSessionId !== null && !seen.has(requestedActiveSessionId)) {
      throw new Error('workspace active session does not exist');
    }

    const preparedSessions = entries.map((entry) =>
      this.wrapSession(cloneStoppedSession(entry.session)),
    );
    const preparedRebind = Object.fromEntries(
      entries.map((entry) => [entry.session.id, Object.freeze({ ...entry.rebind })]),
    ) as Record<string, HydratedWorkspaceSession['rebind']>;
    const preparedWaveforms = this.waveform.prepareReplacement(
      entries.map((entry) => ({ sessionId: entry.session.id, waveform: entry.waveform })),
    );
    const nextActiveSessionId = this.catalog.replace(preparedSessions, requestedActiveSessionId);
    this.runtimeSessionIds.clear();
    this.capture.replaceSessions(preparedSessions);
    this.sessions.value = preparedSessions;
    this.activeSessionId.value = nextActiveSessionId;
    this.workspaceRebindBySessionId.value = Object.freeze(preparedRebind);
    this.waveform.replacePrepared(preparedWaveforms);
    for (const registeredId of [...this.cleanupFns.keys()]) {
      if (!seen.has(registeredId)) this.cleanupFns.delete(registeredId);
    }
    this.lastDeletedSession.value = null;
    this.persistenceTracker.reset();
  }

  completeWorkspaceRebind(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
  ): CompleteWorkspaceRebindResult {
    if (!this.canMutateUserState()) {
      return Object.freeze({ ok: false, reason: 'mutation-rejected' });
    }
    const session = this.findSession(sessionId);
    if (!session) return Object.freeze({ ok: false, reason: 'session-missing' });
    if (!this.workspaceRebindBySessionId.value[sessionId]) {
      return Object.freeze({ ok: false, reason: 'not-required' });
    }
    if (session.isConnected) {
      return Object.freeze({ ok: false, reason: 'session-active' });
    }
    const normalizedPortName = portName.trim();
    if (
      normalizedPortName.length === 0 ||
      normalizedPortName.length > 1024 ||
      containsControlCharacters(normalizedPortName)
    ) {
      return Object.freeze({ ok: false, reason: 'invalid-port' });
    }

    session.portName = normalizedPortName;
    session.portConfig = normalizePortConfig(portConfig);
    const nextRebind = { ...this.workspaceRebindBySessionId.value };
    delete nextRebind[sessionId];
    this.workspaceRebindBySessionId.value = Object.freeze(nextRebind);
    this.schedulePersist(sessionId);
    this.notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId }));
    return Object.freeze({ ok: true });
  }

  updateSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean {
    return this.updateSessionConnectionSettingsInternal(sessionId, portName, portConfig, displayName);
  }

  updateRuntimeSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean {
    if (!this.runtimeSessionIds.has(sessionId)) return false;
    return this.updateSessionConnectionSettingsInternal(
      sessionId,
      portName,
      portConfig,
      displayName,
      true,
    );
  }

  isPersistentSession(sessionId: string): boolean {
    return !this.runtimeSessionIds.has(sessionId);
  }

  exposeForPinia(): SessionStoreFacade {
    return {
      sessionStore: this,
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      activeSession: this.activeSession,
      userMutationsAllowed: this.userMutationsAllowed,
      runtimeCaptureAllowed: this.runtimeCaptureAllowed,
      persistenceReadOnly: this.persistenceReadOnly,
      workspaceRebindBySessionId: readonly(this.workspaceRebindBySessionId),
      workspaceWaveformBySessionId: readonly(this.workspaceWaveformBySessionId),
      lastDeletedSession: readonly(this.lastDeletedSession) as SessionStoreFacade['lastDeletedSession'],
      getSessionFramesVersion: this.getSessionFramesVersion,
      createSession: this.createSession.bind(this),
      createRuntimeSession: this.createRuntimeSession.bind(this),
      removeSession: this.removeSession.bind(this),
      removeRuntimeSession: this.removeRuntimeSession.bind(this),
      undoLastRemovedSession: this.undoLastRemovedSession.bind(this),
      isSessionConfigurationDirty: this.isSessionConfigurationDirty.bind(this),
      markWorkspacePersisted: this.markWorkspacePersisted.bind(this),
      replaceWorkspaceSessions: this.replaceWorkspaceSessions.bind(this),
      completeWorkspaceRebind: this.completeWorkspaceRebind.bind(this),
      updateSessionConnectionSettings: this.updateSessionConnectionSettings.bind(this),
      updateRuntimeSessionConnectionSettings:
        this.updateRuntimeSessionConnectionSettings.bind(this),
      isPersistentSession: this.isPersistentSession.bind(this),
      appendSessionWaveformSamples: this.appendSessionWaveformSamples,
      replaceSessionWaveformSamples: this.replaceSessionWaveformSamples,
      setSessionWaveformChannelVisible: this.setSessionWaveformChannelVisible,
      clearSessionWaveform: this.clearSessionWaveform,
      resetSessionWaveform: this.resetSessionWaveform,
      setSessionWaveformFrameCursor: this.setSessionWaveformFrameCursor,
      commitSessionWaveformFrameIngest: this.commitSessionWaveformFrameIngest,
      setWorkspaceMutationPermissions: this.setWorkspaceMutationPermissions.bind(this),
      subscribeWorkspaceChanges: this.subscribeWorkspaceChanges.bind(this),
      setActiveSession: this.setActiveSession.bind(this),
      registerCleanup: this.registerCleanup.bind(this),
      onFramesCleared: this.onFramesCleared,
      addFrame: this.addFrame,
      publishSessionFrames: this.publishSessionFrames,
      setConnected: this.setConnected.bind(this),
      updateDroppedBytes: this.updateDroppedBytes,
      clearFrames: this.clearFrames,
      setCapturePaused: this.setCapturePaused,
      reorderSessions: this.reorderSessions.bind(this),
      ...this.documentMutations,
      ...this.settingsMutations,
    };
  }

  undoLastRemovedSession(): UndoDeletedSessionResult {
    if (!this.canMutateUserState()) {
      return Object.freeze({ ok: false, reason: 'mutation-rejected' });
    }
    const snapshot = this.lastDeletedSession.value;
    if (!snapshot) return Object.freeze({ ok: false, reason: 'nothing-to-undo' });
    if (this.findSession(snapshot.session.id)) {
      return Object.freeze({ ok: false, reason: 'id-conflict' });
    }
    const frameCount = snapshot.session.frames.length + snapshot.session.pausedFrames.length;
    const captureBytes = frameBuffersByteLength(snapshot.session);
    if (
      !this.mutationGate.preflightSessionRegistration(snapshot.session.id, frameCount, captureBytes)
    ) {
      return Object.freeze({ ok: false, reason: 'limit-exceeded' });
    }

    const restored = this.wrapSession(cloneStoppedSession(snapshot.session));
    const insertionIndex = Math.max(0, Math.min(snapshot.index, this.sessions.value.length));
    const nextSessions = [...this.sessions.value];
    nextSessions.splice(insertionIndex, 0, restored);
    this.sessions.value = nextSessions;
    this.capture.initializeSession(restored);
    this.activeSessionId.value = this.catalog.merge(
      nextSessions,
      [restored.id],
      snapshot.wasActive ? restored.id : this.activeSessionId.value,
      snapshot.mruSessionIds,
      snapshot.wasActive ? null : this.activeSessionId.value,
    );
    if (snapshot.rebind) {
      this.workspaceRebindBySessionId.value = Object.freeze({
        ...this.workspaceRebindBySessionId.value,
        [restored.id]: snapshot.rebind,
      });
    }
    this.waveform.restoreSession(restored.id, snapshot.waveform);
    this.schedulePersist(restored.id);
    this.lastDeletedSession.value = null;
    this.notifyWorkspaceChange(Object.freeze({ kind: 'session-restored', sessionId: restored.id }));
    return Object.freeze({ ok: true, sessionId: restored.id });
  }

  private notifyWorkspaceChange(event: WorkspaceSessionChangeEvent): void {
    for (const listener of [...this.workspaceChangeListeners]) {
      try {
        listener(event);
      } catch (observerError) {
        logger.warn('workspace session observer failed', observerError);
      }
    }
  }

  private canAddRuntimeFrame(
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ): boolean {
    return (
      this.runtimeSessionIds.has(sessionId) ||
      (this.canCaptureRuntimeEvents() &&
        this.mutationGate.preflightRuntimeCapture(sessionId, frame))
    );
  }

  private schedulePersist(dirtySessionId?: string): number {
    return this.persistenceTracker.markDirty(dirtySessionId);
  }

  private wrapSession(session: SerialSession): SerialSession {
    return shallowReactive(session);
  }

  private createSessionInternal(
    portName: string,
    portConfig: SerialSession['portConfig'],
    options: SessionCreationOptions = {},
    allowRuntimeWithoutWorkspaceMutation = false,
  ): string | null {
    const runtimeOnly = options.lifetime === 'runtime';
    if (!this.canMutateUserState() && !(runtimeOnly && allowRuntimeWithoutWorkspaceMutation)) {
      return null;
    }
    const id = crypto.randomUUID();
    if (!runtimeOnly && !this.mutationGate.preflightSessionRegistration(id, 0, 0)) return null;
    const record = createSessionRecord(id, portName, portConfig);
    if (options.displayName) record.displayName = options.displayName;
    if (runtimeOnly) this.runtimeSessionIds.add(id);
    const session = this.wrapSession(record);
    this.sessions.value = [...this.sessions.value, session];
    this.capture.initializeSession(session);
    this.waveform.addEmptySession(id);
    this.activeSessionId.value = id;
    this.catalog.touch(id);
    this.schedulePersist(id);
    this.notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
    return id;
  }

  private async removeSessionInternal(
    id: string,
    runtimeTeardown: boolean,
  ): Promise<DeletedSessionSnapshot | null> {
    if (!this.canMutateUserState() && !(runtimeTeardown && this.runtimeSessionIds.has(id)))
      return null;
    const session = this.findSession(id);
    if (!session) return null;
    const runtimeOnly = this.runtimeSessionIds.has(id);
    const cleanup = this.cleanupFns.get(id);
    if (cleanup) this.cleanupFns.delete(id);
    const currentIndex = this.sessions.value.findIndex((candidate) => candidate.id === id);
    const snapshot = Object.freeze<DeletedSessionSnapshot>({
      session: cloneStoppedSession(session),
      index: currentIndex,
      wasActive: this.activeSessionId.value === id,
      rebind: this.workspaceRebindBySessionId.value[id] ?? null,
      waveform: this.waveform.snapshotSession(id),
      mruSessionIds: Object.freeze(this.catalog.snapshotMruSessionIds()),
    });
    this.capture.removeSession(id);
    this.sessions.value = this.sessions.value.filter((session) => session.id !== id);
    this.runtimeSessionIds.delete(id);
    this.catalog.remove(id);
    this.persistenceTracker.clearDirty(id);
    const nextRebind = { ...this.workspaceRebindBySessionId.value };
    delete nextRebind[id];
    this.workspaceRebindBySessionId.value = Object.freeze(nextRebind);
    this.waveform.removeSession(id);
    if (snapshot.wasActive) {
      const remainingIds = new Set(this.sessions.value.map((session) => session.id));
      const mruSuccessor = this.catalog
        .snapshotMruSessionIds()
        .find((candidate) => remainingIds.has(candidate));
      this.activeSessionId.value = mruSuccessor ?? this.sessions.value[0]?.id ?? null;
      if (this.activeSessionId.value) this.catalog.touch(this.activeSessionId.value);
    }
    this.schedulePersist();
    this.lastDeletedSession.value = runtimeOnly ? null : snapshot;
    this.notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
    if (cleanup) await cleanup();
    return snapshot;
  }

  private updateSessionConnectionSettingsInternal(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
    allowRuntimeWithoutWorkspaceMutation = false,
  ): boolean {
    if (
      !this.canMutateUserState() &&
      !(allowRuntimeWithoutWorkspaceMutation && this.runtimeSessionIds.has(sessionId))
    ) {
      return false;
    }
    const session = this.findSession(sessionId);
    if (!session || session.isConnected) return false;
    const normalizedPortName = portName.trim();
    if (
      normalizedPortName.length === 0 ||
      normalizedPortName.length > 1024 ||
      containsControlCharacters(normalizedPortName)
    ) {
      return false;
    }
    session.portName = normalizedPortName;
    session.portConfig = normalizePortConfig(portConfig);
    if (displayName !== undefined) session.displayName = displayName;
    this.schedulePersist(sessionId);
    this.notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId }));
    return true;
  }
}

export type SessionStoreDocumentMutations = ReturnType<typeof createSessionDocumentMutations>;
export type SessionStoreSettingsMutations = ReturnType<typeof createSessionSettingsMutations>;

export type SessionStoreFacade = {
  readonly sessionStore: SessionStore;
  readonly sessions: SessionStore['sessions'];
  readonly activeSessionId: SessionStore['activeSessionId'];
  readonly activeSession: SessionStore['activeSession'];
  readonly userMutationsAllowed: SessionStore['userMutationsAllowed'];
  readonly runtimeCaptureAllowed: SessionStore['runtimeCaptureAllowed'];
  readonly persistenceReadOnly: SessionStore['persistenceReadOnly'];
  readonly workspaceRebindBySessionId: Readonly<SessionStore['workspaceRebindBySessionId']>;
  readonly workspaceWaveformBySessionId: Readonly<SessionStore['workspaceWaveformBySessionId']>;
  readonly lastDeletedSession: Readonly<SessionStore['lastDeletedSession']>;
  readonly getSessionFramesVersion: SessionStore['getSessionFramesVersion'];
  readonly createSession: SessionStore['createSession'];
  readonly createRuntimeSession: SessionStore['createRuntimeSession'];
  readonly removeSession: SessionStore['removeSession'];
  readonly removeRuntimeSession: SessionStore['removeRuntimeSession'];
  readonly undoLastRemovedSession: SessionStore['undoLastRemovedSession'];
  readonly isSessionConfigurationDirty: SessionStore['isSessionConfigurationDirty'];
  readonly markWorkspacePersisted: SessionStore['markWorkspacePersisted'];
  readonly replaceWorkspaceSessions: SessionStore['replaceWorkspaceSessions'];
  readonly completeWorkspaceRebind: SessionStore['completeWorkspaceRebind'];
  readonly updateSessionConnectionSettings: SessionStore['updateSessionConnectionSettings'];
  readonly updateRuntimeSessionConnectionSettings: SessionStore['updateRuntimeSessionConnectionSettings'];
  readonly isPersistentSession: SessionStore['isPersistentSession'];
  readonly appendSessionWaveformSamples: SessionStore['appendSessionWaveformSamples'];
  readonly replaceSessionWaveformSamples: SessionStore['replaceSessionWaveformSamples'];
  readonly setSessionWaveformChannelVisible: SessionStore['setSessionWaveformChannelVisible'];
  readonly clearSessionWaveform: SessionStore['clearSessionWaveform'];
  readonly resetSessionWaveform: SessionStore['resetSessionWaveform'];
  readonly setSessionWaveformFrameCursor: SessionStore['setSessionWaveformFrameCursor'];
  readonly commitSessionWaveformFrameIngest: SessionStore['commitSessionWaveformFrameIngest'];
  readonly setWorkspaceMutationPermissions: SessionStore['setWorkspaceMutationPermissions'];
  readonly subscribeWorkspaceChanges: SessionStore['subscribeWorkspaceChanges'];
  readonly setActiveSession: SessionStore['setActiveSession'];
  readonly registerCleanup: SessionStore['registerCleanup'];
  readonly onFramesCleared: SessionStore['onFramesCleared'];
  readonly addFrame: SessionStore['addFrame'];
  readonly publishSessionFrames: SessionStore['publishSessionFrames'];
  readonly setConnected: SessionStore['setConnected'];
  readonly updateDroppedBytes: SessionStore['updateDroppedBytes'];
  readonly clearFrames: SessionStore['clearFrames'];
  readonly setCapturePaused: SessionStore['setCapturePaused'];
  readonly reorderSessions: SessionStore['reorderSessions'];
} & SessionStoreDocumentMutations &
  SessionStoreSettingsMutations;

export function exposeSessionStoreForPinia(store: SessionStore): SessionStoreFacade {
  return store.exposeForPinia();
}

function cloneStoppedSession(session: SerialSession): SerialSession {
  const raw = toRaw(session);
  const cloned: SerialSession = {
    ...raw,
    frames: [...raw.frames],
    pausedFrames: [...raw.pausedFrames],
  };
  cloned.isConnected = false;
  cloned.startTime = null;
  cloned.autoLogEnabled = false;
  cloned.logPath = null;
  cloned.droppedBytes = 0;
  return cloned;
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
