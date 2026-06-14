import { logger } from './logger';

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch (e) {
    logger.warn('storage: loadJson failed for', key, e);
    return fallback;
  }
}

export function saveJson<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    logger.warn('storage: saveJson failed for', key, e);
    return false;
  }
}

export function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch (e) {
    logger.warn('storage: loadString failed for', key, e);
    return '';
  }
}

export function saveString(key: string, value: string): boolean {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
    return true;
  } catch (e) {
    logger.warn('storage: saveString failed for', key, e);
    return false;
  }
}
