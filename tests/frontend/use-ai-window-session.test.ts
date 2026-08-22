// @vitest-environment happy-dom

import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { effectScope, defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useAiWindowSession } from '../../src/features/ai/application/use-ai-window-session.ts';
import type { SerialSession } from '../../src/types.ts';
import {
  AI_BRIDGE_EVENTS,
  AI_BRIDGE_WORKSPACE_ID,
  NO_AI_SESSION_ID,
  createAiBridgeEnvelope,
  parseAiBridgeEnvelope,
} from '../../src/features/ai-activity/index.ts';
import { AiActivityCenter } from '../../src/features/ai-activity/ai-activity-center.ts';
import { OperationRegistry } from '../../src/features/platform/application/operation-registry.ts';

interface RecordedEmit {
  event: string;
  payload: unknown;
}

function setup() {
  const emitted: RecordedEmit[] = [];
  const scope = effectScope();
  let api!: ReturnType<typeof useAiWindowSession>;
  scope.run(() => {
    api = useAiWindowSession({
      emit: async (event, payload) => {
        emitted.push({ event, payload });
      },
    });
  });
  return { api, emitted };
}

function summary(id = 'sess-1') {
  return {
    id,
    portName: 'COM1',
    baudRate: 115200,
    isConnected: true,
    txBytes: 1,
    rxBytes: 2,
    txFrames: 3,
    rxFrames: 4,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
  } as const;
}

function mainEnvelope(
  payload: Record<string, unknown>,
  overrides: Partial<{
    workspaceId: string;
    revision: number;
    requestId: string;
    sessionId: string;
  }> = {},
) {
  return createAiBridgeEnvelope({
    workspaceId: 'workspace-a',
    revision: 2,
    origin: 'main',
    requestId: 'request-a',
    sessionId: 'sess-1',
    payload,
    ...overrides,
  });
}

function strictSetup(ids: string[] = []) {
  const emitted: RecordedEmit[] = [];
  let sequence = 0;
  const api = useAiWindowSession({
    strictProtocol: true,
    requestId: () => ids[sequence++] ?? `request-${sequence}`,
    emit: async (event, payload) => {
      emitted.push({ event, payload });
    },
  });
  return { api, emitted };
}

/** A minimal SerialSession sufficient for the AI-window fields under test. */
function fakeSession(overrides: Partial<SerialSession> = {}): SerialSession {
  return {
    id: 'sess-1',
    portName: 'COM1',
    portConfig: {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      dtr: false,
      rts: false,
    },
    isConnected: false,
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
    parserState: { config: { kind: 'fixed', frameSize: 1 }, buffer: [] },
    modbusRegisters: [],
    modbusConfig: { enabled: false, transport: 'rtu', pollIntervalMs: 1000, timeoutMs: 500 },
    waveformSourceMode: 'text',
    autoLogEnabled: false,
    logPath: null,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
    logAiMessages: [],
    ...overrides,
  } as unknown as SerialSession;
}

test('useAiWindowSession: setTerminalAiModel mutates the session and emits an update', async () => {
  const { api, emitted } = setup();
  api.session.value = fakeSession();

  await api.setTerminalAiModel('glm-4.7');

  assert.equal(api.session.value!.terminalAiModel, 'glm-4.7', 'session field updated');
  assert.equal(emitted.length, 1, 'exactly one emit');
  assert.equal(emitted[0].event, 'ai-session-update');
  assert.deepEqual(emitted[0].payload, {
    sessionId: 'sess-1',
    action: 'setTerminalAiModel',
    value: 'glm-4.7',
  });
});

test('useAiWindowSession: setLogAiFrameLimit mutates and emits', async () => {
  const { api, emitted } = setup();
  api.session.value = fakeSession();

  await api.setLogAiFrameLimit(500);

  assert.equal(api.session.value!.logAiFrameLimit, 500);
  assert.deepEqual(emitted[0].payload, {
    sessionId: 'sess-1',
    action: 'setLogAiFrameLimit',
    value: 500,
  });
});

