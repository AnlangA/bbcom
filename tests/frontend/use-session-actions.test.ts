import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionCoreStore } from '../../src/stores/session-core.ts';
import { useSerialStore } from '../../src/stores/serial.ts';
import { useAppStore } from '../../src/stores/app.ts';
import { useSessionActions } from '../../src/composables/useSessionActions.ts';
import type { PortConfig } from '../../src/types/index.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function withLocalStorageMock<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  const restore = () => {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          restore();
          return v;
        },
        (e) => {
          restore();
          throw e;
        },
      );
    }
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

function setup() {
  setActivePinia(createPinia());
  const sessions = useSessionCoreStore();
  const serial = useSerialStore();
  const app = useAppStore();
  const actions = useSessionActions();
  return { sessions, serial, app, actions };
}

test('useSessionActions: createSession returns null for an empty port name', () => {
  withLocalStorageMock(() => {
    const { sessions, actions } = setup();
    const id = actions.createSession('', cfg);

    assert.equal(id, null, 'empty port rejected');
    assert.equal(sessions.sessions.length, 0, 'no session created');
  });
});

test('useSessionActions: createSession registers the session and persists the port config', () => {
  withLocalStorageMock(() => {
    const { sessions, serial, actions } = setup();
    const id = actions.createSession('COM3', cfg);

    assert.ok(id, 'a session id is returned');
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].portName, 'COM3');
    assert.deepEqual(
      { ...serial.portConfig },
      { ...cfg },
      'port config copied into the serial store',
    );
  });
});

test('useSessionActions: createSession routes a pending AI command into the new session draft', () => {
  withLocalStorageMock(() => {
    const { sessions, app, actions } = setup();
    app.setPendingAiCommand('ls -la');

    const id = actions.createSession('COM5', cfg);

    assert.ok(id);
    assert.equal(sessions.sessions[0].sendDraft, 'ls -la', 'pending AI command became the draft');
    assert.equal(app.pendingAiCommand, '', 'pending command consumed');
  });
});

test('useSessionActions: createSession without a pending AI command leaves the draft empty', () => {
  withLocalStorageMock(() => {
    const { sessions, actions } = setup();
    const id = actions.createSession('COM7', cfg);

    assert.ok(id);
    assert.equal(sessions.sessions[0].sendDraft, '', 'no pending command -> empty draft');
  });
});
