import { onMounted, onUnmounted, ref } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import type { AiChatMessage, AiModel, LogAiContextMode } from '../types';

interface AiSessionSnapshot {
  sessionId: string;
  portName: string;
  isConnected: boolean;
  frameCount: number;
  baudRate: number;
  terminalAiModel: AiModel;
  logAiModel: AiModel;
  logAiContextMode: LogAiContextMode;
  logAiFrameLimit: number;
  logAiMessageCount: number;
  logAiMessages: AiChatMessage[];
}

export function useAiWindowSession() {
  const sessionId = ref<string | null>(null);
  const portName = ref('');
  const isConnected = ref(false);
  const frameCount = ref(0);
  const baudRate = ref(115200);
  const terminalAiModel = ref<AiModel>('glm-4.5-air');
  const logAiModel = ref<AiModel>('glm-4.5-air');
  const logAiContextMode = ref<LogAiContextMode>('latest-10k');
  const logAiFrameLimit = ref(200);
  const logAiMessages = ref<AiChatMessage[]>([]);
  const unlisteners: Array<() => void> = [];

  onMounted(async () => {
    unlisteners.push(await listen<AiSessionSnapshot>('ai-session-snapshot', (event) => {
      const snap = event.payload;
      sessionId.value = snap.sessionId;
      portName.value = snap.portName;
      isConnected.value = snap.isConnected;
      frameCount.value = snap.frameCount;
      baudRate.value = snap.baudRate;
      terminalAiModel.value = snap.terminalAiModel;
      logAiModel.value = snap.logAiModel;
      logAiContextMode.value = snap.logAiContextMode;
      logAiFrameLimit.value = snap.logAiFrameLimit;
      logAiMessages.value = snap.logAiMessages;
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
    terminalAiModel.value = model;
    await emitUpdate('setTerminalAiModel', model);
  }

  async function setLogAiModel(model: AiModel) {
    logAiModel.value = model;
    await emitUpdate('setLogAiModel', model);
  }

  async function setLogAiContextMode(mode: LogAiContextMode) {
    logAiContextMode.value = mode;
    await emitUpdate('setLogAiContextMode', mode);
  }

  async function setLogAiFrameLimit(limit: number) {
    logAiFrameLimit.value = limit;
    await emitUpdate('setLogAiFrameLimit', limit);
  }

  async function addLogAiMessage(message: Omit<AiChatMessage, 'id' | 'timestamp'>) {
    logAiMessages.value.push({
      ...message,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    });
    await emitUpdate('addLogAiMessage', message);
  }

  async function clearLogAiMessages() {
    logAiMessages.value = [];
    await emitUpdate('clearLogAiMessages', null);
  }

  async function emitUpdate(action: string, value: unknown) {
    if (!sessionId.value) return;
    await emit('ai-session-update', {
      sessionId: sessionId.value,
      action,
      value,
    });
  }

  return {
    sessionId,
    portName,
    isConnected,
    frameCount,
    baudRate,
    terminalAiModel,
    logAiModel,
    logAiContextMode,
    logAiFrameLimit,
    logAiMessages,
    applyCommand,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
  };
}
