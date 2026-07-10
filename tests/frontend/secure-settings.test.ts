import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import {
  clearSecretString,
  createSecureSettings,
  loadSecretString,
  saveSecretString,
  type SecureSettingsBackend,
  type SecureSettingsWarning,
} from '../../src/lib/secure-settings.ts';
import {
  createSerializedLatestValueQueue,
  loadAndMigrateLegacySecret,
  useAppStore,
} from '../../src/stores/app.ts';

interface BackendOptions {
  available?: boolean;
  failSecureOpen?: boolean;
  failSecureGet?: boolean;
  failSecureSet?: boolean;
  failSecureRemove?: boolean;
  failLegacyGet?: boolean;
  failLegacyDelete?: boolean;
  failLegacySave?: boolean;
  secureValueAfterGet?: string;
}

function fakeBackend(options: BackendOptions = {}) {
  const secure = new Map<string, string>();
  const legacy = new Map<string, unknown>();
  const events: string[] = [];
  const warnings: SecureSettingsWarning[] = [];

  const backend: SecureSettingsBackend = {
    isAvailable: () => options.available !== false,
    async openSecureStore() {
      events.push('secure.open');
      if (options.failSecureOpen) throw new Error('open failed');
      return {
        async get(key) {
          events.push('secure.get');
          if (options.failSecureGet) throw new Error('get failed');
          const value = secure.get(key) ?? null;
          if (options.secureValueAfterGet !== undefined) {
            secure.set(key, options.secureValueAfterGet);
          }
          return value;
        },
        async set(key, value) {
          events.push('secure.set');
          if (options.failSecureSet) throw new Error('set failed');
          secure.set(key, value);
        },
        async migrateIfMissing(key, value) {
          events.push('secure.migrate-if-missing');
          if (options.failSecureSet) throw new Error('migration failed');
          const currentValue = secure.get(key);
          if (currentValue !== undefined) return currentValue;
          secure.set(key, value);
          return value;
        },
        async remove(key) {
          events.push('secure.remove');
          if (options.failSecureRemove) throw new Error('remove failed');
          secure.delete(key);
        },
      };
    },
    openLegacyStore() {
      return {
        async get(key) {
          events.push('legacy.get');
          if (options.failLegacyGet) throw new Error('legacy get failed');
          return legacy.get(key);
        },
        async delete(key) {
          events.push('legacy.delete');
          if (options.failLegacyDelete) throw new Error('legacy delete failed');
          return legacy.delete(key);
        },
        async save() {
          events.push('legacy.save');
          if (options.failLegacySave) throw new Error('legacy save failed');
        },
      };
    },
    warn(event) {
      warnings.push(event);
    },
  };

  return { backend, secure, legacy, events, warnings };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('secure settings no-op quietly outside the Tauri runtime', async () => {
  assert.equal(await loadSecretString('ai-api-key'), '');
  assert.equal(await saveSecretString('ai-api-key', 'secret'), false);
  assert.equal(await clearSecretString('ai-api-key'), false);
});

test('native credential wins and stale legacy plaintext is removed', async () => {
  const fake = fakeBackend();
  fake.secure.set('ai-api-key', 'secure-value');
  fake.legacy.set('ai-api-key', 'old-plaintext');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.loadSecretString('ai-api-key'), 'secure-value');
  assert.equal(fake.legacy.has('ai-api-key'), false);
  assert.deepEqual(fake.events, [
    'secure.open',
    'secure.get',
    'legacy.get',
    'legacy.delete',
    'legacy.save',
  ]);
  assert.deepEqual(fake.warnings, []);
});

test('legacy plaintext migrates only after native credential write succeeds', async () => {
  const fake = fakeBackend();
  fake.legacy.set('ai-api-key', 'legacy-value');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.loadSecretString('ai-api-key'), 'legacy-value');
  assert.equal(fake.secure.get('ai-api-key'), 'legacy-value');
  assert.equal(fake.legacy.has('ai-api-key'), false);
  assert.deepEqual(fake.events, [
    'secure.open',
    'secure.get',
    'legacy.get',
    'secure.migrate-if-missing',
    'legacy.get',
    'legacy.delete',
    'legacy.save',
  ]);
  assert.ok(
    fake.events.indexOf('secure.migrate-if-missing') < fake.events.indexOf('legacy.delete'),
  );
});

