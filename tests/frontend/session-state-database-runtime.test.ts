import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import {
  createSessionRecord,
  type PersistedSessionsFile,
} from '../../src/lib/session-persistence.ts';
import {
  IndexedDbSessionStateDatabase,
  SESSION_STATE_DATABASE_VERSION,
} from '../../src/lib/session-state-database.ts';
import type { PortConfig } from '../../src/types/index.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  dtr: false,
  rts: false,
};

type OpenMode = 'success' | 'version-error' | 'error' | 'blocked';
type TransactionMode = 'success' | 'abort' | 'error';

class FakeRequest<T> {
  result!: T;
  error: DOMException | Error | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  succeed(value: T): void {
    this.result = value;
    queueMicrotask(() => this.onsuccess?.({ target: this } as unknown as Event));
  }

  fail(error: DOMException | Error): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ target: this } as unknown as Event));
  }
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class FakeObjectStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly failReads: () => boolean,
  ) {}

  get(key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    if (this.failReads()) request.fail(new Error('get failed'));
    else request.succeed(this.records.get(key));
    return request;
  }

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    if (this.failReads()) request.fail(new Error('getAll failed'));
    else request.succeed([...this.records.values()]);
    return request;
  }

  put(value: unknown): void {
    const record = value as { key?: string; id?: string; sessionId?: string };
    const key = record.key ?? record.id ?? record.sessionId;
    if (!key) throw new Error('missing record key');
    this.records.set(key, value);
  }

  clear(): void {
    this.records.clear();
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;

  constructor(
    private readonly stores: Map<string, Map<string, unknown>>,
    private readonly outcome: TransactionMode,
    private readonly failReads: () => boolean,
  ) {
    queueMicrotask(() => {
      if (this.outcome === 'abort') {
        this.error = new Error('transaction aborted');
        this.onabort?.();
      } else if (this.outcome === 'error') {
        this.error = new Error('transaction failed');
        this.onerror?.();
      } else {
        this.oncomplete?.();
      }
    });
  }

  objectStore(name: string): FakeObjectStore {
    const records = this.stores.get(name);
    if (!records) throw new Error(`missing ${name}`);
    return new FakeObjectStore(records, this.failReads);
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  onversionchange: (() => void) | null = null;
  closed = false;

  constructor(
    readonly stores = new Map<string, Map<string, unknown>>(),
    private readonly controller: FakeIndexedDb,
  ) {}

  createObjectStore(name: string): void {
    this.stores.set(name, new Map());
  }

  transaction(_names: string[], _mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(
      this.stores,
      this.controller.transactionMode,
      () => this.controller.failReads,
    );
  }

  close(): void {
    this.closed = true;
  }

  changeVersion(): void {
    this.onversionchange?.();
  }
}

class FakeIndexedDb {
  openMode: OpenMode = 'success';
  transactionMode: TransactionMode = 'success';
  failReads = false;
  readonly database = new FakeDatabase(undefined, this);

  open(_name: string, _version: number): FakeOpenRequest {
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      if (this.openMode === 'version-error') {
        request.fail(new DOMException('newer database', 'VersionError'));
        return;
      }
      if (this.openMode === 'error') {
        request.fail(new Error('open failed'));
        return;
      }
      if (this.openMode === 'blocked') {
        request.onblocked?.({ target: request } as unknown as Event);
        return;
      }
      request.result = this.database;
      request.onupgradeneeded?.({ target: request } as unknown as Event);
      request.succeed(this.database);
    });
    return request;
  }
}

const originalIndexedDb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;

afterEach(() => {
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = originalIndexedDb;
});

function install(fake: FakeIndexedDb): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = fake as unknown as IDBFactory;
}

function file(id = 'session', byte = 0x41): PersistedSessionsFile {
  return {
    version: 2,
    activeSessionId: id,
    mruSessionIds: [id],
    sessions: [
      {
        ...createSessionRecord(id, 'COM-runtime', config, {
          frames: [
            {
              id: `frame-${id}`,
              direction: 'RX',
              timestamp: 1,
              data: new Uint8Array([byte]),
            },
          ],
        }),
      },
    ],
  };
}

test('IndexedDB session database opens, upgrades, preserves frames on metadata saves, and closes cleanly', async () => {
  const fake = new FakeIndexedDb();
  install(fake);
  const database = new IndexedDbSessionStateDatabase();

  assert.deepEqual(await database.load(), { kind: 'empty' });
  await database.save(file(), true);
  assert.deepEqual(await database.load(), { kind: 'current', file: file() });

  const metadataOnly = file('session', 0x42);
  metadataOnly.sessions[0].sendDraft = 'metadata changed';
  await database.save(metadataOnly, false);
  const loaded = await database.load();
  assert.equal(loaded.kind, 'current');
  if (loaded.kind === 'current') {
    assert.equal(loaded.file.sessions[0].sendDraft, 'metadata changed');
    assert.deepEqual(Array.from(loaded.file.sessions[0].frames[0].data), [0x41]);
  }

  fake.database.changeVersion();
  assert.equal(fake.database.closed, true);
  assert.equal((await database.load()).kind, 'current');
  database.close();
});

test('IndexedDB session database rejects future saves and reports future and transport failure states', async () => {
  const fake = new FakeIndexedDb();
  install(fake);
  const database = new IndexedDbSessionStateDatabase();
  await assert.rejects(database.save({ ...file(), version: 3 }, true), /future session schema/);

  fake.openMode = 'version-error';
  assert.deepEqual(await database.load(), {
    kind: 'future',
    storedVersion: SESSION_STATE_DATABASE_VERSION + 1,
  });

  const failing = new FakeIndexedDb();
  failing.openMode = 'error';
  install(failing);
  await assert.rejects(new IndexedDbSessionStateDatabase().load(), /open failed/);
  failing.openMode = 'blocked';
  await assert.rejects(new IndexedDbSessionStateDatabase().load(), /upgrade is blocked/);
});

test('IndexedDB session database propagates request and transaction errors and detects future manifests', async () => {
  const fake = new FakeIndexedDb();
  install(fake);
  const database = new IndexedDbSessionStateDatabase();
  await database.save(file(), true);

  fake.failReads = true;
  await assert.rejects(database.load(), /get failed|getAll failed/);
  fake.failReads = false;

  fake.transactionMode = 'abort';
  await assert.rejects(database.save(file(), true), /transaction aborted/);
  fake.transactionMode = 'error';
  await assert.rejects(database.save(file(), true), /transaction failed/);
  fake.transactionMode = 'success';

  const manifest = fake.database.stores.get('manifest')?.get('current') as {
    schemaVersion: number;
  };
  manifest.schemaVersion = 99;
  assert.deepEqual(await database.load(), { kind: 'future', storedVersion: 99 });
});
