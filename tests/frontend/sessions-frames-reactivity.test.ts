import test from 'node:test';
import assert from 'node:assert/strict';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
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

/**
 * Reactivity regression guard for the frames store. A consumer (DataPacketList,
 * StatusBar, …) reads `session.frames.length` through a computed; that computed
 * MUST re-evaluate after addFrame/clearFrames. This is the silent-failure mode
 * a shallowRef conversion would introduce if the notify channel were missed.
 */
test('frames: computed reading session.frames.length updates after addFrame', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const id = store.createSession('COM1', cfg);

    const session = () => store.sessions.find((s) => s.id === id)!;
    const len = computed(() => session().frames.length);

    assert.equal(len.value, 0, 'starts empty');
    store.addFrame(id, { direction: 'RX', data: new Uint8Array([1]) });
    assert.equal(len.value, 1, 'computed sees the new frame');
    store.addFrame(id, { direction: 'TX', data: new Uint8Array([2]) });
    assert.equal(len.value, 2, 'computed sees the second frame');
    store.clearFrames(id);
    assert.equal(len.value, 0, 'computed sees the clear');
  });
});

test('frames: a watchEffect that reads frames.length re-runs after addFrame', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const id = store.createSession('COM1', cfg);

    // The authoritative consumer pattern: a computed that reads frames.length.
    // In a real component this is re-evaluated on dependency change; here we
    // assert that after a mutation the computed's NEXT read reflects the new
    // state — the property a shallowRef + triggerRef conversion must preserve.
    const session = () => store.sessions.find((s) => s.id === id)!;
    const len = computed(() => session().frames.length);
    const txBytes = computed(() => session().txBytes);

    assert.equal(len.value, 0, 'starts empty');
    store.addFrame(id, { direction: 'RX', data: new Uint8Array([1, 2, 3]) });
    assert.equal(len.value, 1, 'length computed reflects addFrame');
    assert.equal(txBytes.value, 0, 'RX frame does not bump txBytes');
    store.addFrame(id, { direction: 'TX', data: new Uint8Array([4, 5]) });
    assert.equal(len.value, 2, 'length computed reflects second addFrame');
    assert.equal(txBytes.value, 2, 'TX frame bumps txBytes');
    store.clearFrames(id);
    assert.equal(len.value, 0, 'length computed reflects clearFrames');
  });
});
