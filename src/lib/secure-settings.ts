import { LazyStore } from '@tauri-apps/plugin-store';

const store = new LazyStore('secure-settings.json');

export async function loadSecretString(key: string): Promise<string> {
  try {
    const value = await store.get<string>(key);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export async function saveSecretString(key: string, value: string): Promise<boolean> {
  try {
    await store.set(key, value);
    await store.save();
    return true;
  } catch {
    return false;
  }
}

export async function clearSecretString(key: string): Promise<boolean> {
  try {
    await store.delete(key);
    await store.save();
    return true;
  } catch {
    return false;
  }
}
