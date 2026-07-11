import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import type { PersistedSessionsFile } from '../../src/lib/session-persistence.ts';
import type { SessionStateDatabaseLoadResult } from '../../src/lib/session-state-database.ts';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from '../../src/lib/session-state-worker-protocol.ts';

const databaseControl = vi.hoisted(() => ({
  loads: [] as Array<SessionStateDatabaseLoadResult | Error>,
  saves: [] as Array<Error | null>,
  saved: [] as Array<{ file: PersistedSessionsFile; includeFrames: boolean }>,
}));

vi.mock('../../src/lib/session-state-database.ts', () => ({
  IndexedDbSessionStateDatabase: class {
    async load(): Promise<SessionStateDatabaseLoadResult> {
      const next = databaseControl.loads.shift() ?? { kind: 'empty' };
      if (next instanceof Error) throw next;
      return next;
    }

    async save(file: PersistedSessionsFile, includeFrames: boolean): Promise<void> {
      databaseControl.saved.push({ file, includeFrames });
      const next = databaseControl.saves.shift() ?? null;
      if (next) throw next;
    }
  },
}));

interface WorkerScopeDouble {
  onmessage: ((event: MessageEvent<SessionStateWorkerRequest>) => void) | null;
  postMessage(message: SessionStateWorkerResponse): void;
}

const originalSelf = (globalThis as { self?: unknown }).self;

afterEach(() => {
  databaseControl.loads.length = 0;
  databaseControl.saves.length = 0;
  databaseControl.saved.length = 0;
  (globalThis as { self?: unknown }).self = originalSelf;
});

async function settleWorker(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

test('session state worker serializes successful load/save work and reports failures by request id', async () => {
  const messages: SessionStateWorkerResponse[] = [];
  const scope: WorkerScopeDouble = {
    onmessage: null,
    postMessage: (message) => messages.push(message),
  };
  (globalThis as { self: WorkerScopeDouble }).self = scope;
  databaseControl.loads.push({ kind: 'empty' }, new Error('database failed'));
  databaseControl.saves.push(null, new Error('write failed'));

  await import('../../src/workers/session-state.worker.ts?session-state-worker-test');
  assert.ok(scope.onmessage);

  const file: PersistedSessionsFile = {
    version: 2,
    activeSessionId: null,
    mruSessionIds: [],
    sessions: [],
  };
  scope.onmessage({ data: { id: 1, kind: 'load' } } as MessageEvent<SessionStateWorkerRequest>);
  scope.onmessage({
    data: { id: 2, kind: 'save', file, includeFrames: true },
  } as MessageEvent<SessionStateWorkerRequest>);
  scope.onmessage({ data: { id: 3, kind: 'load' } } as MessageEvent<SessionStateWorkerRequest>);
  scope.onmessage({
    data: { id: 4, kind: 'save', file, includeFrames: false },
  } as MessageEvent<SessionStateWorkerRequest>);
  await settleWorker();

  assert.deepEqual(messages, [
    { id: 1, ok: true, result: { kind: 'empty' } },
    { id: 2, ok: true, result: null },
    { id: 3, ok: false, error: 'database failed' },
    { id: 4, ok: false, error: 'write failed' },
  ]);
  assert.deepEqual(databaseControl.saved, [
    { file, includeFrames: true },
    { file, includeFrames: false },
  ]);
});
