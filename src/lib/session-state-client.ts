import type { PersistedSessionsFile } from './session-persistence';
import type { SessionStateDatabaseLoadResult } from './session-state-database';
import type {
  SessionStateWorkerRequest,
  SessionStateWorkerResponse,
} from './session-state-worker-protocol';

export interface SessionStatePersistenceClient {
  load(): Promise<SessionStateDatabaseLoadResult>;
  save(file: PersistedSessionsFile, includeFrames: boolean): Promise<void>;
  dispose(): void;
}

export interface SessionStateWorkerLike {
  onmessage: ((event: MessageEvent<SessionStateWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SessionStateWorkerRequest): void;
  terminate(): void;
}

interface PendingRequest {
  resolve(value: SessionStateDatabaseLoadResult | null): void;
  reject(error: Error): void;
}

/** Promise-based adapter around the dedicated IndexedDB worker protocol. */
export class WorkerSessionStateClient implements SessionStatePersistenceClient {
  private readonly worker: SessionStateWorkerLike;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private disposed = false;

  constructor(worker: SessionStateWorkerLike) {
    this.worker = worker;
    worker.onmessage = (event) => this.handleResponse(event.data);
    worker.onerror = (event) => {
      this.rejectAll(new Error(event.message || 'session persistence worker failed'));
    };
  }

  async load(): Promise<SessionStateDatabaseLoadResult> {
    const result = await this.request({ kind: 'load' });
    if (!result) throw new Error('session persistence worker returned no load result');
    return result;
  }

  async save(file: PersistedSessionsFile, includeFrames: boolean): Promise<void> {
    await this.request({ kind: 'save', file, includeFrames });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.rejectAll(new Error('session persistence worker disposed'));
  }

  private request(
    request:
      | Omit<Extract<SessionStateWorkerRequest, { kind: 'load' }>, 'id'>
      | Omit<Extract<SessionStateWorkerRequest, { kind: 'save' }>, 'id'>,
  ): Promise<SessionStateDatabaseLoadResult | null> {
    if (this.disposed) return Promise.reject(new Error('session persistence worker disposed'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } as SessionStateWorkerRequest);
    });
  }

  private handleResponse(response: SessionStateWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createWorkerSessionStateClient(): SessionStatePersistenceClient | null {
  if (typeof globalThis.Worker === 'undefined' || typeof globalThis.indexedDB === 'undefined') {
    return null;
  }
  try {
    const worker = new Worker(new URL('../workers/session-state.worker.ts', import.meta.url), {
      type: 'module',
      name: 'bbcom-session-state',
    });
    return new WorkerSessionStateClient(worker);
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sessionStateFilesEqual(
  left: PersistedSessionsFile,
  right: PersistedSessionsFile,
): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * Commit a legacy localStorage snapshot to IndexedDB, read it back, and only
 * then authorize deletion of the legacy key.
 */
export async function migrateLegacySessionState(
  file: PersistedSessionsFile,
  client: SessionStatePersistenceClient,
  removeLegacy: () => void,
): Promise<boolean> {
  await client.save(file, true);
  const readback = await client.load();
  if (readback.kind !== 'current' || !sessionStateFilesEqual(file, readback.file)) return false;
  removeLegacy();
  return true;
}
