import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AiChatMessage, AiModel, LogAiContextMode, SerialSession, DataFrame, SendHistoryEntry } from '../types';
import { MAX_FRAMES, MAX_HISTORY } from '../types';
import { nowMillis } from '../lib/time';

const FRAME_TRIM_THRESHOLD = 500;

export const useSessionStore = defineStore('sessions', () => {
  const sessions = ref<SerialSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const cleanupFns = new Map<string, () => Promise<void>>();

  const activeSession = computed(() =>
    sessions.value.find((s) => s.id === activeSessionId.value) ?? null
  );

  function createSession(portName: string, portConfig: SerialSession['portConfig']): string {
    const id = crypto.randomUUID();
    sessions.value.push({
      id,
      portName,
      portConfig,
      isConnected: false,
      frames: [],
      txBytes: 0,
      rxBytes: 0,
      txFrames: 0,
      rxFrames: 0,
      startTime: null,
      sendHistory: [],
      sendDraft: '',
      quickCommands: [],
      autoLogEnabled: false,
      terminalAiModel: 'glm-4.5-air',
      logAiModel: 'glm-4.5-air',
      logAiContextMode: 'latest-10k',
      logAiFrameLimit: 200,
      logAiMessages: [],
    });
    activeSessionId.value = id;
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
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id;
  }

  function registerCleanup(id: string, fn: () => Promise<void>) {
    cleanupFns.set(id, fn);
  }

  function addFrame(sessionId: string, frame: Omit<DataFrame, 'id' | 'timestamp'>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;

    const fullFrame: DataFrame = {
      ...frame,
      id: crypto.randomUUID(),
      timestamp: nowMillis(),
    };

    session.frames.push(fullFrame);

    if (session.frames.length > MAX_FRAMES + FRAME_TRIM_THRESHOLD) {
      const trimmed = session.frames.slice(-MAX_FRAMES);
      session.frames = trimmed;
    }

    if (frame.direction === 'TX') {
      session.txBytes += frame.data.length;
      session.txFrames += 1;
    } else {
      session.rxBytes += frame.data.length;
      session.rxFrames += 1;
    }
  }

  function setConnected(sessionId: string, connected: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.isConnected = connected;
    if (connected && !session.startTime) {
      session.startTime = Date.now();
    }
  }

  function clearFrames(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.frames = [];
    session.txBytes = 0;
    session.rxBytes = 0;
    session.txFrames = 0;
    session.rxFrames = 0;
  }

  function addSendHistory(sessionId: string, entry: SendHistoryEntry) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = session.sendHistory.filter(
      (h) => !(h.data === entry.data && h.isHex === entry.isHex)
    );
    session.sendHistory.unshift(entry);
    if (session.sendHistory.length > MAX_HISTORY) {
      session.sendHistory = session.sendHistory.slice(0, MAX_HISTORY);
    }
  }

  function clearSendHistory(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = [];
  }

  function setSendDraft(sessionId: string, draft: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendDraft = draft;
  }

  function addQuickCommand(sessionId: string, command: Omit<SerialSession['quickCommands'][number], 'id'>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.quickCommands.push({ ...command, id: crypto.randomUUID() });
  }

  function removeQuickCommand(sessionId: string, commandId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.quickCommands = session.quickCommands.filter((c) => c.id !== commandId);
  }

  function setAutoLogEnabled(sessionId: string, enabled: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.autoLogEnabled = enabled;
  }

  function setTerminalAiModel(sessionId: string, model: AiModel) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.terminalAiModel = model;
  }

  function setLogAiModel(sessionId: string, model: AiModel) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiModel = model;
  }

  function setLogAiContextMode(sessionId: string, mode: LogAiContextMode) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiContextMode = mode;
  }

  function setLogAiFrameLimit(sessionId: string, limit: number) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiFrameLimit = Math.max(20, Math.min(2000, Math.floor(limit || 200)));
  }

  function addLogAiMessage(sessionId: string, message: Omit<AiChatMessage, 'id' | 'timestamp'>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiMessages.push({
      ...message,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }

  function clearLogAiMessages(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiMessages = [];
  }

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
    addSendHistory,
    clearSendHistory,
    setSendDraft,
    addQuickCommand,
    removeQuickCommand,
    setAutoLogEnabled,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
  };
});
