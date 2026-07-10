import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useSessionStore } from '../../src/stores/sessions.ts';
import { SESSION_STORAGE_KEY } from '../../src/lib/session-persistence.ts';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from '../../src/lib/session-state-worker-protocol.ts';
import type { PersistedSessionsFile } from '../../src/lib/session-persistence.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MigrationWorker {
  static latest: MigrationWorker | null = null;
  onmessage: ((event: MessageEvent<SessionStateWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: SessionStateWorkerRequest[] = [];
  stored: PersistedSessionsFile | null = null;

  constructor() {
    MigrationWorker.latest = this;
  }

  postMessage(request: SessionStateWorkerRequest): void {
    this.requests.push(request);
    queueMicrotask(() => {
      if (request.kind === 'save') {
        this.stored = request.file;
        this.respond({ id: request.id, ok: true, result: null });
      } else {
        this.respond({
          id: request.id,
          ok: true,
          result: this.stored ? { kind: 'current', file: this.stored } : { kind: 'empty' },
        });
      }
    });
  }

  terminate(): void {}

  private respond(response: SessionStateWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<SessionStateWorkerResponse>);
  }
}

test('session store migrates localStorage through Worker IndexedDB save + readback before deletion', async () => {
  const target = globalThis as unknown as {
    Worker?: typeof Worker;
    indexedDB?: IDBFactory;
    localStorage?: LocalStorageLike;
  };
  const previousWorker = target.Worker;
  const previousIndexedDb = target.indexedDB;
  const previousStorage = target.localStorage;
  const data = new Map<string, string>();
  const legacy = JSON.stringify({
    version: 1,
    activeSessionId: 'legacy',
    sessions: [
      {
        id: 'legacy',
        portName: 'COM7',
        portConfig: {
          baudRate: 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
          dtr: false,
          rts: false,
        },
        frames: [{ id: 'f1', direction: 'RX', timestamp: 1, dataHex: '41' }],
      },
    ],
  });
  data.set(SESSION_STORAGE_KEY, legacy);
  target.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  target.indexedDB = {} as IDBFactory;
  target.Worker = MigrationWorker as unknown as typeof Worker;

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();
    assert.equal(store.sessions.length, 0, 'worker restore is asynchronous');
    await store.whenPersistenceReady();

    assert.equal(store.sessions.length, 1);
    assert.equal(store.sessions[0].portName, 'COM7');
    assert.deepEqual(Array.from(store.sessions[0].frames[0].data), [0x41]);
    assert.equal(data.has(SESSION_STORAGE_KEY), false);
    assert.deepEqual(
      MigrationWorker.latest?.requests.map((request) => request.kind),
      ['load', 'save', 'load'],
    );
  } finally {
    target.Worker = previousWorker;
    target.indexedDB = previousIndexedDb;
    target.localStorage = previousStorage;
  }
});
