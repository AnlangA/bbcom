// @vitest-environment happy-dom

import { defineComponent, nextTick, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SerialSession } from '@/types.ts';
import { OperationRegistry } from '@/features/platform/application/operation-registry.ts';
import {
  AI_BRIDGE_EVENTS,
  createAiBridgeEnvelope,
} from '@/features/ai-activity/protocol.ts';
import { useAiSessionBridge } from '@/features/ai/application/use-ai-session-bridge.ts';

type EventHandler = (event: { payload: unknown }) => void;

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, EventHandler>(),
  emitted: [] as Array<{ event: string; payload: unknown }>,
  unlisten: vi.fn(),
  runAiRequest: vi.fn(),
  cancelAiRequest: vi.fn(async () => undefined),
  debug: vi.fn(),
  catalog: null as null | {
    sessions: { value: SerialSession[] };
    activeSession: { value: SerialSession | null };
  },
  runtimeConnected: null as null | { value: boolean },
  app: null as null | {
    theme: 'dark' | 'light';
    locale: 'en' | 'zh';
    aiKeyStatus: { configured: boolean; durability: 'os' | 'session' | 'missing' };
    applyAiCommand: ReturnType<typeof vi.fn>;
  },
  document: null as null | Record<string, ReturnType<typeof vi.fn>>,
  operations: null as OperationRegistry | null,
  workspaceId: 'workspace-a',
  acceptsSaves: true,
  workspaceListener: null as null | ((snapshot: unknown) => void),
  unsubscribeWorkspace: vi.fn(),
}));

vi.mock('@/features/platform/native', () => ({
  emitNativeEvent: async (event: string, payload: unknown) => {
    bridge.emitted.push({ event, payload });
  },
  listenNativeEvent: async (event: string, handler: EventHandler) => {
    bridge.listeners.set(event, handler);
    return () => {
      bridge.unlisten(event);
      bridge.listeners.delete(event);
    };
  },
  runAiRequest: (...args: unknown[]) => bridge.runAiRequest(...args),
  cancelAiRequest: (...args: unknown[]) => bridge.cancelAiRequest(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: (...args: unknown[]) => bridge.debug(...args) },
}));

vi.mock('@/features/settings/store/app-store', () => ({
  useAppStore: () => bridge.app,
}));

vi.mock('@/features/sessions', () => ({
  useSessionCatalog: () => bridge.catalog,
  useSessionApplicationServices: () => ({ operationRegistry: bridge.operations }),
  useSessionRuntimeStatuses: () => ({
    isConnected: () => bridge.runtimeConnected?.value ?? false,
  }),
  useSessionDocument: () => bridge.document,
}));

vi.mock('@/features/workspace/application', () => ({
  useOptionalWorkspaceApplication: () => ({
    application: {
      snapshot: () => ({
        acceptsSaves: bridge.acceptsSaves,
        currentWorkspace: { workspaceId: bridge.workspaceId },
      }),
      subscribe: (listener: (snapshot: unknown) => void) => {
        bridge.workspaceListener = listener;
        return bridge.unsubscribeWorkspace;
      },
    },
  }),
}));

function sessionFixture(): SerialSession {
  return {
    id: 'session-1',
    portName: 'COM1',
    portConfig: {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    },
    isConnected: true,
    frames: [],
    pausedFrames: [],
    capturePaused: false,
    txBytes: 0,
    rxBytes: 0,
    txFrames: 0,
    rxFrames: 0,
    startTime: null,
    sendHistory: [],
    sendDraft: '',
    quickCommands: [],
    macros: [],
    triggers: [],
    highlights: [],
    parserState: { config: { kind: 'fixed', frameSize: 1 }, presetId: null },
    modbusRegisters: [],
    modbusConfig: {
      enabled: false,
      transport: 'rtu',
      pollIntervalMs: 1000,
      timeoutMs: 500,
    },
    waveformSourceMode: 'text',
    autoLogEnabled: false,
    logPath: null,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
    logAiMessages: [],
  } as SerialSession;
}

function envelope(
  revision: number,
  requestId: string,
  payload: Record<string, unknown>,
  options: { workspaceId?: string; sessionId?: string } = {},
) {
  return createAiBridgeEnvelope({
    workspaceId: options.workspaceId ?? bridge.workspaceId,
    revision,
    origin: 'ai-assistant',
    requestId,
    sessionId: options.sessionId ?? 'session-1',
    payload,
  });
}

