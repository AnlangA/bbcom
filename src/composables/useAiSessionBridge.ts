import { computed, getCurrentInstance, onMounted, onUnmounted, watch } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import { buildLogAiContext } from '../lib/ai-log-context';
import { isValidAiModel } from '../lib/ai-models';
import { logger } from '../lib/logger';
import { useSessionStore } from '../stores/sessions';
import { useAppStore } from '../stores/app';
import { useSessionApplicationServices } from '../features/sessions/runtime/session-application-services';
import { useOptionalWorkspaceApplication } from '../features/workspace/application';
import {
  AI_BRIDGE_EVENTS,
  NO_AI_SESSION_ID,
  NO_AI_WORKSPACE_ID,
  AiActivityCancelledError,
  AiActivityCenter,
  createAiBridgeEnvelope,
  isAiActivityRunPayload,
  isPayloadKind,
  parseAiBridgeEnvelope,
} from '../features/ai-activity';
import { IPC_LIMITS, type IpcError, type OperationRecord } from '../generated/ipc-contracts';
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
  kind?: 'command-apply';
  command: string;
}

interface AiSessionUpdateEvent {
  kind?: 'session-update';
  action: string;
  value: unknown;
}

export interface AiResponseBinding {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly requestId?: string;
}

export type AiResponseBindingPhase = 'context-issued' | 'user-committed' | 'running' | 'rejected';

interface StoredAiResponseBinding extends AiResponseBinding {
  readonly requestId: string;
  readonly phase: AiResponseBindingPhase;
  readonly error?: IpcError;
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
        event.value.role === 'user' &&
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
  const applicationServices = useSessionApplicationServices();
  const workspace = useOptionalWorkspaceApplication();
  const activityCenter = new AiActivityCenter({
    operations: applicationServices.operationRegistry,
  });
  const session = computed(() => sessionStore.activeSession);
  const unlisteners: Array<() => void> = [];
  const responseBindings = new Map<string, StoredAiResponseBinding>();
  let revision = 1;
  let observedWorkspaceId = currentWorkspaceId();
  let unsubscribeOperations: (() => void) | null = null;
  let unsubscribeWorkspace: (() => void) | null = null;

  function currentWorkspaceId(): string {
    return workspace?.application.snapshot().currentWorkspace?.workspaceId ?? NO_AI_WORKSPACE_ID;
  }

  function currentSessionId(): string {
    return session.value?.id ?? NO_AI_SESSION_ID;
  }

  async function sendSnapshot(requestId: string = crypto.randomUUID()) {
    try {
      const active = session.value;
      const sessionId = currentSessionId();
      await emit(
        AI_BRIDGE_EVENTS.sessionSnapshot,
        createAiBridgeEnvelope({
          workspaceId: currentWorkspaceId(),
          revision,
          origin: 'main',
          requestId,
          sessionId,
          payload: {
            kind: 'session-snapshot',
            session: active ? toAiSessionSummary(active) : null,
          },
        }),
      );
      if (active) {
        await emit(
          AI_BRIDGE_EVENTS.chatSnapshot,
          createAiBridgeEnvelope({
            workspaceId: currentWorkspaceId(),
            revision,
            origin: 'main',
            requestId,
            sessionId,
            payload: { kind: 'chat-snapshot', snapshot: toAiChatSnapshot(active) },
          }),
        );
      }
    } catch (error) {
      logger.debug('ai-session summary bridge unavailable:', error);
    }
  }

  async function sendAuthority(requestId: string = crypto.randomUUID()) {
    try {
      await emit(
        AI_BRIDGE_EVENTS.authoritySnapshot,
        createAiBridgeEnvelope({
          workspaceId: currentWorkspaceId(),
          revision,
          origin: 'main',
          requestId,
          sessionId: currentSessionId(),
          payload: {
            kind: 'authority-snapshot',
            theme: appStore.theme,
            locale: appStore.locale,
            aiKeyStatus: { ...appStore.aiKeyStatus },
          },
        }),
      );
    } catch (error) {
      logger.debug('ai authority bridge unavailable:', error);
    }
  }

