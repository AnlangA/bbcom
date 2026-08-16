import { useSessionCatalog, useSessionDocument } from '../features/sessions/session-ports';
import { useAppStore } from '../stores/app';
import {
  invokeAbortAutoLog,
  invokeAppendAutoLogBatch,
  invokeBeginAutoLog,
  invokeFinishAutoLog,
  requestSaveTarget,
  revokeFileGrant,
  type AutoLogAppendStats,
  type AutoLogFormat,
  type ExportFramePayload,
  type SaveTargetGrant,
} from '../features/native';
import { bytesToBase64 } from '../lib/base64';
import { logger } from '../lib/logger';
import type { DataFrame, DisplayMode, SerialSession } from '../types';

export const AUTO_LOG_DEBOUNCE_MS = 100;
export const AUTO_LOG_IMMEDIATE_FLUSH_BYTES = 64 * 1024;
export const AUTO_LOG_MAX_QUEUED_BYTES = 1024 * 1024;
export const AUTO_LOG_MAX_QUEUED_ENTRIES = 1024;
export const AUTO_LOG_MAX_BATCH_BYTES = 256 * 1024;
export const AUTO_LOG_MAX_BATCH_FRAMES = 256;
export const AUTO_LOG_APPEND_TIMEOUT_MS = 15_000;
export const AUTO_LOG_DRAIN_TIMEOUT_MS = 2_000;
export const AUTO_LOG_TERMINAL_TIMEOUT_MS = 5_000;
/** Main-window notification emitted when capture must stop to avoid data loss. */
export const AUTO_LOG_FAILURE_EVENT = 'bbcom:auto-log-failure';

export type AutoLogFailureReason =
  'begin-failure' | 'overflow' | 'append-failure' | 'drain-timeout';

export type AutoLogShutdownFailureStage = 'append' | 'drain' | 'terminal';

/**
 * A durable auto-log could not be closed cleanly during the application exit
 * handshake. The stage is intentionally renderer-owned: the native `finish`
 * command writes the footer, flushes the writer and calls `sync_all` as one
 * operation, so any rejection there is a terminal failure.
 */
export class AutoLogShutdownError extends Error {
  readonly stage: AutoLogShutdownFailureStage;

  constructor(stage: AutoLogShutdownFailureStage, cause: unknown) {
    super(`auto-log shutdown ${stage} failed`, { cause });
    this.name = 'AutoLogShutdownError';
    this.stage = stage;
  }
}

interface AutoLogQueueEntry {
  frame: DataFrame;
  rawBytes: number;
}

export interface AutoLogSessionClient {
  begin(token: string, format: AutoLogFormat): Promise<{ logId: string }>;
  append(logId: string, frames: ExportFramePayload[]): Promise<AutoLogAppendStats>;
  finish(logId: string): Promise<void>;
  abort(logId: string): Promise<void>;
}

interface SessionStore {
  readonly sessions: readonly SerialSession[];
  setAutoLogTarget(sessionId: string, displayName: string | null): void;
}
type RevokeTarget = (token: string) => Promise<void>;
type ShutdownMode = 'none' | 'graceful' | 'abort';

interface SessionAutoLogState {
  sessionId: string;
  generation: number;
  logId: string;
  displayName: string;
  sessionStore: SessionStore;
  client: AutoLogSessionClient;
  appendTimeoutMs: number;
  drainTimeoutMs: number;
  terminalTimeoutMs: number;
  debounceMs: number;
  queue: AutoLogQueueEntry[];
  outstandingBytes: number;
  outstandingEntries: number;
  accepting: boolean;
  shutdownMode: ShutdownMode;
  storeCleared: boolean;
  warningLogged: boolean;
  worker: Promise<void> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  terminalPromise: Promise<void> | null;
  cancelAppendWait: (() => void) | null;
  shutdownFailure: AutoLogShutdownError | null;
}

const DEFAULT_SESSION_CLIENT: AutoLogSessionClient = {
  begin: invokeBeginAutoLog,
  append: invokeAppendAutoLogBatch,
  finish: invokeFinishAutoLog,
  abort: invokeAbortAutoLog,
};

// Runtime capture and toolbar actions use separate composable instances. A
// backend log session remains bound to the client that opened it.
const generations = new Map<string, number>();
const sessionStates = new Map<string, SessionAutoLogState>();

