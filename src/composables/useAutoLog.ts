import { useSessionStore } from '../stores/sessions';
import { useAppStore } from '../stores/app';
import {
  invokeAppendLog,
  requestSaveTarget,
  revokeFileGrant,
  type SaveTargetGrant,
} from '../lib/ipc';
import { formatFrameData, formatLogLine } from '../lib/format';
import { logger } from '../lib/logger';
import type { DataFrame } from '../types';

export const AUTO_LOG_MAX_QUEUED_BYTES = 1024 * 1024;
export const AUTO_LOG_MAX_QUEUED_ENTRIES = 1024;
export const AUTO_LOG_MAX_BATCH_BYTES = 256 * 1024;
export const AUTO_LOG_APPEND_TIMEOUT_MS = 15_000;
export const AUTO_LOG_REVOKE_TIMEOUT_MS = 5_000;

interface AutoLogQueueEntry {
  content: string;
  byteLength: number;
}

type SessionStore = ReturnType<typeof useSessionStore>;
type AppendLog = (token: string, content: string) => Promise<void>;
type RevokeTarget = (token: string) => Promise<void>;
type ShutdownMode = 'none' | 'graceful' | 'abort';

interface SessionAutoLogState {
  sessionId: string;
  generation: number;
  grant: SaveTargetGrant;
  sessionStore: SessionStore;
  appendLog: AppendLog;
  revokeTarget: RevokeTarget;
  appendTimeoutMs: number;
  revokeTimeoutMs: number;
  queue: AutoLogQueueEntry[];
  outstandingBytes: number;
  outstandingEntries: number;
  accepting: boolean;
  shutdownMode: ShutdownMode;
  storeCleared: boolean;
  warningLogged: boolean;
  worker: Promise<void> | null;
  revokePromise: Promise<void> | null;
}

// Coordination is module-level because the serial runtime and the toolbar use
// separate composable instances. A grant is permanently bound to the deps that
// created it; later append/disable calls must never substitute another
// instance's test doubles or IPC functions.
const generations = new Map<string, number>();
const sessionStates = new Map<string, SessionAutoLogState>();
const utf8Encoder = new TextEncoder();

