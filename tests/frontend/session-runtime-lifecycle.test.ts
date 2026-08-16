import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionCoreStore } from '../../src/stores/session-core.ts';
import type { PortConfig } from '../../src/types/index.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

async function withLocalStorageMock(run: () => Promise<void>): Promise<void> {
  const target = globalThis as { localStorage?: LocalStorageLike };
  const previous = target.localStorage;
  const data = new Map<string, string>();
  target.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  try {
    await run();
  } finally {
    target.localStorage = previous;
  }
}

test('tab switches retain runtimes while closing awaits exactly that session cleanup', async () => {
  await withLocalStorageMock(async () => {
    setActivePinia(createPinia());
    const store = useSessionCoreStore();
    const persistence = useSessionCoreStore();
    const firstId = store.createSession('COM1', config);
    const secondId = store.createSession('COM2', config);
    let firstCleanupCount = 0;
    let secondCleanupCount = 0;

    persistence.registerCleanup(firstId, async () => {
      firstCleanupCount += 1;
    });
    persistence.registerCleanup(secondId, async () => {
      secondCleanupCount += 1;
    });

    store.setActiveSession(firstId);
    store.setActiveSession(secondId);
    store.setActiveSession(firstId);
    assert.equal(firstCleanupCount, 0, 'switching never disconnects the previous runtime');
    assert.equal(secondCleanupCount, 0, 'switching never disconnects the next runtime');

    await store.removeSession(firstId);
    assert.equal(firstCleanupCount, 1, 'closing awaits the removed session runtime cleanup');
    assert.equal(secondCleanupCount, 0, 'closing one session leaves other runtimes untouched');
    assert.equal(
      store.sessions.some((session) => session.id === firstId),
      false,
    );

    await store.removeSession(secondId);
    assert.equal(secondCleanupCount, 1);
  });
});