export interface UseAutoLogDeps {
  sessionClient?: AutoLogSessionClient;
  requestTarget?: (sessionId: string) => Promise<SaveTargetGrant | null>;
  revokeTarget?: RevokeTarget;
  debounceMs?: number;
  appendTimeoutMs?: number;
  drainTimeoutMs?: number;
  terminalTimeoutMs?: number;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
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

async function settleAppendWithin<T>(
  state: SessionAutoLogState,
  operation: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observed = operation.then(
    (value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  const stopped = new Promise<{ kind: 'timeout' }>((resolve) => {
    state.cancelAppendWait = () => resolve({ kind: 'timeout' });
    timer = setTimeout(state.cancelAppendWait, state.appendTimeoutMs);
  });
  const result = await Promise.race([observed, stopped]);
  if (timer) clearTimeout(timer);
  state.cancelAppendWait = null;
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

export function autoLogFormatForDisplayMode(displayMode: DisplayMode): AutoLogFormat {
  return displayMode === 'HEX' || displayMode === 'HEXASCII' ? 'hex' : 'text';
}

async function revokeUnusedGrant(
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
    logger.warn('unused auto-log grant revoke failed for', sessionId);
  }
}

function clearStoreTarget(state: SessionAutoLogState): void {
  if (state.storeCleared) return;
  state.storeCleared = true;
  if (hasSession(state.sessionStore, state.sessionId)) {
    state.sessionStore.setAutoLogTarget(state.sessionId, null);
  }
}

function cancelDebounce(state: SessionAutoLogState): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
}

function dropQueuedEntries(state: SessionAutoLogState): void {
  for (const entry of state.queue) {
    state.outstandingBytes -= entry.rawBytes;
    state.outstandingEntries -= 1;
  }
  state.queue = [];
}

function markAborted(
  state: SessionAutoLogState,
  reason: Exclude<AutoLogFailureReason, 'begin-failure'>,
  details?: Record<string, number>,
): void {
  state.accepting = false;
  state.shutdownMode = 'abort';
  cancelDebounce(state);
  clearStoreTarget(state);
  dropQueuedEntries(state);
  if (!state.warningLogged) {
    state.warningLogged = true;
    logger.warn(`auto-log ${reason}; logging disabled for`, state.sessionId, details);
    notifyAutoLogFailure(state.sessionId, reason);
  }
}

function recordShutdownFailure(
  state: SessionAutoLogState,
  stage: AutoLogShutdownFailureStage,
  cause: unknown,
): void {
  state.shutdownFailure ??= new AutoLogShutdownError(stage, cause);
}

function notifyAutoLogFailure(sessionId: string, reason: AutoLogFailureReason): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(AUTO_LOG_FAILURE_EVENT, {
      detail: { sessionId, reason },
    }),
  );
}

function toPayload(frame: DataFrame): ExportFramePayload {
  // Same dual-channel wire shape as the export wrapper: the legacy `data`
  // number array stays empty and bytes cross IPC base64-encoded (~4/3 wire
  // expansion instead of ~4x per byte).
  return {
    id: frame.id,
    direction: frame.direction,
    timestamp: frame.timestamp,
    data: [],
    dataB64: bytesToBase64(frame.data),
  };
}

function takeNextBatch(state: SessionAutoLogState): AutoLogQueueEntry[] {
  let count = 0;
  let rawBytes = 0;
  while (count < state.queue.length && count < AUTO_LOG_MAX_BATCH_FRAMES) {
    const next = state.queue[count];
    if (count > 0 && rawBytes + next.rawBytes > AUTO_LOG_MAX_BATCH_BYTES) break;
    rawBytes += next.rawBytes;
    count += 1;
  }
  return state.queue.splice(0, count);
}

async function terminalOnce(state: SessionAutoLogState): Promise<void> {
  if (!state.terminalPromise) {
    const operation = Promise.resolve().then(() =>
      state.shutdownMode === 'abort'
        ? state.client.abort(state.logId)
        : state.client.finish(state.logId),
    );
    state.terminalPromise = settleWithin(operation, state.terminalTimeoutMs)
      .catch((error: unknown) => {
        recordShutdownFailure(state, 'terminal', error);
        logger.warn('auto-log backend session cleanup failed for', state.sessionId);
      })
      .finally(() => {
        if (sessionStates.get(state.sessionId) === state) {
          sessionStates.delete(state.sessionId);
        }
      });
  }
  await state.terminalPromise;
}

