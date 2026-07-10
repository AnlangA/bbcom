import { invoke } from '@tauri-apps/api/core';
import { LazyStore } from '@tauri-apps/plugin-store';
import { logger } from './logger';

const LEGACY_STORE_FILE = 'secure-settings.json';

export interface SecureSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  migrateIfMissing(key: string, value: string): Promise<string>;
  remove(key: string): Promise<void>;
}

export interface LegacySecretStore {
  get(key: string): Promise<unknown>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
}

export type SecureSettingsWarning =
  | 'secure-read-failed'
  | 'secure-write-failed'
  | 'legacy-read-failed'
  | 'legacy-cleanup-failed'
  | 'migration-write-failed'
  | 'clear-failed';

export interface SecureSettingsBackend {
  isAvailable(): boolean;
  openSecureStore(): Promise<SecureSecretStore>;
  openLegacyStore(): LegacySecretStore;
  warn(event: SecureSettingsWarning): void;
}

export type NativeSecretState = 'present' | 'missing' | 'unavailable';

export interface SecretStringLoadResult {
  nativeState: NativeSecretState;
  value: string;
}

export function createSecureSettings(backend: SecureSettingsBackend) {
  async function readLegacyValue(key: string): Promise<string> {
    try {
      const value = await backend.openLegacyStore().get(key);
      return typeof value === 'string' ? value : '';
    } catch {
      backend.warn('legacy-read-failed');
      return '';
    }
  }

  async function removeLegacyValue(key: string): Promise<boolean> {
    try {
      const legacy = backend.openLegacyStore();
      const value = await legacy.get(key);
      if (value === undefined) return true;
      await legacy.delete(key);
      await legacy.save();
      return true;
    } catch {
      backend.warn('legacy-cleanup-failed');
      return false;
    }
  }

  async function loadSecretStringState(key: string): Promise<SecretStringLoadResult> {
    if (!backend.isAvailable()) return { nativeState: 'unavailable', value: '' };

    let secure: SecureSecretStore;
    try {
      secure = await backend.openSecureStore();
      const value = await secure.get(key);
      if (value !== null) {
        // Retry any legacy cleanup that failed after a previous secure write.
        await removeLegacyValue(key);
        return { nativeState: 'present', value };
      }
    } catch {
      backend.warn('secure-read-failed');
      return {
        nativeState: 'unavailable',
        value: await readLegacyValue(key),
      };
    }

    const legacyValue = await readLegacyValue(key);
    if (!legacyValue) return { nativeState: 'missing', value: '' };

    try {
      // This compare-and-set is serialized with normal saves in the Rust
      // backend. A value written by another window after get(null) wins.
      const value = await secure.migrateIfMissing(key, legacyValue);
      await removeLegacyValue(key);
      return { nativeState: 'present', value };
    } catch {
      // The old plaintext remains authoritative until the native credential
      // store confirms a durable write. Loading continues and retries later.
      backend.warn('migration-write-failed');
      return { nativeState: 'unavailable', value: legacyValue };
    }
  }

  async function loadSecretString(key: string): Promise<string> {
    return (await loadSecretStringState(key)).value;
  }

  async function migrateSecretStringIfMissing(
    key: string,
    value: string,
  ): Promise<SecretStringLoadResult> {
    if (!backend.isAvailable()) return { nativeState: 'unavailable', value };

    try {
      const secure = await backend.openSecureStore();
      const currentValue = await secure.migrateIfMissing(key, value);
      await removeLegacyValue(key);
      return { nativeState: 'present', value: currentValue };
    } catch {
      backend.warn('migration-write-failed');
      return { nativeState: 'unavailable', value };
    }
  }

  async function saveSecretString(key: string, value: string): Promise<boolean> {
    if (!backend.isAvailable()) return false;
    try {
      const secure = await backend.openSecureStore();
      await secure.set(key, value);
    } catch {
      backend.warn('secure-write-failed');
      return false;
    }

    // Native credential durability defines write success. Plaintext cleanup is
    // strictly ordered afterwards and retried by every later read/write.
    await removeLegacyValue(key);
    return true;
  }

  async function clearSecretString(key: string): Promise<boolean> {
    if (!backend.isAvailable()) return false;

    let secureCleared = false;
    try {
      const secure = await backend.openSecureStore();
      await secure.remove(key);
      secureCleared = true;
    } catch {
      backend.warn('clear-failed');
    }

    const legacyCleared = await removeLegacyValue(key);
    return secureCleared && legacyCleared;
  }

  return {
    loadSecretStringState,
    loadSecretString,
    migrateSecretStringIfMissing,
    saveSecretString,
    clearSecretString,
  };
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!w.__TAURI_INTERNALS__ || !!w.__TAURI__;
}

const ipcSecureStore: SecureSecretStore = {
  get: (key) => invoke<string | null>('secure_settings_load', { request: { key } }),
  set: (key, value) => invoke<void>('secure_settings_save', { request: { key, value } }),
  migrateIfMissing: (key, value) =>
    invoke<string>('secure_settings_migrate_if_missing', { request: { key, value } }),
  remove: (key) => invoke<void>('secure_settings_clear', { request: { key } }),
};

let legacyStore: LazyStore | null = null;

function openLegacyStore(): LegacySecretStore {
  legacyStore ??= new LazyStore(LEGACY_STORE_FILE, { autoSave: false, defaults: {} });
  return {
    get: (key) => legacyStore!.get(key),
    delete: (key) => legacyStore!.delete(key),
    save: () => legacyStore!.save(),
  };
}

const secureSettings = createSecureSettings({
  isAvailable: isTauriRuntime,
  openSecureStore: async () => ipcSecureStore,
  openLegacyStore,
  // Deliberately omit key names, values, and raw backend errors from logs.
  warn: (event) => logger.warn('secure-settings:', event),
});

export const loadSecretString = secureSettings.loadSecretString;
export const loadSecretStringState = secureSettings.loadSecretStringState;
export const migrateSecretStringIfMissing = secureSettings.migrateSecretStringIfMissing;
export const saveSecretString = secureSettings.saveSecretString;
export const clearSecretString = secureSettings.clearSecretString;
