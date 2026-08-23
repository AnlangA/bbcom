import { computed, ref, watch, type Ref } from 'vue';
import { TriggerEngine, type Trigger, type TriggerFire } from '@/lib/trigger-engine';
import type { Macro, DataFrame } from '@/types';
import { useSessionCatalog, useSessionDocument } from '@/features/sessions/ports/session-ports';
import { useAppStore } from '@/features/settings/store/app-store';
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
} from '@/features/platform/native';
import { bytesToBase64 } from '@/lib/base64';
import { logger } from '@/lib/logger';

export const AUTO_LOG_DEBOUNCE_MS = 100;
export const AUTO_LOG_IMMEDIATE_FLUSH_BYTES = 64 * 1024;
export const AUTO_LOG_MAX_QUEUED_BYTES = 1024 * 1024;
export const AUTO_LOG_MAX_QUEUED_ENTRIES = 1024;
export const AUTO_LOG_MAX_BATCH_BYTES = 256 * 1024;
export const AUTO_LOG_MAX_BATCH_FRAMES = 256;
export const AUTO_LOG_APPEND_TIMEOUT_MS = 15_000;
export const AUTO_LOG_DRAIN_TIMEOUT_MS = 2_000;
export const AUTO_LOG_TERMINAL_TIMEOUT_MS = 5_000;
export const AUTO_LOG_FAILURE_EVENT = 'bbcom:auto-log-failure';

export type AutoLogFailureReason =
  'begin-failure' | 'overflow' | 'append-failure' | 'drain-timeout';

export type AutoLogShutdownFailureStage = 'append' | 'drain' | 'terminal';

export class AutoLogShutdownError extends Error {
  readonly stage: AutoLogShutdownFailureStage;

  constructor(stage: AutoLogShutdownFailureStage, cause: unknown) {
    super(`auto-log shutdown ${stage} failed`, { cause });
    this.name = 'AutoLogShutdownError';
    this.stage = stage;
  }
}

export interface AutoLogSessionClient {
  begin(token: string, format: AutoLogFormat): Promise<{ logId: string }>;
  append(logId: string, frames: ExportFramePayload[]): Promise<AutoLogAppendStats>;
  finish(logId: string): Promise<void>;
  abort(logId: string): Promise<void>;
}

export interface UseAutoLogDeps {
  sessionClient?: AutoLogSessionClient;
  requestTarget?: (sessionId: string) => Promise<SaveTargetGrant | null>;
  revokeTarget?: (token: string) => Promise<void>;
  debounceMs?: number;
  appendTimeoutMs?: number;
  drainTimeoutMs?: number;
  terminalTimeoutMs?: number;
}

export const MIN_DELAY_MS = 0;
export const MAX_DELAY_MS = 3_600_000;

export function clampDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.floor(value)));
}

export interface MacroRunResult {
  completed: number;
  failedAt: number;
  aborted: boolean;
}

export interface TriggersBridgeOptions {
  triggers: Ref<Trigger[]>;
  send: (data: string, isHex: boolean) => Promise<boolean>;
  onFire?: (fire: TriggerFire) => void;
}

export interface MacroRunnerBridgeOptions {
  send: (data: string, isHex: boolean) => Promise<boolean>;
  onStep?: (index: number, total: number) => void;
}

export interface AutoLogBridgeOptions extends UseAutoLogDeps {
  sessionStore?: SessionStore;
  displayMode?: () => import('@/types').DisplayMode;
}

interface SessionStore {
  readonly sessions: readonly import('@/types').SerialSession[];
  setAutoLogTarget(sessionId: string, displayName: string | null): void;
}

type RevokeTarget = (token: string) => Promise<void>;
type ShutdownMode = 'none' | 'graceful' | 'abort';

interface AutoLogQueueEntry {
  frame: DataFrame;
  rawBytes: number;
}

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

const generations = new Map<string, number>();
const sessionStates = new Map<string, SessionAutoLogState>();

/**
 * Bridges the TriggerEngine to a session's RX stream.
 */
export class TriggersBridge {
  private readonly engine: TriggerEngine;
  private readonly options: TriggersBridgeOptions;
  private readonly stopWatch: () => void;
  private sendTail: Promise<void> = Promise.resolve();
  private paused = false;