async function drainState(state: SessionAutoLogState): Promise<void> {
  try {
    while (state.queue.length > 0 && state.shutdownMode !== 'abort') {
      const batch = takeNextBatch(state);
      const batchRawBytes = batch.reduce((total, entry) => total + entry.rawBytes, 0);
      let failed = false;
      try {
        await settleAppendWithin(
          state,
          Promise.resolve().then(() =>
            state.client.append(
              state.logId,
              batch.map((entry) => toPayload(entry.frame)),
            ),
          ),
        );
      } catch (error) {
        failed = true;
        recordShutdownFailure(state, 'append', error);
        markAborted(state, 'append-failure');
      } finally {
        state.outstandingBytes -= batchRawBytes;
        state.outstandingEntries -= batch.length;
      }
      if (failed) break;
    }

    if (state.shutdownMode !== 'none') await terminalOnce(state);
  } finally {
    state.worker = null;
    if (state.shutdownMode === 'none' && state.queue.length > 0) armDebounce(state);
  }
}

function ensureWorker(state: SessionAutoLogState): Promise<void> {
  cancelDebounce(state);
  if (state.worker) return state.worker;
  state.worker = Promise.resolve().then(() => drainState(state));
  return state.worker;
}

function armDebounce(state: SessionAutoLogState): void {
  if (state.debounceTimer || state.worker || !state.accepting) return;
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void ensureWorker(state);
  }, state.debounceMs);
}

async function shutdownState(
  state: SessionAutoLogState,
  mode: Exclude<ShutdownMode, 'none'>,
  strict = false,
): Promise<void> {
  state.accepting = false;
  cancelDebounce(state);
  if (mode === 'abort') {
    state.shutdownMode = 'abort';
    dropQueuedEntries(state);
  } else if (state.shutdownMode === 'none') {
    state.shutdownMode = 'graceful';
  }
  clearStoreTarget(state);

  const drain = ensureWorker(state);
  try {
    await settleWithin(drain, state.drainTimeoutMs);
  } catch (error) {
    recordShutdownFailure(state, 'drain', error);
    state.cancelAppendWait?.();
    markAborted(state, 'drain-timeout');
    if (sessionStates.get(state.sessionId) === state) sessionStates.delete(state.sessionId);
    // The append operation remains observed by drainState. Start abort without
    // extending the public two-second shutdown deadline.
    void terminalOnce(state);
  }

  if (strict && state.shutdownFailure) throw state.shutdownFailure;
}

function createState(
  sessionId: string,
  generation: number,
  logId: string,
  displayName: string,
  sessionStore: SessionStore,
  client: AutoLogSessionClient,
  debounceMs: number,
  appendTimeoutMs: number,
  drainTimeoutMs: number,
  terminalTimeoutMs: number,
): SessionAutoLogState {
  return {
    sessionId,
    generation,
    logId,
    displayName,
    sessionStore,
    client,
    debounceMs,
    appendTimeoutMs,
    drainTimeoutMs,
    terminalTimeoutMs,
    queue: [],
    outstandingBytes: 0,
    outstandingEntries: 0,
    accepting: true,
    shutdownMode: 'none',
    storeCleared: false,
    warningLogged: false,
    worker: null,
    debounceTimer: null,
    terminalPromise: null,
    cancelAppendWait: null,
    shutdownFailure: null,
  };
}

