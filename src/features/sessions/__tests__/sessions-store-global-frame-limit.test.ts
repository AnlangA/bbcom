import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;

afterEach(() => {
  vi.doUnmock('@/lib/session-store-helpers.ts');
  vi.resetModules();
  (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
});

test('store enforces the aggregate capture-byte budget and republishes an evicted resident session', async () => {
  vi.resetModules();
  vi.doMock('@/lib/session-store-helpers.ts', async () => {
    const actual = await vi.importActual<typeof import('@/lib/session-store-helpers.ts')>(
      '@/lib/session-store-helpers.ts',
    );
    return { ...actual, MAX_GLOBAL_FRAME_BYTES: 3 };
  });
  (globalThis as { localStorage?: Storage }).localStorage = undefined;

  const [{ useSessionStore }] = await Promise.all([
    import('@/features/sessions/store/session-store.ts'),
  ]);
  setActivePinia(createPinia());
  const sessions = useSessionStore();
  const config = {
    baudRate: 115200,
    dataBits: 8 as const,
    stopBits: 1 as const,
    parity: 'none' as const,
    flowControl: 'none' as const,
    dtr: false,
    rts: false,
  };
  const first = sessions.createSession('COM-budget-1', config);
  const second = sessions.createSession('COM-budget-2', config);

  sessions.addFrame(first, { direction: 'RX', data: new Uint8Array([1, 2]) });
  const firstVersion = sessions.getSessionFramesVersion(first);
  sessions.addFrame(second, { direction: 'RX', data: new Uint8Array([3, 4]) });

  const firstSession = sessions.sessions.find((session) => session.id === first);
  const secondSession = sessions.sessions.find((session) => session.id === second);
  assert.deepEqual(firstSession?.frames, []);
  assert.equal(firstSession?.droppedBytes, 2);
  assert.deepEqual(Array.from(secondSession?.frames[0]?.data ?? []), [3, 4]);
  assert.equal(sessions.getSessionFramesVersion(first), firstVersion + 1);
});