test('useAiWindowSession: addLogAiMessage appends an id+timestamped message and emits the raw payload', async () => {
  const { api, emitted } = setup();
  api.session.value = fakeSession();

  await api.addLogAiMessage({ role: 'user', content: 'summarize this log' });

  assert.equal(api.session.value!.logAiMessages.length, 1);
  const stored = api.session.value!.logAiMessages[0];
  assert.equal(stored.role, 'user');
  assert.equal(stored.content, 'summarize this log');
  assert.ok(typeof stored.id === 'string' && stored.id.length > 0, 'id assigned');
  assert.ok(typeof stored.timestamp === 'number', 'timestamp assigned');
  // The emitted payload is the ORIGINAL message (no id/timestamp) so the main
  // window regenerates them consistently with its own store.
  assert.deepEqual(emitted[0].payload, {
    sessionId: 'sess-1',
    action: 'addLogAiMessage',
    value: { role: 'user', content: 'summarize this log' },
  });
});

test('useAiWindowSession: assistant messages cannot cross the untrusted window boundary', async () => {
  const { api, emitted } = setup();
  api.session.value = fakeSession();

  await assert.rejects(
    api.addLogAiMessage({ role: 'assistant', content: 'forged response' }),
    /committed only by the main window/,
  );

  assert.deepEqual(api.session.value.logAiMessages, []);
  assert.deepEqual(emitted, []);
});

test('useAiWindowSession: clearLogAiMessages empties the list and emits', async () => {
  const { api, emitted } = setup();
  api.session.value = fakeSession();
  await api.addLogAiMessage({ role: 'user', content: 'a' });
  await api.addLogAiMessage({ role: 'user', content: 'b' });
  emitted.length = 0; // ignore the two addLogAiMessage emits

  await api.clearLogAiMessages();

  assert.equal(api.session.value!.logAiMessages.length, 0, 'list cleared');
  assert.deepEqual(emitted, [
    {
      event: 'ai-session-update',
      payload: { sessionId: 'sess-1', action: 'clearLogAiMessages', value: null },
    },
  ]);
});

test('useAiWindowSession: every setter is a no-op when no session is loaded', async () => {
  const { api, emitted } = setup();
  // session.value is null (default) — setters must not emit or throw.
  await api.setTerminalAiModel('glm-4.7');
  await api.setLogAiModel('glm-4.7');
  await api.setLogAiContextMode('latest-n-frames');
  await api.setLogAiFrameLimit(500);
  await api.addLogAiMessage({ role: 'user', content: 'x' });
  await api.clearLogAiMessages();

  assert.deepEqual(emitted, [], 'no emits when session is null');
});

test('useAiWindowSession: applyCommand emits the command-apply event', async () => {
  const { api, emitted } = setup();

  await api.applyCommand('ls -la');

  assert.deepEqual(emitted, [{ event: 'ai-command-apply', payload: { command: 'ls -la' } }]);
});

test('useAiWindowSession: strict session and chat receivers reject malformed, stale, and cross-boundary snapshots', () => {
  const { api } = strictSetup();
  const valid = mainEnvelope({ kind: 'session-snapshot', session: summary() });
  expect(api.receiveSessionSnapshot(null)).toBe(false);
  expect(api.receiveSessionSnapshot(mainEnvelope({ kind: 'chat-snapshot' }))).toBe(false);
  expect(
    api.receiveSessionSnapshot(mainEnvelope({ kind: 'session-snapshot', session: { id: 1 } })),
  ).toBe(false);
  expect(
    api.receiveSessionSnapshot(
      mainEnvelope({ kind: 'session-snapshot', session: summary() }, { sessionId: 'sess-2' }),
    ),
  ).toBe(false);
  expect(api.receiveSessionSnapshot(valid)).toBe(true);
  expect(api.workspaceId.value).toBe('workspace-a');
  expect(api.revision.value).toBe(2);
  expect(api.session.value).toMatchObject({ id: 'sess-1', logAiMessages: [] });
  expect(
    api.receiveSessionSnapshot(mainEnvelope({ kind: 'session-snapshot', session: null })),
  ).toBe(false);
  expect(
    api.receiveSessionSnapshot(
      mainEnvelope(
        { kind: 'session-snapshot', session: null },
        { sessionId: NO_AI_SESSION_ID, revision: 3 },
      ),
    ),
  ).toBe(true);
  expect(api.session.value).toBeNull();
  expect(api.receiveSessionSnapshot(valid)).toBe(false);

  expect(
    api.receiveSessionSnapshot(
      mainEnvelope({ kind: 'session-snapshot', session: summary() }, { revision: 4 }),
    ),
  ).toBe(true);
  const messages = [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }];
  const chat = mainEnvelope(
    { kind: 'chat-snapshot', snapshot: { sessionId: 'sess-1', messages } },
    { revision: 5 },
  );
  expect(api.receiveChatSnapshot(null)).toBe(false);
  expect(
    api.receiveChatSnapshot(
      mainEnvelope(
        { kind: 'chat-snapshot', snapshot: { sessionId: 'other', messages } },
        { revision: 5 },
      ),
    ),
  ).toBe(false);
  expect(api.receiveChatSnapshot({ ...chat, workspaceId: 'workspace-b' })).toBe(false);
  expect(api.receiveChatSnapshot(chat)).toBe(true);
  expect(api.session.value?.logAiMessages).toEqual(messages);
  const badMessages = [
    { id: 1, role: 'user', content: 'x', timestamp: 1 },
    { id: '1', role: 'system', content: 'x', timestamp: 1 },
    { id: '1', role: 'user', content: 2, timestamp: 1 },
    { id: '1', role: 'user', content: 'x', timestamp: 'now' },
  ];
  for (const message of badMessages) {
    expect(
      api.receiveChatSnapshot(
        mainEnvelope(
          { kind: 'chat-snapshot', snapshot: { sessionId: 'sess-1', messages: [message] } },
          { revision: 6 },
        ),
      ),
    ).toBe(false);
  }
});

