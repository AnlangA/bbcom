import { getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import type {
  AiChatMessage,
  AiChatSnapshot,
  AiLogContextSnapshot,
  AiModel,
  AiSessionSummary,
  AiWindowSession,
  LogAiContextMode,
} from '../types';

interface AiSessionSnapshot {
  session: AiSessionSummary | null;
}

interface PendingResolver<T> {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Injectable emitter so the local mutation/event contract stays unit-testable. */
export interface UseAiWindowSessionDeps {
  emit?: (event: string, payload?: unknown) => Promise<void>;
}

function localSession(
  summary: AiSessionSummary,
  previous: AiWindowSession | null,
): AiWindowSession {
  return {
    ...summary,
    // Chat text is intentionally delivered only in its bounded snapshot, not
    // in the regular session summary event.
    logAiMessages: previous?.id === summary.id ? previous.logAiMessages : [],
  };
}

export function useAiWindowSession(deps: UseAiWindowSessionDeps = {}) {
  const session = ref<AiWindowSession | null>(null);
  const unlisteners: Array<() => void> = [];
  const pendingSnapshotResolvers: PendingResolver<AiWindowSession | null>[] = [];
  const pendingContextResolvers: PendingResolver<AiLogContextSnapshot | null>[] = [];
  const doEmit = deps.emit ?? emit;

  if (getCurrentInstance()) {
    onMounted(async () => {
      unlisteners.push(
        await listen<AiSessionSnapshot>('ai-session-snapshot', (event) => {
          session.value = event.payload.session
            ? localSession(event.payload.session, session.value)
            : null;
          resolvePendingSnapshots(session.value);
        }),
      );
      unlisteners.push(
        await listen<AiChatSnapshot>('ai-chat-snapshot', (event) => {
          if (!session.value || event.payload.sessionId !== session.value.id) return;
          session.value.logAiMessages = event.payload.messages;
        }),
      );
      unlisteners.push(
        await listen<AiLogContextSnapshot>('ai-log-context', (event) => {
          resolvePendingContexts(event.payload);
        }),
      );
      await refreshSession();
    });

    onUnmounted(() => {
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
      resolvePendingSnapshots(session.value);
      resolvePendingContexts(null);
    });
  }

  async function refreshSession(timeoutMs = 1000): Promise<AiWindowSession | null> {
    const pending = waitForSnapshot(timeoutMs);
    await doEmit('ai-session-snapshot-request');
    return pending;
  }

  async function getLogContext(timeoutMs = 1000): Promise<AiLogContextSnapshot | null> {
    const sessionId = session.value?.id;
    if (!sessionId) return null;
    const pending = waitForContext(timeoutMs);
    await doEmit('ai-log-context-request', { sessionId });
    return pending;
  }

  function waitForSnapshot(timeoutMs: number): Promise<AiWindowSession | null> {
    return new Promise((resolve) => {
      const pending: PendingResolver<AiWindowSession | null> = {
        resolve,
        timer: setTimeout(() => {
          removePending(pendingSnapshotResolvers, pending);
          resolve(session.value);
        }, timeoutMs),
      };
      pendingSnapshotResolvers.push(pending);
    });
  }

  function waitForContext(timeoutMs: number): Promise<AiLogContextSnapshot | null> {
    return new Promise((resolve) => {
      const pending: PendingResolver<AiLogContextSnapshot | null> = {
        resolve,
        timer: setTimeout(() => {
          removePending(pendingContextResolvers, pending);
          resolve(null);
        }, timeoutMs),
      };
      pendingContextResolvers.push(pending);
    });
  }

  function removePending<T>(items: PendingResolver<T>[], pending: PendingResolver<T>) {
    const index = items.indexOf(pending);
    if (index >= 0) items.splice(index, 1);
    clearTimeout(pending.timer);
  }

  function resolvePendingSnapshots(value: AiWindowSession | null) {
    const pending = pendingSnapshotResolvers.splice(0);
    pending.forEach((item) => {
      clearTimeout(item.timer);
      item.resolve(value);
    });
  }

  function resolvePendingContexts(value: AiLogContextSnapshot | null) {
    const pending = pendingContextResolvers.splice(0);
    pending.forEach((item) => {
      clearTimeout(item.timer);
      item.resolve(value);
    });
  }

  async function applyCommand(command: string) {
    await doEmit('ai-command-apply', { command });
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
    await doEmit('ai-session-update', {
      sessionId: session.value.id,
      action,
      value,
    });
  }

  return {
    session,
    refreshSession,
    getLogContext,
    applyCommand,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
  };
}
