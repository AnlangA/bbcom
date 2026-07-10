import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { useSessionFrames } from '../../src/composables/useSessionFrames.ts';
import type { DataFrame, PortConfig } from '../../src/types/index.ts';

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

function setup(): { sessionId: string; store: ReturnType<typeof useSessionStore> } {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM1', cfg);
  return { sessionId, store };
}

test('useSessionFrames: addFrame appends a fully-formed frame to the session', () => {
  withLocalStorageMock(() => {
    const { sessionId, store } = setup();
    const { addFrame } = useSessionFrames(sessionId);

    const frame = addFrame({ direction: 'RX', data: new Uint8Array([1, 2, 3]) });

    assert.ok(frame, 'addFrame returns the created frame');
    assert.ok(frame!.id, 'frame has an id');
    assert.equal(typeof frame!.timestamp, 'number', 'frame has a timestamp');
    assert.equal(frame!.direction, 'RX');
    assert.equal(store.sessions[0].frames.length, 1, 'frame lands in the session');
    assert.equal(store.sessions[0].frames[0].direction, 'RX');
  });
});

test('useSessionFrames: addFrame is a no-op for an unknown session', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const { addFrame } = useSessionFrames('does-not-exist');

    const frame = addFrame({ direction: 'TX', data: new Uint8Array([0]) });

    assert.equal(frame, undefined, 'unknown session yields undefined');
  });
});

test('useSessionFrames: clearFrames empties the session buffers', () => {
  withLocalStorageMock(() => {
    const { sessionId, store } = setup();
    const { addFrame, clearFrames } = useSessionFrames(sessionId);

    addFrame({ direction: 'RX', data: new Uint8Array([1]) });
    addFrame({ direction: 'RX', data: new Uint8Array([2]) });
    addFrame({ direction: 'TX', data: new Uint8Array([3]) });
    assert.equal(store.sessions[0].frames.length, 3, 'frames accumulated');

    clearFrames();

    assert.equal(store.sessions[0].frames.length, 0, 'frames cleared');
  });
});

test('useSessionFrames: addFrame frames are markRaw (not deeply reactive)', () => {
  withLocalStorageMock(() => {
    const { sessionId, store } = setup();
    const { addFrame } = useSessionFrames(sessionId);

    addFrame({ direction: 'RX', data: new Uint8Array([1, 2]) });
    const stored: DataFrame = store.sessions[0].frames[0];

    // A markRaw object carries Vue's __v_skip flag and is not a reactive Proxy.
    assert.equal(toVueRawMark(stored), true, 'stored frame is marked raw');
    assert.equal(
      Object.getPrototypeOf(stored) === Object.prototype || Object.getPrototypeOf(stored) === null,
      true,
      'stored frame is a plain object, not a Proxy',
    );
  });
});

function toVueRawMark(obj: unknown): boolean {
  return Boolean((obj as { __v_skip?: boolean }).__v_skip);
}
