import { computed, getCurrentInstance, onMounted, onUnmounted, watch } from 'vue';
import { emitNativeEvent as emit, listenNativeEvent as listen } from '@/features/platform/native';
import { buildLogAiContext } from '@/lib/ai-log-context';
import { logger } from '@/lib/logger';
import { useAppStore } from '@/features/settings/store/app-store';
import {
  useSessionApplicationServices,
  useSessionCatalog,
  useSessionDocument,
  useSessionRuntimeStatuses,
} from '@/features/sessions';
import { useOptionalWorkspaceApplication } from '@/features/workspace/application';
import {
  AI_BRIDGE_EVENTS,
  NO_AI_SESSION_ID,
  NO_AI_WORKSPACE_ID,
  AiActivityCenter,
  createAiBridgeEnvelope,
  isAiActivityRunPayload,
  isPayloadKind,
  parseAiBridgeEnvelope,
} from '@/features/ai-activity';
import { IPC_LIMITS, type IpcError } from '@/generated/ipc-contracts';
import {
  MAX_AI_MESSAGE_BYTES,
  aiActivityError,
  applyAiSessionUpdate,
  canPersistAiResponse,
  hasBoundedText,
  isAiCommandApplyEvent,
  isRecord,
  isTerminalOperation,
  rejectedAiActivity,
  sameOperationBinding,
  toAiChatSnapshot,
  toAiSessionSummary,
  workspaceAiMessageLimitError,
} from '@/features/ai/ai-session-projection';
import { AiResponseBindingRegistry } from '@/features/ai/ai-response-binding-registry';
import type { AiLogContextSnapshot } from '@/types';

// The pure helpers and the response-binding state machine moved into
// framework-free modules under `features/ai`. They are re-exported here so
// every existing import site keeps working unchanged.
export {
  applyAiSessionUpdate,
  canPersistAiResponse,
  isAiSessionUpdate,
  toAiChatSnapshot,
  toAiSessionSummary,
  workspaceAiMessageLimitError,
  type AiResponseBinding,
  type AiResponseBindingPhase,
} from '@/features/ai/ai-session-projection';
export { isAiResponseBindingTransitionAllowed } from '@/features/ai/ai-response-binding-registry';

interface AiSessionUpdateEvent {
  kind?: 'session-update';
  action: string;
  value: unknown;
}