test('useAiWindowSession: strict request bindings preserve workspace/session and resolve snapshots and contexts', async () => {
  const { api, emitted } = strictSetup(['unused', 'refresh', 'context', 'explicit']);
  expect(api.createRequestBinding()).toBeNull();
  const refresh = api.refreshSession(100);
  const refreshEnvelope = parseAiBridgeEnvelope(emitted[0].payload, 'ai-assistant');
  expect(refreshEnvelope).toMatchObject({
    workspaceId: AI_BRIDGE_WORKSPACE_ID,
    requestId: 'refresh',
    sessionId: NO_AI_SESSION_ID,
  });
  expect(
    api.receiveSessionSnapshot(
      mainEnvelope(
        { kind: 'session-snapshot', session: summary() },
        { requestId: 'refresh', revision: 3 },
      ),
    ),
  ).toBe(true);
  await expect(refresh).resolves.toMatchObject({ id: 'sess-1' });

  const binding = api.createRequestBinding('context');
  expect(binding).toEqual({
    workspaceId: 'workspace-a',
    sessionId: 'sess-1',
    revision: 3,
    requestId: 'context',
  });
  const contextTask = api.getLogContext(binding!, 100);
  const context = {
    sessionId: 'sess-1',
    text: 'RX OK',
    truncated: false,
    frameCount: 1,
    charLimit: 50_000,
  };
  expect(api.receiveLogContext(null)).toBe(false);
  expect(
    api.receiveLogContext(
      mainEnvelope(
        { kind: 'log-context', snapshot: context },
        { requestId: 'context', workspaceId: 'workspace-b', revision: 4 },
      ),
    ),
  ).toBe(false);
  expect(
    api.receiveLogContext(
      mainEnvelope(
        { kind: 'log-context', snapshot: context },
        { requestId: 'context', revision: 4 },
      ),
    ),
  ).toBe(true);
  await expect(contextTask).resolves.toEqual(context);
  expect(api.isBindingCurrent(binding!)).toBe(true);
  expect(api.isBindingCurrent({ ...binding!, workspaceId: 'workspace-b' })).toBe(false);
  expect(api.isBindingCurrent({ ...binding!, sessionId: 'sess-2' })).toBe(false);

  await api.applyCommand('status', binding!);
  await api.releaseRequestBinding(binding!);
  expect(emitted.slice(-2).map((entry) => entry.event)).toEqual([
    AI_BRIDGE_EVENTS.commandApply,
    AI_BRIDGE_EVENTS.activityCancel,
  ]);
});