export function useAutoLog(deps: UseAutoLogDeps = {}) {
  const catalog = useSessionCatalog();
  const sessionStore: SessionStore = {
    get sessions() {
      return catalog.sessions.value;
    },
    setAutoLogTarget(sessionId, displayName) {
      useSessionDocument(sessionId).setAutoLogTarget(sessionId, displayName);
    },
  };
  const appStore = useAppStore();
  const client = deps.sessionClient ?? DEFAULT_SESSION_CLIENT;
  const requestTarget =
    deps.requestTarget ??
    ((sessionId: string) => requestSaveTarget('auto-log', `bbcom-${sessionId}-${Date.now()}.txt`));
  const revokeTarget = deps.revokeTarget ?? revokeFileGrant;
  const debounceMs = normalizeTimeout(deps.debounceMs, AUTO_LOG_DEBOUNCE_MS);
  const appendTimeoutMs = normalizeTimeout(deps.appendTimeoutMs, AUTO_LOG_APPEND_TIMEOUT_MS);
  const drainTimeoutMs = normalizeTimeout(deps.drainTimeoutMs, AUTO_LOG_DRAIN_TIMEOUT_MS);
  const terminalTimeoutMs = normalizeTimeout(deps.terminalTimeoutMs, AUTO_LOG_TERMINAL_TIMEOUT_MS);

  async function enable(sessionId: string): Promise<string | null> {
    const generation = nextGeneration(sessionId);
    const format = autoLogFormatForDisplayMode(appStore.displayMode);
    let grant: SaveTargetGrant | null;
    try {
      grant = await requestTarget(sessionId);
    } catch {
      notifyAutoLogFailure(sessionId, 'begin-failure');
      return null;
    }
    if (!grant) return null;

    if (!isCurrentGeneration(sessionId, generation) || !hasSession(sessionStore, sessionId)) {
      await revokeUnusedGrant(sessionId, grant, revokeTarget, terminalTimeoutMs);
      return null;
    }

    const previous = sessionStates.get(sessionId);
    if (previous) await shutdownState(previous, 'graceful');
    if (!isCurrentGeneration(sessionId, generation) || !hasSession(sessionStore, sessionId)) {
      await revokeUnusedGrant(sessionId, grant, revokeTarget, terminalTimeoutMs);
      return null;
    }

    let logId: string;
    try {
      ({ logId } = await client.begin(grant.token, format));
    } catch {
      await revokeUnusedGrant(sessionId, grant, revokeTarget, terminalTimeoutMs);
      notifyAutoLogFailure(sessionId, 'begin-failure');
      return null;
    }
    if (!isCurrentGeneration(sessionId, generation) || !hasSession(sessionStore, sessionId)) {
      await settleWithin(client.abort(logId), terminalTimeoutMs).catch(() => undefined);
      return null;
    }

    const state = createState(
      sessionId,
      generation,
      logId,
      grant.displayName,
      sessionStore,
      client,
      debounceMs,
      appendTimeoutMs,
      drainTimeoutMs,
      terminalTimeoutMs,
    );
    sessionStates.set(sessionId, state);
    sessionStore.setAutoLogTarget(sessionId, grant.displayName);
    return grant.displayName;
  }

  async function disable(sessionId: string): Promise<void> {
    nextGeneration(sessionId);
    const state = sessionStates.get(sessionId);
    if (state) {
      await shutdownState(state, 'graceful');
    } else if (hasSession(sessionStore, sessionId)) {
      sessionStore.setAutoLogTarget(sessionId, null);
    }
  }

  /**
   * Strict exit-handshake variant of `disable`. Unlike the toolbar path, it
   * rejects when queued frames, the drain deadline, or native finish
   * (footer/flush/sync) fails, so the shutdown coordinator cannot report a
   * false `completed` participant.
   */
  async function prepareShutdown(sessionId: string): Promise<void> {
    nextGeneration(sessionId);
    const state = sessionStates.get(sessionId);
    if (state) {
      await shutdownState(state, 'graceful', true);
    } else if (hasSession(sessionStore, sessionId)) {
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

    const rawBytes = frame.data.byteLength;
    const exceedsLimit =
      rawBytes > AUTO_LOG_MAX_BATCH_BYTES ||
      state.outstandingBytes + rawBytes > AUTO_LOG_MAX_QUEUED_BYTES ||
      state.outstandingEntries + 1 > AUTO_LOG_MAX_QUEUED_ENTRIES;
    if (exceedsLimit) {
      markAborted(state, 'overflow', {
        outstandingBytes: state.outstandingBytes,
        outstandingEntries: state.outstandingEntries,
        attemptedBytes: rawBytes,
      });
      void ensureWorker(state);
      return;
    }

    state.queue.push({ frame, rawBytes });
    state.outstandingBytes += rawBytes;
    state.outstandingEntries += 1;
    if (state.outstandingBytes >= AUTO_LOG_IMMEDIATE_FLUSH_BYTES) {
      void ensureWorker(state);
    } else {
      armDebounce(state);
    }
  }

  return { enable, disable, prepareShutdown, appendFrame };
}
