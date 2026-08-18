import {
  LEGACY_RESET_MARKER_KEY,
  LEGACY_RESET_MARKER_VALUE,
  type LegacyResetMarkerStore,
} from './types';

export interface LegacyResetWebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal adapter for localStorage-like marker storage. */
export function webStorageLegacyResetMarkerStore(
  storage: LegacyResetWebStorage,
): LegacyResetMarkerStore {
  return {
    isSet(key) {
      return key === LEGACY_RESET_MARKER_KEY && storage.getItem(key) === LEGACY_RESET_MARKER_VALUE;
    },
    write(key, value) {
      storage.setItem(key, value);
    },
    remove(key) {
      storage.removeItem(key);
    },
  };
}

/** Synchronous completion probe used by the gate to skip its own flash: the
 *  marker is only ever written after the native journal committed, so a set
 *  marker lets the gate start fully transparent while the authoritative
 *  journal is still being confirmed. */
export function isLegacyResetMarkerSet(storage: LegacyResetWebStorage): boolean {
  return storage.getItem(LEGACY_RESET_MARKER_KEY) === LEGACY_RESET_MARKER_VALUE;
}
