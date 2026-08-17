import { SESSION_STORAGE_KEY } from '../../lib/session-persistence';
import { SESSION_STATE_DATABASE_NAME } from '../../lib/session-state-database';
import type { LegacyResetWebStorage } from './marker-store';
import type { LegacySessionSnapshotReader } from './legacy-renderer-source';
import type { LegacyReadContext } from './types';

const MANIFEST_STORE = 'manifest';
const SESSION_STORE = 'sessions';
const FRAME_STORE = 'frames';
const MANIFEST_KEY = 'current';

type IndexedDbFactoryWithEnumeration = Omit<IDBFactory, 'databases'> & {
  databases?: () => Promise<readonly IDBDatabaseInfo[]>;
};

/**
 * Reads both 0.7.3 persistence sources without opening a missing database,
 * upgrading a schema, deleting a fallback, or writing a migration marker.
 */
export class BrowserLegacySessionSnapshotReader implements LegacySessionSnapshotReader {
  constructor(
    private readonly storage: LegacyResetWebStorage,
    private readonly databaseFactory: IndexedDbFactoryWithEnumeration | null = typeof globalThis.indexedDB ===
    'undefined'
      ? null
      : (globalThis.indexedDB as IndexedDbFactoryWithEnumeration),
  ) {}

  async read(context: LegacyReadContext): Promise<unknown> {
    throwIfAborted(context.signal);
    const localStorageSnapshot = readLocalStorageSnapshot(this.storage);
    const indexedDbSnapshot = await readExistingDatabase(this.databaseFactory, context.signal);
    throwIfAborted(context.signal);
    return Object.freeze({
      indexedDb: indexedDbSnapshot,
      localStorage: localStorageSnapshot,
    });
  }
}

function readLocalStorageSnapshot(storage: LegacyResetWebStorage): unknown {
  const encoded = storage.getItem(SESSION_STORAGE_KEY);
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    // Preserve malformed legacy bytes as text in the encrypted backup instead
    // of destroying the user's only recovery source or pretending it is empty.
    return Object.freeze({ malformedJson: encoded });
  }
}

async function readExistingDatabase(
  factory: IndexedDbFactoryWithEnumeration | null,
  signal: AbortSignal,
): Promise<unknown> {
  if (!factory) return null;
  let database: IDBDatabase;
  try {
    // Never use IDBFactory.databases() enumeration as an absence proof:
    // some WebViews list a pre-existing database inconsistently (or not at
    // all), which classified real legacy data as an empty install and
    // silently skipped the backup flow. Opening without a version and
    // aborting the initial upgrade transaction is the portable, non-creating
    // existence probe required by the IndexedDB transaction model, so it is
    // the only authority on whether the database exists.
    database = await openExistingDatabase(factory, signal);
  } catch (error) {
    if (error instanceof MissingLegacyDatabaseError) return null;
    throw error;
  }
  try {
    const requiredStores = [MANIFEST_STORE, SESSION_STORE, FRAME_STORE];
    if (requiredStores.some((store) => !database.objectStoreNames.contains(store))) {
      throw new Error('legacy session database schema is incomplete');
    }
    const transaction = database.transaction(requiredStores, 'readonly');
    const abort = (): void => transaction.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const manifestRequest = transaction.objectStore(MANIFEST_STORE).get(MANIFEST_KEY);
      const sessionsRequest = transaction.objectStore(SESSION_STORE).getAll();
      const framesRequest = transaction.objectStore(FRAME_STORE).getAll();
      const [manifest, sessions, frames] = await Promise.all([
        requestResult(manifestRequest),
        requestResult(sessionsRequest),
        requestResult(framesRequest),
        transactionDone(transaction),
      ]);
      throwIfAborted(signal);
      return Object.freeze({
        databaseVersion: database.version,
        manifest: manifest ?? null,
        sessions,
        frames,
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    database.close();
  }
}

function openExistingDatabase(
  factory: IndexedDbFactoryWithEnumeration,
  signal: AbortSignal,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const request = factory.open(SESSION_STATE_DATABASE_NAME);
    let opened: IDBDatabase | null = null;
    const abort = (): void => {
      opened?.close();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new MissingLegacyDatabaseError());
    };
    request.onsuccess = () => {
      opened = request.result;
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        opened.close();
        reject(abortError());
      } else {
        resolve(request.result);
      }
    };
    request.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(request.error ?? new Error('failed to open legacy session database'));
    };
    request.onblocked = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('legacy session database is blocked'));
    };
  });
}

class MissingLegacyDatabaseError extends Error {
  constructor() {
    super('legacy session database does not exist');
    this.name = 'MissingLegacyDatabaseError';
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('legacy IndexedDB read failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('legacy IndexedDB read was aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('legacy IndexedDB read failed'));
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('legacy state read aborted');
  error.name = 'AbortError';
  return error;
}
