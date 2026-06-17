import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useAiWindowSession } from '../../src/composables/useAiWindowSession.ts';
import type { SerialSession } from '../../src/types.ts';

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

  await api.setTerminalAiModel('glm-4.6');

  assert.equal(api.session.value!.terminalAiModel, 'glm-4.6', 'session field updated');
  assert.equal(emitted.length, 1, 'exactly one emit');
  assert.equal(emitted[0].event, 'ai-session-update');
  assert.deepEqual(emitted[0].payload, {
    sessionId: 'sess-1',
    action: 'setTerminalAiModel',
    value: 'glm-4.6',
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

test('useAiWindowSession: clearLogAiMessages empties the list and emits', async () => {
  const { api, emitted } = setup();
  api.session.value = fakeSession();
  await api.addLogAiMessage({ role: 'user', content: 'a' });
  await api.addLogAiMessage({ role: 'user', content: 'b' });
  emitted.length = 0; // ignore the two addLogAiMessage emits

  await api.clearLogAiMessages();

  assert.equal(api.session.value!.logAiMessages.length, 0, 'list cleared');
  assert.deepEqual(emitted, [
    { event: 'ai-session-update', payload: { sessionId: 'sess-1', action: 'clearLogAiMessages', value: null } },
  ]);
});

test('useAiWindowSession: every setter is a no-op when no session is loaded', async () => {
  const { api, emitted } = setup();
  // session.value is null (default) — setters must not emit or throw.
  await api.setTerminalAiModel('glm-4.6');
  await api.setLogAiModel('glm-4.6');
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
