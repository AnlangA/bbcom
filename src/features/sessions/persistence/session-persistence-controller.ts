import {
  SESSION_STORAGE_FUTURE_BACKUP_KEY,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_VERSION,
  UnsupportedSessionStorageVersionError,
  hydrateSession,
  migratePersistedFile,
  sessionSnapshotsForLocalStorage,
  serializeSessionSnapshots,
  type PersistedSessionsFile,
} from '../../../lib/session-persistence';
import { SessionPersistenceScheduler } from '../../../lib/session-persistence-scheduler';
import {
  createWorkerSessionStateClient,
  migrateLegacySessionState,
  sessionStateFilesEqual,
  type SessionStatePersistenceClient,
} from '../../../lib/session-state-client';
import {
  isLocalStorageAvailable,
  loadString,
  removeString,
  saveJson,
  saveString,
} from '../../../lib/storage';
import { logger } from '../../../lib/logger';
import type { SerialSession } from '../../../types/session';

export type SessionPersistenceDirtyKind = 'config' | 'frames' | 'mru';

let legacyPersistenceEnabled = true;

/**
 * Permanently selects the workspace-owned persistence path for this renderer
 * process. It must be called before the Pinia session store is created.
 *
 * The old IndexedDB/localStorage repository then remains byte-for-byte
 * read-only for the one-time G24 backup and for downgrade compatibility.
 */
export function enterWorkspaceSessionPersistenceMode(): void {
  legacyPersistenceEnabled = false;
}

export interface SessionPersistenceHost {
  serialize(includeFrames: boolean): PersistedSessionsFile;
  replaceFromFile(file: PersistedSessionsFile): void;
  mergeFromFile(file: PersistedSessionsFile): void;
  setReadOnly(readOnly: boolean): void;
  /** Called only after the snapshot for this generation is physically durable. */
  onPersisted?(result: { includeFrames: boolean; dirtyGeneration: number }): void;
}

/**
 * Coordinates legacy localStorage, IndexedDB Worker persistence and debounce
 * scheduling without owning renderer state. The v2 wire format is unchanged.
 */
