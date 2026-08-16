import { encodeUtf8, parseHex } from '../../../lib/format';
import { concatUint8Arrays } from '../../../lib/bytes';
import { mapDataBits, mapFlowControl, mapParity, mapStopBits } from '../../../lib/serial-config';
import { SerialRxQueue } from '../../../lib/serial-rx-queue';
import {
  SerialRxDrainScheduler,
  SerialUiPublishScheduler,
  type SerialTimerScheduler,
} from '../../../lib/serial-rx-scheduler';
import type { SerialPortAdapter, SerialPortFactory } from './serial-port';
import {
  SERIAL_WRITE_CLOSE_GRACE_MS,
  SerialWriteScheduler,
} from '../../../lib/serial-write-scheduler';
import { logger } from '../../../lib/logger';
import { normalizeRxFrameGapMs } from '../../../lib/serial-framing';
import { MAX_INPUT_SIZE } from '../../../types';
import type { IpcError } from '../../../generated/ipc-contracts';
import type { DataFrame, PortConfig, SerialSendResult, SerialWriteOptions } from '../../../types';
import type { PortLeaseClient } from './port-lease-registry';
import { classifyOpenFailure, type SerialConnectionFailure } from './serial-connection-failure';
import { createPortLeaseController } from './serial-port-lease';
import {
  createRxEvidenceDrainer,
  createShutdownProtocol,
  createUnsafeRxLatch,
  isPortCloseProven,
  NO_ACTIVE_CONNECTION_EVIDENCE,
  settlesWithin,
  UNWATCHED_OPEN_EVIDENCE,
  type ConnectionAttempt,
  type PortCloseEvidence,
  type SerialRxStopEvidence,
  type SerialStopResult,
} from './serial-shutdown-evidence';

export { classifyOpenFailure, type SerialConnectionFailure } from './serial-connection-failure';
export type { SerialStopResult } from './serial-shutdown-evidence';

const MAX_RX_QUEUE_BYTES = MAX_INPUT_SIZE * 2;
const MAX_RX_QUEUE_CHUNKS = 512;
const RECONNECT_INTERVAL_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;

/** Result of validating + encoding a send payload before it enters the queue. */
export type SendPayloadResult =
  | { ok: true; payload: Uint8Array }
  | {
      ok: false;
      reason: 'empty' | 'bad-hex' | 'too-large';
      requestedBytes: number;
    };

export function buildSendPayload(data: string, isHex: boolean): SendPayloadResult {
  let payload: Uint8Array;
  if (isHex) {
    try {
      payload = parseHex(data);
    } catch {
      return { ok: false, reason: 'bad-hex', requestedBytes: 0 };
    }
    if (payload.length === 0) return { ok: false, reason: 'empty', requestedBytes: 0 };
  } else {
    if (data.length === 0) return { ok: false, reason: 'empty', requestedBytes: 0 };
    payload = encodeUtf8(data);
  }
  if (payload.length > MAX_INPUT_SIZE) {
    return { ok: false, reason: 'too-large', requestedBytes: payload.length };
  }
  return { ok: true, payload };
}

export interface SerialConnectionOptions {
  onDisconnect?: () => void;
  onOverflow?: (totalDroppedBytes: number) => void;
  autoReconnect?: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onRxFrame?: (frame: DataFrame) => void;
}

export interface SerialConnectionSink {
  setConnected(sessionId: string, connected: boolean): void;
  updateDroppedBytes(sessionId: string, totalDroppedBytes: number): void;
  addFrame(
    sessionId: string,
    frame: Omit<DataFrame, 'id' | 'timestamp'>,
    options?: { publish?: boolean },
  ): DataFrame | undefined;
  publishFrames(sessionId: string): void;
  appendAutoLogFrame(sessionId: string, frame: DataFrame): void;
}

export interface TimerPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  delay(delayMs: number): Promise<void>;
}

export interface VisibilityPort {
  isVisible(): boolean;
}

export interface SerialConnectionDependencies {
  leaseClient: PortLeaseClient;
  sessionName: string | (() => string);
  createPort: SerialPortFactory;
  sink: SerialConnectionSink;
  timerScheduler?: SerialTimerScheduler;
  timerPort?: TimerPort;
  visibilityPort?: VisibilityPort;
  writeCloseGraceMs?: number;
}

export interface SerialConnectionSnapshot {
  readonly port: SerialPortAdapter | null;
  readonly isConnecting: boolean;
  readonly isConnected: boolean;
  readonly isClosing: boolean;
  readonly reconnecting: boolean;
  readonly error: string | null;
  readonly connectionFailure: SerialConnectionFailure | null;
  readonly totalDroppedBytes: number;
}

