import { computed, getCurrentInstance, onMounted, onUnmounted, watch } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import { buildLogAiContext } from '../lib/ai-log-context';
import { isValidAiModel } from '../lib/ai-models';
import { logger } from '../lib/logger';
import { useSessionStore } from '../stores/sessions';
import { useAppStore } from '../stores/app';
import type {
  AiChatMessage,
  AiChatSnapshot,
  AiLogContextSnapshot,
  AiModel,
  AiSessionSummary,
  LogAiContextMode,
  SerialSession,
} from '../types';

interface AiCommandApplyEvent {
  command: string;
}

interface AiSessionUpdateEvent {
  sessionId: string;
  action: string;
  value: unknown;
}

interface AiLogContextRequest {
  sessionId: string;
}

const MAX_AI_SUMMARY_BYTES = 10 * 1024;
const MAX_AI_CHAT_MESSAGES = 100;
const MAX_AI_CHAT_BYTES = 1024 * 1024;
const MAX_AI_COMMAND_BYTES = 16 * 1024;
const MAX_AI_MESSAGE_BYTES = 256 * 1024;
const MAX_AI_SESSION_ID_BYTES = 256;
const encoder = new TextEncoder();
const LOG_AI_CONTEXT_MODES = new Set<LogAiContextMode>([
  'latest-10k',
  'latest-n-frames',
  'full-capped',
]);

/**
 * Apply a single AI-window session-update event to the session store. Extracted
 * as a pure dispatcher so the action routing is unit-testable without the
 * event bus.
 */
export function applyAiSessionUpdate(
  event: unknown,
  sessionStore: {
    setTerminalAiModel: (id: string, model: AiModel) => void;
    setLogAiModel: (id: string, model: AiModel) => void;
    setLogAiContextMode: (id: string, mode: LogAiContextMode) => void;
    setLogAiFrameLimit: (id: string, limit: number) => void;
    addLogAiMessage: (id: string, message: Omit<AiChatMessage, 'id' | 'timestamp'>) => void;
    clearLogAiMessages: (id: string) => void;
  },
  activeSessionId: string | null,
): boolean {
  if (!isAiSessionUpdate(event, activeSessionId)) return false;
  switch (event.action) {
    case 'setTerminalAiModel':
      sessionStore.setTerminalAiModel(event.sessionId, event.value);
      return true;
    case 'setLogAiModel':
      sessionStore.setLogAiModel(event.sessionId, event.value);
      return true;
    case 'setLogAiContextMode':
      sessionStore.setLogAiContextMode(event.sessionId, event.value);
      return true;
    case 'setLogAiFrameLimit':
      sessionStore.setLogAiFrameLimit(event.sessionId, event.value);
      return true;
    case 'addLogAiMessage':
      sessionStore.addLogAiMessage(event.sessionId, event.value);
      return true;
    case 'clearLogAiMessages':
      sessionStore.clearLogAiMessages(event.sessionId);
      return true;
  }
}

type ValidAiSessionUpdate =
  | { sessionId: string; action: 'setTerminalAiModel' | 'setLogAiModel'; value: AiModel }
  | { sessionId: string; action: 'setLogAiContextMode'; value: LogAiContextMode }
  | { sessionId: string; action: 'setLogAiFrameLimit'; value: number }
  | {
      sessionId: string;
      action: 'addLogAiMessage';
      value: Omit<AiChatMessage, 'id' | 'timestamp'>;
    }
  | { sessionId: string; action: 'clearLogAiMessages'; value: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasBoundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

/**
 * Cross-window events are untrusted input even though both webviews are our
 * own.  Keep the AI surface constrained to its active-session settings and
 * bounded message payloads before it reaches the persisted session store.
 */
export function isAiSessionUpdate(
  event: unknown,
  activeSessionId: string | null,
): event is ValidAiSessionUpdate {
  if (!isRecord(event)) return false;
  if (
    !hasBoundedText(event.sessionId, MAX_AI_SESSION_ID_BYTES) ||
    event.sessionId !== activeSessionId ||
    typeof event.action !== 'string'
  ) {
    return false;
  }

  switch (event.action) {
    case 'setTerminalAiModel':
    case 'setLogAiModel':
      return typeof event.value === 'string' && isValidAiModel(event.value);
    case 'setLogAiContextMode':
      return (
        typeof event.value === 'string' && LOG_AI_CONTEXT_MODES.has(event.value as LogAiContextMode)
      );
    case 'setLogAiFrameLimit':
      return (
        typeof event.value === 'number' &&
        Number.isInteger(event.value) &&
        event.value >= 20 &&
        event.value <= 2000
      );
    case 'addLogAiMessage':
      return (
        isRecord(event.value) &&
        (event.value.role === 'user' || event.value.role === 'assistant') &&
        hasBoundedText(event.value.content, MAX_AI_MESSAGE_BYTES)
      );
    case 'clearLogAiMessages':
      return event.value === null;
    default:
      return false;
  }
}

function isAiCommandApplyEvent(value: unknown): value is AiCommandApplyEvent {
  return isRecord(value) && hasBoundedText(value.command, MAX_AI_COMMAND_BYTES);
}

function isAiLogContextRequest(
  value: unknown,
  activeSessionId: string | null,
): value is AiLogContextRequest {
  return (
    isRecord(value) &&
    hasBoundedText(value.sessionId, MAX_AI_SESSION_ID_BYTES) &&
    value.sessionId === activeSessionId
  );
}

function boundedText(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > maxBytes) end -= 1;
  return value.slice(0, end);
}

