import { defineStore } from 'pinia';
import { computed, markRaw, shallowRef, shallowReactive, toRaw, ref } from 'vue';
import type {
  AiChatMessage,
  AiModel,
  DataFrame,
  HighlightRule,
  LogAiContextMode,
  Macro,
  ModbusMasterConfig,
  ModbusRegister,
  SendHistoryEntry,
  SerialSession,
  Trigger,
  WaveformSourceMode,
} from '../types';
import type { ParserConfig } from '../lib/protocol-parser';
import { MAX_HISTORY } from '../types';
import { maxBufferFrames } from '../lib/buffer-config';
import { nowMillis } from '../lib/time';
import {
  cloneModbusConfig,
  normalizeModbusRegister,
  normalizeModbusRegisters,
} from '../lib/modbus';
import {
  SESSION_STORAGE_FUTURE_BACKUP_KEY,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_VERSION,
  UnsupportedSessionStorageVersionError,
  cloneParserConfig,
  createSessionRecord,
  hydrateSession,
  migratePersistedFile,
  sessionSnapshotsForLocalStorage,
  serializeSessionSnapshots,
  type PersistedSessionsFile,
} from '../lib/session-persistence';
import {
  createWorkerSessionStateClient,
  migrateLegacySessionState,
  sessionStateFilesEqual,
  type SessionStatePersistenceClient,
} from '../lib/session-state-client';
import { SessionPersistenceScheduler } from '../lib/session-persistence-scheduler';
import {
  appendFrameToSession,
  appendIdentifiedItem,
  frameBuffersByteLength,
  flushPausedFramesToLive,
  MAX_GLOBAL_FRAME_BYTES,
  MAX_SESSION_FRAME_BYTES,
  normalizeLogAiFrameLimit,
  patchIdentifiedItem,
  removeIdentifiedItem,
  resetSessionFrames,
  trimSessionsToGlobalByteLimit,
  upsertSendHistory,
} from '../lib/session-store-helpers';
import {
  isLocalStorageAvailable,
  loadString,
  removeString,
  saveJson,
  saveString,
} from '../lib/storage';
import { logger } from '../lib/logger';

