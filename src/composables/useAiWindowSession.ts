import { getCurrentInstance, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { emitNativeEvent as emit, listenNativeEvent as listen } from '../features/native';
import type { OperationRecord, RunAiRequest } from '../generated/ipc-contracts';
import {
  AI_BRIDGE_EVENTS,
  AI_BRIDGE_WORKSPACE_ID,
  NO_AI_SESSION_ID,
  NO_AI_WORKSPACE_ID,
  type AiActivityBinding,
  type AiActivityCenter,
  type AiActivityResult,
  createAiBridgeEnvelope,
  isAiActivityResultPayload,
  isAiActivitySnapshotPayload,
  isAiCommandResultPayload,
  isPayloadKind,
  isRecord,
  parseAiBridgeEnvelope,
} from '../features/ai-activity';
import type {
  AiChatMessage,
  AiChatSnapshot,
  AiLogContextSnapshot,
  AiModel,
  AiSessionSummary,
  AiWindowSession,
  LogAiContextMode,
} from '../types';

interface PendingResolver<T> {
  readonly resolve: (value: T) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly sessionId?: string;
  readonly workspaceId?: string;
}

interface PendingActivity {
  readonly binding: AiWindowRequestBinding;
  readonly resolve: (value: AiActivityResult) => void;
  readonly reject: (reason: unknown) => void;
}

export type AiWindowRequestBinding = AiActivityBinding;

/** Injectable dependencies keep the protocol and activity lifecycle testable. */
export interface UseAiWindowSessionDeps {
  emit?: (event: string, payload?: unknown) => Promise<void>;
  listen?: typeof listen;
  requestId?: () => string;
  activityCenter?: AiActivityCenter;
  /** Explicit opt-in for injected transports; production is always strict. */
  strictProtocol?: boolean;
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
  const workspaceId = ref(AI_BRIDGE_WORKSPACE_ID);
  const revision = ref(0);
  const activities = shallowRef<readonly OperationRecord[]>([]);
  /** Last command the main window refused to apply, for UI retry feedback. */
  const lastCommandRejection = shallowRef<Readonly<{ requestId: string; reason: string }> | null>(
    null,
  );
  const unlisteners: Array<() => void> = [];
  const pendingSnapshots = new Map<string, PendingResolver<AiWindowSession | null>>();
  const pendingContexts = new Map<string, PendingResolver<AiLogContextSnapshot | null>>();
  const pendingActivities = new Map<string, PendingActivity>();
  const doEmit = deps.emit ?? emit;
  const doListen = deps.listen ?? listen;
  const nextRequestId: () => string = deps.requestId ?? (() => crypto.randomUUID());
  const activityCenter = deps.activityCenter;
  // Existing injected-emitter unit consumers retain their old raw-payload
  // adapter. Actual window traffic never enables this compatibility branch.
  const strictProtocol = deps.emit === undefined || deps.strictProtocol === true;
  let unsubscribeActivities: (() => void) | null = null;

  if (getCurrentInstance()) {
    onMounted(async () => {
      if (activityCenter) {
        unsubscribeActivities = activityCenter.subscribe((records) => {
          activities.value = records;
        });
      }
      unlisteners.push(
        await doListen<unknown>(AI_BRIDGE_EVENTS.sessionSnapshot, (event) => {
          receiveSessionSnapshot(event.payload);
        }),
      );
      unlisteners.push(
        await doListen<unknown>(AI_BRIDGE_EVENTS.chatSnapshot, (event) => {
          receiveChatSnapshot(event.payload);
        }),
      );
      unlisteners.push(
        await doListen<unknown>(AI_BRIDGE_EVENTS.logContext, (event) => {
          receiveLogContext(event.payload);
        }),
      );
      unlisteners.push(
        await doListen<unknown>(AI_BRIDGE_EVENTS.activityResult, (event) => {
          receiveActivityResult(event.payload);
        }),
      );
      unlisteners.push(
        await doListen<unknown>(AI_BRIDGE_EVENTS.activitySnapshot, (event) => {
          receiveActivitySnapshot(event.payload);
        }),
      );
      unlisteners.push(
        await doListen<unknown>(AI_BRIDGE_EVENTS.commandResult, (event) => {
          receiveCommandResult(event.payload);
        }),
      );
      await requestActivitySnapshot();
      await refreshSession();
    });

    onUnmounted(() => {
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
      unsubscribeActivities?.();
      unsubscribeActivities = null;
      settleAll(pendingSnapshots, session.value);
      settleAll(pendingContexts, null);
      rejectAllActivities(pendingActivities);
    });
  }

  function receiveSessionSnapshot(value: unknown): boolean {
    const envelope = parseAiBridgeEnvelope(value, 'main');
    if (
      !envelope ||
      envelope.revision < revision.value ||
      !isPayloadKind(envelope.payload, 'session-snapshot') ||
      !isAiSessionSummaryOrNull(envelope.payload.session)
    ) {
      return false;
    }
    const summary = envelope.payload.session;
    if (
      (summary && (envelope.sessionId !== summary.id || summary.id === NO_AI_SESSION_ID)) ||
      (!summary && envelope.sessionId !== NO_AI_SESSION_ID)
    ) {
      return false;
    }
    revision.value = envelope.revision;
    workspaceId.value = envelope.workspaceId;
    session.value = summary ? localSession(summary, session.value) : null;
    settleOne(pendingSnapshots, envelope.requestId, session.value);
    return true;
  }

  function receiveChatSnapshot(value: unknown): boolean {
    const envelope = parseAiBridgeEnvelope(value, 'main');
    if (
      !envelope ||
      envelope.revision < revision.value ||
      !isPayloadKind(envelope.payload, 'chat-snapshot') ||
      !isAiChatSnapshot(envelope.payload.snapshot) ||
      envelope.payload.snapshot.sessionId !== envelope.sessionId ||
      envelope.workspaceId !== workspaceId.value ||
      session.value?.id !== envelope.sessionId
    ) {
      return false;
    }
    revision.value = envelope.revision;
    session.value.logAiMessages = envelope.payload.snapshot.messages;
    return true;
  }

  function receiveLogContext(value: unknown): boolean {
    const envelope = parseAiBridgeEnvelope(value, 'main');
    if (
      !envelope ||
      envelope.revision < revision.value ||
      !isPayloadKind(envelope.payload, 'log-context') ||
      !isAiLogContextSnapshot(envelope.payload.snapshot) ||
      envelope.payload.snapshot.sessionId !== envelope.sessionId
    ) {
      return false;
    }
    const pending = pendingContexts.get(envelope.requestId);
    if (
      !pending ||
      pending.sessionId !== envelope.sessionId ||
      pending.workspaceId !== envelope.workspaceId
    ) {
      return false;
    }
    revision.value = envelope.revision;
    settleOne(pendingContexts, envelope.requestId, envelope.payload.snapshot);
    return true;
  }

  function receiveActivityResult(value: unknown): boolean {
    const envelope = parseAiBridgeEnvelope(value, 'main');
    if (!envelope || !isAiActivityResultPayload(envelope.payload)) return false;
    const pending = pendingActivities.get(envelope.requestId);
    if (!pending || !matchesEnvelope(pending.binding, envelope)) return false;
    pendingActivities.delete(envelope.requestId);
    if (envelope.payload.outcome === 'failed') {
      pending.reject(envelope.payload.error);
    } else {
      pending.resolve(Object.freeze({ ...pending.binding, result: envelope.payload.result }));
    }
    return true;
  }

  function receiveActivitySnapshot(value: unknown): boolean {
    const envelope = parseAiBridgeEnvelope(value, 'main');
    if (
      !envelope ||
      envelope.revision < revision.value ||
      !isAiActivitySnapshotPayload(envelope.payload)
    ) {
      return false;
    }
    revision.value = envelope.revision;
    workspaceId.value = envelope.workspaceId;
    activities.value = Object.freeze(
      envelope.payload.operations.filter((operation) => operation.kind === 'ai-request'),
    );
    return true;
  }

  async function refreshSession(timeoutMs = 1000): Promise<AiWindowSession | null> {
    if (!strictProtocol) {
      await doEmit(AI_BRIDGE_EVENTS.sessionRequest);
      return session.value;
    }
    const requestId = nextRequestId();
    const pending = waitFor(pendingSnapshots, requestId, timeoutMs, () => session.value);
    await doEmit(
      AI_BRIDGE_EVENTS.sessionRequest,
      createAiBridgeEnvelope({
        workspaceId: workspaceId.value,
        revision: revision.value,
        origin: 'ai-assistant',
        requestId,
        sessionId: session.value?.id ?? NO_AI_SESSION_ID,
        payload: { kind: 'session-snapshot-request' },
      }),
    );
    return pending;
  }

  async function getLogContext(
    bindingOrTimeout?: AiWindowRequestBinding | number,
    requestedTimeoutMs = 1000,
  ): Promise<AiLogContextSnapshot | null> {
    const binding =
      typeof bindingOrTimeout === 'object' ? bindingOrTimeout : createRequestBinding();
    const timeoutMs = typeof bindingOrTimeout === 'number' ? bindingOrTimeout : requestedTimeoutMs;
    if (!binding) return null;
    if (!strictProtocol) {
      await doEmit(AI_BRIDGE_EVENTS.logContextRequest, { sessionId: binding.sessionId });
      return null;
    }
    const pending = waitFor(
      pendingContexts,
      binding.requestId,
      timeoutMs,
      () => null,
      binding.sessionId,
      binding.workspaceId,
    );
    await doEmit(
      AI_BRIDGE_EVENTS.logContextRequest,
      createAiBridgeEnvelope({
        workspaceId: binding.workspaceId,
        revision: binding.revision,
        origin: 'ai-assistant',
        requestId: binding.requestId,
        sessionId: binding.sessionId,
        payload: { kind: 'log-context-request' },
      }),
    );
    return pending;
  }

  async function releaseRequestBinding(binding: AiWindowRequestBinding): Promise<void> {
    if (!strictProtocol) return;
    await emitBound(AI_BRIDGE_EVENTS.activityCancel, binding, { kind: 'activity-cancel' });
  }

  /** Records the main window's refusal so the UI can offer a retry instead of
   *  leaving a command-apply press silently ignored. */
  function receiveCommandResult(value: unknown): boolean {
    const envelope = parseAiBridgeEnvelope(value, 'main');
    if (!envelope || !isAiCommandResultPayload(envelope.payload)) return false;
    if (envelope.payload.outcome === 'rejected') {
      lastCommandRejection.value = Object.freeze({
        requestId: envelope.requestId,
        reason: envelope.payload.reason,
      });
    }
    return true;
  }

  async function applyCommand(
    command: string,
    explicitBinding?: AiWindowRequestBinding,
  ): Promise<string | null> {
    const binding = explicitBinding ?? createRequestBinding();
    if (!strictProtocol) {
      await doEmit(AI_BRIDGE_EVENTS.commandApply, { command });
      return null;
    }
    if (binding) {
      await emitBound(AI_BRIDGE_EVENTS.commandApply, binding, { kind: 'command-apply', command });
      return binding.requestId;
    }
    return null;
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

  async function addLogAiMessage(
    message: Omit<AiChatMessage, 'id' | 'timestamp'>,
    binding?: AiWindowRequestBinding,
  ) {
    if (message.role !== 'user') {
      throw new Error('AI assistant messages are committed only by the main window');
    }
    const target = binding ?? createRequestBinding();
    if (!target) return;
    // A response for an earlier session is sent to main with its original
    // binding, but it must never appear in the currently selected session UI.
    if (workspaceId.value === target.workspaceId && session.value?.id === target.sessionId) {
      session.value.logAiMessages.push({
        ...message,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      });
    }
    await emitUpdate('addLogAiMessage', message, target);
  }

  async function clearLogAiMessages() {
    if (!session.value) return;
    session.value.logAiMessages = [];
    await emitUpdate('clearLogAiMessages', null);
  }

  function createRequestBinding(requestId = nextRequestId()): AiWindowRequestBinding | null {
    const sessionId = session.value?.id;
    if (
      !sessionId ||
      (strictProtocol &&
        (workspaceId.value === AI_BRIDGE_WORKSPACE_ID || workspaceId.value === NO_AI_WORKSPACE_ID))
    ) {
      return null;
    }
    return Object.freeze({
      workspaceId: workspaceId.value,
      sessionId,
      revision: revision.value,
      requestId,
    });
  }

  async function runRequest(
    request: RunAiRequest,
    binding: AiWindowRequestBinding,
  ): Promise<AiActivityResult> {
    if (activityCenter) return activityCenter.run({ ...binding, request });
    if (!strictProtocol) throw new Error('AI activity authority is unavailable');
    if (request.requestId !== binding.requestId) {
      throw new Error('AI native requestId must equal the activity requestId');
    }
    if (pendingActivities.has(binding.requestId)) {
      throw new Error(`AI activity is already pending: ${binding.requestId}`);
    }
    return new Promise<AiActivityResult>((resolve, reject) => {
      pendingActivities.set(binding.requestId, { binding, resolve, reject });
      void emitBound(AI_BRIDGE_EVENTS.activityRun, binding, {
        kind: 'activity-run',
        request,
      }).catch((error) => {
        if (pendingActivities.delete(binding.requestId)) {
          void releaseRequestBinding(binding).catch(() => undefined);
          reject(error);
        }
      });
    });
  }

  async function cancelRequest(requestId: string): Promise<void> {
    if (activityCenter) {
      await activityCenter.cancel(requestId);
      return;
    }
    const pending = pendingActivities.get(requestId);
    const operation = activities.value.find((candidate) => candidate.operationId === requestId);
    const binding =
      pending?.binding ??
      (operation?.sessionId
        ? {
            workspaceId: operation.workspaceId,
            sessionId: operation.sessionId,
            revision: revision.value,
            requestId: operation.operationId,
          }
        : null);
    if (!binding) return;
    await emitBound(AI_BRIDGE_EVENTS.activityCancel, binding, { kind: 'activity-cancel' });
  }

  function isBindingCurrent(binding: AiWindowRequestBinding): boolean {
    return workspaceId.value === binding.workspaceId && session.value?.id === binding.sessionId;
  }

  async function emitUpdate(
    action: string,
    value: unknown,
    explicitBinding?: AiWindowRequestBinding,
  ) {
    const binding = explicitBinding ?? createRequestBinding();
    if (!binding) return;
    if (!strictProtocol) {
      await doEmit(AI_BRIDGE_EVENTS.sessionUpdate, {
        sessionId: binding.sessionId,
        action,
        value,
      });
      return;
    }
    await emitBound(AI_BRIDGE_EVENTS.sessionUpdate, binding, {
      kind: 'session-update',
      action,
      value,
    });
  }

  async function emitBound(event: string, binding: AiWindowRequestBinding, payload: unknown) {
    await doEmit(
      event,
      createAiBridgeEnvelope({
        workspaceId: binding.workspaceId,
        revision: binding.revision,
        origin: 'ai-assistant',
        requestId: binding.requestId,
        sessionId: binding.sessionId,
        payload,
      }),
    );
  }

  async function requestActivitySnapshot(): Promise<void> {
    if (activityCenter || !strictProtocol) return;
    await doEmit(
      AI_BRIDGE_EVENTS.activitySnapshotRequest,
      createAiBridgeEnvelope({
        workspaceId: workspaceId.value,
        revision: revision.value,
        origin: 'ai-assistant',
        requestId: nextRequestId(),
        sessionId: session.value?.id ?? NO_AI_SESSION_ID,
        payload: { kind: 'activity-snapshot-request' },
      }),
    );
  }

  return {
    session,
    workspaceId,
    revision,
    activities,
    lastCommandRejection,
    refreshSession,
    getLogContext,
    releaseRequestBinding,
    applyCommand,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
    createRequestBinding,
    runRequest,
    cancelRequest,
    isBindingCurrent,
    // Pure receivers are exposed for deterministic protocol tests; browser
    // callers continue to use the same public session/mutation API.
    receiveSessionSnapshot,
    receiveChatSnapshot,
    receiveLogContext,
    receiveActivityResult,
    receiveActivitySnapshot,
    receiveCommandResult,
  };
}

function waitFor<T>(
  pending: Map<string, PendingResolver<T>>,
  requestId: string,
  timeoutMs: number,
  fallback: () => T,
  sessionId?: string,
  workspaceId?: string,
): Promise<T> {
  return new Promise((resolve) => {
    const item: PendingResolver<T> = {
      resolve,
      sessionId,
      workspaceId,
      timer: setTimeout(() => {
        pending.delete(requestId);
        resolve(fallback());
      }, timeoutMs),
    };
    pending.set(requestId, item);
  });
}

function matchesEnvelope(
  binding: AiWindowRequestBinding,
  envelope: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly requestId: string;
    readonly revision: number;
  },
): boolean {
  return (
    binding.workspaceId === envelope.workspaceId &&
    binding.sessionId === envelope.sessionId &&
    binding.requestId === envelope.requestId &&
    binding.revision === envelope.revision
  );
}

function rejectAllActivities(pending: Map<string, PendingActivity>): void {
  const activities = Array.from(pending.values());
  pending.clear();
  for (const activity of activities) {
    activity.reject(new Error('AI activity view was disposed; application work remains queryable'));
  }
}

function settleOne<T>(pending: Map<string, PendingResolver<T>>, requestId: string, value: T): void {
  const item = pending.get(requestId);
  if (!item) return;
  pending.delete(requestId);
  clearTimeout(item.timer);
  item.resolve(value);
}

function settleAll<T>(pending: Map<string, PendingResolver<T>>, value: T): void {
  const items = Array.from(pending.values());
  pending.clear();
  for (const item of items) {
    clearTimeout(item.timer);
    item.resolve(value);
  }
}

function isAiSessionSummaryOrNull(value: unknown): value is AiSessionSummary | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.portName === 'string' &&
    typeof value.baudRate === 'number' &&
    typeof value.isConnected === 'boolean' &&
    typeof value.txBytes === 'number' &&
    typeof value.rxBytes === 'number' &&
    typeof value.txFrames === 'number' &&
    typeof value.rxFrames === 'number' &&
    typeof value.terminalAiModel === 'string' &&
    typeof value.logAiModel === 'string' &&
    typeof value.logAiContextMode === 'string' &&
    typeof value.logAiFrameLimit === 'number'
  );
}

function isAiChatSnapshot(value: unknown): value is AiChatSnapshot {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.length <= 100 &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === 'string' &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        typeof message.timestamp === 'number',
    )
  );
}

function isAiLogContextSnapshot(value: unknown): value is AiLogContextSnapshot {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.text === 'string' &&
    typeof value.truncated === 'boolean' &&
    Number.isSafeInteger(value.frameCount) &&
    Number.isSafeInteger(value.charLimit)
  );
}
