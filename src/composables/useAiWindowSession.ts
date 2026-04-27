import { onMounted, onUnmounted, ref } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import type { AiChatMessage, AiModel, LogAiContextMode, SerialSession } from '../types';

interface AiSessionSnapshot {
  session: SerialSession | null;
}

export function useAiWindowSession() {
  const session = ref<SerialSession | null>(null);
  const unlisteners: Array<() => void> = [];

  onMounted(async () => {
    unlisteners.push(await listen<AiSessionSnapshot>('ai-session-snapshot', (event) => {
      session.value = event.payload.session;
    }));
    await emit('ai-session-snapshot-request');
  });

  onUnmounted(() => {
    unlisteners.forEach((unlisten) => unlisten());
    unlisteners.length = 0;
  });

  async function applyCommand(command: string) {
    await emit('ai-command-apply', { command });
  }

  async function setTerminalAiModel(model: AiModel) {
    if (!session.value) return;
    session.value.terminalAiModel = model;
    await emitUpdate('setTerminalAiModel', model);
  }

  async function setLogAiModel(model: AiModel) {
    if (!session.value) return;
    session.value.logAiModel = model;
    await emitUpdate('setLogAiModel', model);
  }

  async function setLogAiContextMode(mode: LogAiContextMode) {
    if (!session.value) return;
    session.value.logAiContextMode = mode;
    await emitUpdate('setLogAiContextMode', mode);
  }

  async function setLogAiFrameLimit(limit: number) {
    if (!session.value) return;
    session.value.logAiFrameLimit = limit;
    await emitUpdate('setLogAiFrameLimit', limit);
  }

  async function addLogAiMessage(message: Omit<AiChatMessage, 'id' | 'timestamp'>) {
    if (!session.value) return;
    session.value.logAiMessages.push({
      ...message,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    });
    await emitUpdate('addLogAiMessage', message);
  }

  async function clearLogAiMessages() {
    if (!session.value) return;
    session.value.logAiMessages = [];
    await emitUpdate('clearLogAiMessages', null);
  }

  async function emitUpdate(action: string, value: unknown) {
    if (!session.value) return;
    await emit('ai-session-update', {
      sessionId: session.value.id,
      action,
      value,
    });
  }

  return {
    session,
    applyCommand,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
  };
}
