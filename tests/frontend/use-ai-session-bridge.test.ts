import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAiSessionUpdate } from '../../src/composables/useAiSessionBridge.ts';

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

test('applyAiSessionUpdate: routes setTerminalAiModel to the model setter', () => {
  const store = recordingStore();
  applyAiSessionUpdate({ sessionId: SID, action: 'setTerminalAiModel', value: 'glm-4.6' }, store);
  assert.deepEqual(store.calls, [{ method: 'setTerminalAiModel', id: SID, value: 'glm-4.6' }]);
});

test('applyAiSessionUpdate: routes setLogAiFrameLimit and coerces value to a number', () => {
  const store = recordingStore();
  // The bridge receives numbers over IPC as plain JSON; ensure Number() coercion holds.
  applyAiSessionUpdate({ sessionId: SID, action: 'setLogAiFrameLimit', value: '500' }, store);
  assert.deepEqual(store.calls, [{ method: 'setLogAiFrameLimit', id: SID, value: 500 }]);
});

test('applyAiSessionUpdate: routes addLogAiMessage with the message payload', () => {
  const store = recordingStore();
  const msg = { role: 'user', content: 'summarize' };
  applyAiSessionUpdate({ sessionId: SID, action: 'addLogAiMessage', value: msg }, store);
  assert.deepEqual(store.calls, [{ method: 'addLogAiMessage', id: SID, value: msg }]);
});

test('applyAiSessionUpdate: routes clearLogAiMessages', () => {
  const store = recordingStore();
  applyAiSessionUpdate({ sessionId: SID, action: 'clearLogAiMessages', value: null }, store);
  assert.deepEqual(store.calls, [{ method: 'clearLogAiMessages', id: SID, value: undefined }]);
});

test('applyAiSessionUpdate: routes every supported action exactly once per event', () => {
  const store = recordingStore();
  const actions: Array<{ action: string; value: unknown }> = [
    { action: 'setLogAiModel', value: 'glm-4.5-air' },
    { action: 'setLogAiContextMode', value: 'latest-n-frames' },
  ];
  for (const a of actions) {
    applyAiSessionUpdate({ sessionId: SID, ...a }, store);
  }
  assert.equal(store.calls.length, 2, 'each action dispatched once');
  assert.equal(store.calls[0].method, 'setLogAiModel');
  assert.equal(store.calls[1].method, 'setLogAiContextMode');
});

test('applyAiSessionUpdate: unknown actions are a no-op (no throw, no store mutation)', () => {
  const store = recordingStore();
  applyAiSessionUpdate({ sessionId: SID, action: 'totallyUnknown', value: 42 }, store);
  assert.deepEqual(store.calls, [], 'unknown action ignored');
});
