import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import {
  WorkerSessionStateClient,
  createWorkerSessionStateClient,
  migrateLegacySessionState,
  sessionStateFilesEqual,
  type SessionStatePersistenceClient,
  type SessionStateWorkerLike,
} from '../../src/lib/session-state-client.ts';
import type { PersistedSessionsFile } from '../../src/lib/session-persistence.ts';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from '../../src/lib/session-state-worker-protocol.ts';

const file: PersistedSessionsFile = {
  version: 2,
  activeSessionId: null,
  mruSessionIds: [],
  sessions: [],
};

class WorkerDouble implements SessionStateWorkerLike {
  onmessage: ((event: MessageEvent<SessionStateWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: SessionStateWorkerRequest[] = [];
  terminated = 0;

  postMessage(message: SessionStateWorkerRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  respond(response: SessionStateWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<SessionStateWorkerResponse>);
  }

  fail(message = ''): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
const originalIndexedDb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;

afterEach(() => {
  (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = originalIndexedDb;
});

test('worker persistence client rejects no-result loads, worker errors, pending work, and post-disposal calls', async () => {
  const worker = new WorkerDouble();
  const client = new WorkerSessionStateClient(worker);

  const noResult = client.load();
  worker.respond({ id: 1, ok: true, result: null });
  await assert.rejects(noResult, /no load result/);

  const first = client.save(file, true);
  const second = client.load();
  worker.fail();
  await assert.rejects(first, /worker failed/);
  await assert.rejects(second, /worker failed/);
  worker.respond({ id: 999, ok: false, error: 'ignored' });

  client.dispose();
  client.dispose();
  assert.equal(worker.terminated, 1);
  await assert.rejects(client.load(), /disposed/);
});

test('worker factory uses the module worker when browser prerequisites exist and returns null on construction failure', () => {
  (globalThis as { Worker?: typeof Worker }).Worker = undefined;
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
  assert.equal(createWorkerSessionStateClient(), null);

  class ThrowingWorker {
    constructor() {
      throw new Error('blocked');
    }
  }
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = {} as IDBFactory;
  (globalThis as { Worker: typeof Worker }).Worker = ThrowingWorker as unknown as typeof Worker;
  assert.equal(createWorkerSessionStateClient(), null);

  class ConstructedWorker extends WorkerDouble {
    static latest: ConstructedWorker | null = null;

    constructor(_url: URL, options: WorkerOptions) {
      super();
      assert.equal(options.type, 'module');
      assert.equal(options.name, 'bbcom-session-state');
      ConstructedWorker.latest = this;
    }
  }
  (globalThis as { Worker: typeof Worker }).Worker = ConstructedWorker as unknown as typeof Worker;
  const client = createWorkerSessionStateClient();
  assert.ok(client instanceof WorkerSessionStateClient);
  client.dispose();
  assert.equal(ConstructedWorker.latest?.terminated, 1);
});

test('legacy migration only deletes after current equal readback and preserves structural equality', async () => {
  const empty: SessionStatePersistenceClient = {
    async load() {
      return { kind: 'empty' };
    },
    async save() {},
    dispose() {},
  };
  let removed = 0;
  assert.equal(await migrateLegacySessionState(file, empty, () => removed++), false);
  assert.equal(removed, 0);

  const future: SessionStatePersistenceClient = {
    async load() {
      return { kind: 'future', storedVersion: 3 };
    },
    async save() {},
    dispose() {},
  };
  assert.equal(await migrateLegacySessionState(file, future, () => removed++), false);

  const throwing: SessionStatePersistenceClient = {
    async load() {
      throw new Error('read failed');
    },
    async save() {},
    dispose() {},
  };
  await assert.rejects(
    migrateLegacySessionState(file, throwing, () => removed++),
    /read failed/,
  );
  assert.equal(removed, 0);

  assert.equal(
    sessionStateFilesEqual(
      {
        ...file,
        sessions: [{ id: 's', values: [undefined, null, true] }],
      } as unknown as PersistedSessionsFile,
      {
        sessions: [{ values: [undefined, null, true], id: 's' }],
        mruSessionIds: [],
        activeSessionId: null,
        version: 2,
      } as unknown as PersistedSessionsFile,
    ),
    true,
  );
  assert.equal(sessionStateFilesEqual(file, { ...file, activeSessionId: 'different' }), false);
});
