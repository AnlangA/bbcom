import { describe, expect, test, vi } from 'vitest';
import { BrowserLegacySessionSnapshotReader } from '../../src/features/migration/legacy-session-snapshot-reader.ts';
import { SESSION_STORAGE_KEY } from '../../src/lib/session-persistence.ts';
import { SESSION_STATE_DATABASE_NAME } from '../../src/lib/session-state-database.ts';
import type { LegacyResetWebStorage } from '../../src/features/migration/marker-store.ts';

type MutableRequest<T> = IDBRequest<T> & {
  result: T;
  error: DOMException | null;
};

type MutableOpenRequest = IDBOpenDBRequest & {
  result: IDBDatabase;
  error: DOMException | null;
  transaction: IDBTransaction | null;
};

function storageWith(value: string | null): LegacyResetWebStorage {
  return {
    getItem: vi.fn((key: string) => (key === SESSION_STORAGE_KEY ? value : null)),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}

function successfulRequest<T>(result: T): IDBRequest<T> {
  const request = { result, error: null } as MutableRequest<T>;
  queueMicrotask(() => request.onsuccess?.(new Event('success')));
  return request;
}

function existingDatabase(options: {
  manifest?: unknown;
  sessions?: unknown[];
  frames?: unknown[];
  stores?: readonly string[];
  complete?: boolean;
}) {
  const close = vi.fn();
  const abort = vi.fn();
  const stores = options.stores ?? ['manifest', 'sessions', 'frames'];
  const transaction = {
    error: null,
    oncomplete: null,
    onabort: null,
    onerror: null,
    abort,
    objectStore(name: string) {
      return {
        get: () => successfulRequest(options.manifest),
        getAll: () =>
          successfulRequest(
            name === 'sessions' ? (options.sessions ?? []) : (options.frames ?? []),
          ),
      } as unknown as IDBObjectStore;
    },
  } as unknown as IDBTransaction;
  abort.mockImplementation(() => transaction.onabort?.(new Event('abort')));

  const database = {
    version: 7,
    close,
    objectStoreNames: {
      contains: (name: string) => stores.includes(name),
    },
    transaction: vi.fn(() => {
      if (options.complete !== false) {
        queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.(new Event('complete'))));
      }
      return transaction;
    }),
  } as unknown as IDBDatabase;
  return { database, transaction, close, abort };
}

function factoryForDatabase(database: IDBDatabase, enumerate = true) {
  const request = {
    result: database,
    error: null,
    transaction: null,
  } as MutableOpenRequest;
  const factory = {
    open: vi.fn(() => {
      queueMicrotask(() => request.onsuccess?.(new Event('success')));
      return request;
    }),
    ...(enumerate
      ? { databases: vi.fn(async () => [{ name: SESSION_STATE_DATABASE_NAME, version: 7 }]) }
      : {}),
  };
  return { factory: factory as unknown as IDBFactory, request };
}

