import {
  LEGACY_SOURCE_VERSION,
  type Legacy073Snapshot,
  type LegacyJsonObject,
  type LegacyJsonValue,
  type LegacyReadContext,
  type LegacyReadOnlySource,
} from './types';
import type { LegacyResetWebStorage } from './marker-store';

export const LEGACY_APP_SETTINGS_KEY = 'bbcom-app-settings' as const;
export const LEGACY_SERIAL_SETTINGS_KEY = 'bbcom-serial-settings' as const;
export const LEGACY_CONNECTION_PRESETS_KEY = 'bbcom-connection-presets' as const;

/**
 * A read-only session snapshot reader supplied before the legacy Pinia store is
 * created. Implementations may read IndexedDB, but must not open it with a new
 * version, migrate it, save it, or delete the localStorage fallback.
 */
export interface LegacySessionSnapshotReader {
  read(context: LegacyReadContext): Promise<unknown>;
}

export interface LegacyRendererSourceOptions {
  readonly storage: LegacyResetWebStorage;
  readonly sessions: LegacySessionSnapshotReader;
}

/**
 * Reads the three legacy domains without exposing any mutation API. Values are
 * converted to immutable JSON before the coordinator applies its second,
 * credential/path-oriented sanitization pass.
 */
export class LegacyRendererReadOnlySource implements LegacyReadOnlySource {
  constructor(private readonly options: LegacyRendererSourceOptions) {}

  async readSnapshot(context: LegacyReadContext): Promise<Legacy073Snapshot> {
    throwIfAborted(context.signal);
    const raw = await this.options.sessions.read(context);
    throwIfAborted(context.signal);
    return Object.freeze({
      applicationVersion: LEGACY_SOURCE_VERSION,
      payload: Object.freeze({ sessions: toLegacyJsonValue(raw) }),
    });
  }

  readSettings(context: LegacyReadContext): Promise<LegacyJsonObject> {
    throwIfAborted(context.signal);
    return Promise.resolve(
      Object.freeze({
        app: readObject(this.options.storage, LEGACY_APP_SETTINGS_KEY),
        serial: readObject(this.options.storage, LEGACY_SERIAL_SETTINGS_KEY),
      }),
    );
  }

  readPresets(context: LegacyReadContext): Promise<LegacyJsonObject> {
    throwIfAborted(context.signal);
    return Promise.resolve(readObject(this.options.storage, LEGACY_CONNECTION_PRESETS_KEY));
  }
}

function readObject(storage: LegacyResetWebStorage, key: string): LegacyJsonObject {
  const encoded = storage.getItem(key);
  if (encoded === null || encoded === '') return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`legacy state is not valid JSON: ${key}`);
  }
  const value = toLegacyJsonValue(parsed);
  if (!isJsonObject(value)) throw new Error(`legacy state is not an object: ${key}`);
  return value;
}

function toLegacyJsonValue(value: unknown, seen = new WeakSet<object>()): LegacyJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('legacy state contains a non-finite number');
    return value;
  }
  if (value instanceof Uint8Array) {
    return Object.freeze({ $bbcomBytesBase64: bytesToBase64(value) });
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('legacy state must not be cyclic');
    seen.add(value);
    const result = Object.freeze(value.map((child) => toLegacyJsonValue(child, seen)));
    seen.delete(value);
    return result;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('legacy state contains a non-JSON value');
  }
  if (seen.has(value)) throw new Error('legacy state must not be cyclic');
  seen.add(value);
  const output: Record<string, LegacyJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = toLegacyJsonValue(child, seen);
  }
  seen.delete(value);
  return Object.freeze(output);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function isJsonObject(value: LegacyJsonValue): value is LegacyJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('legacy state read aborted');
  error.name = 'AbortError';
  throw error;
}