function dispatch(event: string, payload: unknown): void {
  const listener = bridge.listeners.get(event);
  expect(listener, `listener for ${event}`).toBeTypeOf('function');
  listener?.({ payload });
}

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeEach(() => {
  bridge.listeners.clear();
  bridge.emitted.length = 0;
  bridge.unlisten.mockClear();
  bridge.runAiRequest.mockReset();
  bridge.cancelAiRequest.mockClear();
  bridge.debug.mockClear();
  bridge.workspaceId = 'workspace-a';
  bridge.acceptsSaves = true;
  bridge.workspaceListener = null;
  bridge.unsubscribeWorkspace.mockClear();
  bridge.operations = new OperationRegistry();

  const active = ref<SerialSession | null>(sessionFixture());
  bridge.catalog = {
    sessions: ref([active.value!]),
    activeSession: active,
  };
  bridge.runtimeConnected = ref(true);
  bridge.app = reactive({
    theme: 'dark' as const,
    locale: 'en' as const,
    aiKeyStatus: { configured: false, durability: 'missing' as const },
    applyAiCommand: vi.fn(),
  });
  bridge.document = {
    setTerminalAiModel: vi.fn(),
    setLogAiModel: vi.fn(),
    setLogAiContextMode: vi.fn(),
    setLogAiFrameLimit: vi.fn(),
    addLogAiMessage: vi.fn(),
    clearLogAiMessages: vi.fn(),
  };
});

test('mounted AI bridge validates requests, publishes snapshots, and cleans up listeners', async () => {
  const Host = defineComponent({
    setup: () => ({ aiBridge: useAiSessionBridge() }),
    template: '<div />',
  });
  const wrapper = mount(Host);
  await flush();

  // Main listens to every bridge event except the seven it only emits
  // (authority/session/chat/log-context/activity snapshots + command result).
  expect(bridge.listeners.size).toBe(Object.keys(AI_BRIDGE_EVENTS).length - 7);
  expect(bridge.emitted.map(({ event }) => event)).toEqual(
    expect.arrayContaining([
      AI_BRIDGE_EVENTS.authoritySnapshot,
      AI_BRIDGE_EVENTS.sessionSnapshot,
      AI_BRIDGE_EVENTS.chatSnapshot,
    ]),
  );

  const revision = (wrapper.vm as unknown as { aiBridge: { revision: number } }).aiBridge.revision;
  dispatch(
    AI_BRIDGE_EVENTS.authorityRequest,
    envelope(revision, 'authority-1', { kind: 'authority-request' }),
  );
  dispatch(
    AI_BRIDGE_EVENTS.sessionRequest,
    envelope(revision, 'snapshot-1', { kind: 'session-snapshot-request' }),
  );
  dispatch(
    AI_BRIDGE_EVENTS.commandApply,
    envelope(revision, 'command-1', { kind: 'command-apply', command: 'AT+RST' }),
  );
  dispatch(
    AI_BRIDGE_EVENTS.activitySnapshotRequest,
    envelope(revision, 'activities-1', { kind: 'activity-snapshot-request' }),
  );
  dispatch(AI_BRIDGE_EVENTS.authorityRequest, { malformed: true });
  await flush();

  expect(bridge.app?.applyAiCommand).toHaveBeenCalledWith('AT+RST');
  expect(
    bridge.emitted.some(
      ({ event, payload }) =>
        event === AI_BRIDGE_EVENTS.activitySnapshot &&
        (payload as { requestId?: string }).requestId === 'activities-1',
    ),
  ).toBe(true);

  bridge.runtimeConnected!.value = false;
  bridge.app!.theme = 'light';
  bridge.catalog!.activeSession.value = null;
  await flush();
  expect(
    (wrapper.vm as unknown as { aiBridge: { workspaceId: string } }).aiBridge.workspaceId,
  ).toBe('workspace-a');

  bridge.workspaceId = 'workspace-b';
  bridge.workspaceListener?.({ currentWorkspace: { workspaceId: 'workspace-b' } });
  bridge.workspaceListener?.({ currentWorkspace: { workspaceId: 'workspace-b' } });
  await flush();

  wrapper.unmount();
  expect(bridge.unlisten).toHaveBeenCalledTimes(8);
  expect(bridge.unsubscribeWorkspace).toHaveBeenCalledOnce();
});

