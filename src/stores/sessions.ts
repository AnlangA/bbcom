import { defineStore } from 'pinia';
import { computed, markRaw, ref } from 'vue';
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
} from '../lib/modbus-registers';
import {
  MAX_PERSISTED_SESSIONS,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_VERSION,
  cloneParserConfig,
  createSessionRecord,
  hydrateSession,
  serializeSessionSnapshots,
  type PersistedSessionsFile,
} from '../lib/session-persistence';
import { isLocalStorageAvailable, loadJson, saveJson } from '../lib/storage';

const FRAME_TRIM_THRESHOLD = 500;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_MAX_WAIT_MS = 2_500;

export const useSessionStore = defineStore('sessions', () => {
  const sessions = ref<SerialSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const cleanupFns = new Map<string, () => Promise<void>>();
  let loaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDirtyAt = 0;

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null,
  );

  function loadPersistedSessions() {
    const saved = loadJson<PersistedSessionsFile>(SESSION_STORAGE_KEY, {
      version: SESSION_STORAGE_VERSION,
      activeSessionId: null,
      sessions: [],
    });
    if (!Array.isArray(saved.sessions)) {
      loaded = true;
      return;
    }

    const restored = saved.sessions
      .slice(0, MAX_PERSISTED_SESSIONS)
      .map((raw) => hydrateSession(raw, { decorateFrame: markRaw }))
      .filter((s): s is SerialSession => s !== null);
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
    sessions.value.push(createSessionRecord(id, portName, portConfig));
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

    // While capture is paused, hold frames off-screen so the live view freezes
    // without losing data; resuming flushes them back in order.
    const max = maxBufferFrames.value;
    const target = session.capturePaused ? session.pausedFrames : session.frames;
    target.push(fullFrame);
    if (target.length > max + FRAME_TRIM_THRESHOLD) {
      target.splice(0, target.length - max);
    }

    if (frame.direction === 'TX') {
      session.txBytes += frame.data.length;
      session.txFrames += 1;
    } else {
      session.rxBytes += frame.data.length;
      session.rxFrames += 1;
    }

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

  function clearFrames(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.frames = [];
    session.pausedFrames = [];
    session.capturePaused = false;
    session.txBytes = 0;
    session.rxBytes = 0;
    session.txFrames = 0;
    session.rxFrames = 0;
    schedulePersist();
  }

  function setCapturePaused(sessionId: string, paused: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session || session.capturePaused === paused) return;
    session.capturePaused = paused;
    if (!paused && session.pausedFrames.length > 0) {
      // Flush the off-screen buffer back into the live view, preserving order.
      const max = maxBufferFrames.value;
      for (const held of session.pausedFrames) session.frames.push(held);
      session.pausedFrames = [];
      if (session.frames.length > max + FRAME_TRIM_THRESHOLD) {
        session.frames.splice(0, session.frames.length - max);
      }
    }
    schedulePersist();
  }

  function addSendHistory(sessionId: string, entry: SendHistoryEntry) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = session.sendHistory.filter(
      (h) => !(h.data === entry.data && h.isHex === entry.isHex),
    );
    session.sendHistory.unshift(entry);
    if (session.sendHistory.length > MAX_HISTORY) {
      session.sendHistory = session.sendHistory.slice(0, MAX_HISTORY);
    }
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
    session.quickCommands.push({ ...command, id: crypto.randomUUID() });
    schedulePersist();
  }

  function removeQuickCommand(sessionId: string, commandId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.quickCommands = session.quickCommands.filter((c) => c.id !== commandId);
    schedulePersist();
  }

  function addMacro(sessionId: string, macro: Omit<Macro, 'id'>): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.macros.push({ ...macro, id });
    schedulePersist();
    return id;
  }

  function updateMacro(sessionId: string, macroId: string, patch: Partial<Omit<Macro, 'id'>>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.macros.findIndex((m) => m.id === macroId);
    if (idx === -1) return;
    session.macros[idx] = { ...session.macros[idx], ...patch };
    schedulePersist();
  }

  function removeMacro(sessionId: string, macroId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.macros = session.macros.filter((m) => m.id !== macroId);
    schedulePersist();
  }

  function addTrigger(sessionId: string, trigger: Omit<Trigger, 'id'>): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.triggers.push({ ...trigger, id });
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
    const idx = session.triggers.findIndex((t) => t.id === triggerId);
    if (idx === -1) return;
    session.triggers[idx] = { ...session.triggers[idx], ...patch };
    schedulePersist();
  }

  function removeTrigger(sessionId: string, triggerId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.triggers = session.triggers.filter((t) => t.id !== triggerId);
    schedulePersist();
  }

  function addHighlight(
    sessionId: string,
    highlight: Omit<HighlightRule, 'id'>,
  ): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.highlights.push({ ...highlight, id });
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
    const idx = session.highlights.findIndex((h) => h.id === highlightId);
    if (idx === -1) return;
    session.highlights[idx] = { ...session.highlights[idx], ...patch };
    schedulePersist();
  }

  function removeHighlight(sessionId: string, highlightId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.highlights = session.highlights.filter((h) => h.id !== highlightId);
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
    session.modbusRegisters.push(
      normalizeModbusRegister({ ...reg, id, value: null, values: null, valueTs: null }),
    );
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
    session.modbusRegisters[idx] = normalizeModbusRegister({
      ...session.modbusRegisters[idx],
      ...patch,
      id: session.modbusRegisters[idx].id,
    });
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
    session.logAiFrameLimit = Math.max(20, Math.min(2000, Math.floor(limit || 200)));
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
    createSession,
    removeSession,
    setActiveSession,
    registerCleanup,
    addFrame,
    setConnected,
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