  readonly enabledCount = computed(
    () => this.options.triggers.value.filter((item) => item.enabled).length,
  );

  constructor(options: TriggersBridgeOptions) {
    this.options = options;
    this.engine = new TriggerEngine(options.triggers.value);
    this.stopWatch = watch(
      options.triggers,
      (next) => {
        this.engine.setTriggers(next);
      },
      { deep: true },
    );
  }

  feedBytes(bytes: Uint8Array): Promise<void> {
    if (this.options.triggers.value.length === 0) return Promise.resolve();
    const fires = this.engine.feed(bytes);
    if (this.paused) return Promise.resolve();
    for (const fire of fires) this.options.onFire?.(fire);
    if (fires.length === 0) return Promise.resolve();

    const operation = this.sendTail.then(async () => {
      for (const fire of fires) {
        if (this.paused) break;
        await this.options.send(fire.response, fire.responseIsHex);
      }
    });
    this.sendTail = operation.catch(() => undefined);
    return operation;
  }

  feedFrame(frame: DataFrame): Promise<void> {
    if (frame.direction !== 'RX') return Promise.resolve();
    return this.feedBytes(frame.data);
  }

  reset(): void {
    this.engine.reset();
  }

  async pause(signal?: AbortSignal): Promise<void> {
    this.paused = true;
    if (signal?.aborted) {
      this.paused = false;
      throw new Error('trigger pause cancelled');
    }
    let detachAbort: () => void = () => undefined;
    try {
      await Promise.race([
        this.sendTail,
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('trigger pause cancelled'));
          signal?.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => signal?.removeEventListener('abort', onAbort);
        }),
      ]);
    } catch (error) {
      this.paused = false;
      throw error;
    } finally {
      detachAbort();
    }
  }

  resume(): void {
    this.paused = false;
  }

  dispose(): void {
    this.stopWatch();
  }
}

/**
 * Sequentially sends a macro's steps through the session write path.
 */
export class MacroRunnerBridge {
  readonly running = ref(false);
  private readonly options: MacroRunnerBridgeOptions;
  private aborted = false;
  private paused = false;
  private sendInFlight = false;
  private readonly resumeWaiters = new Set<() => void>();
  private readonly pauseWaiters = new Set<() => void>();
  private pendingDelayResolver: (() => void) | null = null;
  private pendingDelayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MacroRunnerBridgeOptions) {
    this.options = options;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.paused = false;
    resolveWaiters(this.resumeWaiters);
    if (this.pendingDelayTimer !== null) {
      clearTimeout(this.pendingDelayTimer);
      this.pendingDelayTimer = null;
    }
    if (this.pendingDelayResolver !== null) {
      const resolve = this.pendingDelayResolver;
      this.pendingDelayResolver = null;
      resolve();
    }
  }

  async pause(signal?: AbortSignal): Promise<void> {
    this.paused = true;
    if (signal?.aborted) {
      this.paused = false;
      throw new Error('macro pause cancelled');
    }
    if (!this.sendInFlight) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.pauseWaiters.delete(onIdle);
        this.paused = false;
        reject(new Error('macro pause cancelled'));
      };
      const onIdle = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pauseWaiters.add(onIdle);
    });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    resolveWaiters(this.resumeWaiters);
  }

  async run(macro: Macro): Promise<MacroRunResult> {
    if (this.running.value) {
      return { completed: 0, failedAt: 0, aborted: true };
    }
    this.aborted = false;
    this.running.value = true;
    const steps = macro.steps;
    let i = 0;
    try {
      for (; i < steps.length; i += 1) {
        await this.waitWhilePaused();
        if (this.aborted) break;
        this.options.onStep?.(i, steps.length);
        const step = steps[i];
        this.sendInFlight = true;
        let ok: boolean;
        try {
          ok = await this.options.send(step.data, step.isHex);
        } finally {
          this.sendInFlight = false;
          resolveWaiters(this.pauseWaiters);
        }
        if (!ok) {
          return { completed: i, failedAt: i, aborted: false };
        }
        if (this.aborted) break;
        if (i < steps.length - 1) {
          await this.cancellableDelay(clampDelayMs(step.delayMs));
        }
      }
      return { completed: i, failedAt: steps.length, aborted: this.aborted };
    } finally {
      this.running.value = false;
    }
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused || this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => this.resumeWaiters.add(resolve));
  }

  private cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0 || this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingDelayResolver = resolve;
      this.pendingDelayTimer = setTimeout(() => {
        this.pendingDelayTimer = null;
        this.pendingDelayResolver = null;
        resolve();
      }, ms);
    });
  }
}