test('AI log binding accepts one correlated response and rejects stale or replayed activity', async () => {
  bridge.runAiRequest.mockResolvedValue({
    kind: 'log',
    answer: 'The device reset successfully.',
    evidence: [],
    suggestions: [],
    truncated: false,
  });
  const Host = defineComponent({
    setup: () => ({ aiBridge: useAiSessionBridge() }),
    template: '<div />',
  });
  const wrapper = mount(Host);
  await flush();
  const currentRevision = () =>
    (wrapper.vm as unknown as { aiBridge: { revision: number } }).aiBridge.revision;

  dispatch(
    AI_BRIDGE_EVENTS.logContextRequest,
    envelope(currentRevision(), 'log-1', { kind: 'log-context-request' }),
  );
  dispatch(
    AI_BRIDGE_EVENTS.logContextRequest,
    envelope(currentRevision(), 'log-1', { kind: 'log-context-request' }),
  );
  await flush();
  expect(bridge.emitted.some(({ event }) => event === AI_BRIDGE_EVENTS.logContext)).toBe(true);

  dispatch(
    AI_BRIDGE_EVENTS.sessionUpdate,
    envelope(currentRevision(), 'log-1', {
      kind: 'session-update',
      action: 'addLogAiMessage',
      value: { role: 'user', content: 'What happened?' },
    }),
  );
  await flush();
  expect(bridge.document?.addLogAiMessage).toHaveBeenCalledWith('session-1', {
    role: 'user',
    content: 'What happened?',
  });

  const boundRevision = currentRevision() - 1;
  dispatch(
    AI_BRIDGE_EVENTS.activityRun,
    envelope(boundRevision, 'log-1', {
      kind: 'activity-run',
      request: { requestId: 'log-1', kind: 'log', prompt: 'summarize' },
    }),
  );
  await flush();
  expect(bridge.runAiRequest).toHaveBeenCalledOnce();
  expect(bridge.document?.addLogAiMessage).toHaveBeenCalledWith('session-1', {
    role: 'assistant',
    content: 'The device reset successfully.',
  });
  expect(
    bridge.emitted.some(
      ({ event, payload }) =>
        event === AI_BRIDGE_EVENTS.activityResult &&
        (payload as { payload?: { outcome?: string } }).payload?.outcome === 'completed',
    ),
  ).toBe(true);

  dispatch(
    AI_BRIDGE_EVENTS.activityRun,
    envelope(
      currentRevision(),
      'stale-run',
      {
        kind: 'activity-run',
        request: { requestId: 'stale-run', kind: 'log', prompt: 'replay' },
      },
      { workspaceId: 'workspace-old' },
    ),
  );
  dispatch(AI_BRIDGE_EVENTS.activityRun, { invalid: true });
  await flush();
  expect(
    bridge.emitted.some(
      ({ event, payload }) =>
        event === AI_BRIDGE_EVENTS.activityResult &&
        (payload as { requestId?: string; payload?: { outcome?: string } }).requestId ===
          'stale-run' &&
        (payload as { payload?: { outcome?: string } }).payload?.outcome === 'failed',
    ),
  ).toBe(true);

  dispatch(
    AI_BRIDGE_EVENTS.sessionUpdate,
    envelope(currentRevision(), 'clear-1', {
      kind: 'session-update',
      action: 'clearLogAiMessages',
      value: null,
    }),
  );
  dispatch(
    AI_BRIDGE_EVENTS.sessionUpdate,
    envelope(currentRevision() + 10, 'future-1', {
      kind: 'session-update',
      action: 'setLogAiModel',
      value: 'future-model',
    }),
  );
  await flush();
  expect(bridge.document?.clearLogAiMessages).toHaveBeenCalledOnce();
  expect(bridge.document?.setLogAiModel).not.toHaveBeenCalled();

  wrapper.unmount();
});

test('terminal activity uses the current revision and cancellation requires the same binding', async () => {
  bridge.runAiRequest.mockResolvedValue({
    kind: 'terminal',
    command: 'AT',
    explanation: 'Probe the modem',
    risk: 'safe',
  });
  const Host = defineComponent({
    setup: () => ({ aiBridge: useAiSessionBridge() }),
    template: '<div />',
  });
  const wrapper = mount(Host);
  await flush();
  const revision = (wrapper.vm as unknown as { aiBridge: { revision: number } }).aiBridge.revision;

  dispatch(
    AI_BRIDGE_EVENTS.activityRun,
    envelope(revision, 'terminal-1', {
      kind: 'activity-run',
      request: { requestId: 'terminal-1', kind: 'terminal', prompt: 'probe' },
    }),
  );
  await flush();
  expect(bridge.runAiRequest).toHaveBeenCalledOnce();

  dispatch(
    AI_BRIDGE_EVENTS.activityCancel,
    envelope(revision, 'unknown-operation', { kind: 'activity-cancel' }),
  );
  dispatch(
    AI_BRIDGE_EVENTS.activityCancel,
    envelope(revision, 'terminal-1', { kind: 'wrong-kind' }),
  );
  await flush();
  expect(bridge.cancelAiRequest).not.toHaveBeenCalled();

  wrapper.unmount();
});
