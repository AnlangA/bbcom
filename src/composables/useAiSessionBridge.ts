import { computed, onMounted, onUnmounted, watch } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import { useSessionStore } from '../stores/sessions';
import { useAppStore } from '../stores/app';
import { logger } from '../lib/logger';
import type { AiChatMessage, AiModel, LogAiContextMode } from '../types';

interface AiCommandApplyEvent {
  command: string;
}

interface AiSessionUpdateEvent {
  sessionId: string;
  action: string;
  value: unknown;
}

/**
 * Apply a single AI-window session-update event to the session store. Extracted
 * as a pure dispatcher so the action routing is unit-testable without the Tauri
 * event bus. Each arm maps an `action` string to the corresponding store mutator.
 */
export function applyAiSessionUpdate(
  event: AiSessionUpdateEvent,
  sessionStore: {
    setTerminalAiModel: (id: string, model: AiModel) => void;
    setLogAiModel: (id: string, model: AiModel) => void;
    setLogAiContextMode: (id: string, mode: LogAiContextMode) => void;
    setLogAiFrameLimit: (id: string, limit: number) => void;
    addLogAiMessage: (id: string, message: Omit<AiChatMessage, 'id' | 'timestamp'>) => void;
    clearLogAiMessages: (id: string) => void;
  },
): void {
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
      sessionStore.addLogAiMessage(
        event.sessionId,
        event.value as Omit<AiChatMessage, 'id' | 'timestamp'>,
      );
      break;
    case 'clearLogAiMessages':
      sessionStore.clearLogAiMessages(event.sessionId);
      break;
    default:
      break;
  }
}

export function useAiSessionBridge() {
  const sessionStore = useSessionStore();
  const appStore = useAppStore();
  const session = computed(() => sessionStore.activeSession);
  const unlisteners: Array<() => void> = [];

  async function sendSnapshot() {
    try {
      await emit('ai-session-snapshot', { session: session.value });
    } catch (e) {
      logger.debug('ai-session snapshot bridge unavailable:', e);
    }
  }

  onMounted(async () => {
    try {
      unlisteners.push(
        await listen('ai-session-snapshot-request', () => {
          void sendSnapshot();
        }),
      );
      unlisteners.push(
        await listen<AiCommandApplyEvent>('ai-command-apply', (event) => {
          appStore.applyAiCommand(event.payload.command);
        }),
      );
      unlisteners.push(
        await listen<AiSessionUpdateEvent>('ai-session-update', (event) => {
          applyAiSessionUpdate(event.payload, sessionStore);
          void sendSnapshot();
        }),
      );
    } catch (e) {
      logger.debug('ai-session event bridge unavailable:', e);
    }
    await sendSnapshot();
  });

  onUnmounted(() => {
    unlisteners.forEach((unlisten) => unlisten());
    unlisteners.length = 0;
  });

  watch(
    () => session.value?.id,
    () => {
      void sendSnapshot();
    },
  );

  watch(
    () => session.value?.isConnected,
    () => {
      void sendSnapshot();
    },
  );
}