/**
 * Durable auto-log writer with bounded queues and strict shutdown semantics.
 */
export class AutoLogBridge {
  private readonly sessionStore: SessionStore;
  private readonly client: AutoLogSessionClient;
  private readonly requestTarget: (sessionId: string) => Promise<SaveTargetGrant | null>;
  private readonly revokeTarget: RevokeTarget;
  private readonly displayMode: () => import('@/types').DisplayMode;
  private readonly debounceMs: number;
  private readonly appendTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly terminalTimeoutMs: number;

  constructor(options: AutoLogBridgeOptions = {}) {
    const catalog = options.sessionStore ? null : useSessionCatalog();
    this.sessionStore =
      options.sessionStore ??
      ({
        get sessions() {
          return catalog!.sessions.value;
        },
        setAutoLogTarget(sessionId, displayName) {
          useSessionDocument(sessionId).setAutoLogTarget(sessionId, displayName);
        },
      } satisfies SessionStore);
    const appStore = options.displayMode ? null : useAppStore();
    this.client = options.sessionClient ?? DEFAULT_SESSION_CLIENT;
    this.requestTarget =
      options.requestTarget ??
      ((sessionId: string) =>
        requestSaveTarget('auto-log', `bbcom-${sessionId}-${Date.now()}.txt`));
    this.revokeTarget = options.revokeTarget ?? revokeFileGrant;
    this.displayMode = options.displayMode ?? (() => appStore!.displayMode);
    this.debounceMs = normalizeTimeout(options.debounceMs, AUTO_LOG_DEBOUNCE_MS);
    this.appendTimeoutMs = normalizeTimeout(options.appendTimeoutMs, AUTO_LOG_APPEND_TIMEOUT_MS);
    this.drainTimeoutMs = normalizeTimeout(options.drainTimeoutMs, AUTO_LOG_DRAIN_TIMEOUT_MS);
    this.terminalTimeoutMs = normalizeTimeout(
      options.terminalTimeoutMs,
      AUTO_LOG_TERMINAL_TIMEOUT_MS,
    );
  }

  async enable(sessionId: string): Promise<string | null> {
    const generation = nextGeneration(sessionId);
    const format = autoLogFormatForDisplayMode(this.displayMode());
    let grant: SaveTargetGrant | null;
    try {
      grant = await this.requestTarget(sessionId);
    } catch {
      notifyAutoLogFailure(sessionId, 'begin-failure');
      return null;
    }
    if (!grant) return null;

    if (!isCurrentGeneration(sessionId, generation) || !hasSession(this.sessionStore, sessionId)) {
      await revokeUnusedGrant(sessionId, grant, this.revokeTarget, this.terminalTimeoutMs);
      return null;
    }

    const previous = sessionStates.get(sessionId);
    if (previous) await shutdownState(previous, 'graceful');
    if (!isCurrentGeneration(sessionId, generation) || !hasSession(this.sessionStore, sessionId)) {
      await revokeUnusedGrant(sessionId, grant, this.revokeTarget, this.terminalTimeoutMs);
      return null;
    }

    let logId: string;
    try {
      ({ logId } = await this.client.begin(grant.token, format));
    } catch {
      await revokeUnusedGrant(sessionId, grant, this.revokeTarget, this.terminalTimeoutMs);
      notifyAutoLogFailure(sessionId, 'begin-failure');
      return null;
    }
    if (!isCurrentGeneration(sessionId, generation) || !hasSession(this.sessionStore, sessionId)) {
      await settleWithin(this.client.abort(logId), this.terminalTimeoutMs).catch(() => undefined);
      return null;
    }

    const state = createState(
      sessionId,
      generation,
      logId,
      grant.displayName,
      this.sessionStore,
      this.client,
      this.debounceMs,
      this.appendTimeoutMs,
      this.drainTimeoutMs,
      this.terminalTimeoutMs,
    );
    sessionStates.set(sessionId, state);
    this.sessionStore.setAutoLogTarget(sessionId, grant.displayName);
    return grant.displayName;
  }

