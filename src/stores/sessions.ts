import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { SerialSession, DataFrame, SendHistoryEntry } from '../types';
import { nowMillis } from '../lib/time';

const MAX_FRAMES = 10000;
const MAX_HISTORY = 20;

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

    if (session.frames.length > MAX_FRAMES) {
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
  };
});