export function createSessionPersistenceController(host: SessionPersistenceHost) {
  const useLegacyPersistence = legacyPersistenceEnabled;
  let persistenceClient: SessionStatePersistenceClient | null = useLegacyPersistence
    ? createWorkerSessionStateClient()
    : null;
  let loaded = !useLegacyPersistence;
  let readOnly = false;
  let stateRevision = 0;
  let pendingConfigDirty = false;
  let pendingMruDirty = false;
  let pendingFramesDirty = false;
  let readyPromise: Promise<void> = Promise.resolve();
  let started = false;
  let workerSaveChain: Promise<void> = Promise.resolve();

  const scheduler = new SessionPersistenceScheduler(writePersistedSnapshot, {
    onError: (error) => logger.warn('session persistence flush failed', error),
  });

  function setReadOnly(value: boolean): void {
    readOnly = value;
    host.setReadOnly(value);
  }

  function canonicalizePersistedFile(file: PersistedSessionsFile): PersistedSessionsFile {
    const hydrated = file.sessions
      .map((raw) => hydrateSession(raw))
      .filter((session): session is SerialSession => session !== null);
    const activeSessionId =
      file.activeSessionId && hydrated.some((session) => session.id === file.activeSessionId)
        ? file.activeSessionId
        : (hydrated[0]?.id ?? null);
    return serializeSessionSnapshots(hydrated, activeSessionId, {
      mruSessionIds: file.mruSessionIds,
      includeFrames: true,
    });
  }

  function readLegacySnapshot(): { raw: string; file: PersistedSessionsFile } | null {
    const raw = loadString(SESSION_STORAGE_KEY);
    if (!raw) return null;
    try {
      return { raw, file: migratePersistedFile(JSON.parse(raw) as unknown) };
    } catch (error) {
      if (error instanceof UnsupportedSessionStorageVersionError) {
        saveString(SESSION_STORAGE_FUTURE_BACKUP_KEY, raw);
        setReadOnly(true);
      } else {
        logger.warn('legacy session snapshot is malformed', error);
      }
      return null;
    }
  }

  function resumePendingPersistence(): void {
    if (readOnly) return;
    if (pendingMruDirty) {
      pendingMruDirty = false;
      pendingFramesDirty = false;
      pendingConfigDirty = false;
      scheduler.markConfigDirty(true);
      return;
    }
    if (pendingFramesDirty) {
      pendingFramesDirty = false;
      pendingConfigDirty = false;
      scheduler.markFramesDirty();
      return;
    }
    if (pendingConfigDirty) {
      pendingConfigDirty = false;
      scheduler.markConfigDirty();
    }
  }

  async function initializeWorkerPersistence(
    legacy: { raw: string; file: PersistedSessionsFile } | null,
    initialRevision: number,
  ): Promise<void> {
    const client = persistenceClient;
    if (!client) return;
    try {
      const result = await client.load();
      if (result.kind === 'future') {
        setReadOnly(true);
        scheduler.dispose();
        client.dispose();
        if (stateRevision === initialRevision) {
          host.replaceFromFile({
            version: SESSION_STORAGE_VERSION,
            activeSessionId: null,
            mruSessionIds: [],
            sessions: [],
          });
        }
        return;
      }

      if (result.kind === 'current') {
        const migrated = migratePersistedFile(result.file);
        const saved = canonicalizePersistedFile(migrated);
        if (stateRevision === initialRevision) host.replaceFromFile(saved);
        else host.mergeFromFile(saved);
        if (legacy && sessionStateFilesEqual(legacy.file, saved)) {
          removeString(SESSION_STORAGE_KEY);
        }
        if (!sessionStateFilesEqual(result.file, saved)) pendingFramesDirty = true;
        return;
      }

      if (legacy) {
        const migrated = await migrateLegacySessionState(legacy.file, client, () => {
          removeString(SESSION_STORAGE_KEY);
        });
        if (!migrated) throw new Error('IndexedDB migration readback did not match');
        if (stateRevision === initialRevision) host.replaceFromFile(legacy.file);
        else host.mergeFromFile(legacy.file);
      }
    } catch (error) {
      logger.warn('IndexedDB session persistence unavailable; using localStorage fallback', error);
      client.dispose();
      persistenceClient = null;
      if (legacy && stateRevision === initialRevision) host.replaceFromFile(legacy.file);
      else if (legacy) host.mergeFromFile(legacy.file);
    } finally {
      loaded = true;
      resumePendingPersistence();
    }
  }

  function loadPersistedSessions(): Promise<void> {
    const legacy = readLegacySnapshot();
    if (readOnly) {
      loaded = true;
      return Promise.resolve();
    }
    if (!persistenceClient) {
      if (legacy) host.replaceFromFile(legacy.file);
      loaded = true;
      return Promise.resolve();
    }
    const initialRevision = stateRevision;
    return initializeWorkerPersistence(legacy, initialRevision);
  }

  function writePersistedSnapshot(includeFrames: boolean): Promise<void> {
    if (!loaded || readOnly) return Promise.resolve();
    const dirtyGeneration = stateRevision;
    if (!persistenceClient) {
      if (isLocalStorageAvailable()) {
        saveJson(SESSION_STORAGE_KEY, sessionSnapshotsForLocalStorage(host.serialize(true)));
        host.onPersisted?.({ includeFrames: true, dirtyGeneration });
      }
      return Promise.resolve();
    }
    const snapshot = host.serialize(includeFrames);
    const write = workerSaveChain
      .catch(() => undefined)
      .then(() => {
        if (!persistenceClient || readOnly) return;
        return persistenceClient.save(snapshot, includeFrames).then(() => {
          host.onPersisted?.({ includeFrames, dirtyGeneration });
        });
      });
    workerSaveChain = write;
    return write;
  }

  function start(): Promise<void> {
    if (!started) {
      started = true;
      readyPromise = useLegacyPersistence ? loadPersistedSessions() : Promise.resolve();
    }
    return readyPromise;
  }

  function schedulePersist(kind: SessionPersistenceDirtyKind = 'config'): number {
    stateRevision += 1;
    const dirtyGeneration = stateRevision;
    if (!useLegacyPersistence) return dirtyGeneration;
    if (readOnly) return dirtyGeneration;
    if (!loaded) {
      if (kind === 'frames') pendingFramesDirty = true;
      else if (kind === 'mru') pendingMruDirty = true;
      else pendingConfigDirty = true;
      return dirtyGeneration;
    }
    if (!persistenceClient && !isLocalStorageAvailable()) return dirtyGeneration;
    if (kind === 'frames') scheduler.markFramesDirty();
    else if (kind === 'mru') scheduler.markConfigDirty(true);
    else scheduler.markConfigDirty();
    return dirtyGeneration;
  }

  async function flushPersistedSessions(): Promise<void> {
    if (!useLegacyPersistence) return;
    if (readOnly) return;
    if (!loaded) {
      pendingConfigDirty = true;
      pendingFramesDirty = true;
      await readyPromise;
    }
    if (readOnly) return;
    await scheduler.flushNow();
  }

  function flushFinalPersistence(): Promise<'completed' | 'timeout'> {
    if (!useLegacyPersistence) return Promise.resolve('completed');
    return scheduler.flushFinal();
  }

  return {
    start,
    schedulePersist,
    flushPersistedSessions,
    flushFinalPersistence,
    whenPersistenceReady: () => readyPromise,
  };
}
