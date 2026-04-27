import { computed, onMounted, onUnmounted, watch } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import { useSessionStore } from '../stores/sessions';
import { useAppStore } from '../stores/app';
import type { AiChatMessage, AiModel, LogAiContextMode } from '../types';

interface AiCommandApplyEvent {
  command: string;
}

interface AiSessionUpdateEvent {
  sessionId: string;
  action: string;
  value: unknown;
}

export function useAiSessionBridge() {
  const sessionStore = useSessionStore();
  const appStore = useAppStore();
  const session = computed(() => sessionStore.activeSession);
  const unlisteners: Array<() => void> = [];

  async function sendSnapshot() {
    await emit('ai-session-snapshot', { session: session.value });
  }

  onMounted(async () => {
    unlisteners.push(await listen('ai-session-snapshot-request', () => {
      void sendSnapshot();
    }));
    unlisteners.push(await listen<AiCommandApplyEvent>('ai-command-apply', (event) => {
      appStore.applyAiCommand(event.payload.command);
    }));
    unlisteners.push(await listen<AiSessionUpdateEvent>('ai-session-update', (event) => {
      applyUpdate(event.payload);
      void sendSnapshot();
    }));
    await sendSnapshot();
  });

  onUnmounted(() => {
    unlisteners.forEach((unlisten) => unlisten());
    unlisteners.length = 0;
  });

  watch(session, () => {
    void sendSnapshot();
  }, { deep: true });

  function applyUpdate(event: AiSessionUpdateEvent) {
    switch (event.action) {
      case 'setTerminalAiModel':
        sessionStore.setTerminalAiModel(event.sessionId, event.value as AiModel);
        break;
      case 'setLogAiModel':
        sessionStore.setLogAiModel(event.sessionId, event.value as AiModel);
        break;
      case 'setLogAiContextMode':
        sessionStore.setLogAiContextMode(event.sessionId, event.value as LogAiContextMode);
        break;
      case 'setLogAiFrameLimit':
        sessionStore.setLogAiFrameLimit(event.sessionId, Number(event.value));
        break;
      case 'addLogAiMessage':
        sessionStore.addLogAiMessage(event.sessionId, event.value as Omit<AiChatMessage, 'id' | 'timestamp'>);
        break;
      case 'clearLogAiMessages':
        sessionStore.clearLogAiMessages(event.sessionId);
        break;
      default:
        break;
    }
  }
}
