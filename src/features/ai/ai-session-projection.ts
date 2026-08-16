import { isValidAiModel } from '../../lib/ai-models';
import { IPC_LIMITS, type IpcError, type OperationRecord } from '../../generated/ipc-contracts';
import { AiActivityCancelledError } from '../ai-activity';
import type {
  AiChatMessage,
  AiChatSnapshot,
  AiModel,
  AiSessionSummary,
  LogAiContextMode,
  SerialSession,
} from '../../types';

/**
 * Pure, framework-free helpers behind the AI session bridge.
 *
 * Everything here is unit-testable without Vue, Pinia, or the Tauri event
 * bus: untrusted event guards (`isAiSessionUpdate`, `isAiCommandApplyEvent`),
 * the store dispatcher (`applyAiSessionUpdate`), snapshot projectors
 * (`toAiSessionSummary`, `toAiChatSnapshot`), persistence-limit math
 * (`canPersistAiResponse`, `workspaceAiMessageLimitError`), and the
 * operation/error mappers the bridge needs for activity correlation.
 */

interface AiCommandApplyEvent {
  kind?: 'command-apply';
  command: string;
}

export interface AiResponseBinding {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly requestId?: string;
}

export type AiResponseBindingPhase = 'context-issued' | 'user-committed' | 'running' | 'rejected';

export const MAX_AI_SUMMARY_BYTES = 10 * 1024;
export const MAX_AI_CHAT_MESSAGES = 100;
export const MAX_AI_CHAT_BYTES = 1024 * 1024;
export const MAX_AI_COMMAND_BYTES = 16 * 1024;
export const MAX_AI_MESSAGE_BYTES = 256 * 1024;
export const MAX_AI_SESSION_ID_BYTES = 256;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function hasBoundedText(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
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
        event.value.role === 'user' &&
        hasBoundedText(event.value.content, MAX_AI_MESSAGE_BYTES)
      );
    case 'clearLogAiMessages':
      return event.value === null;
    default:
      return false;
  }
}

export function isAiCommandApplyEvent(value: unknown): value is AiCommandApplyEvent {
  return isRecord(value) && hasBoundedText(value.command, MAX_AI_COMMAND_BYTES);
}

function boundedText(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > maxBytes) end -= 1;
  return value.slice(0, end);
}

/** Build a regular event payload with no frame, secret, or message content. */
export function toAiSessionSummary(
  session: SerialSession,
  runtimeConnected: boolean = session.isConnected,
): AiSessionSummary {
  const summary: AiSessionSummary = {
    id: boundedText(session.id, 256),
    portName: boundedText(session.portName, 1024),
    baudRate: session.portConfig.baudRate,
    isConnected: runtimeConnected,
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

export function canPersistAiResponse(
  binding: AiResponseBinding,
  correlated: AiResponseBinding | undefined,
  currentWorkspaceId: string,
  acceptsSaves: boolean,
  sessionExists: boolean,
): boolean {
  return (
    acceptsSaves &&
    sessionExists &&
    binding.workspaceId === currentWorkspaceId &&
    correlated?.workspaceId === binding.workspaceId &&
    correlated.sessionId === binding.sessionId &&
    correlated.revision === binding.revision
  );
}

export function workspaceAiMessageLimitError(
  sessions: readonly Pick<SerialSession, 'logAiMessages'>[],
  content: string,
  requestId: string,
  reservation: Readonly<{ reservedMessages: number; reservedBytes: number }> = {
    reservedMessages: 0,
    reservedBytes: 0,
  },
): IpcError | null {
  const contentBytes = encoder.encode(content).byteLength;
  if (contentBytes > IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGE_BYTES) {
    return aiLimitError(
      requestId,
      'aiMessage.content',
      IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGE_BYTES,
      contentBytes,
    );
  }
  let messageCount = 0;
  let totalBytes = 0;
  for (const session of sessions) {
    messageCount += session.logAiMessages.length;
    for (const message of session.logAiMessages) {
      totalBytes += encoder.encode(message.content).byteLength;
    }
  }
  if (messageCount + 1 + reservation.reservedMessages > IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGES) {
    return aiLimitError(
      requestId,
      'aiMessages',
      IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGES,
      messageCount + 1 + reservation.reservedMessages,
    );
  }
  if (totalBytes + contentBytes + reservation.reservedBytes > IPC_LIMITS.MAX_WORKSPACE_AI_BYTES) {
    return aiLimitError(
      requestId,
      'aiBytes',
      IPC_LIMITS.MAX_WORKSPACE_AI_BYTES,
      totalBytes + contentBytes + reservation.reservedBytes,
    );
  }
  return null;
}

function aiLimitError(requestId: string, field: string, limit: number, actual: number): IpcError {
  return Object.freeze({
    code: 'LIMIT_EXCEEDED',
    messageKey: 'error.limit_exceeded',
    retryable: false,
    operation: 'run_ai_request',
    requestId,
    field,
    limit,
    actual,
  });
}

export function isTerminalOperation(operation: OperationRecord): boolean {
  return (
    operation.status === 'completed' ||
    operation.status === 'failed' ||
    operation.status === 'cancelled' ||
    operation.status === 'interrupted'
  );
}

export function sameOperationBinding(
  operation: OperationRecord | undefined,
  envelope: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly requestId: string;
  },
): boolean {
  return (
    operation?.kind === 'ai-request' &&
    operation.operationId === envelope.requestId &&
    operation.workspaceId === envelope.workspaceId &&
    operation.sessionId === envelope.sessionId
  );
}

export function rejectedAiActivity(requestId: string): IpcError {
  return Object.freeze({
    code: 'CANCELLED',
    messageKey: 'error.cancelled',
    retryable: false,
    operation: 'run_ai_request',
    requestId,
  });
}

export function aiActivityError(error: unknown, requestId: string): IpcError {
  if (isIpcError(error)) return Object.freeze({ ...error, requestId });
  if (error instanceof AiActivityCancelledError) return rejectedAiActivity(requestId);
  return Object.freeze({
    code: 'AI_PROVIDER_FAILED',
    messageKey: 'error.ai_request_failed',
    retryable: true,
    operation: 'run_ai_request',
    requestId,
  });
}

function isIpcError(value: unknown): value is IpcError {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === 'string' &&
    typeof value.messageKey === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.operation === 'string'
  );
}