  async disable(sessionId: string): Promise<void> {
    nextGeneration(sessionId);
    const state = sessionStates.get(sessionId);
    if (state) {
      await shutdownState(state, 'graceful');
    } else if (hasSession(this.sessionStore, sessionId)) {
      this.sessionStore.setAutoLogTarget(sessionId, null);
    }
  }

  async prepareShutdown(sessionId: string): Promise<void> {
    nextGeneration(sessionId);
    const state = sessionStates.get(sessionId);
    if (state) {
      await shutdownState(state, 'graceful', true);
    } else if (hasSession(this.sessionStore, sessionId)) {
      this.sessionStore.setAutoLogTarget(sessionId, null);
    }
  }

  appendFrame(sessionId: string, frame: DataFrame): void {
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
}

export interface AutomationBridgeCreateOptions {
  triggers: TriggersBridgeOptions;
  macro: MacroRunnerBridgeOptions;
  autoLog?: AutoLogBridgeOptions;
}

/**
 * Headless automation bundle used by the session runtime controller.
 */
export class AutomationBridge {
  readonly triggers: TriggersBridge;
  readonly macro: MacroRunnerBridge;
  readonly autoLog: AutoLogBridge;

  constructor(options: AutomationBridgeCreateOptions) {
    this.triggers = new TriggersBridge(options.triggers);
    this.macro = new MacroRunnerBridge(options.macro);
    this.autoLog = new AutoLogBridge(options.autoLog);
  }

  dispose(): void {
    this.triggers.dispose();
  }
}

export function createAutomationBridge(options: AutomationBridgeCreateOptions): AutomationBridge {
  return new AutomationBridge(options);
}

export function createTriggersBridge(options: TriggersBridgeOptions): TriggersBridge {
  return new TriggersBridge(options);
}

export function createMacroRunnerBridge(options: MacroRunnerBridgeOptions): MacroRunnerBridge {
  return new MacroRunnerBridge(options);
}

export function createAutoLogBridge(options: AutoLogBridgeOptions = {}): AutoLogBridge {
  return new AutoLogBridge(options);
}

export function useTriggers(options: TriggersBridgeOptions) {
  const bridge = createTriggersBridge(options);
  return {
    feedBytes: (bytes: Uint8Array) => bridge.feedBytes(bytes),
    feedFrame: (frame: DataFrame) => bridge.feedFrame(frame),
    reset: () => bridge.reset(),
    pause: (signal?: AbortSignal) => bridge.pause(signal),
    resume: () => bridge.resume(),
    enabledCount: bridge.enabledCount,
  };
}

export function useMacroRunner(options: MacroRunnerBridgeOptions) {
  const bridge = createMacroRunnerBridge(options);
  return {
    running: bridge.running,
    run: (macro: Macro) => bridge.run(macro),
    abort: () => bridge.abort(),
    pause: (signal?: AbortSignal) => bridge.pause(signal),
    resume: () => bridge.resume(),
  };
}

export function useAutoLog(deps: UseAutoLogDeps = {}) {
  const bridge = createAutoLogBridge(deps);
  return {
    enable: (sessionId: string) => bridge.enable(sessionId),
    disable: (sessionId: string) => bridge.disable(sessionId),
    prepareShutdown: (sessionId: string) => bridge.prepareShutdown(sessionId),
    appendFrame: (sessionId: string, frame: DataFrame) => bridge.appendFrame(sessionId, frame),
  };
}

export function autoLogFormatForDisplayMode(
  displayMode: import('@/types').DisplayMode,
): AutoLogFormat {
  return displayMode === 'HEX' || displayMode === 'HEXASCII' ? 'hex' : 'text';
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

function resolveWaiters(waiters: Set<() => void>): void {
  const pending = Array.from(waiters);
  waiters.clear();
  for (const resolve of pending) resolve();
}
