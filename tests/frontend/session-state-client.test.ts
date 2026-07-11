import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  WorkerSessionStateClient,
  migrateLegacySessionState,
  sessionStateFilesEqual,
  type SessionStatePersistenceClient,
  type SessionStateWorkerLike,
} from '../../src/lib/session-state-client.ts';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from '../../src/lib/session-state-worker-protocol.ts';
import type { PersistedSessionsFile } from '../../src/lib/session-persistence.ts';

const emptyFile: PersistedSessionsFile = {
  version: 2,
  activeSessionId: null,
  mruSessionIds: [],
  sessions: [],
};

class FakeWorker implements SessionStateWorkerLike {
  onmessage: ((event: MessageEvent<SessionStateWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: SessionStateWorkerRequest[] = [];
  terminated = false;

  postMessage(message: SessionStateWorkerRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: SessionStateWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<SessionStateWorkerResponse>);
  }
}

test('worker client correlates load/save responses and propagates worker errors', async () => {
  const worker = new FakeWorker();
  const client = new WorkerSessionStateClient(worker);

  const loading = client.load();
  assert.deepEqual(worker.requests[0], { id: 1, kind: 'load' });
  worker.respond({ id: 1, ok: true, result: { kind: 'current', file: emptyFile } });
  assert.deepEqual(await loading, { kind: 'current', file: emptyFile });

  const saving = client.save(emptyFile, false);
  assert.deepEqual(worker.requests[1], {
    id: 2,
    kind: 'save',
    file: emptyFile,
    includeFrames: false,
  });
  worker.respond({ id: 2, ok: false, error: 'quota exceeded' });
  await assert.rejects(saving, /quota exceeded/);

  client.dispose();
  assert.equal(worker.terminated, true);
});

test('legacy migration deletes localStorage only after an equal IndexedDB readback', async () => {
  let stored: PersistedSessionsFile | null = null;
  let removed = 0;
  const client: SessionStatePersistenceClient = {
    async save(file) {
      stored = file;
    },
    async load() {
      return stored ? { kind: 'current', file: stored } : { kind: 'empty' };
    },
    dispose() {},
  };

  assert.equal(await migrateLegacySessionState(emptyFile, client, () => removed++), true);
  assert.equal(removed, 1);

  const mismatch: SessionStatePersistenceClient = {
    async save() {},
    async load() {
      return { kind: 'current', file: { ...emptyFile, activeSessionId: 'different' } };
    },
    dispose() {},
  };
  assert.equal(await migrateLegacySessionState(emptyFile, mismatch, () => removed++), false);
  assert.equal(removed, 1);
});

test('session state readback comparison is independent of object key order', () => {
  const reordered = {
    sessions: [],
    mruSessionIds: [],
    activeSessionId: null,
    version: 2,
  } as PersistedSessionsFile;
  assert.equal(sessionStateFilesEqual(emptyFile, reordered), true);
});