export type SerialConnectionListener = (snapshot: SerialConnectionSnapshot) => void;

export interface SerialConnectionController {
  snapshot(): SerialConnectionSnapshot;
  subscribe(listener: SerialConnectionListener): () => void;
  start(): Promise<boolean>;
  send(data: string, isHex: boolean, options?: SerialWriteOptions): Promise<SerialSendResult>;
  sendBytes(payload: Uint8Array, options?: SerialWriteOptions): Promise<SerialSendResult>;
  sendBreak(durationMs?: number): Promise<boolean>;
  rawBytes(callback: (bytes: Uint8Array) => void): () => void;
  stop(): Promise<SerialStopResult>;
  visibilityChanged(): void;
  dispose(): Promise<SerialStopResult>;
}

interface MutableCell<T> {
  value: T;
}

function observableCell<T>(initial: T, changed: () => void): MutableCell<T> {
  let current = initial;
  return {
    get value() {
      return current;
    },
    set value(value: T) {
      if (Object.is(value, current)) return;
      current = value;
      changed();
    },
  };
}

const DEFAULT_TIMER_PORT: TimerPort = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  delay: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

class StaleConnectionError extends Error {
  constructor() {
    super('stale serial connection generation');
  }
}

type SendFailureReason = 'empty' | 'bad-hex' | 'too-large' | 'not-connected';

const SERIAL_SEND_OPERATION = 'serial_send';

function sendError(
  code: IpcError['code'],
  messageKey: string,
  retryable: boolean,
  details: Partial<Pick<IpcError, 'field' | 'limit' | 'actual'>> = {},
): IpcError {
  return {
    code,
    messageKey,
    retryable,
    operation: SERIAL_SEND_OPERATION,
    ...details,
  };
}

function failedSend(reason: SendFailureReason, requestedBytes: number): SerialSendResult {
  let error: IpcError;
  switch (reason) {
    case 'too-large':
      error = sendError('LIMIT_EXCEEDED', 'error.limit_exceeded', false, {
        field: 'payload',
        limit: MAX_INPUT_SIZE,
        actual: requestedBytes,
      });
      break;
    case 'not-connected':
      error = sendError('SERIAL_DISCONNECTED', 'error.serial_disconnected', true);
      break;
    case 'empty':
    case 'bad-hex':
      error = sendError('INVALID_INPUT', 'error.invalid_input', false, { field: 'payload' });
      break;
  }

  return {
    outcome: 'failed',
    requestedBytes,
    sentBytes: 0,
    error,
  };
}