/** Injectable sinks so queueing and grant lifecycle are unit-testable. */
export interface UseAutoLogDeps {
  appendLog?: AppendLog;
  requestTarget?: (sessionId: string) => Promise<SaveTargetGrant | null>;
  revokeTarget?: RevokeTarget;
  appendTimeoutMs?: number;
  revokeTimeoutMs?: number;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Convert rejection into a fulfilled tagged result before racing. If the
  // underlying IPC rejects after the timeout, this observer still consumes it
  // and prevents an unhandled rejection.
  const observed = operation.then(
    (value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const result = await Promise.race([observed, timeout]);
  if (timer) clearTimeout(timer);
  if (result.kind === 'timeout') throw new Error('operation timed out');
  if (result.kind === 'rejected') throw result.error;
  return result.value;
}

function nextGeneration(sessionId: string): number {
  const generation = (generations.get(sessionId) ?? 0) + 1;
  generations.set(sessionId, generation);
  return generation;
}

function isCurrentGeneration(sessionId: string, generation: number): boolean {
  return generations.get(sessionId) === generation;
}

function hasSession(store: SessionStore, sessionId: string): boolean {
  return store.sessions.some((session) => session.id === sessionId);
}

async function revokeGrant(
  sessionId: string,
  grant: SaveTargetGrant,
  revokeTarget: RevokeTarget,
  timeoutMs: number,
): Promise<void> {
  try {
    await settleWithin(
      Promise.resolve().then(() => revokeTarget(grant.token)),
      timeoutMs,
    );
  } catch {
    logger.warn('auto-log grant revoke failed for', sessionId);
  }
}

function clearStoreTarget(state: SessionAutoLogState): void {
  if (state.storeCleared) return;
  state.storeCleared = true;
  if (hasSession(state.sessionStore, state.sessionId)) {
    state.sessionStore.setAutoLogTarget(state.sessionId, null);
  }
}

function dropQueuedEntries(state: SessionAutoLogState): void {
  for (const entry of state.queue) {
    state.outstandingBytes -= entry.byteLength;
    state.outstandingEntries -= 1;
  }
  state.queue = [];
}

function markAborted(
  state: SessionAutoLogState,
  reason: 'overflow' | 'append-failure',
  overflowStats?: {
    outstandingBytes: number;
    outstandingEntries: number;
    attemptedBytes: number;
  },
): void {
  state.accepting = false;
  state.shutdownMode = 'abort';
  clearStoreTarget(state);
  dropQueuedEntries(state);
  if (!state.warningLogged) {
    state.warningLogged = true;
    if (reason === 'overflow') {
      logger.warn('auto-log queue limit exceeded; logging disabled for', state.sessionId, {
        outstandingBytes: overflowStats?.outstandingBytes ?? state.outstandingBytes,
        outstandingEntries: overflowStats?.outstandingEntries ?? state.outstandingEntries,
        attemptedBytes: overflowStats?.attemptedBytes ?? 0,
      });
    } else {
      logger.warn('auto-log append failed; logging disabled for', state.sessionId);
    }
  }
}

async function revokeStateOnce(state: SessionAutoLogState): Promise<void> {
  if (!state.revokePromise) {
    state.revokePromise = revokeGrant(
      state.sessionId,
      state.grant,
      state.revokeTarget,
      state.revokeTimeoutMs,
    ).finally(() => {
      if (sessionStates.get(state.sessionId) === state) {
        sessionStates.delete(state.sessionId);
      }
    });
  }
  await state.revokePromise;
}

function takeNextBatch(state: SessionAutoLogState): AutoLogQueueEntry[] {
  let count = 0;
  let byteLength = 0;
  while (count < state.queue.length) {
    const next = state.queue[count];
    if (count > 0 && byteLength + next.byteLength > AUTO_LOG_MAX_BATCH_BYTES) break;
    byteLength += next.byteLength;
    count += 1;
  }
  return state.queue.splice(0, count);
}

async function drainState(state: SessionAutoLogState): Promise<void> {
  try {
    while (state.queue.length > 0) {
      const batch = takeNextBatch(state);
      const batchBytes = batch.reduce((total, entry) => total + entry.byteLength, 0);
      const content = batch.map((entry) => entry.content).join('');
      let failed = false;
      try {
        await settleWithin(
          Promise.resolve().then(() => state.appendLog(state.grant.token, content)),
          state.appendTimeoutMs,
        );
      } catch {
        failed = true;
        markAborted(state, 'append-failure');
      } finally {
        state.outstandingBytes -= batchBytes;
        state.outstandingEntries -= batch.length;
      }
      if (failed) break;
    }

    if (state.shutdownMode !== 'none') await revokeStateOnce(state);
  } finally {
    state.worker = null;
  }
}

function ensureWorker(state: SessionAutoLogState): Promise<void> {
  if (state.worker) return state.worker;
  // Start on a microtask so synchronous frame bursts coalesce into bounded IPC
  // batches and so `state.worker` is installed before drainState can finish.
  state.worker = Promise.resolve().then(() => drainState(state));
  return state.worker;
}

async function shutdownState(
  state: SessionAutoLogState,
  mode: Exclude<ShutdownMode, 'none'>,
): Promise<void> {
  state.accepting = false;
  if (mode === 'abort') {
    state.shutdownMode = 'abort';
    dropQueuedEntries(state);
  } else if (state.shutdownMode === 'none') {
    state.shutdownMode = 'graceful';
  }
  clearStoreTarget(state);
  await ensureWorker(state);
}

function createState(
  sessionId: string,
  generation: number,
  grant: SaveTargetGrant,
  sessionStore: SessionStore,
  appendLog: AppendLog,
  revokeTarget: RevokeTarget,
  appendTimeoutMs: number,
  revokeTimeoutMs: number,
): SessionAutoLogState {
  return {
    sessionId,
    generation,
    grant,
    sessionStore,
    appendLog,
    revokeTarget,
    appendTimeoutMs,
    revokeTimeoutMs,
    queue: [],
    outstandingBytes: 0,
    outstandingEntries: 0,
    accepting: true,
    shutdownMode: 'none',
    storeCleared: false,
    warningLogged: false,
    worker: null,
    revokePromise: null,
  };
}

export function useAutoLog(deps: UseAutoLogDeps = {}) {
  const sessionStore = useSessionStore();
  const appStore = useAppStore();
  const doAppend = deps.appendLog ?? invokeAppendLog;
  const doRequestTarget =
    deps.requestTarget ??
    ((sessionId: string) => requestSaveTarget('auto-log', `bbcom-${sessionId}-${Date.now()}.txt`));
  const doRevoke = deps.revokeTarget ?? revokeFileGrant;
  const appendTimeoutMs = normalizeTimeout(deps.appendTimeoutMs, AUTO_LOG_APPEND_TIMEOUT_MS);
  const revokeTimeoutMs = normalizeTimeout(deps.revokeTimeoutMs, AUTO_LOG_REVOKE_TIMEOUT_MS);

  async function enable(sessionId: string): Promise<string | null> {
    const generation = nextGeneration(sessionId);
    const grant = await doRequestTarget(sessionId);
    if (!grant) return null;

    if (!isCurrentGeneration(sessionId, generation) || !hasSession(sessionStore, sessionId)) {
      await revokeGrant(sessionId, grant, doRevoke, revokeTimeoutMs);
      return null;
    }

    const previous = sessionStates.get(sessionId);
    if (previous) await shutdownState(previous, 'graceful');

    // A disable, removal, or newer enable may have won while the previous
    // queue drained. Never resurrect that stale grant.
    if (!isCurrentGeneration(sessionId, generation) || !hasSession(sessionStore, sessionId)) {
      await revokeGrant(sessionId, grant, doRevoke, revokeTimeoutMs);
      return null;
    }

    const state = createState(
      sessionId,
      generation,
      grant,
      sessionStore,
      doAppend,
      doRevoke,
      appendTimeoutMs,
      revokeTimeoutMs,
    );
    sessionStates.set(sessionId, state);
    sessionStore.setAutoLogTarget(sessionId, grant.displayPath);
    return grant.displayPath;
  }

  /** Stop accepting frames, drain all accepted entries, then revoke once. */
  async function disable(sessionId: string): Promise<void> {
    nextGeneration(sessionId);
    const state = sessionStates.get(sessionId);
    if (state) {
      await shutdownState(state, 'graceful');
    } else if (hasSession(sessionStore, sessionId)) {
      // Also clear stale persisted UI state when no in-memory grant exists.
      sessionStore.setAutoLogTarget(sessionId, null);
    }
  }

  function appendFrame(sessionId: string, frame: DataFrame): void {
    const state = sessionStates.get(sessionId);
    if (!state?.accepting) return;

    const session = state.sessionStore.sessions.find((item) => item.id === sessionId);
    if (!session?.autoLogEnabled) {
      void shutdownState(state, 'graceful');
      return;
    }

    const dataText = formatFrameData(frame.data, appStore.displayMode);
    const content = `${formatLogLine(frame.timestamp, frame.direction, dataText)}\n`;
    const byteLength = utf8Encoder.encode(content).byteLength;
    const exceedsLimit =
      byteLength > AUTO_LOG_MAX_BATCH_BYTES ||
      state.outstandingBytes + byteLength > AUTO_LOG_MAX_QUEUED_BYTES ||
      state.outstandingEntries + 1 > AUTO_LOG_MAX_QUEUED_ENTRIES;

    if (exceedsLimit) {
      markAborted(state, 'overflow', {
        outstandingBytes: state.outstandingBytes,
        outstandingEntries: state.outstandingEntries,
        attemptedBytes: byteLength,
      });
      void ensureWorker(state);
      return;
    }

    state.queue.push({ content, byteLength });
    state.outstandingBytes += byteLength;
    state.outstandingEntries += 1;
    void ensureWorker(state);
  }

  return { enable, disable, appendFrame };
}
