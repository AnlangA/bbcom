import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';
import type { PortConfig } from '@/types/index.ts';

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

function withLocalStorageMock<T>(
  fn: (data: Map<string, string>) => Promise<T> | T,
): Promise<T> | T {
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
    const result = fn(data);
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
    const len = computed(() => {
      void store.getSessionFramesVersion(id);
      return session().frames.length;
    });

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
    const len = computed(() => {
      void store.getSessionFramesVersion(id);
      return session().frames.length;
    });
    const txBytes = computed(() => {
      void store.getSessionFramesVersion(id);
      return session().txBytes;
    });

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

test('per-session frame version ignores persisted config, draft, macro, and AI mutations', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const id = store.createSession('COM1', cfg);
    const macroName = computed(() => store.sessions[0]?.macros[0]?.name ?? '');
    let frameEvaluations = 0;
    const frameCount = computed(() => {
      frameEvaluations += 1;
      void store.getSessionFramesVersion(id);
      return store.sessions[0]?.frames.length ?? 0;
    });

    assert.equal(
      store.getSessionFramesVersion(id),
      0,
      'creating a session is not a frame mutation',
    );
    assert.equal(frameCount.value, 0);

    store.setSendDraft(id, 'AT+GMR');
    store.setModbusConfig(id, { enabled: true, pollIntervalMs: 500 });
    const macroId = store.addMacro(id, {
      name: 'Boot',
      steps: [{ data: 'AT', isHex: false, delayMs: 50 }],
    });
    assert.ok(macroId);
    assert.equal(
      macroName.value,
      'Boot',
      'macro collection remains reactive without a frame pulse',
    );
    store.updateMacro(id, macroId, { name: 'Startup' });
    assert.equal(macroName.value, 'Startup', 'macro edits replace the raw collection reference');
    store.addLogAiMessage(id, { role: 'user', content: 'Summarize this capture' });

    assert.equal(store.getSessionFramesVersion(id), 0);
    assert.equal(frameCount.value, 0);
    assert.equal(frameEvaluations, 1, 'persisted mutations do not invalidate frame consumers');

    // Non-frame mutations never invalidate frame consumers; durability is
    // workspace-owned now, so there is no localStorage snapshot to inspect.
  });
});

test('per-session frame version advances only for live or paused frame-buffer mutations', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const id = store.createSession('COM1', cfg);

    assert.equal(store.getSessionFramesVersion(id), 0);
    store.updateDroppedBytes(id, 3);
    assert.equal(
      store.getSessionFramesVersion(id),
      0,
      'runtime metrics do not masquerade as frame changes',
    );

    store.addFrame(id, { direction: 'RX', data: new Uint8Array([1]) });
    assert.equal(store.getSessionFramesVersion(id), 1, 'adding a live frame emits one pulse');

    store.setCapturePaused(id, true);
    assert.equal(
      store.getSessionFramesVersion(id),
      1,
      'toggling pause alone does not mutate a frame buffer',
    );

    store.addFrame(id, { direction: 'TX', data: new Uint8Array([2]) });
    assert.equal(store.getSessionFramesVersion(id), 2, 'adding a paused frame emits one pulse');

    store.setCapturePaused(id, false);
    assert.equal(
      store.getSessionFramesVersion(id),
      3,
      'flushing paused frames into the live buffer emits one pulse',
    );

    store.clearFrames(id);
    assert.equal(
      store.getSessionFramesVersion(id),
      4,
      'clearing non-empty buffers emits one pulse',
    );
    store.clearFrames(id);
    assert.equal(
      store.getSessionFramesVersion(id),
      4,
      'clearing already-empty buffers is not a frame mutation',
    );
  });
});

test('per-session frame versions isolate resident views from other sessions', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const firstId = store.createSession('COM1', cfg);
    const secondId = store.createSession('COM2', cfg);
    let firstVersionEvaluations = 0;
    const firstVersion = computed(() => {
      firstVersionEvaluations += 1;
      return store.getSessionFramesVersion(firstId);
    });

    assert.equal(firstVersion.value, 0);
    assert.equal(store.getSessionFramesVersion(secondId), 0);

    store.addFrame(secondId, { direction: 'RX', data: new Uint8Array([2]) });
    assert.equal(firstVersion.value, 0);
    assert.equal(
      firstVersionEvaluations,
      1,
      'another session frame does not invalidate this session version',
    );
    assert.equal(store.getSessionFramesVersion(secondId), 1);

    store.addFrame(firstId, { direction: 'RX', data: new Uint8Array([1]) });
    assert.equal(firstVersion.value, 1);
    assert.equal(firstVersionEvaluations, 2);
    assert.equal(store.getSessionFramesVersion(secondId), 1);

    store.clearFrames(firstId);
    assert.equal(firstVersion.value, 2);
    assert.equal(store.getSessionFramesVersion(secondId), 1);
  });
});