export function createSerialConnectionController(
  sessionId: string,
  portName: string | (() => string),
  config: PortConfig | (() => PortConfig),
  options: SerialConnectionOptions | undefined,
  dependencies: SerialConnectionDependencies,
): SerialConnectionController {
  const listeners = new Set<SerialConnectionListener>();
  let initialized = false;
  const notify = () => {
    if (!initialized) return;
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };
  const createPort = dependencies.createPort;
  const sink = dependencies.sink;
  const timerPort = dependencies.timerPort ?? DEFAULT_TIMER_PORT;
  const closeGraceMs = dependencies.writeCloseGraceMs ?? SERIAL_WRITE_CLOSE_GRACE_MS;

  const port = observableCell<SerialPortAdapter | null>(null, notify);
  const isConnecting = observableCell(false, notify);
  const isConnected = observableCell(false, notify);
  const error = observableCell<string | null>(null, notify);
  const connectionFailure = observableCell<SerialConnectionFailure | null>(null, notify);
  const totalDroppedBytes = observableCell(0, notify);
  const reconnecting = observableCell(false, notify);
  const isClosing = observableCell(false, notify);

  const rxQueue = new SerialRxQueue({
    maxBytes: MAX_RX_QUEUE_BYTES,
    maxChunks: MAX_RX_QUEUE_CHUNKS,
  });
  let rxOverflowErrorMessage: string | null = null;

  const isDocumentVisible = () => dependencies.visibilityPort?.isVisible() ?? true;
  const uiPublisher = new SerialUiPublishScheduler(
    () => {
      sink.updateDroppedBytes(sessionId, totalDroppedBytes.value);
      sink.publishFrames(sessionId);
    },
    isDocumentVisible,
    dependencies.timerScheduler,
  );
  let rxDrain = createRxDrain(readPortConfig().rxFrameGapMs);

  let activeConnection: ConnectionAttempt | null = null;
  let pendingAttempt: ConnectionAttempt | null = null;
  let connectionGeneration = 0;
  let intentionalClose = true;
  let reconnectTimer: unknown | null = null;
  let reconnectAttempts = 0;
  let breakInFlight = false;
  let closingPromise: Promise<SerialStopResult> | null = null;

  // Process-level port lease acquire/transition/release bookkeeping.
  const leases = createPortLeaseController({
    leaseClient: dependencies.leaseClient,
    sessionId,
    sessionName: dependencies.sessionName,
    onLeaseFailure: (failure) => {
      connectionFailure.value = failure;
      error.value = failure.error.code;
      intentionalClose = true;
    },
  });
  // Once a watched connection cannot prove its final RX boundary, no later
  // empty stop may turn that historical data-loss risk into a safe result.
  // The latch lives for this runtime instance and is cleared only when the
  // runtime itself is discarded (or the user explicitly forces shutdown).
  const unsafeRxLatch = createUnsafeRxLatch();
  const drainAttemptRx = createRxEvidenceDrainer({
    enqueueReceivedBytes,
    flushRxAndPublish,
    totalDroppedBytes: () => totalDroppedBytes.value,
  });
  const { shutdownConnection } = createShutdownProtocol({
    closeGraceMs,
    drainAttemptRx,
    rememberUnsafeEvidence: (evidence) => unsafeRxLatch.remember(evidence),
  });

  const rawByteObservers = new Set<(bytes: Uint8Array) => void>();

  function assertCurrent(attempt: ConnectionAttempt): void {
    if (attempt.generation !== connectionGeneration || intentionalClose || attempt.disconnected) {
      throw new StaleConnectionError();
    }
  }

  function readPortConfig(): Readonly<PortConfig> {
    const current = typeof config === 'function' ? config() : config;
    return Object.freeze({ ...current });
  }

  function readConnectionTarget(): Readonly<{
    portName: string;
    config: Readonly<PortConfig>;
  }> {
    const currentPortName = (typeof portName === 'function' ? portName() : portName).trim();
    if (
      currentPortName.length === 0 ||
      currentPortName.length > 1024 ||
      containsControlCharacters(currentPortName)
    ) {
      throw new TypeError('invalid serial port');
    }
    return Object.freeze({ portName: currentPortName, config: readPortConfig() });
  }

  function createRxDrain(rxFrameGapMs: number): SerialRxDrainScheduler {
    return new SerialRxDrainScheduler(
      () => ({ bytes: rxQueue.pendingBytes, chunks: rxQueue.pendingChunks }),
      flushQueue,
      dependencies.timerScheduler,
      normalizeRxFrameGapMs(rxFrameGapMs),
    );
  }

  function resetRxDrain(rxFrameGapMs: number): void {
    rxDrain.cancel();
    rxDrain = createRxDrain(rxFrameGapMs);
  }

  async function openConnection(
    generation: number,
    target: Readonly<{ portName: string; config: Readonly<PortConfig> }>,
  ): Promise<ConnectionAttempt> {
    let settleAttempt!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleAttempt = resolve;
    });
    let didSettle = false;
    const attempt: ConnectionAttempt = {
      generation,
      target,
      port: createPort({
        path: target.portName,
        baudRate: target.config.baudRate,
        dataBits: mapDataBits(target.config.dataBits),
        stopBits: mapStopBits(target.config.stopBits),
        parity: mapParity(target.config.parity),
        flowControl: mapFlowControl(target.config.flowControl),
      }),
      watch: null,
      scheduler: null,
      committed: false,
      disconnected: false,
      acceptingRx: true,
      settled,
      settle() {
        if (didSettle) return;
        didSettle = true;
        settleAttempt();
      },
      closeEvidence: 'close-failed',
      watchInstalled: false,
      rxStopEvidence: null,
      shutdownTask: null,
    };
    pendingAttempt = attempt;

    try {
      await attempt.port.open();
      assertCurrent(attempt);
      attempt.watch = await attempt.port.watch(
        {
          onData(data) {
            // Generation/disconnect state invalidates lifecycle continuations,
            // but RX remains admissible until the explicit drain boundary has
            // yielded every already-queued Channel task.
            if (!attempt.acceptingRx) return;
            enqueueReceivedBytes(data instanceof Uint8Array ? data : encodeUtf8(data));
          },
          onDisconnect() {
            // Some native backends announce watch shutdown before delivering
            // their last queued channel messages. During an intentional close
            // the explicit unwatch boundary owns teardown, so keep this
            // generation receivable until performStop has flushed it.
            if (
              attempt.shutdownTask ||
              (isClosing.value && attempt.generation === connectionGeneration)
            ) {
              return;
            }
            attempt.disconnected = true;
            void handleDisconnect(attempt);
          },
          onError(message) {
            if (attempt.generation === connectionGeneration) {
              logger.warn('serial watch error for', target.portName, message);
            }
          },
        },
        {
          decode: false,
          // Native v3 otherwise retains up to one second in its watch batch,
          // and unwatch does not flush that buffer. Immediate channel batches
          // avoid a known retained-batch loss before the explicit drain boundary.
          serialDataFlushIntervalMs: 0,
        },
      );
      attempt.watchInstalled = true;
      assertCurrent(attempt);

      // Unsupported control lines are non-fatal, but a generation change at
      // either await boundary still invalidates the whole transaction.
      try {
        await attempt.port.writeDataTerminalReady(target.config.dtr);
      } catch (controlError) {
        assertCurrent(attempt);
        logger.debug('serial DTR write unsupported for', target.portName, controlError);
      }
      assertCurrent(attempt);
      try {
        await attempt.port.writeRequestToSend(target.config.rts);
      } catch (controlError) {
        assertCurrent(attempt);
        logger.debug('serial RTS write unsupported for', target.portName, controlError);
      }
      assertCurrent(attempt);

      attempt.scheduler = new SerialWriteScheduler((chunk) => attempt.port.writeBinary(chunk));
      attempt.committed = true;
      activeConnection = attempt;
      if (pendingAttempt === attempt) pendingAttempt = null;
      port.value = attempt.port;
      return attempt;
    } catch (openError) {
      let closeEvidence: PortCloseEvidence;
      try {
        closeEvidence = await cleanupAttempt(attempt);
      } catch {
        // A failed rollback is still a live native-handle possibility. Keep
        // both the concrete attempt and its lease reachable so stop() can
        // retry the same teardown instead of reporting an empty runtime.
        logger.warn('serial candidate rollback failed for', target.portName);
        pendingAttempt = attempt;
        retainUnclosedConnection(attempt, generation);
        throw openError;
      }
      if (!isPortCloseProven(closeEvidence)) {
        pendingAttempt = attempt;
        retainUnclosedConnection(attempt, generation);
      }
      throw openError;
    } finally {
      if (
        !attempt.committed &&
        pendingAttempt === attempt &&
        isPortCloseProven(attempt.closeEvidence)
      ) {
        pendingAttempt = null;
      }
      attempt.settle();
    }
  }

  async function start(): Promise<boolean> {
    // A close owns the current generation until the watch boundary has been
    // acknowledged and the final renderer RX queue has been published.
    // An unresolved open or an unclosed native handle also owns the lease.
    // Starting a replacement in either state could create two driver handles
    // for the same physical port, so the caller must retry stop first.
    if (
      isConnecting.value ||
      isClosing.value ||
      pendingAttempt !== null ||
      (activeConnection !== null &&
        activeConnection.disconnected &&
        !isPortCloseProven(activeConnection.closeEvidence))
    ) {
      return false;
    }
    intentionalClose = false;
    isConnecting.value = true;
    error.value = null;
    connectionFailure.value = null;
    stopReconnect();

    let target: ReturnType<typeof readConnectionTarget>;
    try {
      target = readConnectionTarget();
    } catch (targetError) {
      const failure = classifyOpenFailure(targetError);
      connectionFailure.value = failure;
      error.value = failure.error.code;
      intentionalClose = true;
      isConnecting.value = false;
      return false;
    }

    // A replacement keeps the old generation and RX queue authoritative until
    // its explicit shutdown barrier has published the final Channel tail. Only
    // then may a new generation reset renderer state or open another handle.
    const previous = activeConnection;
    if (previous) {
      isClosing.value = true;
      port.value = null;
      isConnected.value = false;
      sink.setConnected(sessionId, false);
      try {
        const closeEvidence = await shutdownConnection(previous, closeGraceMs);
        if (!isPortCloseProven(closeEvidence)) {
          retainUnclosedConnection(previous, connectionGeneration);
          isConnecting.value = false;
          if (!closingPromise) isClosing.value = false;
          return false;
        }
        if (previous.rxStopEvidence?.rxDrainGuarantee !== 'guaranteed') {
          if (activeConnection === previous) detachActiveConnection();
          failAndReleaseLease(connectionGeneration);
          isConnecting.value = false;
          if (!closingPromise) isClosing.value = false;
          return false;
        }
      } catch {
        retainUnclosedConnection(previous, connectionGeneration);
        isConnecting.value = false;
        if (!closingPromise) isClosing.value = false;
        return false;
      }
      // An explicit stop may have joined the same shutdownTask and detached
      // the attempt. In that case it owns the lease and the replacement must
      // not continue after the shared barrier resolves.
      if (
        intentionalClose ||
        activeConnection !== previous ||
        previous.generation !== connectionGeneration
      ) {
        isConnecting.value = false;
        if (!closingPromise) isClosing.value = false;
        return false;
      }
      detachActiveConnection();
      isClosing.value = false;
    }

    const generation = ++connectionGeneration;
    leases.adoptGeneration(generation);
    resetRxDrain(target.config.rxFrameGapMs);
    if (!leases.acquire(generation, target.portName)) {
      failAndReleaseLease(generation);
      return finishStart(generation, false);
    }

    flushRxAndPublish();
    rxDrain.cancel();
    uiPublisher.cancel();
    rxQueue.reset();
    rxOverflowErrorMessage = null;
    totalDroppedBytes.value = 0;
    sink.updateDroppedBytes(sessionId, 0);

    if (generation !== connectionGeneration || intentionalClose) {
      return finishStart(generation, false);
    }

    try {
      await openConnection(generation, target);
      if (generation !== connectionGeneration || intentionalClose) {
        const stale = detachActiveConnection();
        if (stale) {
          const closeEvidence = await shutdownConnection(stale, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(stale, generation);
            return finishStart(generation, false);
          }
        }
        failAndReleaseLease(generation);
        return finishStart(generation, false);
      }
      isConnected.value = true;
      sink.setConnected(sessionId, true);
      if (!leases.transition(generation, 'connected')) {
        const connected = detachActiveConnection();
        if (connected) {
          const closeEvidence = await shutdownConnection(connected, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(connected, generation);
            isConnected.value = false;
            sink.setConnected(sessionId, false);
            return finishStart(generation, false);
          }
        }
        failAndReleaseLease(generation);
        isConnected.value = false;
        sink.setConnected(sessionId, false);
        return finishStart(generation, false);
      }
      return finishStart(generation, true);
    } catch (openError) {
      if (generation === connectionGeneration && !intentionalClose) {
        if (!(openError instanceof StaleConnectionError)) {
          logger.warn('serial open failed for', target.portName, openError);
          const failure = classifyOpenFailure(openError);
          connectionFailure.value = failure;
          error.value = failure.error.code;
        }
        isConnected.value = false;
        sink.setConnected(sessionId, false);
        const unresolved = activeConnection;
        if (!unresolved || isPortCloseProven(unresolved.closeEvidence)) {
          failAndReleaseLease(generation);
        }
      }
      return finishStart(generation, false);
    }
  }

  function finishStart(generation: number, result: boolean): boolean {
    if (generation === connectionGeneration) isConnecting.value = false;
    return result;
  }

  async function handleDisconnect(attempt: ConnectionAttempt): Promise<void> {
    if (!attempt.committed) return;
    if (attempt.generation !== connectionGeneration || activeConnection !== attempt) return;

    // Retain both the active attempt and its generation until the RX barrier
    // settles. A concurrent explicit stop therefore detaches the same attempt,
    // joins its shutdownTask, and cannot observe a false no-active state.
    isClosing.value = true;
    port.value = null;
    isConnected.value = false;
    sink.setConnected(sessionId, false);
    let closeEvidence: PortCloseEvidence;
    try {
      closeEvidence = await shutdownConnection(attempt, 0);
    } catch {
      // The attempt and its process lease remain the retry token when any
      // shutdown phase rejects unexpectedly. A concurrent stop may already
      // have detached them; retainUnclosedConnection is deliberately
      // idempotent with that path and restores the same attempt afterwards.
      logger.warn('serial disconnect shutdown failed for', attempt.target.portName);
      retainUnclosedConnection(attempt, connectionGeneration);
      if (!closingPromise) isClosing.value = false;
      return;
    }
    if (!isPortCloseProven(closeEvidence)) {
      retainUnclosedConnection(attempt, connectionGeneration);
      if (!closingPromise) isClosing.value = false;
      return;
    }
    // If stop() joined this barrier it already detached the attempt and owns
    // lease release plus the final generation bump.
    if (intentionalClose || activeConnection !== attempt) return;

    detachActiveConnection();
    connectionGeneration += 1;
    leases.adoptGeneration(connectionGeneration);
    isClosing.value = false;
    if (attempt.rxStopEvidence?.rxDrainGuarantee !== 'guaranteed') {
      // Physical closure alone cannot repair a final-RX boundary that was not
      // proven. Keep the runtime stopped and surface the disconnect instead of
      // silently reconnecting after possible data loss.
      failAndReleaseLease(connectionGeneration);
      options?.onDisconnect?.();
      return;
    }

    if (options?.autoReconnect?.()) {
      if (reconnecting.value) scheduleReconnect();
      else startReconnect();
    } else {
      failAndReleaseLease(connectionGeneration);
      options?.onDisconnect?.();
    }
  }

  function startReconnect(): void {
    if (reconnecting.value || intentionalClose || isClosing.value) return;
    reconnecting.value = true;
    reconnectAttempts = 0;
    if (!leases.transition(connectionGeneration, 'reconnecting')) {
      reconnecting.value = false;
      failAndReleaseLease(connectionGeneration);
      options?.onDisconnect?.();
      return;
    }
    options?.onReconnecting?.();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (
      reconnectTimer ||
      intentionalClose ||
      isClosing.value ||
      pendingAttempt !== null ||
      (activeConnection !== null && !isPortCloseProven(activeConnection.closeEvidence))
    ) {
      return;
    }
    reconnectTimer = timerPort.schedule(() => void attemptReconnect(), RECONNECT_INTERVAL_MS);
  }

  async function attemptReconnect(): Promise<void> {
    reconnectTimer = null;
    if (
      intentionalClose ||
      isClosing.value ||
      pendingAttempt !== null ||
      (activeConnection !== null && !isPortCloseProven(activeConnection.closeEvidence))
    ) {
      reconnecting.value = false;
      return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      reconnecting.value = false;
      failAndReleaseLease(connectionGeneration);
      options?.onDisconnect?.();
      return;
    }

    const generation = ++connectionGeneration;
    leases.adoptGeneration(generation);
    try {
      const target = readConnectionTarget();
      resetRxDrain(target.config.rxFrameGapMs);
      await openConnection(generation, target);
      if (generation !== connectionGeneration || intentionalClose) {
        const stale = detachActiveConnection();
        if (stale) {
          const closeEvidence = await shutdownConnection(stale, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(stale, generation);
            reconnecting.value = false;
            return;
          }
        }
        failAndReleaseLease(generation);
        return;
      }
      reconnecting.value = false;
      isConnected.value = true;
      error.value = null;
      connectionFailure.value = null;
      rxOverflowErrorMessage = null;
      if (!leases.transition(generation, 'connected')) {
        const connected = detachActiveConnection();
        if (connected) {
          const closeEvidence = await shutdownConnection(connected, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(connected, generation);
            reconnecting.value = false;
            isConnected.value = false;
            sink.setConnected(sessionId, false);
            options?.onDisconnect?.();
            return;
          }
        }
        failAndReleaseLease(generation);
        reconnecting.value = false;
        isConnected.value = false;
        sink.setConnected(sessionId, false);
        options?.onDisconnect?.();
        return;
      }
      sink.setConnected(sessionId, true);
      options?.onReconnected?.();
    } catch (reconnectError) {
      if (generation === connectionGeneration && !intentionalClose) {
        if (!(reconnectError instanceof StaleConnectionError)) {
          const failure = classifyOpenFailure(reconnectError);
          connectionFailure.value = failure;
          error.value = failure.error.code;
        }
        if (activeConnection && !isPortCloseProven(activeConnection.closeEvidence)) {
          reconnecting.value = false;
          options?.onDisconnect?.();
        } else {
          scheduleReconnect();
        }
      }
    }
  }

  function stopReconnect(): void {
    if (reconnectTimer) {
      timerPort.cancel(reconnectTimer);
      reconnectTimer = null;
    }
    reconnecting.value = false;
  }

  function enqueueReceivedBytes(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    for (const observer of rawByteObservers) observer(bytes);

    const result = rxQueue.enqueue(bytes);
    totalDroppedBytes.value = result.totalDroppedBytes;
    if (result.overflowStarted) options?.onOverflow?.(result.totalDroppedBytes);

    if (result.droppedSinceDrain > 0) {
      rxOverflowErrorMessage = 'SERIAL_RX_OVERFLOW';
      error.value = rxOverflowErrorMessage;
    } else if (rxOverflowErrorMessage && error.value === rxOverflowErrorMessage) {
      error.value = null;
      rxOverflowErrorMessage = null;
    }
    rxDrain.notify();
  }

  function flushQueue(): void {
    if (rxQueue.pendingChunks === 0) return;
    const { chunks, byteLength } = rxQueue.drain();
    const frame = sink.addFrame(
      sessionId,
      { direction: 'RX', data: concatUint8Arrays(chunks, byteLength) },
      { publish: false },
    );
    if (!frame) return;
    sink.appendAutoLogFrame(sessionId, frame);
    options?.onRxFrame?.(frame);
    uiPublisher.markDirty();
  }

  function flushRxAndPublish(): void {
    rxDrain.flushNow();
    uiPublisher.flushNow();
  }

  async function send(
    data: string,
    isHex: boolean,
    writeOptions?: SerialWriteOptions,
  ): Promise<SerialSendResult> {
    const built = buildSendPayload(data, isHex);
    if (!built.ok) return failedSend(built.reason, built.requestedBytes);
    return enqueuePayload(built.payload, writeOptions);
  }

  async function sendBytes(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
  ): Promise<SerialSendResult> {
    if (payload.length === 0) return failedSend('empty', 0);
    if (payload.length > MAX_INPUT_SIZE) return failedSend('too-large', payload.length);
    return enqueuePayload(payload, writeOptions);
  }

  async function enqueuePayload(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
  ): Promise<SerialSendResult> {
    const connection = activeConnection;
    if (isClosing.value || !connection?.scheduler || !isConnected.value) {
      return failedSend('not-connected', payload.length);
    }
    const result = await connection.scheduler.enqueue(payload, writeOptions);
    if (result.sentBytes > 0) {
      const txFrame = sink.addFrame(sessionId, {
        direction: 'TX',
        data: payload.slice(0, result.sentBytes),
        txStatus: result.outcome === 'complete' ? 'complete' : 'partial-unknown',
        requestedBytes: result.requestedBytes,
      });
      if (txFrame) sink.appendAutoLogFrame(sessionId, txFrame);
    }
    if (result.error?.code === 'SERIAL_PARTIAL_WRITE') {
      logger.warn(
        'serial write did not complete on',
        connection.target.portName,
        result.error.code,
        result.error.messageKey,
      );
    }
    return result;
  }

  function rawBytes(callback: (bytes: Uint8Array) => void): () => void {
    rawByteObservers.add(callback);
    return () => rawByteObservers.delete(callback);
  }

  async function sendBreak(durationMs = 250): Promise<boolean> {
    const connection = activeConnection;
    if (isClosing.value || breakInFlight || !connection) return false;
    breakInFlight = true;
    try {
      await connection.port.setBreak();
      await timerPort.delay(durationMs);
      await connection.port.clearBreak();
      return connection === activeConnection;
    } catch (breakError) {
      logger.warn('serial setBreak/clearBreak failed on', connection.target.portName, breakError);
      return false;
    } finally {
      breakInFlight = false;
    }
  }

  function failAndReleaseLease(generation: number): void {
    if (activeConnection && !isPortCloseProven(activeConnection.closeEvidence)) {
      activeConnection.disconnected = true;
      leases.transition(generation, 'closing');
      return;
    }
    leases.failAndRelease(generation);
  }

  function detachActiveConnection(): ConnectionAttempt | null {
    const connection = activeConnection;
    activeConnection = null;
    port.value = null;
    return connection;
  }

  function retainUnclosedConnection(attempt: ConnectionAttempt, leaseGeneration: number): void {
    attempt.disconnected = true;
    if (pendingAttempt === attempt) pendingAttempt = null;
    activeConnection = attempt;
    port.value = null;
    isConnected.value = false;
    sink.setConnected(sessionId, false);
    leases.transition(leaseGeneration, 'closing');
  }

  async function cleanupAttempt(attempt: ConnectionAttempt): Promise<PortCloseEvidence> {
    return shutdownConnection(attempt, closeGraceMs);
  }

  async function performStop(): Promise<SerialStopResult> {
    const closingGeneration = connectionGeneration;
    isClosing.value = true;
    intentionalClose = true;
    stopReconnect();
    isConnecting.value = false;

    let opening = pendingAttempt;
    const connection = detachActiveConnection();
    if (opening === connection) {
      pendingAttempt = null;
      opening = null;
    }
    const lease = leases.detach();
    if (lease) leases.transitionDetached(lease, 'closing');

    let rxEvidence: SerialRxStopEvidence =
      unsafeRxLatch.current ??
      connection?.rxStopEvidence ??
      opening?.rxStopEvidence ??
      (opening ? UNWATCHED_OPEN_EVIDENCE : NO_ACTIVE_CONNECTION_EVIDENCE);
    let pendingOpen: SerialStopResult['pendingOpen'] = opening ? 'unsettled' : 'none';
    let portClose: SerialStopResult['portClose'] =
      connection || opening ? 'close-failed' : 'no-active-port';
    let physicalCloseProven = connection === null && opening === null;
    try {
      if (opening) {
        if (await settlesWithin(opening.settled, closeGraceMs)) {
          pendingOpen = 'settled';
          rxEvidence = opening.rxStopEvidence ?? rxEvidence;
          unsafeRxLatch.remember(rxEvidence);
          portClose = opening.closeEvidence;
          physicalCloseProven = isPortCloseProven(portClose);
        } else {
          portClose = 'pending-open-unsettled';
        }
      }

      if (connection) {
        portClose = await shutdownConnection(connection, closeGraceMs);
        rxEvidence = connection.rxStopEvidence ?? rxEvidence;
        if (connectionGeneration === closingGeneration) connectionGeneration += 1;
        physicalCloseProven = isPortCloseProven(portClose);
      } else if (!opening || pendingOpen === 'settled') {
        flushRxAndPublish();
        if (connectionGeneration === closingGeneration) connectionGeneration += 1;
      }

      if (physicalCloseProven && pendingOpen !== 'unsettled') {
        rxDrain.cancel();
        uiPublisher.cancel();
        rxQueue.clearPending();
      }
      error.value = null;
      connectionFailure.value = null;
    } finally {
      if (lease && physicalCloseProven) {
        unsafeRxLatch.remember(rxEvidence);
        dependencies.leaseClient.release(lease.grant.leaseId, sessionId);
      } else if (lease && opening && pendingOpen === 'unsettled') {
        pendingAttempt = opening;
        leases.reattach({ generation: connectionGeneration, grant: lease.grant });
        // Fail closed while native open is unresolved. Only release the
        // process lease after the stale transaction has settled and its final
        // cleanup produced positive close evidence.
        void opening.settled.then(() => {
          if (isPortCloseProven(opening.closeEvidence)) {
            const settledEvidence = opening.rxStopEvidence;
            if (settledEvidence) unsafeRxLatch.remember(settledEvidence);
            dependencies.leaseClient.release(lease.grant.leaseId, sessionId);
            leases.clearIfHeld(lease);
            if (pendingAttempt === opening) pendingAttempt = null;
          } else {
            retainUnclosedConnection(opening, connectionGeneration);
          }
        });
      } else if (lease && !physicalCloseProven) {
        leases.reattach({ generation: connectionGeneration, grant: lease.grant });
        const unresolvedAttempt = connection ?? opening;
        if (unresolvedAttempt && pendingOpen !== 'unsettled') {
          retainUnclosedConnection(unresolvedAttempt, connectionGeneration);
        }
      }
      isConnected.value = false;
      sink.setConnected(sessionId, false);
      isClosing.value = false;
    }

    const finalRxEvidence = unsafeRxLatch.current ?? rxEvidence;
    return {
      ...finalRxEvidence,
      pendingOpen,
      portClose,
    };
  }

  async function stop(): Promise<SerialStopResult> {
    if (closingPromise) return closingPromise;
    closingPromise = performStop();
    try {
      return await closingPromise;
    } finally {
      closingPromise = null;
    }
  }

  function snapshot(): SerialConnectionSnapshot {
    return Object.freeze({
      port: port.value,
      isConnecting: isConnecting.value,
      isConnected: isConnected.value,
      isClosing: isClosing.value,
      reconnecting: reconnecting.value,
      error: error.value,
      connectionFailure: connectionFailure.value,
      totalDroppedBytes: totalDroppedBytes.value,
    });
  }

  function subscribe(listener: SerialConnectionListener): () => void {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  function visibilityChanged(): void {
    uiPublisher.visibilityChanged();
  }

  async function dispose(): Promise<SerialStopResult> {
    const result = await stop();
    listeners.clear();
    rawByteObservers.clear();
    return result;
  }

  initialized = true;
  return {
    snapshot,
    subscribe,
    start,
    send,
    sendBytes,
    sendBreak,
    rawBytes,
    stop,
    visibilityChanged,
    dispose,
  };
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
