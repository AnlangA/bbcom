import { logger } from './logger';

function getLocalStorage(): Storage | null {
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

export function isLocalStorageAvailable(): boolean {
  return getLocalStorage() !== null;
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const storage = getLocalStorage();
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch (e) {
    logger.warn('storage: loadJson failed for', key, e);
    return fallback;
  }
}

export function saveJson<T>(key: string, value: T): boolean {
  try {
    const storage = getLocalStorage();
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    logger.warn('storage: saveJson failed for', key, e);
    return false;
  }
}

export function loadString(key: string): string {
  try {
    const storage = getLocalStorage();
    if (!storage) return '';
    return storage.getItem(key) ?? '';
  } catch (e) {
    logger.warn('storage: loadString failed for', key, e);
    return '';
  }
}

export function saveString(key: string, value: string): boolean {
  try {
    const storage = getLocalStorage();
    if (!storage) return false;
    if (value) {
      storage.setItem(key, value);
    } else {
      storage.removeItem(key);
    }
    return true;
  } catch (e) {
    logger.warn('storage: saveString failed for', key, e);
    return false;
  }
}
