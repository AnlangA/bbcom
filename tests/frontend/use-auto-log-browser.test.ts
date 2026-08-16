// @vitest-environment happy-dom
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  AUTO_LOG_FAILURE_EVENT,
  AUTO_LOG_MAX_BATCH_BYTES,
  useAutoLog,
} from '../../src/composables/useAutoLog.ts';
import { useSessionCoreStore } from '../../src/stores/session-core.ts';
import type { DataFrame, PortConfig } from '../../src/types.ts';
import { createInvokeHandler, unexpectedCommand } from './helpers/invoke-mock.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function setup() {
  setActivePinia(createPinia());
  const sessions = useSessionCoreStore();
  const sessionId = sessions.createSession('COM7', config);
  return { sessions, sessionId };
}

function frame(bytes = 1): DataFrame {
  return { id: 'f1', direction: 'RX', timestamp: 1, data: new Uint8Array(bytes) };
}

afterEach(() => {
  invoke.mockReset();
  localStorage.clear();
});

test('useAutoLog reports begin and overflow failures to the visible main window exactly once', async () => {
  const begin = setup();
  const failures: Array<{ sessionId: string; reason: string }> = [];
  const listener = (event: Event) => {
    failures.push((event as CustomEvent<{ sessionId: string; reason: string }>).detail);
  };
  window.addEventListener(AUTO_LOG_FAILURE_EVENT, listener);
  try {
    const failing = useAutoLog({
      requestTarget: async () => Promise.reject(new Error('dialog denied')),
    });
    assert.equal(await failing.enable(begin.sessionId), null);

    const overflowing = useAutoLog({
      requestTarget: async () => ({ token: 'grant', displayName: 'capture.txt' }),
      sessionClient: {
        begin: async () => ({ logId: 'log' }),
        append: async () => ({ frames: 0, rawBytes: 0 }),
        finish: async () => {},
        abort: async () => {},
      },
    });
    assert.equal(await overflowing.enable(begin.sessionId), 'capture.txt');
    overflowing.appendFrame(begin.sessionId, frame(AUTO_LOG_MAX_BATCH_BYTES + 1));
    overflowing.appendFrame(begin.sessionId, frame(AUTO_LOG_MAX_BATCH_BYTES + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(failures, [
      { sessionId: begin.sessionId, reason: 'begin-failure' },
      { sessionId: begin.sessionId, reason: 'overflow' },
    ]);
  } finally {
    window.removeEventListener(AUTO_LOG_FAILURE_EVENT, listener);
  }
});

test('useAutoLog defaults use only grant-token and bounded auto-log IPC commands', async () => {
  invoke.mockImplementation(
    createInvokeHandler({
      responses: {
        request_save_target: { token: 'opaque-grant', displayName: 'capture.txt' },
        begin_auto_log: { logId: 'log-id' },
        append_auto_log_batch: { frames: 1, rawBytes: 1 },
        finish_auto_log: undefined,
      },
      fallback: unexpectedCommand,
    }),
  );
  const { sessionId } = setup();
  const auto = useAutoLog({ debounceMs: 1 });

  assert.equal(await auto.enable(sessionId), 'capture.txt');
  auto.appendFrame(sessionId, frame());
  await auto.disable(sessionId);

  assert.equal(invoke.mock.calls[0]?.[0], 'request_save_target');
  assert.deepEqual(invoke.mock.calls.slice(1), [
    ['begin_auto_log', { request: { token: 'opaque-grant', format: 'hex' } }],
    [
      'append_auto_log_batch',
      {
        request: {
          logId: 'log-id',
          frames: [{ id: 'f1', direction: 'RX', timestamp: 1, data: [], dataB64: 'AA==' }],
        },
      },
    ],
    ['finish_auto_log', { request: { logId: 'log-id' } }],
  ]);
});