test('legacy migration compare-and-set keeps a native value written after the read', async () => {
  const fake = fakeBackend({ secureValueAfterGet: 'new-native-value' });
  fake.legacy.set('ai-api-key', 'old-legacy-value');
  const settings = createSecureSettings(fake.backend);

  assert.deepEqual(await settings.loadSecretStringState('ai-api-key'), {
    nativeState: 'present',
    value: 'new-native-value',
  });
  assert.equal(fake.secure.get('ai-api-key'), 'new-native-value');
  assert.equal(fake.legacy.has('ai-api-key'), false);
  assert.deepEqual(fake.events, [
    'secure.open',
    'secure.get',
    'legacy.get',
    'secure.migrate-if-missing',
    'legacy.get',
    'legacy.delete',
    'legacy.save',
  ]);
});

test('failed native read never overwrites a newer credential with legacy plaintext', async () => {
  const fake = fakeBackend({ failSecureGet: true });
  fake.secure.set('ai-api-key', 'new-native-value');
  fake.legacy.set('ai-api-key', 'old-legacy-value');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.loadSecretString('ai-api-key'), 'old-legacy-value');
  assert.equal(fake.secure.get('ai-api-key'), 'new-native-value');
  assert.equal(fake.legacy.get('ai-api-key'), 'old-legacy-value');
  assert.deepEqual(fake.events, ['secure.open', 'secure.get', 'legacy.get']);
  assert.deepEqual(fake.warnings, ['secure-read-failed']);
});

test('failed migration keeps legacy plaintext readable and never deletes it', async () => {
  const fake = fakeBackend({ failSecureSet: true });
  fake.legacy.set('ai-api-key', 'must-not-appear-in-logs');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.loadSecretString('ai-api-key'), 'must-not-appear-in-logs');
  assert.equal(fake.legacy.get('ai-api-key'), 'must-not-appear-in-logs');
  assert.equal(fake.events.includes('legacy.delete'), false);
  assert.deepEqual(fake.warnings, ['migration-write-failed']);
  assert.equal(JSON.stringify(fake.warnings).includes('must-not-appear-in-logs'), false);
});

test('save writes only the native credential then cleans legacy plaintext', async () => {
  const fake = fakeBackend();
  fake.legacy.set('ai-api-key', 'old-value');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.saveSecretString('ai-api-key', 'new-value'), true);
  assert.equal(fake.secure.get('ai-api-key'), 'new-value');
  assert.equal(fake.legacy.has('ai-api-key'), false);
  assert.deepEqual(fake.events, [
    'secure.open',
    'secure.set',
    'legacy.get',
    'legacy.delete',
    'legacy.save',
  ]);
});

test('failed native credential write reports false and leaves legacy data untouched', async () => {
  const fake = fakeBackend({ failSecureSet: true });
  fake.legacy.set('ai-api-key', 'old-value');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.saveSecretString('ai-api-key', 'new-value'), false);
  assert.equal(fake.legacy.get('ai-api-key'), 'old-value');
  assert.equal(fake.events.includes('legacy.delete'), false);
  assert.deepEqual(fake.warnings, ['secure-write-failed']);
});

test('clear removes both native and legacy copies', async () => {
  const fake = fakeBackend();
  fake.secure.set('ai-api-key', 'secure-value');
  fake.legacy.set('ai-api-key', 'legacy-value');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.clearSecretString('ai-api-key'), true);
  assert.equal(fake.secure.has('ai-api-key'), false);
  assert.equal(fake.legacy.has('ai-api-key'), false);
  assert.deepEqual(fake.events, [
    'secure.open',
    'secure.remove',
    'legacy.get',
    'legacy.delete',
    'legacy.save',
  ]);
});

test('clear still removes legacy plaintext when native storage fails and reports false', async () => {
  const fake = fakeBackend({ failSecureRemove: true });
  fake.legacy.set('ai-api-key', 'legacy-value');
  const settings = createSecureSettings(fake.backend);

  assert.equal(await settings.clearSecretString('ai-api-key'), false);
  assert.equal(fake.legacy.has('ai-api-key'), false);
  assert.deepEqual(fake.warnings, ['clear-failed']);
});

test('unavailable native read only displays local legacy and never migrates or cleans it', async () => {
  const fake = fakeBackend({ failSecureGet: true });
  fake.secure.set('ai-api-key', 'new-native-value');
  const settings = createSecureSettings(fake.backend);
  let localLegacy = 'old-local-value';
  let migrationCalled = false;
  let cleanupCalled = false;

  const value = await loadAndMigrateLegacySecret({
    readLegacyValue: () => localLegacy,
    clearLegacyValue: () => {
      cleanupCalled = true;
      localLegacy = '';
    },
    loadSecureValue: () => settings.loadSecretStringState('ai-api-key'),
    migrateIfMissing: async (legacyValue) => {
      migrationCalled = true;
      return settings.migrateSecretStringIfMissing('ai-api-key', legacyValue);
    },
  });

  assert.equal(value, 'old-local-value');
  assert.equal(fake.secure.get('ai-api-key'), 'new-native-value');
  assert.equal(localLegacy, 'old-local-value');
  assert.equal(migrationCalled, false);
  assert.equal(cleanupCalled, false);
  assert.deepEqual(fake.events, ['secure.open', 'secure.get', 'legacy.get']);
});