export function useAiSessionBridge() {
  const catalog = useSessionCatalog();
  const appStore = useAppStore();
  const applicationServices = useSessionApplicationServices();
  const { isConnected } = useSessionRuntimeStatuses();
  const workspace = useOptionalWorkspaceApplication();
  const activityCenter = new AiActivityCenter({
    operations: applicationServices.operationRegistry,
  });
  const session = computed(() => catalog.activeSession.value);
  const aiSessionMutations = {
    setTerminalAiModel: (
      id: string,
      value: Parameters<ReturnType<typeof useSessionDocument>['setTerminalAiModel']>[1],
    ) => useSessionDocument(id).setTerminalAiModel(id, value),
    setLogAiModel: (
      id: string,
      value: Parameters<ReturnType<typeof useSessionDocument>['setLogAiModel']>[1],
    ) => useSessionDocument(id).setLogAiModel(id, value),
    setLogAiContextMode: (
      id: string,
      value: Parameters<ReturnType<typeof useSessionDocument>['setLogAiContextMode']>[1],
    ) => useSessionDocument(id).setLogAiContextMode(id, value),
    setLogAiFrameLimit: (id: string, value: number) =>
      useSessionDocument(id).setLogAiFrameLimit(id, value),
    addLogAiMessage: (
      id: string,
      value: Parameters<ReturnType<typeof useSessionDocument>['addLogAiMessage']>[1],
    ) => useSessionDocument(id).addLogAiMessage(id, value),
    clearLogAiMessages: (id: string) => useSessionDocument(id).clearLogAiMessages(id),
  };
  const unlisteners: Array<() => void> = [];
  const responseBindings = new AiResponseBindingRegistry();
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

  async function sendCommandRejection(
    requestId: string,
    sessionId: string,
    reason: 'revision-mismatch' | 'session-mismatch' | 'workspace-mismatch' | 'invalid-payload',
  ) {
    try {
      await emit(
        AI_BRIDGE_EVENTS.commandResult,
        createAiBridgeEnvelope({
          workspaceId: currentWorkspaceId(),
          revision,
          origin: 'main',
          requestId,
          sessionId,
          payload: { kind: 'command-result', outcome: 'rejected', reason },
        }),
      );
    } catch (error) {
      logger.debug('ai command-result bridge unavailable:', error);
    }
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
            session: active ? toAiSessionSummary(active, isConnected(active.id)) : null,
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
    const active = catalog.sessions.value.find((candidate) => candidate.id === sessionId);
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
    return catalog.sessions.value.some((candidate) => candidate.id === sessionId);
  }

  function invalidateSessionAiActivities(workspaceId: string, sessionId: string): void {
    for (const requestId of responseBindings.requestIdsFor(workspaceId, sessionId)) {
      responseBindings.delete(requestId);
      const operation = applicationServices.operationRegistry.get(requestId);
      if (!operation || isTerminalOperation(operation)) continue;
      void activityCenter.cancel(requestId).catch((error) => {
        logger.debug('failed to cancel invalidated AI log activity:', error);
      });
    }
  }

  function handleSessionUpdate(value: unknown): void {
    const envelope = receiveEnvelope(value);
    if (!envelope || !isPayloadKind(envelope.payload, 'session-update')) return;
    const update: AiSessionUpdateEvent = {
      kind: 'session-update',
      action: envelope.payload.action as string,
      value: envelope.payload.value,
    };
    const correlated = responseBindings.responseBindingFor(envelope);
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
      const reservation = responseBindings.pendingAiResponseReservation();
      const error = workspaceAiMessageLimitError(
        catalog.sessions.value,
        userMessageContent,
        envelope.requestId,
        {
          reservedMessages: reservation.messages + 1,
          reservedBytes: reservation.bytes + IPC_LIMITS.MAX_AI_RESPONSE_BYTES,
        },
      );
      if (error) {
        responseBindings.remember(
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
        aiSessionMutations,
        envelope.sessionId,
      )
    ) {
      return;
    }

    if (isUserMessage) {
      responseBindings.remember(
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
    return responseBindings.responseBindingFor(envelope)?.phase === 'user-committed';
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
      const rejected = responseBindings.responseBindingFor(binding);
      // A replay while the original request is running must not publish a
      // failure with the same correlation id and reject the legitimate waiter.
      if (rejected?.phase === 'running') return;
      responseBindings.forgetResponseBinding(binding);
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
      responseBindings.remember(
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
      if (request.kind === 'log') responseBindings.forgetResponseBinding(binding);
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
    const correlated = responseBindings.responseBindingFor(binding);
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
    const reservation = responseBindings.pendingAiResponseReservation(binding.requestId);
    const limitError = workspaceAiMessageLimitError(
      catalog.sessions.value,
      result.answer,
      binding.requestId,
      {
        reservedMessages: reservation.messages,
        reservedBytes: reservation.bytes,
      },
    );
    if (limitError) throw limitError;
    aiSessionMutations.addLogAiMessage(binding.sessionId, {
      role: 'assistant',
      content: result.answer,
    });
    revision += 1;
    await sendSnapshot(binding.requestId);
  }

  async function handleActivityCancel(value: unknown): Promise<void> {
    const envelope = receiveEnvelope(value);
    if (!envelope || !isPayloadKind(envelope.payload, 'activity-cancel')) return;
    responseBindings.forgetResponseBinding(envelope);
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
                !responseBindings.remember(
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
            if (!envelope || !isPayloadKind(envelope.payload, 'command-apply')) return;
            if (
              envelope.workspaceId === currentWorkspaceId() &&
              envelope.revision === revision &&
              envelope.sessionId === session.value?.id &&
              isAiCommandApplyEvent(envelope.payload)
            ) {
              appStore.applyAiCommand(envelope.payload.command);
              return;
            }
            // Receipts make a dropped command visible to the AI window (which
            // can offer a retry) instead of the old silent no-op.
            const reason = !isAiCommandApplyEvent(envelope.payload)
              ? 'invalid-payload'
              : envelope.workspaceId !== currentWorkspaceId()
                ? 'workspace-mismatch'
                : envelope.sessionId !== session.value?.id
                  ? 'session-mismatch'
                  : 'revision-mismatch';
            void sendCommandRejection(envelope.requestId, envelope.sessionId, reason);
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
    () => (session.value ? isConnected(session.value.id) : false),
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
