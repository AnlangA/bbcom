export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch (err) {
    console.debug('loadJson failed for key:', key, err);
    return fallback;
  }
}

export function saveJson<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.debug('saveJson failed for key:', key, err);
    return false;
  }
}

export function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch (err) {
    console.debug('loadString failed for key:', key, err);
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
  } catch (err) {
    console.debug('saveString failed for key:', key, err);
    return false;
  }
}
