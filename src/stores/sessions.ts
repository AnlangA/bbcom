import { defineStore } from 'pinia';
import { computed, markRaw, shallowRef, shallowReactive, triggerRef, ref } from 'vue';
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
  MAX_PERSISTED_SESSIONS,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_VERSION,
  cloneParserConfig,
  createSessionRecord,
  hydrateSession,
  migratePersistedFile,
  serializeSessionSnapshots,
  type PersistedSessionsFile,
} from '../lib/session-persistence';
import {
  appendFrameToSession,
  appendIdentifiedItem,
  flushPausedFramesToLive,
  normalizeLogAiFrameLimit,
  patchIdentifiedItem,
  removeIdentifiedItem,
  resetSessionFrames,
  upsertSendHistory,
} from '../lib/session-store-helpers';
import { isLocalStorageAvailable, loadJson, saveJson } from '../lib/storage';

const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_MAX_WAIT_MS = 2_500;

export const useSessionStore = defineStore('sessions', () => {
  const sessions = shallowRef<SerialSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const cleanupFns = new Map<string, () => Promise<void>>();
  let loaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDirtyAt = 0;

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null,
  );

  /**
   * Reactivity signal for frame-count consumers. `sessions` is a shallowRef, so
   * mutating `session.frames` (a plain array) does NOT auto-trigger the
   * dependents that read `session.frames.length` (DataPacketList, StatusBar,
   * ParserPanel, WaveformPanel, SessionTabs, SessionView). `framesVersion` is a
   * plain ref bumped on every frame-affecting mutation; consumers may depend on
   * it directly, and `triggerRef(sessions)` re-runs any effect/computed that
   * read `sessions.value` (the path templates take). Together they replace the
   * implicit deep-reactivity of the old `ref` without a deep:true watcher (AP-3).
   */
  const framesVersion = ref(0);
  function notifyFramesChanged(): void {
    framesVersion.value += 1;
    triggerRef(sessions);
  }

  /**
   * Wrap a plain session record in a shallowReactive proxy. This is the crux of
   * the T2.2 reactivity model: the sessions array is a shallowRef (so pushing
   * 100k+ frames never builds deep per-byte traps), but each session's scalar
   * config fields (sendDraft, modbusConfig, isConnected, ...) must stay reactive
   * so a `session.sendDraft = x` write flows to the component reading it WITHOUT
   * relying on activeSession's computed cache (which returns the same proxy ref
   * and therefore would not invalidate downstream render effects on its own).
   *
   * shallowReactive makes only the top-level keys reactive: nested objects
   * (frames, modbusRegisters, logAiMessages) are kept raw, which is exactly what
   * we want — those are mutated in bulk and surfaced via notifyFramesChanged /
   * triggerRef(sessions) rather than per-element traps. Frame items are already
   * markRaw'd at creation, so wrapping is a no-op for them.
   */
  function wrapSession(session: SerialSession): SerialSession {
    return shallowReactive(session);
  }

  function loadPersistedSessions() {
    const raw = loadJson<PersistedSessionsFile>(SESSION_STORAGE_KEY, {
      version: SESSION_STORAGE_VERSION,
      activeSessionId: null,
      sessions: [],
    });
    // COW-5: run the persisted blob through the versioned migration chain before
    // hydrating, so a future shape change lands forward-compatible and testable.
    const saved = migratePersistedFile(raw);
    if (!Array.isArray(saved.sessions)) {
      loaded = true;
      return;
    }

    const restored = saved.sessions
      .slice(0, MAX_PERSISTED_SESSIONS)
      .map((raw) => hydrateSession(raw, { decorateFrame: markRaw }))
      .filter((s): s is SerialSession => s !== null)
      .map((session) => wrapSession(session));
    sessions.value = restored;
    activeSessionId.value =
      typeof saved.activeSessionId === 'string' &&
      restored.some((session) => session.id === saved.activeSessionId)
        ? saved.activeSessionId
        : (restored[0]?.id ?? null);
    loaded = true;
  }

  function serializeSessions(): PersistedSessionsFile {
    return serializeSessionSnapshots(sessions.value, activeSessionId.value);
  }

  function flushPersistedSessions() {
    if (!loaded) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    firstDirtyAt = 0;
    saveJson(SESSION_STORAGE_KEY, serializeSessions());
  }

  function schedulePersist() {
    // Always notify shallowRef consumers (every mutator calls this); the guard
    // below only short-circuits the persistence debounce, not reactivity.
    notifyFramesChanged();
    if (!loaded || !isLocalStorageAvailable()) return;
    const now = nowMillis();
    if (firstDirtyAt === 0) firstDirtyAt = now;
    if (saveTimer) clearTimeout(saveTimer);
    const elapsed = now - firstDirtyAt;
    const delay = elapsed >= PERSIST_MAX_WAIT_MS ? 0 : PERSIST_DEBOUNCE_MS;
    saveTimer = setTimeout(flushPersistedSessions, delay);
  }

  function createSession(portName: string, portConfig: SerialSession['portConfig']): string {
    const id = crypto.randomUUID();
    sessions.value.push(wrapSession(createSessionRecord(id, portName, portConfig)));
    activeSessionId.value = id;
    schedulePersist();
    return id;
  }

  async function removeSession(id: string) {
    const cleanup = cleanupFns.get(id);
    if (cleanup) {
      cleanupFns.delete(id);
      await cleanup();
    }
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id ?? null;
    }
    schedulePersist();
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id;
    schedulePersist();
  }

  function registerCleanup(id: string, fn: () => Promise<void>) {
    cleanupFns.set(id, fn);
  }

  function addFrame(
    sessionId: string,
    frame: Omit<DataFrame, 'id' | 'timestamp'>,
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

    appendFrameToSession(session, fullFrame, maxBufferFrames.value);

    schedulePersist();
    return fullFrame;
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
    schedulePersist();
  }

  /** Mirror the SerialRxQueue's cumulative dropped-byte count onto the session
   *  so the StatusBar can surface it as a live metric (T3.5). Runtime-only. */
  function updateDroppedBytes(sessionId: string, total: number) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.droppedBytes = total;
    notifyFramesChanged();
  }

  function clearFrames(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    resetSessionFrames(session);
    schedulePersist();
  }

  function setCapturePaused(sessionId: string, paused: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session || session.capturePaused === paused) return;
    session.capturePaused = paused;
    if (!paused && session.pausedFrames.length > 0) {
      // Flush the off-screen buffer back into the live view, preserving order.
      flushPausedFramesToLive(session, maxBufferFrames.value);
    }
    schedulePersist();
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
    appendIdentifiedItem(session.quickCommands, command);
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
    const id = appendIdentifiedItem(session.macros, macro);
    schedulePersist();
    return id;
  }

  function updateMacro(sessionId: string, macroId: string, patch: Partial<Omit<Macro, 'id'>>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    if (!patchIdentifiedItem(session.macros, macroId, patch)) return;
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
    const id = appendIdentifiedItem(session.triggers, trigger);
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
    if (!patchIdentifiedItem(session.triggers, triggerId, patch)) return;
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
    const id = appendIdentifiedItem(session.highlights, highlight);
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
    if (!patchIdentifiedItem(session.highlights, highlightId, patch)) return;
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
    notifyFramesChanged();
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
    session.logAiMessages.push(
      markRaw({
        ...message,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      }),
    );
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
    const [moved] = sessions.value.splice(fromIndex, 1);
    sessions.value.splice(toIndex, 0, moved);
    schedulePersist();
  }

  loadPersistedSessions();

  return {
    sessions,
    activeSessionId,
    activeSession,
    // Reactivity signal: bump on every frame-affecting mutation. Consumers that
    // read session.frames.length through the shallowRef sessions should track
    // this (or rely on the triggerRef), since the frames array is non-reactive.
    framesVersion,
    createSession,
    removeSession,
    setActiveSession,
    registerCleanup,
    addFrame,
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
  };
});