test('explicit native missing state migrates local legacy and uses the compare-and-set winner', async () => {
  let localLegacy = 'old-local-value';
  const migratedValues: string[] = [];

  const value = await loadAndMigrateLegacySecret({
    readLegacyValue: () => localLegacy,
    clearLegacyValue: () => {
      localLegacy = '';
    },
    loadSecureValue: async () => ({ nativeState: 'missing', value: '' }),
    migrateIfMissing: async (legacyValue) => {
      migratedValues.push(legacyValue);
      return { nativeState: 'present', value: 'new-native-value' };
    },
  });

  assert.equal(value, 'new-native-value');
  assert.deepEqual(migratedValues, ['old-local-value']);
  assert.equal(localLegacy, '');
});

test('serialized value queue finishes startup load before persisting a newer UI value', async () => {
  let visibleValue = 'initial';
  let ready = true;
  let persistStarted = false;
  const loadResult = deferred<string>();
  const persistResult = deferred<boolean>();
  const persistDidStart = deferred<void>();
  const queue = createSerializedLatestValueQueue({
    initialPersistedValue: 'initial',
    applyValue: (value) => {
      visibleValue = value;
    },
    setReady: (value) => {
      ready = value;
    },
  });

  const load = queue.load(() => loadResult.promise);
  const save = queue.set('new-value', async () => {
    persistStarted = true;
    persistDidStart.resolve(undefined);
    return persistResult.promise;
  });

  assert.equal(visibleValue, 'new-value', 'set is immediately visible');
  assert.equal(ready, false);
  await Promise.resolve();
  assert.equal(persistStarted, false, 'set waits for the queued load and its migration');

  loadResult.resolve('loaded-old-value');
  assert.equal(await load, true);
  await persistDidStart.promise;
  assert.equal(visibleValue, 'new-value', 'stale load completion cannot replace a newer set');

  persistResult.resolve(true);
  assert.equal(await save, true);
  assert.equal(visibleValue, 'new-value');
  assert.equal(ready, true);
});

test('serialized value queue orders concurrent sets and rolls failure back to durable state', async () => {
  let visibleValue = 'persisted-old';
  const operations: string[] = [];
  const firstResult = deferred<boolean>();
  const secondResult = deferred<boolean>();
  const firstDidStart = deferred<void>();
  const secondDidStart = deferred<void>();
  const queue = createSerializedLatestValueQueue({
    initialPersistedValue: 'persisted-old',
    applyValue: (value) => {
      visibleValue = value;
    },
    setReady: () => undefined,
  });

  const first = queue.set('first-value', async () => {
    operations.push('first');
    firstDidStart.resolve(undefined);
    return firstResult.promise;
  });
  await firstDidStart.promise;

  let secondStarted = false;
  const second = queue.set('second-value', async () => {
    secondStarted = true;
    operations.push('second');
    secondDidStart.resolve(undefined);
    return secondResult.promise;
  });

  assert.equal(visibleValue, 'second-value');
  assert.equal(secondStarted, false, 'second persistence waits for the first');

  firstResult.resolve(true);
  assert.equal(await first, true);
  await secondDidStart.promise;
  assert.equal(visibleValue, 'second-value', 'older success cannot overwrite newer optimistic UI');
  assert.deepEqual(operations, ['first', 'second']);

  secondResult.resolve(false);
  assert.equal(await second, false);
  assert.equal(
    visibleValue,
    'first-value',
    'failed latest set rolls back to the last truly persisted value',
  );
});

test('app clear removes localStorage plaintext even when native clear fails', async () => {
  const key = 'bbcom-app-settings:ai-api-key';
  const data = new Map<string, string>([[key, 'legacy-local-value']]);
  const previous = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => {
      data.set(name, String(value));
    },
    removeItem: (name) => {
      data.delete(name);
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };

  try {
    setActivePinia(createPinia());
    const store = useAppStore();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(await store.setAiApiKey(''), false, 'native clear is unavailable in node');
    assert.equal(data.has(key), false, 'legacy plaintext is removed unconditionally');
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = previous;
  }
});
