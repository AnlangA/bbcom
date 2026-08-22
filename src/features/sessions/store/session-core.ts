import { defineStore } from 'pinia';
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
 * Single instance graph behind every session facade store.
 *
 * Catalog decisions, document/settings mutations, capture accounting,
 * waveform state and persistence orchestration live in framework-light
 * feature modules wired together here exactly once per Pinia instance. The
 * public feature ports select members from this store, so they all
 * share the same controllers, refs and event listeners.
 */
export const useSessionCoreStore = defineStore('session-core', () => {
  const sessions = shallowRef<SerialSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const persistenceReadOnly = ref(false);
  const workspaceRebindBySessionId = shallowRef<
    Readonly<Record<string, HydratedWorkspaceSession['rebind']>>
  >({});
  const workspaceWaveformBySessionId = shallowRef<Readonly<Record<string, SessionWaveformState>>>(
    {},
  );
  const lastDeletedSession = shallowRef<DeletedSessionSnapshot | null>(null);
  const sessionFramesVersions = shallowReactive<Record<string, number>>({});
  const cleanupFns = new Map<string, () => Promise<void>>();
  const runtimeSessionIds = new Set<string>();
  const workspaceChangeListeners = new Set<WorkspaceSessionChangeListener>();
  const persistenceTracker = new SessionMutationRevisionTracker();
  const catalog = new SessionCatalogController();
  // Legacy-only/test renderers retain their historical permissive behaviour.
  // The production workspace renderer calls enterWorkspaceSessionPersistenceMode
  // before constructing this store, making both paths fail closed until main
  // installs the first application snapshot.
  const workspaceUserMutationsAllowed = ref(!workspacePersistenceSelected);
  const workspaceRuntimeCaptureAllowed = ref(!workspacePersistenceSelected);
  const userMutationsAllowed = computed(
    () => workspaceUserMutationsAllowed.value && !persistenceReadOnly.value,
  );
  const runtimeCaptureAllowed = computed(
    () => workspaceRuntimeCaptureAllowed.value && !persistenceReadOnly.value,
  );
  const mutationGate = new SessionMutationGate(
    {
      userMutations: workspaceUserMutationsAllowed.value,
      runtimeCapture: workspaceRuntimeCaptureAllowed.value,
    },
    (permissions) => {
      workspaceUserMutationsAllowed.value = permissions.userMutations;
      workspaceRuntimeCaptureAllowed.value = permissions.runtimeCapture;
    },
  );

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? null,
  );

  function findSession(sessionId: string): SerialSession | undefined {
    return sessions.value.find((session) => session.id === sessionId);
  }

  function notifyWorkspaceChange(event: WorkspaceSessionChangeEvent): void {
    for (const listener of [...workspaceChangeListeners]) {
      try {
        listener(event);
      } catch (observerError) {
        logger.warn('workspace session observer failed', observerError);
      }
    }
  }

  function subscribeWorkspaceChanges(listener: WorkspaceSessionChangeListener): () => void {
    workspaceChangeListeners.add(listener);
    return () => workspaceChangeListeners.delete(listener);
  }

  function setWorkspaceMutationPermissions(permissions: WorkspaceSessionMutationPermissions): void {
    mutationGate.set(permissions);
  }

  function canMutateUserState(): boolean {
    return userMutationsAllowed.value;
  }

  function canCaptureRuntimeEvents(): boolean {
    return runtimeCaptureAllowed.value;
  }

  function canAddRuntimeFrame(
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ): boolean {
    return (
      runtimeSessionIds.has(sessionId) ||
      (canCaptureRuntimeEvents() && mutationGate.preflightRuntimeCapture(sessionId, frame))
    );
  }

  const waveform = createSessionWaveformController({
    hasSession: (sessionId) => Boolean(findSession(sessionId)),
    canMutateUserState,
    canCaptureRuntimeEvents,
    onStateChanged: (state) => {
      workspaceWaveformBySessionId.value = state;
    },
    onChange: notifyWorkspaceChange,
  });
  const {
    appendSessionWaveformSamples,
    replaceSessionWaveformSamples,
    setSessionWaveformChannelVisible,
    clearSessionWaveform,
    resetSessionWaveform,
    setSessionWaveformFrameCursor,
    commitSessionWaveformFrameIngest,
  } = waveform;

  function schedulePersist(dirtySessionId?: string): number {
    return persistenceTracker.markDirty(dirtySessionId);
  }

  const capture = createSessionCaptureController({
    getSessions: () => sessions.value,
    findSession,
    canMutateUserState,
    canCaptureRuntimeEvents: canAddRuntimeFrame,
    frameVersions: sessionFramesVersions,
    getMaxBufferFrames: () => maxBufferFrames.value,
    scheduleFramesPersist: () => schedulePersist(),
    now: nowMillis,
    decorateFrame: (frame) => markRaw(frame),
    unwrapSession: (session) => toRaw(session),
    onListenerError: (error) => logger.warn('session frame-clear listener failed', error),
    onFrameAdded: (sessionId, frame) =>
      notifyWorkspaceChange(Object.freeze({ kind: 'frame-added', sessionId, frame })),
    onCaptureCleared: (sessionId) =>
      notifyWorkspaceChange(Object.freeze({ kind: 'capture-cleared', sessionId })),
    onCaptureTrimmed: (sessionId, droppedFrames, droppedBytes) =>
      notifyWorkspaceChange(
        Object.freeze({ kind: 'capture-trimmed', sessionId, droppedFrames, droppedBytes }),
      ),
  });

  /**
   * Each session is shallow reactive: scalar/config replacements notify the
   * UI, while high-volume frame arrays use the explicit version channel.
   */
  function wrapSession(session: SerialSession): SerialSession {
    return shallowReactive(session);
  }

  const documentMutations = createSessionDocumentMutations({
    findSession,
    canMutateUserState,
    schedulePersist: (sessionId) => {
      schedulePersist(sessionId);
    },
    onSessionChanged: (sessionId) =>
      notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId })),
    onAiMessageAppended: (sessionId, message, startPosition) =>
      notifyWorkspaceChange(
        Object.freeze({ kind: 'ai-message-appended', sessionId, message, startPosition }),
      ),
    onAiMessagesCleared: (sessionId) =>
      notifyWorkspaceChange(Object.freeze({ kind: 'ai-messages-cleared', sessionId })),
    decorateAiMessage: (message) => markRaw(message),
  });
  const settingsMutations = createSessionSettingsMutations({
    findSession,
    canMutateUserState,
    schedulePersist: (sessionId) => {
      schedulePersist(sessionId);
    },
    onSessionChanged: (sessionId) =>
      notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId })),
    onWaveformSourceModeChanged: (sessionId) => {
      const session = findSession(sessionId);
      if (!session) return;
      const lastFrame = session.frames.at(-1);
      resetSessionWaveform(
        sessionId,
        {
          consumed: session.frames.length,
          lastFrameId: lastFrame?.id ?? null,
        },
        true,
      );
    },
  });

  function createSessionInternal(
    portName: string,
    portConfig: SerialSession['portConfig'],
    options: SessionCreationOptions = {},
    allowRuntimeWithoutWorkspaceMutation = false,
  ): string | null {
    const runtimeOnly = options.lifetime === 'runtime';
    if (!canMutateUserState() && !(runtimeOnly && allowRuntimeWithoutWorkspaceMutation)) {
      return null;
    }
    const id = crypto.randomUUID();
    if (!runtimeOnly && !mutationGate.preflightSessionRegistration(id, 0, 0)) return null;
    const record = createSessionRecord(id, portName, portConfig);
    if (options.displayName) record.displayName = options.displayName;
    if (runtimeOnly) runtimeSessionIds.add(id);
    const session = wrapSession(record);
    sessions.value = [...sessions.value, session];
    capture.initializeSession(session);
    waveform.addEmptySession(id);
    activeSessionId.value = id;
    catalog.touch(id);
    schedulePersist(id);
    notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
    return id;
  }

  function createSession(
    portName: string,
    portConfig: SerialSession['portConfig'],
    options: SessionCreationOptions = {},
  ): string | null {
    return createSessionInternal(portName, portConfig, options);
  }

  function createRuntimeSession(
    portName: string,
    portConfig: SerialSession['portConfig'],
    displayName?: string,
  ): string | null {
    return createSessionInternal(
      portName,
      portConfig,
      { lifetime: 'runtime', ...(displayName === undefined ? {} : { displayName }) },
      true,
    );
  }

  async function removeSessionInternal(
    id: string,
    runtimeTeardown: boolean,
  ): Promise<DeletedSessionSnapshot | null> {
    if (!canMutateUserState() && !(runtimeTeardown && runtimeSessionIds.has(id))) return null;
    const session = findSession(id);
    if (!session) return null;
    const runtimeOnly = runtimeSessionIds.has(id);
    const cleanup = cleanupFns.get(id);
    if (cleanup) cleanupFns.delete(id);
    // Remove the session from every document in one synchronous mutation
    // block, then run the asynchronous runtime cleanup (port disconnect)
    // afterwards. A workspace turning read-only mid-cleanup can no longer
    // strand an already-disconnected session in the tab list.
    const currentIndex = sessions.value.findIndex((candidate) => candidate.id === id);
    const snapshot = Object.freeze<DeletedSessionSnapshot>({
      session: cloneStoppedSession(session),
      index: currentIndex,
      wasActive: activeSessionId.value === id,
      rebind: workspaceRebindBySessionId.value[id] ?? null,
      waveform: waveform.snapshotSession(id),
      mruSessionIds: Object.freeze(catalog.snapshotMruSessionIds()),
    });
    capture.removeSession(id);
    sessions.value = sessions.value.filter((session) => session.id !== id);
    runtimeSessionIds.delete(id);
    catalog.remove(id);
    persistenceTracker.clearDirty(id);
    const nextRebind = { ...workspaceRebindBySessionId.value };
    delete nextRebind[id];
    workspaceRebindBySessionId.value = Object.freeze(nextRebind);
    waveform.removeSession(id);
    if (snapshot.wasActive) {
      // Fall back to the most recently used remaining session — picking the
      // first tab would both surprise the user and corrupt the MRU order.
      const remainingIds = new Set(sessions.value.map((session) => session.id));
      const mruSuccessor = catalog
        .snapshotMruSessionIds()
        .find((candidate) => remainingIds.has(candidate));
      activeSessionId.value = mruSuccessor ?? sessions.value[0]?.id ?? null;
      if (activeSessionId.value) catalog.touch(activeSessionId.value);
    }
    schedulePersist();
    lastDeletedSession.value = runtimeOnly ? null : snapshot;
    notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
    if (cleanup) await cleanup();
    return snapshot;
  }

  function removeSession(id: string): Promise<DeletedSessionSnapshot | null> {
    return removeSessionInternal(id, false);
  }

  function removeRuntimeSession(id: string): Promise<DeletedSessionSnapshot | null> {
    if (!runtimeSessionIds.has(id)) return Promise.resolve(null);
    return removeSessionInternal(id, true);
  }

  function setActiveSession(id: string): void {
    if (!canMutateUserState()) return;
    if (!findSession(id)) return;
    activeSessionId.value = id;
    catalog.touch(id);
    schedulePersist();
    notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
  }

  function registerCleanup(id: string, fn: () => Promise<void>): void {
    cleanupFns.set(id, fn);
  }

  function setConnected(sessionId: string, connected: boolean): void {
    const session = findSession(sessionId);
    if (!session) return;
    session.isConnected = connected;
    if (connected) {
      if (!session.startTime) session.startTime = nowMillis();
    } else {
      session.startTime = null;
    }
  }

  function reorderSessions(fromIndex: number, toIndex: number): void {
    if (!canMutateUserState()) return;
    const reordered = reorderSessionCatalog(sessions.value, fromIndex, toIndex);
    if (!reordered) return;
    sessions.value = reordered;
    schedulePersist();
    notifyWorkspaceChange(Object.freeze({ kind: 'catalog-changed' }));
  }

  function isSessionConfigurationDirty(sessionId: string): boolean {
    return persistenceTracker.isDirty(sessionId);
  }

  /** Called only after the workspace service reports a clean, empty save
   * barrier. Legacy persistence uses its own generation-safe callback. */
  function markWorkspacePersisted(): void {
    persistenceTracker.markDurable();
  }

  function replaceWorkspaceSessions(
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

    // Clone and wrap every staged aggregate before changing any live store or
    // capture state. A clone failure therefore leaves the current workspace
    // byte-for-byte untouched.
    const preparedSessions = entries.map((entry) =>
      wrapSession(cloneStoppedSession(entry.session)),
    );
    const preparedRebind = Object.fromEntries(
      entries.map((entry) => [entry.session.id, Object.freeze({ ...entry.rebind })]),
    ) as Record<string, HydratedWorkspaceSession['rebind']>;
    const preparedWaveforms = waveform.prepareReplacement(
      entries.map((entry) => ({ sessionId: entry.session.id, waveform: entry.waveform })),
    );
    const nextActiveSessionId = catalog.replace(preparedSessions, requestedActiveSessionId);
    runtimeSessionIds.clear();
    capture.replaceSessions(preparedSessions);
    sessions.value = preparedSessions;
    activeSessionId.value = nextActiveSessionId;
    workspaceRebindBySessionId.value = Object.freeze(preparedRebind);
    waveform.replacePrepared(preparedWaveforms);
    // The replacement owns the full session set: drop cleanup closures for
    // sessions that no longer exist (runtime disposal itself goes through the
    // registry reconcile diff) so stale closures cannot linger or be reused.
    for (const registeredId of [...cleanupFns.keys()]) {
      if (!seen.has(registeredId)) cleanupFns.delete(registeredId);
    }
    lastDeletedSession.value = null;
    persistenceTracker.reset();
  }

  function completeWorkspaceRebind(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
  ): CompleteWorkspaceRebindResult {
    if (!canMutateUserState()) {
      return Object.freeze({ ok: false, reason: 'mutation-rejected' });
    }
    const session = findSession(sessionId);
    if (!session) return Object.freeze({ ok: false, reason: 'session-missing' });
    if (!workspaceRebindBySessionId.value[sessionId]) {
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
    const nextRebind = { ...workspaceRebindBySessionId.value };
    delete nextRebind[sessionId];
    workspaceRebindBySessionId.value = Object.freeze(nextRebind);
    schedulePersist(sessionId);
    notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId }));
    return Object.freeze({ ok: true });
  }

  function updateSessionConnectionSettingsInternal(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
    allowRuntimeWithoutWorkspaceMutation = false,
  ): boolean {
    if (
      !canMutateUserState() &&
      !(allowRuntimeWithoutWorkspaceMutation && runtimeSessionIds.has(sessionId))
    ) {
      return false;
    }
    const session = findSession(sessionId);
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
    schedulePersist(sessionId);
    notifyWorkspaceChange(Object.freeze({ kind: 'session-changed', sessionId }));
    return true;
  }

  function updateSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean {
    return updateSessionConnectionSettingsInternal(sessionId, portName, portConfig, displayName);
  }

  function updateRuntimeSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean {
    if (!runtimeSessionIds.has(sessionId)) return false;
    return updateSessionConnectionSettingsInternal(
      sessionId,
      portName,
      portConfig,
      displayName,
      true,
    );
  }

  function isPersistentSession(sessionId: string): boolean {
    return !runtimeSessionIds.has(sessionId);
  }

  function undoLastRemovedSession(): UndoDeletedSessionResult {
    if (!canMutateUserState()) {
      return Object.freeze({ ok: false, reason: 'mutation-rejected' });
    }
    const snapshot = lastDeletedSession.value;
    if (!snapshot) return Object.freeze({ ok: false, reason: 'nothing-to-undo' });
    if (findSession(snapshot.session.id)) {
      return Object.freeze({ ok: false, reason: 'id-conflict' });
    }
    const frameCount = snapshot.session.frames.length + snapshot.session.pausedFrames.length;
    const captureBytes = frameBuffersByteLength(snapshot.session);
    if (!mutationGate.preflightSessionRegistration(snapshot.session.id, frameCount, captureBytes)) {
      return Object.freeze({ ok: false, reason: 'limit-exceeded' });
    }

    const restored = wrapSession(cloneStoppedSession(snapshot.session));
    const insertionIndex = Math.max(0, Math.min(snapshot.index, sessions.value.length));
    const nextSessions = [...sessions.value];
    nextSessions.splice(insertionIndex, 0, restored);
    sessions.value = nextSessions;
    capture.initializeSession(restored);
    activeSessionId.value = catalog.merge(
      nextSessions,
      [restored.id],
      snapshot.wasActive ? restored.id : activeSessionId.value,
      snapshot.mruSessionIds,
      snapshot.wasActive ? null : activeSessionId.value,
    );
    if (snapshot.rebind) {
      workspaceRebindBySessionId.value = Object.freeze({
        ...workspaceRebindBySessionId.value,
        [restored.id]: snapshot.rebind,
      });
    }
    waveform.restoreSession(restored.id, snapshot.waveform);
    schedulePersist(restored.id);
    lastDeletedSession.value = null;
    notifyWorkspaceChange(Object.freeze({ kind: 'session-restored', sessionId: restored.id }));
    return Object.freeze({ ok: true, sessionId: restored.id });
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    userMutationsAllowed,
    runtimeCaptureAllowed,
    persistenceReadOnly,
    workspaceRebindBySessionId: readonly(workspaceRebindBySessionId),
    workspaceWaveformBySessionId: readonly(workspaceWaveformBySessionId),
    lastDeletedSession: readonly(lastDeletedSession),
    getSessionFramesVersion: capture.getSessionFramesVersion,
    createSession,
    createRuntimeSession,
    removeSession,
    removeRuntimeSession,
    undoLastRemovedSession,
    isSessionConfigurationDirty,
    markWorkspacePersisted,
    replaceWorkspaceSessions,
    completeWorkspaceRebind,
    updateSessionConnectionSettings,
    updateRuntimeSessionConnectionSettings,
    isPersistentSession,
    appendSessionWaveformSamples,
    replaceSessionWaveformSamples,
    setSessionWaveformChannelVisible,
    clearSessionWaveform,
    resetSessionWaveform,
    setSessionWaveformFrameCursor,
    commitSessionWaveformFrameIngest,
    setWorkspaceMutationPermissions,
    subscribeWorkspaceChanges,
    setActiveSession,
    registerCleanup,
    onFramesCleared: capture.onFramesCleared,
    addFrame: capture.addFrame,
    publishSessionFrames: capture.publishSessionFrames,
    setConnected,
    updateDroppedBytes: capture.updateDroppedBytes,
    clearFrames: capture.clearFrames,
    setCapturePaused: capture.setCapturePaused,
    ...documentMutations,
    ...settingsMutations,
    reorderSessions,
  };
});

/**
 * Select the workspace writer before creating a Pinia facade. This also
 * changes the new store's mutation permissions to fail-closed; hydration uses
 * explicit internal replacement APIs and therefore does not need this gate.
 */
export function enterWorkspaceSessionPersistenceMode(): void {
  workspacePersistenceSelected = true;
}

function cloneStoppedSession(session: SerialSession): SerialSession {
  const raw = toRaw(session);
  // Frame objects are immutable and safely shared, but the frame arrays are
  // appended in place on the live session — copy those one level deep so later
  // appends cannot leak into the clone. Everything else nested on a session is
  // only ever replaced wholesale (never mutated in place) by the document,
  // settings and capture controllers, so sharing beats a structuredClone that
  // would deep-copy up to 100k capture frames per removed/replaced session.
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
