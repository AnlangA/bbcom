import { LazyStore } from '@tauri-apps/plugin-store';
import { logger } from './logger';

const store = new LazyStore('secure-settings.json');

export async function loadSecretString(key: string): Promise<string> {
  try {
    const value = await store.get<string>(key);
    return typeof value === 'string' ? value : '';
  } catch (e) {
    logger.warn('secure-settings: load failed for', key, e);
    return '';
  }
}

export async function saveSecretString(key: string, value: string): Promise<boolean> {
  try {
    await store.set(key, value);
    await store.save();
    return true;
  } catch (e) {
    logger.warn('secure-settings: save failed for', key, e);
    return false;
  }
}

export async function clearSecretString(key: string): Promise<boolean> {
  try {
    await store.delete(key);
    await store.save();
    return true;
  } catch (e) {
    logger.warn('secure-settings: clear failed for', key, e);
    return false;
  }
}
