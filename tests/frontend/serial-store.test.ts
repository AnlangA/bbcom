import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSerialStore } from '../../src/features/serial/store/serial-store.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Install a Map-backed localStorage mock; return the underlying map. */
function installLocalStorageMock(): Map<string, string> {
  const data = new Map<string, string>();
  const mock: LocalStorageLike = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  (globalThis as { localStorage: LocalStorageLike }).localStorage = mock;
  return data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('serial port config persists in-place field mutations (deep watch)', async () => {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = installLocalStorageMock();
  const pinia = createPinia();
  setActivePinia(pinia);

  try {
    const serial = useSerialStore();

    // Mutate fields in place — this mirrors PortSelector's v-model:value="config.baudRate".
    serial.portConfig.baudRate = 9600;
    serial.portConfig.parity = 'even';
    serial.portConfig.dataBits = 7;
    serial.portConfig.rxFrameGapMs = 2;

    // The settings service debounces writes by 300ms into the single v2 key.
    await delay(360);

    const raw = data.get('bbcom-v2:global-settings');
    assert.ok(raw, 'serial settings should be persisted after in-place mutations');
    const saved = JSON.parse(raw as string);
    assert.equal(saved.portConfig.baudRate, 9600);
    assert.equal(saved.portConfig.parity, 'even');
    assert.equal(saved.portConfig.dataBits, 7);
    assert.equal(saved.portConfig.rxFrameGapMs, 2);
  } finally {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
});

test('serial store round-trips persisted config on load', async () => {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = installLocalStorageMock();
  data.set(
    'bbcom-v2:global-settings',
    JSON.stringify({
      version: 2,
      selectedPort: 'COM7',
      portConfig: { baudRate: 57600 },
    }),
  );

  setActivePinia(createPinia());
  try {
    const serial = useSerialStore();
    assert.equal(serial.selectedPort, 'COM7');
    assert.equal(serial.portConfig.baudRate, 57600);
    assert.equal(
      serial.portConfig.rxFrameGapMs,
      5,
      'legacy settings receive the default frame gap',
    );
    // Let the debounced save scheduled during load() flush while the mock is
    // still installed, so no timer fires after we tear down localStorage.
    await delay(360);
  } finally {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
});

test('a missing v2 document migrates the v1 serial blob read-only', async () => {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = installLocalStorageMock();
  const legacyBlob = JSON.stringify({ selectedPort: 'COM9', portConfig: { baudRate: 19200 } });
  data.set('bbcom-v1:serial-settings', legacyBlob);

  setActivePinia(createPinia());
  try {
    const serial = useSerialStore();
    assert.equal(serial.selectedPort, 'COM9');
    assert.equal(serial.portConfig.baudRate, 19200);
    await delay(360);
    assert.equal(
      data.get('bbcom-v1:serial-settings'),
      legacyBlob,
      'the legacy v1 key is never rewritten',
    );
    assert.ok(
      !data.has('bbcom-v2:global-settings'),
      'a pure migration without changes performs no write',
    );

    serial.setSelectedPort('COM10');
    await delay(360);
    const persisted = JSON.parse(data.get('bbcom-v2:global-settings') as string);
    assert.equal(persisted.selectedPort, 'COM10');
    assert.equal(persisted.portConfig.baudRate, 19200, 'migrated values persist into v2');
    assert.equal(
      data.get('bbcom-v1:serial-settings'),
      legacyBlob,
      'the legacy v1 key stays untouched after the first v2 write',
    );
  } finally {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
});
