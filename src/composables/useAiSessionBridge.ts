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

const SNAPSHOT_DEBOUNCE_MS = 200;

export function useAiSessionBridge() {
  const sessionStore = useSessionStore();
  const appStore = useAppStore();
  const session = computed(() => sessionStore.activeSession);
  const unlisteners: Array<() => void> = [];
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshotKey = '';

  function snapshotKey(): string {
    const s = session.value;
    if (!s) return '';
    return `${s.id}:${s.isConnected}:${s.frames.length}:${s.logAiMessages.length}:${s.terminalAiModel}:${s.logAiModel}:${s.logAiContextMode}:${s.logAiFrameLimit}`;
  }

  function sendSnapshotDeferred() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      const key = snapshotKey();
      if (key === lastSnapshotKey) return;
      lastSnapshotKey = key;
      emit('ai-session-snapshot', { session: session.value }).catch((err) => {
        console.debug('failed to emit ai-session-snapshot:', err);
      });
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  async function sendSnapshot() {
    const key = snapshotKey();
    lastSnapshotKey = key;
    try {
      await emit('ai-session-snapshot', { session: session.value });
    } catch (err) {
      console.debug('failed to emit ai-session-snapshot:', err);
    }
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
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
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

  watch(
    () => session.value?.frames.length,
    () => {
      sendSnapshotDeferred();
    },
  );

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
        console.debug('unknown ai-session-update action:', event.action);
        break;
    }
  }
}
