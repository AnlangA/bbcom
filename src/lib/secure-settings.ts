import { LazyStore } from '@tauri-apps/plugin-store';
import { logger } from './logger';

let store: LazyStore | null = null;

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!w.__TAURI_INTERNALS__ || !!w.__TAURI__;
}

function getStore(): LazyStore | null {
  if (!isTauriRuntime()) return null;
  store ??= new LazyStore('secure-settings.json');
  return store;
}

export async function loadSecretString(key: string): Promise<string> {
  const secureStore = getStore();
  if (!secureStore) return '';
  try {
    const value = await secureStore.get<string>(key);
    return typeof value === 'string' ? value : '';
  } catch (e) {
    logger.warn('secure-settings: load failed for', key, e);
    return '';
  }
}

export async function saveSecretString(key: string, value: string): Promise<boolean> {
  const secureStore = getStore();
  if (!secureStore) return false;
  try {
    await secureStore.set(key, value);
    await secureStore.save();
    return true;
  } catch (e) {
    logger.warn('secure-settings: save failed for', key, e);
    return false;
  }
}

export async function clearSecretString(key: string): Promise<boolean> {
  const secureStore = getStore();
  if (!secureStore) return false;
  try {
    await secureStore.delete(key);
    await secureStore.save();
    return true;
  } catch (e) {
    logger.warn('secure-settings: clear failed for', key, e);
    return false;
  }
}