  async function sendLogContext(requestId: string, sessionId: string) {
    const active = sessionStore.sessions.find((candidate) => candidate.id === sessionId);
    if (!active) return;
    const context = buildLogAiContext(active);
    const payload: AiLogContextSnapshot = { sessionId: active.id, ...context };
    try {
      await emit(
        AI_BRIDGE_EVENTS.logContext,
        createAiBridgeEnvelope({
          workspaceId: currentWorkspaceId(),
          revision,
          origin: 'main',
          requestId,
          sessionId,
          payload: { kind: 'log-context', snapshot: payload },
        }),
      );
    } catch (error) {
      logger.debug('ai log-context bridge unavailable:', error);
    }
  }

  function receiveEnvelope(value: unknown) {
    return parseAiBridgeEnvelope(value, 'ai-assistant');
  }

  function isKnownSession(sessionId: string): boolean {
    return sessionStore.sessions.some((candidate) => candidate.id === sessionId);
  }

  function rememberResponseBinding(
    requestId: string,
    workspaceId: string,
    sessionId: string,
    sourceRevision: number,
    phase: AiResponseBindingPhase = 'context-issued',
    error?: IpcError,
  ): boolean {
    const existing = responseBindings.get(requestId);
    if (
      existing &&
      !sameResponseBinding(existing, {
        requestId,
        workspaceId,
        sessionId,
        revision: sourceRevision,
      })
    ) {
      return false;
    }
    if (!isAiResponseBindingTransitionAllowed(existing?.phase ?? null, phase)) return false;
    if (!responseBindings.has(requestId) && responseBindings.size >= 32) return false;
    responseBindings.delete(requestId);
    responseBindings.set(requestId, {
      requestId,
      workspaceId,
      sessionId,
      revision: sourceRevision,
      phase,
      ...(error ? { error } : {}),
    });
    return true;
  }

