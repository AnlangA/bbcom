import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  BrowserSettingsRepository,
  SettingsService,
  defaultGlobalSettings,
  GLOBAL_SETTINGS_STORAGE_KEY,
  LEGACY_APP_SETTINGS_KEY,
  LEGACY_SERIAL_SETTINGS_KEY,
} from '@/features/settings/index.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StorageHarness {
  data: Map<string, string>;
  writes: { key: string; value: string }[];
  restore: () => void;
}

function installStorage(): StorageHarness {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  const writes: { key: string; value: string }[] = [];
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, String(value));
      writes.push({ key, value: String(value) });
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return {
    data,
    writes,
    restore: () => {
      (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
    },
  };
}

test('a valid v2 document round-trips field-by-field', () => {
  const storage = installStorage();
  try {
    const settings = { ...defaultGlobalSettings(), theme: 'light' as const, sendAsHex: true };
    const repository = new BrowserSettingsRepository();
    assert.equal(repository.save(settings), true);
    const loaded = new BrowserSettingsRepository().load();
    assert.equal(loaded.settings.theme, 'light');
    assert.equal(loaded.settings.sendAsHex, true);
    assert.equal(loaded.legacySidebar, null);
  } finally {
    storage.restore();
  }
});

test('corrupt, partial, and future-version documents never throw and fall back to v1', () => {
  const storage = installStorage();
  try {
    storage.data.set(GLOBAL_SETTINGS_STORAGE_KEY, '{not json');
    storage.data.set(
      LEGACY_APP_SETTINGS_KEY,
      JSON.stringify({ theme: 'light', loopIntervalMs: null }),
    );
    storage.data.set(
      LEGACY_SERIAL_SETTINGS_KEY,
      JSON.stringify({ selectedPort: 'COM3', portConfig: { baudRate: 4800 } }),
    );

    const loaded = new BrowserSettingsRepository().load();
    assert.equal(loaded.settings.theme, 'light', 'v1 fields migrate read-only');
    assert.equal(loaded.settings.loopIntervalMs, 1000, 'invalid v1 field stays at default');
    assert.equal(loaded.settings.selectedPort, 'COM3');
    assert.equal(loaded.settings.portConfig.baudRate, 4800);

    storage.data.set(
      GLOBAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultGlobalSettings(), version: 99, theme: 'light' }),
    );
    const future = new BrowserSettingsRepository().load();
    assert.equal(
      future.settings.theme,
      'light',
      'a future v2 document is ignored, v1 migration still applies',
    );

    storage.data.set(
      GLOBAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: 2, theme: 'definitely-not-a-theme', maxBufferFrames: 'huge' }),
    );
    const partial = new BrowserSettingsRepository().load();
    assert.equal(partial.settings.theme, 'dark');
    assert.equal(partial.settings.maxBufferFrames, 20_000);
  } finally {
    storage.restore();
  }
});

test('the repository never writes or deletes the legacy v1 keys', () => {
  const storage = installStorage();
  try {
    const legacyApp = JSON.stringify({ theme: 'light' });
    const legacySerial = JSON.stringify({ selectedPort: 'COM1' });
    storage.data.set(LEGACY_APP_SETTINGS_KEY, legacyApp);
    storage.data.set(LEGACY_SERIAL_SETTINGS_KEY, legacySerial);

    const repository = new BrowserSettingsRepository();
    const loaded = repository.load();
    repository.save({ ...loaded.settings, theme: 'dark' });

    assert.equal(storage.data.get(LEGACY_APP_SETTINGS_KEY), legacyApp);
    assert.equal(storage.data.get(LEGACY_SERIAL_SETTINGS_KEY), legacySerial);
    assert.ok(storage.data.has(GLOBAL_SETTINGS_STORAGE_KEY));
  } finally {
    storage.restore();
  }
});

test('one settings change produces exactly one physical write', async () => {
  vi.useFakeTimers();
  const storage = installStorage();
  try {
    const repository = new BrowserSettingsRepository();
    const service = new SettingsService(repository);
    service.hydrate();

    service.update({ theme: 'light' });
    service.update({ sendAsHex: true });
    service.update({ autoReconnect: true });
    await vi.advanceTimersByTimeAsync(299);
    assert.equal(storage.writes.length, 0, 'writes stay coalesced inside the debounce window');
    await vi.advanceTimersByTimeAsync(2);

    assert.equal(storage.writes.length, 1, 'coalesced updates produce exactly one write');
    const persisted = JSON.parse(storage.writes[0].value);
    assert.equal(persisted.theme, 'light');
    assert.equal(persisted.sendAsHex, true);
    assert.equal(persisted.autoReconnect, true);
    assert.equal(persisted.version, 2);
    assert.equal(service.snapshot().health, 'idle');
  } finally {
    vi.useRealTimers();
    storage.restore();
  }
});

test('flush cancels the debounce and a failed write is observable and recoverable', async () => {
  vi.useFakeTimers();
  const storage = installStorage();
  try {
    const repository = new BrowserSettingsRepository();
    const service = new SettingsService(repository);
    service.hydrate();

    service.update({ theme: 'light' });
    assert.equal(service.snapshot().health, 'pending');
    assert.equal(service.flush(), true);
    assert.equal(service.snapshot().health, 'idle');
    const writesAfterFlush = storage.writes.length;
    await vi.advanceTimersByTimeAsync(400);
    assert.equal(storage.writes.length, writesAfterFlush, 'cancelled debounce never writes');

    // Force physical failure: remove storage entirely and flip the setting.
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = undefined;
    service.update({ theme: 'dark' });
    await vi.advanceTimersByTimeAsync(400);
    assert.equal(service.snapshot().health, 'failed', 'write failure is observable');

    // Retry once storage is back: the same pending state recovers to idle.
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = {
      getItem: (key) => storage.data.get(key) ?? null,
      setItem: (key, value) => {
        storage.data.set(key, String(value));
        storage.writes.push({ key, value: String(value) });
      },
      removeItem: (key) => {
        storage.data.delete(key);
      },
    };
    assert.equal(service.flush(), true);
    assert.equal(service.snapshot().health, 'idle');
  } finally {
    vi.useRealTimers();
    storage.restore();
  }
});

test('the persisted document contains no secrets or sidebar state', async () => {
  vi.useFakeTimers();
  const storage = installStorage();
  try {
    const service = new SettingsService(new BrowserSettingsRepository());
    service.hydrate();
    service.update({ theme: 'light' });
    await vi.advanceTimersByTimeAsync(400);

    const persisted = JSON.parse(storage.data.get(GLOBAL_SETTINGS_STORAGE_KEY) as string);
    assert.deepEqual(Object.keys(persisted).sort(), [
      'ansiColorEnabled',
      'autoReconnect',
      'autoScroll',
      'displayMode',
      'lineEnding',
      'locale',
      'loopIntervalMs',
      'maxBufferFrames',
      'packetViewMode',
      'portConfig',
      'preserveLogLineBreaks',
      'searchMode',
      'selectedPort',
      'sendAsHex',
      'showTimestamp',
      'softWrapEnabled',
      'theme',
      'version',
    ]);
  } finally {
    vi.useRealTimers();
    storage.restore();
  }
});
