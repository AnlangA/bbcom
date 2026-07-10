import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  applyAiSessionUpdate,
  toAiChatSnapshot,
  toAiSessionSummary,
} from '../../src/composables/useAiSessionBridge.ts';
import type { SerialSession } from '../../src/types.ts';

/** Records every call so the dispatcher's routing can be asserted per-action. */
function recordingStore() {
  const calls: Array<{ method: string; id: string; value: unknown }> = [];
  return {
    calls,
    setTerminalAiModel(id: string, value: unknown) {
      calls.push({ method: 'setTerminalAiModel', id, value });
    },
    setLogAiModel(id: string, value: unknown) {
      calls.push({ method: 'setLogAiModel', id, value });
    },
    setLogAiContextMode(id: string, value: unknown) {
      calls.push({ method: 'setLogAiContextMode', id, value });
    },
    setLogAiFrameLimit(id: string, value: unknown) {
      calls.push({ method: 'setLogAiFrameLimit', id, value });
    },
    addLogAiMessage(id: string, value: unknown) {
      calls.push({ method: 'addLogAiMessage', id, value });
    },
    clearLogAiMessages(id: string) {
      calls.push({ method: 'clearLogAiMessages', id, value: undefined });
    },
  };
}

const SID = 'sess-1';

function summaryFixture(): SerialSession {
  return {
    id: SID,
    portName: 'COM1',
    portConfig: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    isConnected: true,
    frames: [{ id: 'secret-frame', direction: 'RX', timestamp: 0, data: new Uint8Array([1]) }],
    pausedFrames: [],
    capturePaused: false,
    txBytes: 1,
    rxBytes: 2,
    txFrames: 1,
    rxFrames: 2,
    startTime: null,
    sendHistory: [],
    sendDraft: '',
    quickCommands: [],
    macros: [],
    triggers: [],
    highlights: [],
    parserState: { config: { kind: 'fixed', frameSize: 1 }, presetId: null },
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
  } as SerialSession;
}

test('AI regular summary contains no frames or chat messages', () => {
  const summary = toAiSessionSummary(summaryFixture());
  const wire = JSON.stringify(summary);
  assert.equal('frames' in summary, false);
  assert.equal('logAiMessages' in summary, false);
  assert.equal(wire.includes('secret-frame'), false);
  assert.ok(new TextEncoder().encode(wire).byteLength < 10 * 1024);
});

test('AI chat snapshot is bounded to 100 messages and 1 MiB', () => {
  const session = summaryFixture();
  session.logAiMessages = Array.from({ length: 150 }, (_, index) => ({
    id: String(index),
    role: 'user' as const,
    content: 'x'.repeat(20_000),
    timestamp: index,
  }));
  const snapshot = toAiChatSnapshot(session);
  assert.ok(snapshot.messages.length <= 100);
  assert.ok(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= 1024 * 1024);
});

test('applyAiSessionUpdate: routes setTerminalAiModel to the model setter', () => {
  const store = recordingStore();
  applyAiSessionUpdate(
    { sessionId: SID, action: 'setTerminalAiModel', value: 'glm-4.7' },
    store,
    SID,
  );
  assert.deepEqual(store.calls, [{ method: 'setTerminalAiModel', id: SID, value: 'glm-4.7' }]);
});

test('applyAiSessionUpdate: routes a bounded integer frame limit', () => {
  const store = recordingStore();
  applyAiSessionUpdate({ sessionId: SID, action: 'setLogAiFrameLimit', value: 500 }, store, SID);
  assert.deepEqual(store.calls, [{ method: 'setLogAiFrameLimit', id: SID, value: 500 }]);
});

test('applyAiSessionUpdate: routes addLogAiMessage with the message payload', () => {
  const store = recordingStore();
  const msg = { role: 'user', content: 'summarize' };
  applyAiSessionUpdate({ sessionId: SID, action: 'addLogAiMessage', value: msg }, store, SID);
  assert.deepEqual(store.calls, [{ method: 'addLogAiMessage', id: SID, value: msg }]);
});

test('applyAiSessionUpdate: routes clearLogAiMessages', () => {
  const store = recordingStore();
  applyAiSessionUpdate({ sessionId: SID, action: 'clearLogAiMessages', value: null }, store, SID);
  assert.deepEqual(store.calls, [{ method: 'clearLogAiMessages', id: SID, value: undefined }]);
});

test('applyAiSessionUpdate: routes every supported action exactly once per event', () => {
  const store = recordingStore();
  const actions: Array<{ action: string; value: unknown }> = [
    { action: 'setLogAiModel', value: 'glm-4.5-air' },
    { action: 'setLogAiContextMode', value: 'latest-n-frames' },
  ];
  for (const a of actions) {
    applyAiSessionUpdate({ sessionId: SID, ...a }, store, SID);
  }
  assert.equal(store.calls.length, 2, 'each action dispatched once');
  assert.equal(store.calls[0].method, 'setLogAiModel');
  assert.equal(store.calls[1].method, 'setLogAiContextMode');
});

test('applyAiSessionUpdate: unknown actions are a no-op (no throw, no store mutation)', () => {
  const store = recordingStore();
  applyAiSessionUpdate({ sessionId: SID, action: 'totallyUnknown', value: 42 }, store, SID);
  assert.deepEqual(store.calls, [], 'unknown action ignored');
});

test('applyAiSessionUpdate: rejects a stale-session, malformed, or oversized event', () => {
  const store = recordingStore();
  assert.equal(
    applyAiSessionUpdate(
      { sessionId: 'other', action: 'setTerminalAiModel', value: 'glm-4.7' },
      store,
      SID,
    ),
    false,
  );
  assert.equal(
    applyAiSessionUpdate(
      { sessionId: SID, action: 'setLogAiFrameLimit', value: '500' },
      store,
      SID,
    ),
    false,
  );
  assert.equal(
    applyAiSessionUpdate(
      {
        sessionId: SID,
        action: 'addLogAiMessage',
        value: { role: 'user', content: 'x'.repeat(256 * 1024 + 1) },
      },
      store,
      SID,
    ),
    false,
  );
  assert.deepEqual(store.calls, []);
});