  function responseBindingFor(envelope: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly revision: number;
    readonly requestId: string;
  }): StoredAiResponseBinding | undefined {
    const binding = responseBindings.get(envelope.requestId);
    return binding && sameResponseBinding(binding, envelope) ? binding : undefined;
  }

  function forgetResponseBinding(envelope: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly revision: number;
    readonly requestId: string;
  }): void {
    if (responseBindingFor(envelope)) responseBindings.delete(envelope.requestId);
  }

  function invalidateSessionAiActivities(workspaceId: string, sessionId: string): void {
    const requestIds = [...responseBindings.values()]
      .filter((binding) => binding.workspaceId === workspaceId && binding.sessionId === sessionId)
      .map((binding) => binding.requestId);
    for (const requestId of requestIds) {
      responseBindings.delete(requestId);
      const operation = applicationServices.operationRegistry.get(requestId);
      if (!operation || isTerminalOperation(operation)) continue;
      void activityCenter.cancel(requestId).catch((error) => {
        logger.debug('failed to cancel invalidated AI log activity:', error);
      });
    }
  }

  function pendingAiResponseReservation(excludeRequestId?: string): {
    readonly messages: number;
    readonly bytes: number;
  } {
    const requests = [...responseBindings.values()].filter(
      (binding) =>
        binding.requestId !== excludeRequestId &&
        (binding.phase === 'user-committed' || binding.phase === 'running'),
    ).length;
    return {
      messages: requests,
      bytes: requests * IPC_LIMITS.MAX_AI_RESPONSE_BYTES,
    };
  }

  function handleSessionUpdate(value: unknown): void {
    const envelope = receiveEnvelope(value);
    if (!envelope || !isPayloadKind(envelope.payload, 'session-update')) return;
    const update: AiSessionUpdateEvent = {
      kind: 'session-update',
      action: envelope.payload.action as string,
      value: envelope.payload.value,
    };
    const correlated = responseBindingFor(envelope);
    const chatMessage =
      update.action === 'addLogAiMessage' && isRecord(update.value) ? update.value : null;
    const isChatMessage = chatMessage !== null;
    const userMessageContent =
      chatMessage?.role === 'user' && hasBoundedText(chatMessage.content, MAX_AI_MESSAGE_BYTES)
        ? chatMessage.content
        : null;
    const isUserMessage = userMessageContent !== null;
    const acceptsSaves = workspace?.application.snapshot().acceptsSaves === true;
    const acceptsCorrelatedUser =
      isUserMessage &&
      acceptsSaves &&
      envelope.workspaceId === currentWorkspaceId() &&
      correlated?.phase === 'context-issued' &&
      isKnownSession(envelope.sessionId);
    const acceptsCurrentMutation =
      !isChatMessage &&
      acceptsSaves &&
      envelope.workspaceId === currentWorkspaceId() &&
      envelope.revision === revision &&
      envelope.sessionId === session.value?.id;

    if (!acceptsCorrelatedUser && !acceptsCurrentMutation) {
      void sendSnapshot(envelope.requestId);
      return;
    }
    if (isUserMessage) {
      const reservation = pendingAiResponseReservation();
      const error = workspaceAiMessageLimitError(
        sessionStore.sessions,
        userMessageContent,
        envelope.requestId,
        {
          reservedMessages: reservation.messages + 1,
          reservedBytes: reservation.bytes + IPC_LIMITS.MAX_AI_RESPONSE_BYTES,
        },
      );
      if (error) {
        rememberResponseBinding(
          envelope.requestId,
          envelope.workspaceId,
          envelope.sessionId,
          envelope.revision,
          'rejected',
          error,
        );
        void sendSnapshot(envelope.requestId);
        return;
      }
    }
    if (
      !applyAiSessionUpdate(
        { ...update, sessionId: envelope.sessionId },
        sessionStore,
        envelope.sessionId,
      )
    ) {
      return;
    }

    if (isUserMessage) {
      rememberResponseBinding(
        envelope.requestId,
        envelope.workspaceId,
        envelope.sessionId,
        envelope.revision,
        'user-committed',
      );
    } else if (update.action === 'clearLogAiMessages') {
      invalidateSessionAiActivities(envelope.workspaceId, envelope.sessionId);
    }
    revision += 1;
    void sendSnapshot(envelope.requestId);
  }

  function acceptsActivityBinding(
    envelope: ReturnType<typeof receiveEnvelope>,
    request: { readonly requestId: string; readonly kind: 'terminal' | 'log' },
  ): boolean {
    if (
      !envelope ||
      envelope.requestId !== request.requestId ||
      envelope.workspaceId !== currentWorkspaceId() ||
      workspace?.application.snapshot().acceptsSaves !== true ||
      !isKnownSession(envelope.sessionId)
    ) {
      return false;
    }
    if (request.kind === 'terminal') {
      return envelope.revision === revision && envelope.sessionId === session.value?.id;
    }
    return responseBindingFor(envelope)?.phase === 'user-committed';
  }

  async function sendActivityResult(
    binding: {
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly revision: number;
      readonly requestId: string;
    },
    payload:
      | {
          readonly kind: 'activity-result';
          readonly outcome: 'completed';
          readonly result: unknown;
        }
      | { readonly kind: 'activity-result'; readonly outcome: 'failed'; readonly error: IpcError },
  ): Promise<void> {
    try {
      await emit(
        AI_BRIDGE_EVENTS.activityResult,
        createAiBridgeEnvelope({ ...binding, origin: 'main', payload }),
      );
    } catch (error) {
      logger.debug('ai activity result bridge unavailable:', error);
    }
  }

  async function handleActivityRun(value: unknown): Promise<void> {
    const envelope = receiveEnvelope(value);
    if (!envelope || !isAiActivityRunPayload(envelope.payload)) return;
    const request = envelope.payload.request;
    const binding = {
      workspaceId: envelope.workspaceId,
      sessionId: envelope.sessionId,
      revision: envelope.revision,
      requestId: envelope.requestId,
    } as const;
    if (!acceptsActivityBinding(envelope, request)) {
      const rejected = responseBindingFor(binding);
      // A replay while the original request is running must not publish a
      // failure with the same correlation id and reject the legitimate waiter.
      if (rejected?.phase === 'running') return;
      forgetResponseBinding(binding);
      await sendActivityResult(binding, {
        kind: 'activity-result',
        outcome: 'failed',
        error:
          rejected?.phase === 'rejected' && rejected.error
            ? rejected.error
            : rejectedAiActivity(envelope.requestId),
      });
      return;
    }
    if (request.kind === 'log') {
      rememberResponseBinding(
        binding.requestId,
        binding.workspaceId,
        binding.sessionId,
        binding.revision,
        'running',
      );
    }
    try {
      const activity = await activityCenter.run({ ...binding, request });
      await persistLogActivityResult(binding, activity.result);
      await sendActivityResult(binding, {
        kind: 'activity-result',
        outcome: 'completed',
        result: activity.result,
      });
    } catch (error) {
      await sendActivityResult(binding, {
        kind: 'activity-result',
        outcome: 'failed',
        error: aiActivityError(error, envelope.requestId),
      });
    } finally {
      if (request.kind === 'log') forgetResponseBinding(binding);
    }
  }

  async function persistLogActivityResult(
    binding: {
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly revision: number;
      readonly requestId: string;
    },
    result: Awaited<ReturnType<AiActivityCenter['run']>>['result'],
  ): Promise<void> {
    if (result.kind !== 'log') return;
    const correlated = responseBindingFor(binding);
    const canCommit =
      correlated?.phase === 'running' &&
      canPersistAiResponse(
        binding,
        correlated,
        currentWorkspaceId(),
        workspace?.application.snapshot().acceptsSaves === true,
        isKnownSession(binding.sessionId),
      );
    if (!canCommit) return;
    const reservation = pendingAiResponseReservation(binding.requestId);
    const limitError = workspaceAiMessageLimitError(
      sessionStore.sessions,
      result.answer,
      binding.requestId,
      {
        reservedMessages: reservation.messages,
        reservedBytes: reservation.bytes,
      },
    );
    if (limitError) throw limitError;
    sessionStore.addLogAiMessage(binding.sessionId, {
      role: 'assistant',
      content: result.answer,
    });
    revision += 1;
    await sendSnapshot(binding.requestId);
  }

  async function handleActivityCancel(value: unknown): Promise<void> {
    const envelope = receiveEnvelope(value);
    if (!envelope || !isPayloadKind(envelope.payload, 'activity-cancel')) return;
    forgetResponseBinding(envelope);
    const operation = applicationServices.operationRegistry.get(envelope.requestId);
    if (!sameOperationBinding(operation, envelope)) return;
    await activityCenter.cancel(envelope.requestId);
  }

  async function sendActivitySnapshot(requestId: string = crypto.randomUUID()): Promise<void> {
    const workspaceId = currentWorkspaceId();
    const operations = activityCenter
      .snapshot()
      .filter((operation) => operation.workspaceId === workspaceId)
      .slice(-64);
    try {
      await emit(
        AI_BRIDGE_EVENTS.activitySnapshot,
        createAiBridgeEnvelope({
          workspaceId,
          revision,
          origin: 'main',
          requestId,
          sessionId: currentSessionId(),
          payload: { kind: 'activity-snapshot', operations },
        }),
      );
    } catch (error) {
      logger.debug('ai activity snapshot bridge unavailable:', error);
    }
  }

  if (getCurrentInstance()) {
    onMounted(async () => {
      unsubscribeOperations = activityCenter.subscribe(() => {
        void sendActivitySnapshot();
      });
      unsubscribeWorkspace =
        workspace?.application.subscribe((snapshot) => {
          const nextWorkspaceId = snapshot.currentWorkspace?.workspaceId ?? NO_AI_WORKSPACE_ID;
          if (nextWorkspaceId === observedWorkspaceId) return;
          observedWorkspaceId = nextWorkspaceId;
          responseBindings.clear();
          revision += 1;
          void Promise.all([sendAuthority(), sendSnapshot(), sendActivitySnapshot()]);
        }) ?? null;
      try {
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.authorityRequest, (event) => {
            const envelope = receiveEnvelope(event.payload);
            if (
              envelope &&
              envelope.revision <= revision &&
              isPayloadKind(envelope.payload, 'authority-request')
            ) {
              void sendAuthority(envelope.requestId);
            }
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.sessionRequest, (event) => {
            const envelope = receiveEnvelope(event.payload);
            if (
              envelope &&
              envelope.revision <= revision &&
              isPayloadKind(envelope.payload, 'session-snapshot-request')
            ) {
              void sendSnapshot(envelope.requestId);
            }
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.logContextRequest, (event) => {
            const envelope = receiveEnvelope(event.payload);
            if (
              envelope &&
              envelope.workspaceId === currentWorkspaceId() &&
              envelope.revision <= revision &&
              isPayloadKind(envelope.payload, 'log-context-request') &&
              isKnownSession(envelope.sessionId)
            ) {
              if (responseBindings.has(envelope.requestId)) return;
              if (
                !rememberResponseBinding(
                  envelope.requestId,
                  envelope.workspaceId,
                  envelope.sessionId,
                  envelope.revision,
                )
              )
                return;
              void sendLogContext(envelope.requestId, envelope.sessionId);
            }
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.commandApply, (event) => {
            const envelope = receiveEnvelope(event.payload);
            if (
              envelope &&
              envelope.workspaceId === currentWorkspaceId() &&
              envelope.revision === revision &&
              envelope.sessionId === session.value?.id &&
              isPayloadKind(envelope.payload, 'command-apply') &&
              isAiCommandApplyEvent(envelope.payload)
            ) {
              appStore.applyAiCommand(envelope.payload.command);
            }
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.sessionUpdate, (event) => {
            handleSessionUpdate(event.payload);
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.activityRun, (event) => {
            void handleActivityRun(event.payload);
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.activityCancel, (event) => {
            void handleActivityCancel(event.payload);
          }),
        );
        unlisteners.push(
          await listen<unknown>(AI_BRIDGE_EVENTS.activitySnapshotRequest, (event) => {
            const envelope = receiveEnvelope(event.payload);
            if (envelope && isPayloadKind(envelope.payload, 'activity-snapshot-request')) {
              void sendActivitySnapshot(envelope.requestId);
            }
          }),
        );
      } catch (error) {
        logger.debug('ai-session event bridge unavailable:', error);
      }
      await Promise.all([sendAuthority(), sendSnapshot()]);
    });

    onUnmounted(() => {
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
      unsubscribeOperations?.();
      unsubscribeOperations = null;
      unsubscribeWorkspace?.();
      unsubscribeWorkspace = null;
    });
  }

  watch(
    () => session.value?.id,
    () => {
      revision += 1;
      void sendSnapshot();
    },
  );

  watch(
    () => session.value?.isConnected,
    () => {
      revision += 1;
      void sendSnapshot();
    },
  );

  watch(
    () => [appStore.theme, appStore.locale, appStore.aiKeyStatus] as const,
    () => {
      revision += 1;
      void Promise.all([sendAuthority(), sendSnapshot()]);
    },
    { deep: true },
  );

  return Object.freeze({
    get workspaceId() {
      return currentWorkspaceId();
    },
    get revision() {
      return revision;
    },
  });
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

export function isAiResponseBindingTransitionAllowed(
  current: AiResponseBindingPhase | null,
  next: AiResponseBindingPhase,
): boolean {
  if (current === null) return next === 'context-issued';
  if (current === 'context-issued') return next === 'user-committed' || next === 'rejected';
  return current === 'user-committed' && next === 'running';
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

function sameResponseBinding(
  left: AiResponseBinding,
  right: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly revision: number;
    readonly requestId: string;
  },
): boolean {
  return (
    left.requestId === right.requestId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.revision === right.revision
  );
}

function isTerminalOperation(operation: OperationRecord): boolean {
  return (
    operation.status === 'completed' ||
    operation.status === 'failed' ||
    operation.status === 'cancelled' ||
    operation.status === 'interrupted'
  );
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

function sameOperationBinding(
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

function rejectedAiActivity(requestId: string): IpcError {
  return Object.freeze({
    code: 'CANCELLED',
    messageKey: 'error.cancelled',
    retryable: false,
    operation: 'run_ai_request',
    requestId,
  });
}

function aiActivityError(error: unknown, requestId: string): IpcError {
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
