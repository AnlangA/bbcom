import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  addDeviceProfile as addPreset,
  describeDeviceProfileConfig as describeConfig,
  deviceProfileConfigsEqual as configsEqual,
  loadDeviceProfiles as loadPresets,
  removeDeviceProfile as removePreset,
} from '@/features/device-profiles/index.ts';
import type { PortConfig } from '@/types.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function withLocalStorageMock<T>(fn: () => T): T {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  try {
    return fn();
  } finally {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
}

const CFG_9600: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

const CFG_ESP32: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: true,
  rts: true,
};

test('configsEqual is true only when every field matches', () => {
  assert.ok(configsEqual(CFG_9600, { ...CFG_9600 }));
  assert.ok(!configsEqual(CFG_9600, { ...CFG_9600, baudRate: 19200 }));
  assert.ok(!configsEqual(CFG_9600, { ...CFG_9600, dtr: true }));
  assert.ok(!configsEqual(CFG_9600, { ...CFG_9600, parity: 'even' }));
});

test('describeConfig renders a compact human-readable label', () => {
  assert.equal(describeConfig(CFG_9600), '9600 8N1, none');
  assert.equal(describeConfig(CFG_ESP32), '115200 8N1, none, DTR+RTS');
  assert.equal(describeConfig({ ...CFG_9600, parity: 'even', stopBits: 2 }), '9600 8E2, none');
});

test('addPreset persists and returns an extended list with a unique id', () => {
  withLocalStorageMock(() => {
    const a = addPreset([], 'Arduino', CFG_9600);
    assert.equal(a.length, 1);
    assert.equal(a[0].name, 'Arduino');
    assert.ok(a[0].id.length > 0);
    // Adding a second preset keeps both with distinct ids.
    const b = addPreset(a, 'ESP32', CFG_ESP32);
    assert.equal(b.length, 2);
    assert.notEqual(b[0].id, b[1].id);
    // loadPresets reads back the persisted blob.
    const loaded = loadPresets();
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded.map((p) => p.name).sort(), ['Arduino', 'ESP32']);
  });
});

test('addPreset falls back to describeConfig when the name is blank', () => {
  withLocalStorageMock(() => {
    const a = addPreset([], '   ', CFG_9600);
    assert.equal(a[0].name, '9600 8N1, none');
  });
});

test('removePreset drops by id and persists', () => {
  withLocalStorageMock(() => {
    const a = addPreset([], 'Arduino', CFG_9600);
    const b = addPreset(a, 'ESP32', CFG_ESP32);
    const c = removePreset(b, a[0].id);
    assert.equal(c.length, 1);
    assert.equal(c[0].name, 'ESP32');
    assert.equal(loadPresets().length, 1);
  });
});

test('loadPresets tolerates a malformed blob and returns []', () => {
  withLocalStorageMock(() => {
    (globalThis as { localStorage: LocalStorageLike }).localStorage.setItem(
      'bbcom-v1:device-profiles',
      JSON.stringify({ version: 1, profiles: 'not-an-array' }),
    );
    assert.deepEqual(loadPresets(), []);
  });
});

test('loadPresets filters out entries missing required fields', () => {
  withLocalStorageMock(() => {
    (globalThis as { localStorage: LocalStorageLike }).localStorage.setItem(
      'bbcom-v1:device-profiles',
      JSON.stringify({
        version: 1,
        profiles: [
          { id: '1', name: 'ok', config: CFG_9600 },
          { id: '2', name: 'no config' }, // malformed -> dropped
          { id: '3', name: 'bad baud', config: { ...CFG_9600, baudRate: 'x' } }, // dropped
        ],
      }),
    );
    const loaded = loadPresets();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'ok');
  });
});
