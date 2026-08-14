import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  SESSION_STORAGE_KEY,
  createSessionRecord,
  serializeSessionSnapshots,
  type PersistedSessionsFile,
} from '../../src/lib/session-persistence.ts';
import { useSessionStore } from '../../src/stores/sessions.ts';
import type { PortConfig } from '../../src/types/index.ts';
import type { SessionStateDatabaseLoadResult } from '../../src/lib/session-state-database.ts';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from '../../src/lib/session-state-worker-protocol.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

interface StorageDouble {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface WorkerScenario {
  loads: Array<SessionStateDatabaseLoadResult | Error>;
  saves?: Array<Error | null>;
  delayFirstLoad?: boolean;
}

class ScenarioWorker {
  static readonly scenarios: WorkerScenario[] = [];
  static latest: ScenarioWorker | null = null;

  onmessage: ((event: MessageEvent<SessionStateWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: SessionStateWorkerRequest[] = [];
  terminated = false;
  private readonly scenario: WorkerScenario;
  private delayedLoad: Extract<SessionStateWorkerRequest, { kind: 'load' }> | null = null;
  private loadCount = 0;

  constructor(_url: URL, _options: WorkerOptions) {
    const scenario = ScenarioWorker.scenarios.shift();
    if (!scenario) throw new Error('missing worker scenario');
    this.scenario = scenario;
    ScenarioWorker.latest = this;
  }

  postMessage(request: SessionStateWorkerRequest): void {
    this.requests.push(request);
    if (request.kind === 'load') {
      if (this.scenario.delayFirstLoad && this.loadCount++ === 0) {
        this.delayedLoad = request;
        return;
      }
      this.respondLoad(request);
      return;
    }
    const result = this.scenario.saves?.shift() ?? null;
    queueMicrotask(() => {
      if (result instanceof Error) {
        this.onmessage?.({
          data: { id: request.id, ok: false, error: result.message },
        } as MessageEvent<SessionStateWorkerResponse>);
      } else {
        this.onmessage?.({
          data: { id: request.id, ok: true, result: null },
        } as MessageEvent<SessionStateWorkerResponse>);
      }
    });
  }

  releaseLoad(): void {
    const request = this.delayedLoad;
    assert.ok(request, 'test must have a delayed load to release');
    this.delayedLoad = null;
    this.respondLoad(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  private respondLoad(request: Extract<SessionStateWorkerRequest, { kind: 'load' }>): void {
    const result = this.scenario.loads.shift() ?? { kind: 'empty' };
    queueMicrotask(() => {
      if (result instanceof Error) {
        this.onerror?.({ message: result.message } as ErrorEvent);
      } else {
        this.onmessage?.({
          data: { id: request.id, ok: true, result },
        } as MessageEvent<SessionStateWorkerResponse>);
      }
    });
  }
}

const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
const originalIndexedDb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;

afterEach(() => {
  ScenarioWorker.scenarios.length = 0;
  ScenarioWorker.latest = null;
  (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = originalIndexedDb;
  (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
});

function installBrowserState(legacy?: string): Map<string, string> {
  const values = new Map<string, string>();
  if (legacy) values.set(SESSION_STORAGE_KEY, legacy);
  const storage: StorageDouble = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  (globalThis as { localStorage: StorageDouble }).localStorage = storage;
  (globalThis as { indexedDB: IDBFactory }).indexedDB = {} as IDBFactory;
  (globalThis as { Worker: typeof Worker }).Worker = ScenarioWorker as unknown as typeof Worker;
  return values;
}

function persisted(id: string): PersistedSessionsFile {
  return serializeSessionSnapshots([createSessionRecord(id, `COM-${id}`, config)], id);
}

function freshStore() {
  setActivePinia(createPinia());
  return useSessionStore();
}

test('worker persistence restores future/current data, merges mutations made while loading, and serializes worker saves', async () => {
  installBrowserState();
  ScenarioWorker.scenarios.push({ loads: [{ kind: 'future', storedVersion: 99 }] });
  const future = freshStore();
  await future.whenPersistenceReady();
  assert.equal(future.persistenceReadOnly, true);
  assert.equal(ScenarioWorker.latest?.terminated, true);
  future.createSession('COM-readonly', config);
  assert.equal(future.sessions.length, 0);
  await future.flushPersistedSessions();

  installBrowserState();
  ScenarioWorker.scenarios.push({
    loads: [{ kind: 'current', file: persisted('worker-session') }],
    saves: [new Error('first save fails'), null],
    delayFirstLoad: true,
  });
  const merged = freshStore();
  const local = merged.createSession('COM-created-before-load', config);
  merged.addFrame(local, { direction: 'RX', data: new Uint8Array([1]) });
  ScenarioWorker.latest?.releaseLoad();
  await merged.whenPersistenceReady();
  assert.deepEqual(merged.sessions.map((session) => session.portName).sort(), [
    'COM-created-before-load',
    'COM-worker-session',
  ]);

  await assert.rejects(merged.flushPersistedSessions(), /first save fails/);
  await merged.flushPersistedSessions();
  assert.equal(
    ScenarioWorker.latest?.requests.filter((request) => request.kind === 'save').length,
    2,
  );
});

test('worker persistence resumes each queued dirty class and keeps a legacy snapshot when migration readback fails', async () => {
  installBrowserState(JSON.stringify(persisted('legacy-failure')));
  ScenarioWorker.scenarios.push({
    loads: [{ kind: 'empty' }, { kind: 'current', file: persisted('different') }],
  });
  const failedMigration = freshStore();
  await failedMigration.whenPersistenceReady();
  assert.equal(failedMigration.sessions[0]?.id, 'legacy-failure');
  assert.ok(ScenarioWorker.latest?.terminated);

  installBrowserState();
  ScenarioWorker.scenarios.push({ loads: [{ kind: 'empty' }], delayFirstLoad: true });
  const pendingFrames = freshStore();
  const frameSession = pendingFrames.createSession('COM-pending-frames', config);
  pendingFrames.addFrame(frameSession, { direction: 'RX', data: new Uint8Array([1]) });
  ScenarioWorker.latest?.releaseLoad();
  await pendingFrames.whenPersistenceReady();

  installBrowserState();
  ScenarioWorker.scenarios.push({ loads: [{ kind: 'empty' }], delayFirstLoad: true });
  const pendingConfig = freshStore();
  const configSession = pendingConfig.createSession('COM-pending-config', config);
  pendingConfig.setSendDraft(configSession, 'queued config');
  const flushing = pendingConfig.flushPersistedSessions();
  ScenarioWorker.latest?.releaseLoad();
  await flushing;
  await pendingConfig.whenPersistenceReady();
});

test('worker persistence falls back to legacy snapshots after malformed and failed worker startup', async () => {
  const malformedStorage = installBrowserState('{ malformed');
  ScenarioWorker.scenarios.push({ loads: [{ kind: 'empty' }] });
  const malformed = freshStore();
  await malformed.whenPersistenceReady();
  assert.equal(malformed.persistenceReadOnly, false);
  assert.equal(malformedStorage.get(SESSION_STORAGE_KEY), '{ malformed');

  const legacy = JSON.stringify(persisted('legacy-worker-error'));
  installBrowserState(legacy);
  ScenarioWorker.scenarios.push({
    loads: [new Error('worker startup failed')],
    delayFirstLoad: true,
  });
  const fallback = freshStore();
  // Mutating before the worker rejects selects the merge path instead of
  // replacing the tabs the user created during startup.
  fallback.createSession('COM-live-before-error', config);
  ScenarioWorker.latest?.releaseLoad();
  await fallback.whenPersistenceReady();
  assert.deepEqual(fallback.sessions.map((session) => session.portName).sort(), [
    'COM-legacy-worker-error',
    'COM-live-before-error',
  ]);
});