/** Build a regular event payload with no frame, secret, or message content. */
export function toAiSessionSummary(session: SerialSession): AiSessionSummary {
  const summary: AiSessionSummary = {
    id: boundedText(session.id, 256),
    portName: boundedText(session.portName, 1024),
    baudRate: session.portConfig.baudRate,
    isConnected: session.isConnected,
    txBytes: session.txBytes,
    rxBytes: session.rxBytes,
    txFrames: session.txFrames,
    rxFrames: session.rxFrames,
    terminalAiModel: session.terminalAiModel,
    logAiModel: session.logAiModel,
    logAiContextMode: session.logAiContextMode,
    logAiFrameLimit: session.logAiFrameLimit,
  };
  // This is a defensive invariant: normal events must remain comfortably
  // below the declared 10 KiB contract even if a port label is malicious.
  if (encoder.encode(JSON.stringify(summary)).byteLength > MAX_AI_SUMMARY_BYTES) {
    summary.portName = '';
  }
  return summary;
}

/** Retain only the recent 100 messages and at most 1 MiB of serialized text. */
export function toAiChatSnapshot(session: SerialSession): AiChatSnapshot {
  const messages: AiChatMessage[] = [];
  let remaining = MAX_AI_CHAT_BYTES;
  for (let index = session.logAiMessages.length - 1; index >= 0; index -= 1) {
    if (messages.length >= MAX_AI_CHAT_MESSAGES || remaining <= 0) break;
    const message = session.logAiMessages[index];
    const overhead =
      encoder.encode(`${message.id}${message.role}${message.timestamp}`).byteLength + 32;
    const content = boundedText(message.content, Math.max(0, remaining - overhead));
    const bytes = encoder.encode(content).byteLength + overhead;
    if (bytes > remaining) break;
    messages.push({ ...message, content });
    remaining -= bytes;
  }
  messages.reverse();
  // The conservative per-message accounting above avoids repeated full JSON
  // serialization on the normal path. Account for JSON punctuation/escaping
  // exactly before emitting so this payload cannot cross the 1 MiB boundary.
  while (
    messages.length > 0 &&
    encoder.encode(JSON.stringify({ sessionId: session.id, messages })).byteLength >
      MAX_AI_CHAT_BYTES
  ) {
    const oldest = messages[0];
    const payloadBytes = encoder.encode(
      JSON.stringify({ sessionId: session.id, messages }),
    ).byteLength;
    const excess = payloadBytes - MAX_AI_CHAT_BYTES;
    const contentBytes = encoder.encode(oldest.content).byteLength;
    if (contentBytes <= excess + 16) {
      messages.shift();
    } else {
      oldest.content = boundedText(oldest.content, contentBytes - excess - 16);
    }
  }
  return { sessionId: session.id, messages };
}

export function useAiSessionBridge() {
  const sessionStore = useSessionStore();
  const appStore = useAppStore();
  const session = computed(() => sessionStore.activeSession);
  const unlisteners: Array<() => void> = [];

  async function sendSnapshot() {
    try {
      const active = session.value;
      await emit('ai-session-snapshot', {
        session: active ? toAiSessionSummary(active) : null,
      });
      if (active) await emit('ai-chat-snapshot', toAiChatSnapshot(active));
    } catch (error) {
      logger.debug('ai-session summary bridge unavailable:', error);
    }
  }

  async function sendLogContext(request: AiLogContextRequest) {
    const active = session.value;
    if (!active || active.id !== request.sessionId) return;
    const context = buildLogAiContext(active);
    const payload: AiLogContextSnapshot = { sessionId: active.id, ...context };
    try {
      await emit('ai-log-context', payload);
    } catch (error) {
      logger.debug('ai log-context bridge unavailable:', error);
    }
  }

  if (getCurrentInstance()) {
    onMounted(async () => {
      try {
        unlisteners.push(
          await listen('ai-session-snapshot-request', () => {
            void sendSnapshot();
          }),
        );
        unlisteners.push(
          await listen<AiLogContextRequest>('ai-log-context-request', (event) => {
            if (isAiLogContextRequest(event.payload, session.value?.id ?? null)) {
              void sendLogContext(event.payload);
            }
          }),
        );
        unlisteners.push(
          await listen<AiCommandApplyEvent>('ai-command-apply', (event) => {
            if (isAiCommandApplyEvent(event.payload)) {
              appStore.applyAiCommand(event.payload.command);
            }
          }),
        );
        unlisteners.push(
          await listen<AiSessionUpdateEvent>('ai-session-update', (event) => {
            if (applyAiSessionUpdate(event.payload, sessionStore, session.value?.id ?? null)) {
              void sendSnapshot();
            }
          }),
        );
      } catch (error) {
        logger.debug('ai-session event bridge unavailable:', error);
      }
      await sendSnapshot();
    });

    onUnmounted(() => {
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
    });
  }

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
