import { isLocalStorageAvailable, loadJson } from '@/lib/storage';
import {
  GLOBAL_SETTINGS_STORAGE_KEY,
  LEGACY_APP_SETTINGS_KEY,
  LEGACY_SERIAL_SETTINGS_KEY,
  type GlobalSettingsV2,
  type LegacySidebarCompat,
  migrateLegacyGlobalSettings,
  normalizeGlobalSettings,
} from './global-settings';

export interface GlobalSettingsDocument {
  readonly settings: GlobalSettingsV2;
  readonly legacySidebar: LegacySidebarCompat | null;
}

/**
 * Physical settings storage boundary. Reads prefer the v2 document; when it is
 * absent, corrupt, or from a future version, settings migrate read-only from
 * the two v1 keys — which are never written or deleted by this repository.
 */
export interface GlobalSettingsRepository {
  load(): GlobalSettingsDocument;
  save(settings: GlobalSettingsV2): boolean;
}

export class BrowserSettingsRepository implements GlobalSettingsRepository {
  load(): GlobalSettingsDocument {
    if (!isLocalStorageAvailable()) {
      return {
        settings: migrateLegacyGlobalSettings(null, null).settings,
        legacySidebar: null,
      };
    }
    // loadJson merges over its fallback and swallows corrupt JSON; a corrupt or
    // future-version blob therefore lands in the v1 migration path below.
    const persisted = loadJson<Record<string, unknown>>(GLOBAL_SETTINGS_STORAGE_KEY, {});
    const normalized = normalizeGlobalSettings(persisted);
    if (normalized !== null) return { settings: normalized, legacySidebar: null };

    const legacyApp = this.readRawJson(LEGACY_APP_SETTINGS_KEY);
    const legacySerial = this.readRawJson(LEGACY_SERIAL_SETTINGS_KEY);
    return migrateLegacyGlobalSettings(legacyApp, legacySerial);
  }

  save(settings: GlobalSettingsV2): boolean {
    if (typeof globalThis.localStorage === 'undefined') return false;
    try {
      globalThis.localStorage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      return true;
    } catch {
      return false;
    }
  }

  private readRawJson(key: string): unknown {
    if (typeof globalThis.localStorage === 'undefined') return null;
    try {
      const raw = globalThis.localStorage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }
}
