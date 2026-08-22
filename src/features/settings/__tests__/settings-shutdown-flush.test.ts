import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useAppStore } from '@/features/settings/store/app-store.ts';
import { useSerialStore } from '@/features/serial/store/serial-store.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

test('flushSettings writes synchronously, cancels debounce, and rejects invalid persisted enums', async () => {
  vi.useFakeTimers();
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  data.set(
    'bbcom-v1:app-settings',
    JSON.stringify({
      displayMode: 'NOT_A_MODE',
      searchMode: '../HEX',
      packetViewMode: 'ALL',
      lineEnding: 'NUL',
    }),
  );
  data.set(
    'bbcom-v1:serial-settings',
    JSON.stringify({
      selectedPort: 42,
      portConfig: {
        baudRate: -1,
        dataBits: 9,
        stopBits: 3,
        parity: 'mark',
        flowControl: 'custom',
        rxFrameGapMs: 2,
        dtr: 'yes',
        rts: true,
      },
    }),
  );

  try {
    setActivePinia(createPinia());
    const app = useAppStore();
    const serial = useSerialStore();
    assert.equal(app.displayMode, 'HEX');
    assert.equal(app.searchMode, 'TEXT');
    assert.equal(app.packetViewMode, 'FRAME');
    assert.equal(app.lineEnding, 'none');
    assert.equal(serial.selectedPort, '');
    assert.deepEqual(serial.portConfig, {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      rxFrameGapMs: 2,
      dtr: false,
      rts: true,
    });

    app.setDisplayMode('UTF8');
    serial.setSelectedPort('COM8');
    await Promise.resolve();
    assert.equal(app.flushSettings(), true);
    assert.equal(serial.flushSettings(), true);
    const persisted = JSON.parse(data.get('bbcom-v2:global-settings') as string);
    assert.equal(persisted.displayMode, 'UTF8');
    assert.equal(persisted.selectedPort, 'COM8');
    assert.equal(
      data.get('bbcom-v1:app-settings'),
      JSON.stringify({
        displayMode: 'NOT_A_MODE',
        searchMode: '../HEX',
        packetViewMode: 'ALL',
        lineEnding: 'NUL',
      }),
      'the legacy v1 app key is never rewritten by a flush',
    );
    assert.ok(data.has('bbcom-v1:serial-settings'), 'the legacy v1 serial key survives');

    const writesAfterFlush = new Map(data);
    await vi.advanceTimersByTimeAsync(301);
    assert.deepEqual(data, writesAfterFlush, 'cancelled debounce performs no later write');
  } finally {
    vi.useRealTimers();
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
});
