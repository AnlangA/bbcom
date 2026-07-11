import {
  SESSION_STORAGE_VERSION,
  normalizePersistedMruSessionIds,
  type PersistedFrame,
  type PersistedSession,
  type PersistedSessionsFile,
} from './session-persistence';

export const SESSION_STATE_DATABASE_NAME = 'bbcom-session-state';
export const SESSION_STATE_DATABASE_VERSION = 2;

const MANIFEST_STORE = 'manifest';
const SESSION_STORE = 'sessions';
const FRAME_STORE = 'frames';
const MANIFEST_KEY = 'current';

type PersistedSessionMetadata = Omit<PersistedSession, 'frames'>;

export interface SessionStateManifestRecord {
  key: typeof MANIFEST_KEY;
  schemaVersion: number;
  activeSessionId: string | null;
  sessionIds: string[];
  mruSessionIds: string[];
  updatedAt: number;
}

export interface SessionStateMetadataRecord {
  id: string;
  metadata: PersistedSessionMetadata;
}

export interface SessionStateFramesRecord {
  sessionId: string;
  frames: PersistedFrame[];
}

export interface SessionStateRecords {
  manifest: SessionStateManifestRecord;
  sessions: SessionStateMetadataRecord[];
  frames: SessionStateFramesRecord[];
}

export type SessionStateDatabaseLoadResult =
  | { kind: 'empty' }
  | { kind: 'current'; file: PersistedSessionsFile }
  | { kind: 'future'; storedVersion: number };

export interface SessionStateDatabase {
  load(): Promise<SessionStateDatabaseLoadResult>;
  save(file: PersistedSessionsFile, includeFrames: boolean): Promise<void>;
  close(): void;
}

/** Split one logical snapshot into the three bounded IndexedDB stores. */
export function splitSessionStateRecords(
  file: PersistedSessionsFile,
  updatedAt = Date.now(),
): SessionStateRecords {
  const mruSessionIds = normalizePersistedMruSessionIds(
    file.sessions,
    file.activeSessionId,
    file.mruSessionIds,
  );
  const retainedFrameIds = new Set(mruSessionIds);
  return {
    manifest: {
      key: MANIFEST_KEY,
      schemaVersion: file.version,
      activeSessionId: file.activeSessionId,
      sessionIds: file.sessions.map((session) => session.id),
      mruSessionIds,
      updatedAt,
    },
    sessions: file.sessions.map((session) => {
      const { frames: _frames, ...metadata } = session;
      // The record intentionally stores all metadata but no frame payload.
      void _frames;
      return { id: session.id, metadata };
    }),
    frames: file.sessions
      .filter((session) => retainedFrameIds.has(session.id))
      .map((session) => ({ sessionId: session.id, frames: session.frames })),
  };
}

/** Reassemble records in the exact tab order stored in the manifest. */
export function joinSessionStateRecords(records: SessionStateRecords): PersistedSessionsFile {
  const metadataById = new Map(records.sessions.map((record) => [record.id, record.metadata]));
  const framesById = new Map(records.frames.map((record) => [record.sessionId, record.frames]));
  const retainedFrameIds = new Set(records.manifest.mruSessionIds);
  const sessions = records.manifest.sessionIds.flatMap((id) => {
    const metadata = metadataById.get(id);
    if (!metadata) return [];
    return [
      {
        ...metadata,
        frames: retainedFrameIds.has(id) ? (framesById.get(id) ?? []) : [],
      },
    ];
  });
  return {
    version: records.manifest.schemaVersion,
    activeSessionId: records.manifest.activeSessionId,
    mruSessionIds: normalizePersistedMruSessionIds(
      sessions,
      records.manifest.activeSessionId,
      records.manifest.mruSessionIds,
    ),
    sessions,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class IndexedDbSessionStateDatabase implements SessionStateDatabase {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private database: IDBDatabase | null = null;

  async load(): Promise<SessionStateDatabaseLoadResult> {
    let database: IDBDatabase;
    try {
      database = await this.open();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'VersionError') {
        return { kind: 'future', storedVersion: SESSION_STATE_DATABASE_VERSION + 1 };
      }
      throw error;
    }

    const transaction = database.transaction(
      [MANIFEST_STORE, SESSION_STORE, FRAME_STORE],
      'readonly',
    );
    const manifestRequest = transaction.objectStore(MANIFEST_STORE).get(MANIFEST_KEY) as IDBRequest<
      SessionStateManifestRecord | undefined
    >;
    const sessionsRequest = transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<
      SessionStateMetadataRecord[]
    >;
    const framesRequest = transaction.objectStore(FRAME_STORE).getAll() as IDBRequest<
      SessionStateFramesRecord[]
    >;
    const [manifest, sessions, frames] = await Promise.all([
      requestResult(manifestRequest),
      requestResult(sessionsRequest),
      requestResult(framesRequest),
      transactionDone(transaction),
    ]);
    if (!manifest) return { kind: 'empty' };
    if (manifest.schemaVersion > SESSION_STORAGE_VERSION) {
      return { kind: 'future', storedVersion: manifest.schemaVersion };
    }
    return {
      kind: 'current',
      file: joinSessionStateRecords({ manifest, sessions, frames }),
    };
  }

  async save(file: PersistedSessionsFile, includeFrames: boolean): Promise<void> {
    if (file.version > SESSION_STORAGE_VERSION) {
      throw new Error(`refusing to overwrite future session schema ${file.version}`);
    }
    const database = await this.open();
    const records = splitSessionStateRecords(file);
    const transaction = database.transaction(
      [MANIFEST_STORE, SESSION_STORE, FRAME_STORE],
      'readwrite',
    );
    const manifestStore = transaction.objectStore(MANIFEST_STORE);
    const sessionStore = transaction.objectStore(SESSION_STORE);
    const frameStore = transaction.objectStore(FRAME_STORE);

    manifestStore.put(records.manifest);
    sessionStore.clear();
    for (const session of records.sessions) sessionStore.put(session);
    if (includeFrames) {
      frameStore.clear();
      for (const frameRecord of records.frames) frameStore.put(frameRecord);
    }
    await transactionDone(transaction);
  }

  close(): void {
    this.database?.close();
    this.database = null;
    this.databasePromise = null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(SESSION_STATE_DATABASE_NAME, SESSION_STATE_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
          database.createObjectStore(MANIFEST_STORE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          database.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(FRAME_STORE)) {
          database.createObjectStore(FRAME_STORE, { keyPath: 'sessionId' });
        }
      };
      request.onsuccess = () => {
        this.database = request.result;
        this.database.onversionchange = () => this.close();
        resolve(this.database);
      };
      request.onerror = () => reject(request.error ?? new Error('failed to open session database'));
      request.onblocked = () => reject(new Error('session database upgrade is blocked'));
    });
    return this.databasePromise;
  }
}