test('useAiWindowSession: strict timeout, stale context, and null-session branches settle safely', async () => {
  vi.useFakeTimers();
  try {
    const { api } = strictSetup(['refresh-timeout', 'context-timeout', 'implicit']);
    const refresh = api.refreshSession(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(refresh).resolves.toBeNull();
    expect(await api.getLogContext()).toBeNull();

    expect(
      api.receiveSessionSnapshot(
        mainEnvelope(
          { kind: 'session-snapshot', session: summary() },
          { requestId: 'late', revision: 3 },
        ),
      ),
    ).toBe(true);
    const binding = api.createRequestBinding('context-timeout')!;
    const contextTask = api.getLogContext(binding, 25);
    expect(
      api.receiveLogContext(
        mainEnvelope(
          {
            kind: 'log-context',
            snapshot: {
              sessionId: 'wrong',
              text: '',
              truncated: false,
              frameCount: 0,
              charLimit: 1,
            },
          },
          { requestId: 'context-timeout', revision: 4 },
        ),
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await expect(contextTask).resolves.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('useAiWindowSession: strict activity result validates exact correlation and handles completed and failed outcomes', async () => {
  const { api, emitted } = strictSetup();
  api.workspaceId.value = 'workspace-a';
  api.revision.value = 7;
  api.session.value = fakeSession();
  const binding = api.createRequestBinding('run-ok')!;
  const task = api.runRequest({ requestId: 'run-ok', kind: 'terminal', prompt: 'status' }, binding);
  await flushPromises();
  expect(emitted[0].event).toBe(AI_BRIDGE_EVENTS.activityRun);
  expect(api.receiveActivityResult(null)).toBe(false);
  expect(
    api.receiveActivityResult(
      mainEnvelope(
        {
          kind: 'activity-result',
          outcome: 'completed',
          result: { kind: 'terminal', command: 'pwd', explanation: 'ok', risk: 'safe' },
        },
        { requestId: 'run-ok', revision: 8 },
      ),
    ),
  ).toBe(false);
  expect(
    api.receiveActivityResult(
      mainEnvelope(
        {
          kind: 'activity-result',
          outcome: 'completed',
          result: { kind: 'terminal', command: 'pwd', explanation: 'ok', risk: 'safe' },
        },
        { requestId: 'run-ok', revision: 7 },
      ),
    ),
  ).toBe(true);
  await expect(task).resolves.toMatchObject({ requestId: 'run-ok', result: { command: 'pwd' } });

  const failedBinding = api.createRequestBinding('run-failed')!;
  const failed = api.runRequest(
    { requestId: 'run-failed', kind: 'log', prompt: 'inspect' },
    failedBinding,
  );
  const error = {
    code: 'AI_PROVIDER_FAILED',
    messageKey: 'error.ai_request_failed',
    retryable: true,
    operation: 'run_ai_request',
  };
  expect(
    api.receiveActivityResult(
      mainEnvelope(
        { kind: 'activity-result', outcome: 'failed', error },
        { requestId: 'run-failed', revision: 7 },
      ),
    ),
  ).toBe(true);
  await expect(failed).rejects.toEqual(error);
  await expect(
    api.runRequest(
      { requestId: 'native-other', kind: 'terminal', prompt: 'x' },
      api.createRequestBinding('binding-other')!,
    ),
  ).rejects.toThrow('native requestId must equal');
});

test('useAiWindowSession: strict duplicate, emit-failure, cancel and operation-snapshot branches are bounded', async () => {
  const emitted: RecordedEmit[] = [];
  let rejectRunEmit = false;
  const api = useAiWindowSession({
    strictProtocol: true,
    emit: async (event, payload) => {
      emitted.push({ event, payload });
      if (rejectRunEmit && event === AI_BRIDGE_EVENTS.activityRun) throw new Error('bridge down');
    },
  });
  api.workspaceId.value = 'workspace-a';
  api.revision.value = 2;
  api.session.value = fakeSession();
  const binding = api.createRequestBinding('duplicate')!;
  const pending = api.runRequest(
    { requestId: 'duplicate', kind: 'terminal', prompt: 'x' },
    binding,
  );
  await expect(
    api.runRequest({ requestId: 'duplicate', kind: 'terminal', prompt: 'x' }, binding),
  ).rejects.toThrow('already pending');
  await api.cancelRequest('duplicate');
  expect(emitted.at(-1)?.event).toBe(AI_BRIDGE_EVENTS.activityCancel);
  expect(
    api.receiveActivityResult(
      mainEnvelope(
        {
          kind: 'activity-result',
          outcome: 'failed',
          error: {
            code: 'CANCELLED',
            messageKey: 'error.cancelled',
            retryable: false,
            operation: 'run_ai_request',
          },
        },
        { requestId: 'duplicate', revision: 2 },
      ),
    ),
  ).toBe(true);
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

  const operations = [
    {
      operationId: 'remote-op',
      kind: 'ai-request',
      status: 'running',
      workspaceId: 'workspace-a',
      sessionId: 'sess-1',
    },
    {
      operationId: 'not-ai',
      kind: 'export',
      status: 'running',
      workspaceId: 'workspace-a',
      sessionId: 'sess-1',
    },
  ];
  expect(api.receiveActivitySnapshot(null)).toBe(false);
  expect(
    api.receiveActivitySnapshot(
      mainEnvelope({ kind: 'activity-snapshot', operations }, { revision: 3 }),
    ),
  ).toBe(false);
  expect(
    api.receiveActivitySnapshot(
      mainEnvelope({ kind: 'activity-snapshot', operations: [operations[0]] }, { revision: 3 }),
    ),
  ).toBe(true);
  await api.cancelRequest('remote-op');
  await api.cancelRequest('missing');

  rejectRunEmit = true;
  const failingBinding = api.createRequestBinding('emit-fails')!;
  await expect(
    api.runRequest({ requestId: 'emit-fails', kind: 'terminal', prompt: 'x' }, failingBinding),
  ).rejects.toThrow('bridge down');
  expect(emitted.some((entry) => entry.event === AI_BRIDGE_EVENTS.activityCancel)).toBe(true);
});

test('useAiWindowSession: injected activity authority handles run, cancel, and snapshots locally', async () => {
  const registry = new OperationRegistry();
  let finish!: (value: {
    kind: 'terminal';
    command: string;
    explanation: string;
    risk: 'safe';
  }) => void;
  const native = new Promise<{
    kind: 'terminal';
    command: string;
    explanation: string;
    risk: 'safe';
  }>((resolve) => {
    finish = resolve;
  });
  const cancelled: string[] = [];
  const center = new AiActivityCenter({
    operations: registry,
    run: () => native,
    cancel: async (id) => {
      cancelled.push(id);
    },
  });
  const api = useAiWindowSession({ activityCenter: center, emit: async () => undefined });
  api.workspaceId.value = 'workspace-a';
  api.session.value = fakeSession();
  const binding = api.createRequestBinding('local-run')!;
  const task = api.runRequest({ requestId: 'local-run', kind: 'terminal', prompt: 'x' }, binding);
  await api.cancelRequest('local-run');
  finish({ kind: 'terminal', command: 'pwd', explanation: 'ok', risk: 'safe' });
  await expect(task).rejects.toThrow('AI request cancelled');
  expect(cancelled).toEqual(['local-run']);
});

test('useAiWindowSession: mounted lifecycle wires all listeners and disposes pending work', async () => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const unlisteners = Array.from({ length: 6 }, () => vi.fn());
  const emitted: RecordedEmit[] = [];
  let index = 0;
  let api!: ReturnType<typeof useAiWindowSession>;
  const Harness = defineComponent({
    setup() {
      api = useAiWindowSession({
        strictProtocol: true,
        requestId: () => `mount-${index}`,
        emit: async (event, payload) => {
          emitted.push({ event, payload });
        },
        listen: (async (event: string, handler: (event: { payload: unknown }) => void) => {
          listeners.set(event, handler);
          return unlisteners[index++];
        }) as never,
      });
      return () => h('div');
    },
  });
  const wrapper = mount(Harness);
  await flushPromises();
  expect(listeners.size).toBe(6);
  expect(emitted.map((entry) => entry.event)).toContain(AI_BRIDGE_EVENTS.activitySnapshotRequest);
  expect(emitted.map((entry) => entry.event)).toContain(AI_BRIDGE_EVENTS.sessionRequest);
  listeners.get(AI_BRIDGE_EVENTS.sessionSnapshot)?.({
    payload: mainEnvelope(
      { kind: 'session-snapshot', session: summary() },
      { requestId: 'mount-1', revision: 2 },
    ),
  });
  listeners.get(AI_BRIDGE_EVENTS.chatSnapshot)?.({
    payload: mainEnvelope({
      kind: 'chat-snapshot',
      snapshot: { sessionId: 'sess-1', messages: [] },
    }),
  });
  listeners.get(AI_BRIDGE_EVENTS.activitySnapshot)?.({
    payload: mainEnvelope({ kind: 'activity-snapshot', operations: [] }),
  });
  const binding = api.createRequestBinding('dispose-run')!;
  const context = api.getLogContext(binding, 10_000);
  const activity = api.runRequest(
    { requestId: 'dispose-run', kind: 'terminal', prompt: 'x' },
    binding,
  );
  wrapper.unmount();
  await expect(context).resolves.toBeNull();
  await expect(activity).rejects.toThrow('view was disposed');
  expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
});