export const useSessionStore = defineStore('sessions', () => {
  const sessions = shallowRef<SerialSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const cleanupFns = new Map<string, () => Promise<void>>();
  const frameClearListeners = new Map<string, Set<() => void>>();
  const sessionFramesVersions = shallowReactive<Record<string, number>>({});
  const sessionFrameBytes = new Map<string, number>();
  const rxQueueDroppedBytes = new Map<string, number>();
  const frameBufferDroppedBytes = new Map<string, number>();
  let totalFrameBytes = 0;
  const persistenceReadOnly = ref(false);
  let mruSessionIds: string[] = [];
  let persistenceClient: SessionStatePersistenceClient | null = createWorkerSessionStateClient();
  let loaded = false;
  let stateRevision = 0;
  let pendingConfigDirty = false;
  let pendingMruDirty = false;
  let pendingFramesDirty = false;
  let persistenceReadyPromise: Promise<void> = Promise.resolve();
  let workerSaveChain: Promise<void> = Promise.resolve();

  const persistenceScheduler = new SessionPersistenceScheduler(writePersistedSnapshot, {
    onError: (error) => logger.warn('session persistence flush failed', error),
  });

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null,
  );

  /** Per-session invalidation avoids repainting unrelated resident sessions. */
  function getSessionFramesVersion(sessionId: string): number {
    return sessionFramesVersions[sessionId] ?? 0;
  }

  function notifyFramesChanged(sessionId: string): void {
    sessionFramesVersions[sessionId] = getSessionFramesVersion(sessionId) + 1;
  }

  function initializeFrameRuntimeState(session: SerialSession): void {
    const retainedBytes = frameBuffersByteLength(session);
    sessionFramesVersions[session.id] = 0;
    sessionFrameBytes.set(session.id, retainedBytes);
    rxQueueDroppedBytes.set(session.id, 0);
    frameBufferDroppedBytes.set(session.id, 0);
    totalFrameBytes += retainedBytes;
  }

  function setRetainedFrameBytes(sessionId: string, retainedBytes: number): void {
    const previous = sessionFrameBytes.get(sessionId) ?? 0;
    sessionFrameBytes.set(sessionId, retainedBytes);
    totalFrameBytes += retainedBytes - previous;
  }

  function addFrameBufferDrop(sessionId: string, droppedBytes: number): void {
    if (droppedBytes <= 0) return;
    frameBufferDroppedBytes.set(
      sessionId,
      (frameBufferDroppedBytes.get(sessionId) ?? 0) + droppedBytes,
    );
    const session = sessions.value.find((candidate) => candidate.id === sessionId);
    if (session) {
      session.droppedBytes =
        (rxQueueDroppedBytes.get(sessionId) ?? 0) + (frameBufferDroppedBytes.get(sessionId) ?? 0);
    }
  }

  function enforceGlobalFrameByteLimit(): Set<string> | undefined {
    // The normal capture path stays under the 256 MiB process budget. Avoid
    // allocating an empty Set for every individual frame in that hot path;
    // create tracking state only when a global eviction actually occurs.
    if (totalFrameBytes <= MAX_GLOBAL_FRAME_BYTES) return undefined;
    const affected = new Set<string>();
    const result = trimSessionsToGlobalByteLimit(
      sessions.value,
      totalFrameBytes,
      MAX_GLOBAL_FRAME_BYTES,
    );
    totalFrameBytes = result.retainedBytes;
    for (const [sessionId, droppedBytes] of result.droppedBytesBySession) {
      sessionFrameBytes.set(
        sessionId,
        Math.max(0, (sessionFrameBytes.get(sessionId) ?? 0) - droppedBytes),
      );
      addFrameBufferDrop(sessionId, droppedBytes);
      affected.add(sessionId);
    }
    return affected;
  }

  /**
   * Wrap a plain session record in a shallowReactive proxy. This is the crux of
   * the high-volume frame reactivity model: the sessions array is a shallowRef
   * (so pushing 100k+ frames never builds deep per-byte traps), but each
   * session's scalar config fields (sendDraft, modbusConfig, isConnected, ...)
   * must stay reactive so a `session.sendDraft = x` write flows to the component
   * reading it without relying on activeSession's computed cache (which returns
   * the same proxy ref and therefore would not invalidate downstream render
   * effects on its own).
   *
   * shallowReactive makes only the top-level keys reactive: nested objects are
   * kept raw. Config collections are therefore replaced through their top-level
   * session key, while the high-volume frame buffers use notifyFramesChanged()
   * instead of per-element traps. Frame items are already markRaw'd at creation,
   * so wrapping is a no-op for them.
   */
  function wrapSession(session: SerialSession): SerialSession {
    return shallowReactive(session);
  }

  function replaceSessionsFromFile(saved: PersistedSessionsFile): void {
    totalFrameBytes = 0;
    sessionFrameBytes.clear();
    rxQueueDroppedBytes.clear();
    frameBufferDroppedBytes.clear();
    for (const id of Object.keys(sessionFramesVersions)) delete sessionFramesVersions[id];

    const restored = saved.sessions
      .map((raw) => hydrateSession(raw, { decorateFrame: markRaw }))
      .filter((session): session is SerialSession => session !== null)
      .map((session) => wrapSession(session));
    sessions.value = restored;
    for (const session of restored) initializeFrameRuntimeState(session);
    activeSessionId.value =
      typeof saved.activeSessionId === 'string' &&
      restored.some((session) => session.id === saved.activeSessionId)
        ? saved.activeSessionId
        : (restored[0]?.id ?? null);
    const validIds = new Set(restored.map((session) => session.id));
    mruSessionIds = (saved.mruSessionIds ?? []).filter((id) => validIds.has(id));
    if (activeSessionId.value) touchMruSession(activeSessionId.value);
  }

  function mergeSessionsFromFile(saved: PersistedSessionsFile): void {
    const existingIds = new Set(sessions.value.map((session) => session.id));
    const restored = saved.sessions
      .map((raw) => hydrateSession(raw, { decorateFrame: markRaw }))
      .filter((session): session is SerialSession => session !== null)
      .filter((session) => !existingIds.has(session.id))
      .map((session) => wrapSession(session));
    if (restored.length > 0) {
      sessions.value = [...restored, ...sessions.value];
      for (const session of restored) initializeFrameRuntimeState(session);
    }
    mruSessionIds = [
      ...mruSessionIds,
      ...(saved.mruSessionIds ?? []),
      ...restored.map((session) => session.id),
    ]
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, 8);
    if (!activeSessionId.value) {
      activeSessionId.value =
        saved.activeSessionId &&
        sessions.value.some((session) => session.id === saved.activeSessionId)
          ? saved.activeSessionId
          : (sessions.value[0]?.id ?? null);
    }
    if (activeSessionId.value) touchMruSession(activeSessionId.value);
  }

  function canonicalizePersistedFile(file: PersistedSessionsFile): PersistedSessionsFile {
    const hydrated = file.sessions
      .map((raw) => hydrateSession(raw))
      .filter((session): session is SerialSession => session !== null);
    const activeSessionId =
      file.activeSessionId && hydrated.some((session) => session.id === file.activeSessionId)
        ? file.activeSessionId
        : (hydrated[0]?.id ?? null);
    return serializeSessionSnapshots(hydrated, activeSessionId, {
      mruSessionIds: file.mruSessionIds,
      includeFrames: true,
    });
  }

  function readLegacySnapshot(): { raw: string; file: PersistedSessionsFile } | null {
    const raw = loadString(SESSION_STORAGE_KEY);
    if (!raw) return null;
    try {
      // Keep legacy data intact until the IndexedDB transaction has completed
      // and been read back. In particular, direct v1 recovery must retain
      // valid imported Modbus runtime values while the old key is still the
      // durable source of truth.
      const migrated = migratePersistedFile(JSON.parse(raw) as unknown);
      return { raw, file: migrated };
    } catch (error) {
      if (error instanceof UnsupportedSessionStorageVersionError) {
        // Preserve the original bytes and disable every persistence write.
        saveString(SESSION_STORAGE_FUTURE_BACKUP_KEY, raw);
        persistenceReadOnly.value = true;
      } else {
        logger.warn('legacy session snapshot is malformed', error);
      }
      return null;
    }
  }

  function touchMruSession(sessionId: string): void {
    mruSessionIds = [sessionId, ...mruSessionIds.filter((id) => id !== sessionId)].slice(0, 8);
  }

  function resumePendingPersistence(): void {
    if (persistenceReadOnly.value) return;
    if (pendingMruDirty) {
      pendingMruDirty = false;
      pendingFramesDirty = false;
      pendingConfigDirty = false;
      persistenceScheduler.markConfigDirty(true);
      return;
    }
    if (pendingFramesDirty) {
      pendingFramesDirty = false;
      pendingConfigDirty = false;
      persistenceScheduler.markFramesDirty();
      return;
    }
    if (pendingConfigDirty) {
      pendingConfigDirty = false;
      persistenceScheduler.markConfigDirty();
    }
  }

  async function initializeWorkerPersistence(
    legacy: { raw: string; file: PersistedSessionsFile } | null,
    initialRevision: number,
  ): Promise<void> {
    const client = persistenceClient;
    if (!client) return;
    try {
      const result = await client.load();
      if (result.kind === 'future') {
        persistenceReadOnly.value = true;
        persistenceScheduler.dispose();
        client.dispose();
        if (stateRevision === initialRevision) {
          replaceSessionsFromFile({
            version: SESSION_STORAGE_VERSION,
            activeSessionId: null,
            mruSessionIds: [],
            sessions: [],
          });
        }
        return;
      }

      if (result.kind === 'current') {
        const migrated = migratePersistedFile(result.file);
        const saved = canonicalizePersistedFile(migrated);
        if (stateRevision === initialRevision) replaceSessionsFromFile(saved);
        else mergeSessionsFromFile(saved);
        if (legacy && sessionStateFilesEqual(legacy.file, saved)) {
          // The successful worker load is the required IndexedDB readback.
          removeString(SESSION_STORAGE_KEY);
        }
        if (!sessionStateFilesEqual(result.file, saved)) pendingFramesDirty = true;
        return;
      }

      if (legacy) {
        const migrated = await migrateLegacySessionState(legacy.file, client, () => {
          removeString(SESSION_STORAGE_KEY);
        });
        if (!migrated) throw new Error('IndexedDB migration readback did not match');
        if (stateRevision === initialRevision) replaceSessionsFromFile(legacy.file);
        else mergeSessionsFromFile(legacy.file);
      }
    } catch (error) {
      // Keep the legacy key as the durable fallback. A worker/IDB failure must
      // never turn a successful previous launch into data loss.
      logger.warn('IndexedDB session persistence unavailable; using localStorage fallback', error);
      client.dispose();
      persistenceClient = null;
      if (legacy && stateRevision === initialRevision) replaceSessionsFromFile(legacy.file);
      else if (legacy) mergeSessionsFromFile(legacy.file);
    } finally {
      loaded = true;
      resumePendingPersistence();
    }
  }

  function loadPersistedSessions(): Promise<void> {
    const legacy = readLegacySnapshot();
    if (persistenceReadOnly.value) {
      loaded = true;
      return Promise.resolve();
    }
    if (!persistenceClient) {
      if (legacy) replaceSessionsFromFile(legacy.file);
      loaded = true;
      return Promise.resolve();
    }
    const initialRevision = stateRevision;
    return initializeWorkerPersistence(legacy, initialRevision);
  }

  function serializeSessions(includeFrames: boolean): PersistedSessionsFile {
    return serializeSessionSnapshots(sessions.value, activeSessionId.value, {
      mruSessionIds,
      includeFrames,
    });
  }

  function writePersistedSnapshot(includeFrames: boolean): Promise<void> {
    if (!loaded || persistenceReadOnly.value) return Promise.resolve();
    if (!persistenceClient) {
      if (isLocalStorageAvailable()) {
        saveJson(SESSION_STORAGE_KEY, sessionSnapshotsForLocalStorage(serializeSessions(true)));
      }
      return Promise.resolve();
    }
    const snapshot = serializeSessions(includeFrames);
    const write = workerSaveChain
      .catch(() => undefined)
      .then(() => {
        if (!persistenceClient || persistenceReadOnly.value) return;
        return persistenceClient.save(snapshot, includeFrames);
      });
    workerSaveChain = write;
    return write;
  }

  function schedulePersist(kind: 'config' | 'frames' | 'mru' = 'config'): void {
    stateRevision += 1;
    if (persistenceReadOnly.value) return;
    if (!loaded) {
      if (kind === 'frames') pendingFramesDirty = true;
      else if (kind === 'mru') pendingMruDirty = true;
      else pendingConfigDirty = true;
      return;
    }
    if (!persistenceClient && !isLocalStorageAvailable()) return;
    if (kind === 'frames') persistenceScheduler.markFramesDirty();
    else if (kind === 'mru') persistenceScheduler.markConfigDirty(true);
    else persistenceScheduler.markConfigDirty();
  }

  async function flushPersistedSessions(): Promise<void> {
    if (persistenceReadOnly.value) return;
    if (!loaded) {
      pendingConfigDirty = true;
      pendingFramesDirty = true;
      await persistenceReadyPromise;
    }
    if (persistenceReadOnly.value) return;
    await persistenceScheduler.flushNow();
  }

  function flushFinalPersistence(): Promise<'completed' | 'timeout'> {
    return persistenceScheduler.flushFinal();
  }

  function createSession(portName: string, portConfig: SerialSession['portConfig']): string {
    const id = crypto.randomUUID();
    const session = wrapSession(createSessionRecord(id, portName, portConfig));
    sessions.value = [...sessions.value, session];
    initializeFrameRuntimeState(session);
    activeSessionId.value = id;
    touchMruSession(id);
    schedulePersist('mru');
    return id;
  }

  async function removeSession(id: string) {
    const cleanup = cleanupFns.get(id);
    if (cleanup) {
      cleanupFns.delete(id);
      await cleanup();
    }
    const retainedBytes = sessionFrameBytes.get(id) ?? 0;
    totalFrameBytes = Math.max(0, totalFrameBytes - retainedBytes);
    sessionFrameBytes.delete(id);
    rxQueueDroppedBytes.delete(id);
    frameBufferDroppedBytes.delete(id);
    frameClearListeners.delete(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    mruSessionIds = mruSessionIds.filter((sessionId) => sessionId !== id);
    delete sessionFramesVersions[id];
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id ?? null;
      if (activeSessionId.value) touchMruSession(activeSessionId.value);
    }
    schedulePersist('mru');
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id;
    touchMruSession(id);
    schedulePersist('mru');
  }

  function registerCleanup(id: string, fn: () => Promise<void>) {
    cleanupFns.set(id, fn);
  }

  /**
   * Subscribe to an explicit terminal-buffer clear for a session. Runtime data
   * planes use this to reset stream state without observing UI frame renders.
   */
  function onFramesCleared(sessionId: string, listener: () => void): () => void {
    let listeners = frameClearListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      frameClearListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = frameClearListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) frameClearListeners.delete(sessionId);
    };
  }

  function notifyFramesCleared(sessionId: string): void {
    const listeners = frameClearListeners.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (listenerError) {
        // A headless runtime must never prevent an explicit user clear from
        // completing; it can recover its own state independently.
        logger.warn('session frame-clear listener failed', listenerError);
      }
    }
  }

  function addFrame(
    sessionId: string,
    frame: Omit<DataFrame, 'id' | 'timestamp'>,
    options: { publish?: boolean } = {},
  ): DataFrame | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;

    // Frames are immutable after creation; markRaw opts them (and their
    // Uint8Array payload) out of deep reactivity, so Vue never builds per-byte
    // proxy traps across up to maxBufferFrames entries — the dominant cost at
    // high baud rates. The arrays themselves stay reactive (length changes
    // still trigger updates); only the element contents are raw.
    const fullFrame: DataFrame = markRaw({
      ...frame,
      id: crypto.randomUUID(),
      timestamp: nowMillis(),
    });

    // Pass the raw (non-proxied) session target: the per-frame byte/frame
    // counter bumps (session.rxBytes += ...) would otherwise cross the
    // shallowReactive proxy on every frame — measured ~14ms/50k for a single
    // counter, ~38% of the addFrame hot path — while their only consumer (the
    // StatusBar) is refreshed anyway via the notifyFramesChanged() channel
    // below. Writing the raw underlying object keeps the values correct (the
    // proxy reads through to the same target) without per-frame setter cost.
    const currentBytes = sessionFrameBytes.get(sessionId) ?? frameBuffersByteLength(session);
    const trim = appendFrameToSession(toRaw(session), fullFrame, maxBufferFrames.value, {
      currentBytes,
      maxBytes: MAX_SESSION_FRAME_BYTES,
    });
    setRetainedFrameBytes(sessionId, trim.retainedBytes);
    addFrameBufferDrop(sessionId, trim.droppedBytes);
    const globallyTrimmed = enforceGlobalFrameByteLimit();

    if (options.publish !== false) notifyFramesChanged(sessionId);
    if (globallyTrimmed) {
      for (const affectedSessionId of globallyTrimmed) {
        if (affectedSessionId !== sessionId) notifyFramesChanged(affectedSessionId);
      }
    }
    schedulePersist('frames');
    return fullFrame;
  }

  /** Publish a batch of frames that were appended with `publish:false`. */
  function publishSessionFrames(sessionId: string) {
    if (!sessions.value.some((session) => session.id === sessionId)) return;
    notifyFramesChanged(sessionId);
  }

  function setConnected(sessionId: string, connected: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.isConnected = connected;
    if (connected) {
      if (!session.startTime) session.startTime = nowMillis();
    } else {
      // Reset so the StatusBar duration reflects the active connection and
      // does not accumulate offline time across reconnects.
      session.startTime = null;
    }
    // Connection state and duration are runtime-only and are intentionally not
    // included in session metadata snapshots.
  }

  /** Mirror the SerialRxQueue's cumulative dropped-byte count onto the session
   *  so the StatusBar can surface it as a live runtime metric. */
  function updateDroppedBytes(sessionId: string, total: number) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const normalized = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    rxQueueDroppedBytes.set(sessionId, normalized);
    session.droppedBytes = normalized + (frameBufferDroppedBytes.get(sessionId) ?? 0);
  }

  function clearFrames(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const hadFrames = session.frames.length > 0 || session.pausedFrames.length > 0;
    if (hadFrames) setRetainedFrameBytes(sessionId, 0);
    resetSessionFrames(session);
    if (hadFrames) {
      notifyFramesChanged(sessionId);
    }
    // The resident raw-byte protocol parser can hold completed/partial data
    // before the terminal capture queue publishes its first DataFrame. An
    // explicit clear must reset that independent stream even when both capture
    // arrays are currently empty.
    notifyFramesCleared(sessionId);
    schedulePersist('frames');
  }

  function setCapturePaused(sessionId: string, paused: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session || session.capturePaused === paused) return;
    session.capturePaused = paused;
    if (!paused && session.pausedFrames.length > 0) {
      // Flush the off-screen buffer back into the live view, preserving order.
      const trim = flushPausedFramesToLive(session, maxBufferFrames.value, {
        currentBytes: sessionFrameBytes.get(sessionId) ?? frameBuffersByteLength(session),
        maxBytes: MAX_SESSION_FRAME_BYTES,
      });
      setRetainedFrameBytes(sessionId, trim.retainedBytes);
      addFrameBufferDrop(sessionId, trim.droppedBytes);
      notifyFramesChanged(sessionId);
    }
    schedulePersist('frames');
  }

  function addSendHistory(sessionId: string, entry: SendHistoryEntry) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = upsertSendHistory(session.sendHistory, entry, MAX_HISTORY);
    schedulePersist();
  }

  function clearSendHistory(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = [];
    schedulePersist();
  }

  function setSendDraft(sessionId: string, draft: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendDraft = draft;
    schedulePersist();
  }

  function addQuickCommand(
    sessionId: string,
    command: Omit<SerialSession['quickCommands'][number], 'id'>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const commands = [...session.quickCommands];
    appendIdentifiedItem(commands, command);
    session.quickCommands = commands;
    schedulePersist();
  }

  function removeQuickCommand(sessionId: string, commandId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.quickCommands = removeIdentifiedItem(session.quickCommands, commandId);
    schedulePersist();
  }

  function addMacro(sessionId: string, macro: Omit<Macro, 'id'>): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const macros = [...session.macros];
    const id = appendIdentifiedItem(macros, macro);
    session.macros = macros;
    schedulePersist();
    return id;
  }

  function updateMacro(sessionId: string, macroId: string, patch: Partial<Omit<Macro, 'id'>>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const macros = [...session.macros];
    if (!patchIdentifiedItem(macros, macroId, patch)) return;
    session.macros = macros;
    schedulePersist();
  }

  function removeMacro(sessionId: string, macroId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.macros = removeIdentifiedItem(session.macros, macroId);
    schedulePersist();
  }

  function addTrigger(sessionId: string, trigger: Omit<Trigger, 'id'>): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const triggers = [...session.triggers];
    const id = appendIdentifiedItem(triggers, trigger);
    session.triggers = triggers;
    schedulePersist();
    return id;
  }

  function updateTrigger(
    sessionId: string,
    triggerId: string,
    patch: Partial<Omit<Trigger, 'id'>>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const triggers = [...session.triggers];
    if (!patchIdentifiedItem(triggers, triggerId, patch)) return;
    session.triggers = triggers;
    schedulePersist();
  }

  function removeTrigger(sessionId: string, triggerId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.triggers = removeIdentifiedItem(session.triggers, triggerId);
    schedulePersist();
  }

  function addHighlight(
    sessionId: string,
    highlight: Omit<HighlightRule, 'id'>,
  ): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const highlights = [...session.highlights];
    const id = appendIdentifiedItem(highlights, highlight);
    session.highlights = highlights;
    schedulePersist();
    return id;
  }

  function updateHighlight(
    sessionId: string,
    highlightId: string,
    patch: Partial<Omit<HighlightRule, 'id'>>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const highlights = [...session.highlights];
    if (!patchIdentifiedItem(highlights, highlightId, patch)) return;
    session.highlights = highlights;
    schedulePersist();
  }

  function removeHighlight(sessionId: string, highlightId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.highlights = removeIdentifiedItem(session.highlights, highlightId);
    schedulePersist();
  }

  function setParserState(sessionId: string, config: ParserConfig, presetId?: string | null) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.parserState = {
      config: cloneParserConfig(config),
      presetId: presetId === undefined ? session.parserState.presetId : presetId,
    };
    schedulePersist();
  }

  function addModbusRegister(
    sessionId: string,
    reg: Omit<ModbusRegister, 'id' | 'value' | 'values' | 'valueTs'>,
  ): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.modbusRegisters = [
      ...session.modbusRegisters,
      normalizeModbusRegister({ ...reg, id, value: null, values: null, valueTs: null }),
    ];
    schedulePersist();
    return id;
  }

  function updateModbusRegister(
    sessionId: string,
    regId: string,
    patch: Partial<Omit<ModbusRegister, 'id'>>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.modbusRegisters.findIndex((r) => r.id === regId);
    if (idx === -1) return;
    session.modbusRegisters = session.modbusRegisters.map((reg, index) =>
      index === idx ? normalizeModbusRegister({ ...reg, ...patch, id: reg.id }) : reg,
    );
    schedulePersist();
  }

  function removeModbusRegister(sessionId: string, regId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.modbusRegisters = session.modbusRegisters.filter((r) => r.id !== regId);
    schedulePersist();
  }

  /**
   * Bulk-replace the register table. Used by "load .bbreg" snapshot import and
   * by tests. Skips persistence when the caller is only updating runtime values
   * (value/valueTs) via {@link setModbusRegisterValues}.
   */
  function setModbusRegisters(sessionId: string, regs: ModbusRegister[]) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.modbusRegisters = normalizeModbusRegisters(regs);
    schedulePersist();
  }

  /**
   * Apply a batch of decoded values to the register table (keyed by row id) as a
   * single reactive write — the poll loop calls this once per tick with every
   * register it read, so the table repaints once instead of per-register.
   * Runtime-only → does not schedule persistence.
   */
  function setModbusRegisterValues(
    sessionId: string,
    values: Array<{ id: string; value: number; values?: number[] | null; valueTs: number }>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    if (values.length === 0) return;
    const byId = new Map(values.map((v) => [v.id, v]));
    // Build a fresh array so Vue detects the change in one shot.
    session.modbusRegisters = session.modbusRegisters.map((reg) => {
      const hit = byId.get(reg.id);
      if (!hit) return reg;
      return {
        ...reg,
        value: hit.value,
        values: hit.values === undefined ? reg.values : hit.values,
        valueTs: hit.valueTs,
      };
    });
  }

  function setModbusConfig(sessionId: string, patch: Partial<ModbusMasterConfig>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.modbusConfig = cloneModbusConfig({ ...session.modbusConfig, ...patch });
    schedulePersist();
  }

  function setWaveformSourceMode(sessionId: string, mode: WaveformSourceMode) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.waveformSourceMode = mode;
    schedulePersist();
  }

  /** Enable auto-logging to `path`, or disable it when `path` is null. Sets
   * logPath and autoLogEnabled together so they can never disagree. */
  function setAutoLogTarget(sessionId: string, path: string | null) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logPath = path;
    session.autoLogEnabled = path !== null;
    schedulePersist();
  }

  function setTerminalAiModel(sessionId: string, model: AiModel) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.terminalAiModel = model;
    schedulePersist();
  }

  function setLogAiModel(sessionId: string, model: AiModel) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiModel = model;
    schedulePersist();
  }

  function setLogAiContextMode(sessionId: string, mode: LogAiContextMode) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiContextMode = mode;
    schedulePersist();
  }

  function setLogAiFrameLimit(sessionId: string, limit: number) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiFrameLimit = normalizeLogAiFrameLimit(limit);
    schedulePersist();
  }

  function addLogAiMessage(sessionId: string, message: Omit<AiChatMessage, 'id' | 'timestamp'>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiMessages = [
      ...session.logAiMessages,
      markRaw({
        ...message,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      }),
    ];
    schedulePersist();
  }

  function clearLogAiMessages(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiMessages = [];
    schedulePersist();
  }

  function reorderSessions(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= sessions.value.length) return;
    if (toIndex < 0 || toIndex >= sessions.value.length) return;
    const reordered = [...sessions.value];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    sessions.value = reordered;
    schedulePersist();
  }

  persistenceReadyPromise = loadPersistedSessions();

  function whenPersistenceReady(): Promise<void> {
    return persistenceReadyPromise;
  }

  if (typeof window !== 'undefined') {
    const requestFinalFlush = () => {
      void flushFinalPersistence();
    };
    window.addEventListener('pagehide', requestFinalFlush);
    window.addEventListener('beforeunload', requestFinalFlush);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') requestFinalFlush();
      });
    }
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    persistenceReadOnly,
    getSessionFramesVersion,
    createSession,
    removeSession,
    setActiveSession,
    registerCleanup,
    onFramesCleared,
    addFrame,
    publishSessionFrames,
    setConnected,
    updateDroppedBytes,
    clearFrames,
    setCapturePaused,
    addSendHistory,
    clearSendHistory,
    setSendDraft,
    addQuickCommand,
    removeQuickCommand,
    addMacro,
    updateMacro,
    removeMacro,
    addTrigger,
    updateTrigger,
    removeTrigger,
    addHighlight,
    updateHighlight,
    removeHighlight,
    setParserState,
    addModbusRegister,
    updateModbusRegister,
    removeModbusRegister,
    setModbusRegisters,
    setModbusRegisterValues,
    setModbusConfig,
    setWaveformSourceMode,
    setAutoLogTarget,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
    reorderSessions,
    flushPersistedSessions,
    flushFinalPersistence,
    whenPersistenceReady,
  };
});