describe('BrowserLegacySessionSnapshotReader', () => {
  test('preserves valid, empty, and malformed localStorage snapshots without a database', async () => {
    const signal = new AbortController().signal;
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith('{"sessions":[1]}'), null).read({
        signal,
      }),
    ).resolves.toEqual({ indexedDb: null, localStorage: { sessions: [1] } });
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith(null), null).read({ signal }),
    ).resolves.toEqual({ indexedDb: null, localStorage: null });
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith('{broken'), null).read({ signal }),
    ).resolves.toEqual({ indexedDb: null, localStorage: { malformedJson: '{broken' } });
  });

  test('opens by name and returns a complete readonly database snapshot', async () => {
    const db = existingDatabase({
      manifest: { revision: 4 },
      sessions: [{ id: 'session-a' }],
      frames: [{ id: 'frame-a' }],
    });
    const { factory } = factoryForDatabase(db.database);
    const reader = new BrowserLegacySessionSnapshotReader(storageWith('{}'), factory);

    await expect(reader.read({ signal: new AbortController().signal })).resolves.toEqual({
      indexedDb: {
        databaseVersion: 7,
        manifest: { revision: 4 },
        sessions: [{ id: 'session-a' }],
        frames: [{ id: 'frame-a' }],
      },
      localStorage: {},
    });
    expect(factory.open).toHaveBeenCalledWith(SESSION_STATE_DATABASE_NAME);
    expect(db.database.transaction).toHaveBeenCalledWith(
      ['manifest', 'sessions', 'frames'],
      'readonly',
    );
    expect(db.close).toHaveBeenCalledOnce();
  });

  test('ignores lying enumeration and proves absence only via the open probe', async () => {
    // Some WebViews enumerate an existing database inconsistently; the
    // enumeration listing must never classify real data as absent. Here the
    // listing omits the database while the open probe confirms it exists —
    // the reader must still read it.
    const db = existingDatabase({ manifest: { revision: 1 }, sessions: [], frames: [] });
    const { factory } = factoryForDatabase(db.database);
    (factory as unknown as { databases?: () => Promise<readonly IDBDatabaseInfo[]> }).databases =
      vi.fn(async () => []);
    const reader = new BrowserLegacySessionSnapshotReader(storageWith(null), factory);
    const snapshot = await reader.read({ signal: new AbortController().signal });
    expect(snapshot.indexedDb).not.toBeNull();
    expect(factory.open).toHaveBeenCalledWith(SESSION_STATE_DATABASE_NAME);

    // Absence is proven solely by the non-creating upgrade probe firing.
    const upgradeAbort = vi.fn();
    const request = {
      result: null,
      error: null,
      transaction: { abort: upgradeAbort },
    } as unknown as MutableOpenRequest;
    const absentFactory = {
      databases: vi.fn(async () => [{ name: 'another-database', version: 1 }]),
      open: vi.fn(() => {
        queueMicrotask(() =>
          request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent),
        );
        return request;
      }),
    } as unknown as IDBFactory;
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith(null), absentFactory).read({
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ indexedDb: null, localStorage: null });
    expect(absentFactory.open).toHaveBeenCalled();

    const incomplete = existingDatabase({ stores: ['manifest', 'sessions'] });
    const { factory: incompleteFactory } = factoryForDatabase(incomplete.database);
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith(null), incompleteFactory).read({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('legacy session database schema is incomplete');
    expect(incomplete.close).toHaveBeenCalledOnce();
  });

  test('uses the non-creating upgrade probe to prove database absence', async () => {
    const upgradeAbort = vi.fn();
    const request = {
      result: null,
      error: null,
      transaction: { abort: upgradeAbort },
    } as unknown as MutableOpenRequest;
    const factory = {
      open: vi.fn(() => {
        queueMicrotask(() =>
          request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent),
        );
        return request;
      }),
    } as unknown as IDBFactory;
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith(null), factory).read({
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ indexedDb: null, localStorage: null });
    expect(upgradeAbort).toHaveBeenCalledOnce();
  });

  test('surfaces open errors and blocked databases with stable fallback messages', async () => {
    for (const eventName of ['error', 'blocked'] as const) {
      const request = {
        result: null,
        error: null,
        transaction: null,
      } as unknown as MutableOpenRequest;
      const factory = {
        open: vi.fn(() => {
          queueMicrotask(() => {
            if (eventName === 'error') request.onerror?.(new Event('error'));
            else request.onblocked?.(new Event('blocked'));
          });
          return request;
        }),
      } as unknown as IDBFactory;
      await expect(
        new BrowserLegacySessionSnapshotReader(storageWith(null), factory).read({
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        eventName === 'error'
          ? 'failed to open legacy session database'
          : 'legacy session database is blocked',
      );
    }
  });

  test('honours cancellation before open, during open, and during a transaction', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      new BrowserLegacySessionSnapshotReader(storageWith(null), null).read({
        signal: alreadyAborted.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Aborting before the open probe resolves rejects with AbortError before
    // any database handle is produced.
    const beforeOpen = new AbortController();
    const pendingBeforeOpen = {
      result: null,
      error: null,
      transaction: null,
    } as unknown as MutableOpenRequest;
    const beforeOpenFactory = {
      databases: vi.fn(async () => [{ name: SESSION_STATE_DATABASE_NAME, version: 1 }]),
      open: vi.fn(() => pendingBeforeOpen),
    } as unknown as IDBFactory;
    const beforeOpenRead = new BrowserLegacySessionSnapshotReader(
      storageWith(null),
      beforeOpenFactory,
    ).read({ signal: beforeOpen.signal });
    await Promise.resolve();
    beforeOpen.abort();
    await expect(beforeOpenRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(beforeOpenFactory.open).toHaveBeenCalled();

    const opening = new AbortController();
    const pendingRequest = {
      result: null,
      error: null,
      transaction: null,
    } as unknown as MutableOpenRequest;
    const pendingFactory = {
      open: vi.fn(() => pendingRequest),
    } as unknown as IDBFactory;
    const openingRead = new BrowserLegacySessionSnapshotReader(
      storageWith(null),
      pendingFactory,
    ).read({ signal: opening.signal });
    await Promise.resolve();
    opening.abort();
    await expect(openingRead).rejects.toMatchObject({ name: 'AbortError' });

    const db = existingDatabase({ complete: false });
    const { factory } = factoryForDatabase(db.database);
    const transactionAbort = new AbortController();
    const transactionRead = new BrowserLegacySessionSnapshotReader(storageWith(null), factory).read(
      {
        signal: transactionAbort.signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    transactionAbort.abort();
    await expect(transactionRead).rejects.toThrow('legacy IndexedDB read was aborted');
    expect(db.abort).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });
});
