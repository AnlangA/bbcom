import { onScopeDispose, ref, shallowRef } from 'vue';
import { useSessionStore } from '../stores/sessions';
import { useSessionFrames } from './useSessionFrames';
import { useAutoLog } from './useAutoLog';
import { encodeUtf8, formatBytes, parseHex } from '../lib/format';
import { concatUint8Arrays } from '../lib/bytes';
import { mapDataBits, mapFlowControl, mapParity, mapStopBits } from '../lib/serial-config';
import { SerialRxQueue } from '../lib/serial-rx-queue';
import {
  SerialRxDrainScheduler,
  SerialUiPublishScheduler,
  type SerialTimerScheduler,
} from '../lib/serial-rx-scheduler';
import {
  createTauriSerialPort,
  type SerialPortAdapter,
  type SerialPortFactory,
  type SerialWatchHandleAdapter,
} from '../lib/serial-port-adapter';
import { SERIAL_WRITE_CLOSE_GRACE_MS, SerialWriteScheduler } from '../lib/serial-write-scheduler';
import { logger } from '../lib/logger';
import { t } from '../lib/i18n';
import { MAX_INPUT_SIZE } from '../types';
import type {
  DataFrame,
  PortConfig,
  SerialSendFailureReason,
  SerialSendResult,
  SerialWriteOptions,
} from '../types';

const MAX_RX_QUEUE_BYTES = MAX_INPUT_SIZE * 2;
const MAX_RX_QUEUE_CHUNKS = 512;
const RECONNECT_INTERVAL_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;

/** Result of validating + encoding a send payload before it enters the queue. */
export type SendPayloadResult =
  { ok: true; payload: Uint8Array } | { ok: false; reason: 'empty' | 'bad-hex' | 'too-large' };

export function buildSendPayload(data: string, isHex: boolean): SendPayloadResult {
  let payload: Uint8Array;
  if (isHex) {
    try {
      payload = parseHex(data);
    } catch {
      return { ok: false, reason: 'bad-hex' };
    }
    if (payload.length === 0) return { ok: false, reason: 'empty' };
  } else {
    if (data.length === 0) return { ok: false, reason: 'empty' };
    payload = encodeUtf8(data);
  }
  if (payload.length > MAX_INPUT_SIZE) return { ok: false, reason: 'too-large' };
  return { ok: true, payload };
}

export interface SerialConnectionOptions {
  onDisconnect?: () => void;
  /** Fired once per connection when RX first overflows. */
  onOverflow?: (totalDroppedBytes: number) => void;
  autoReconnect?: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onRxFrame?: (frame: DataFrame) => void;
}

export interface SerialConnectionDependencies {
  createPort?: SerialPortFactory;
  timerScheduler?: SerialTimerScheduler;
  isDocumentVisible?: () => boolean;
  writeCloseGraceMs?: number;
}

interface ConnectionAttempt {
  generation: number;
  port: SerialPortAdapter;
  watch: SerialWatchHandleAdapter | null;
  scheduler: SerialWriteScheduler | null;
  committed: boolean;
  disconnected: boolean;
}

class StaleConnectionError extends Error {
  constructor() {
    super('stale serial connection generation');
  }
}

function failedSend(
  reason: SerialSendFailureReason,
  requestedBytes: number,
  error?: unknown,
): SerialSendResult {
  return {
    status: 'rejected',
    ok: false,
    requestedBytes,
    confirmedBytes: 0,
    bytesWritten: 0,
    reason,
    code:
      reason === 'queue-full'
        ? 'SERIAL_QUEUE_FULL'
        : reason === 'not-connected' || reason === 'disconnecting'
          ? 'SERIAL_DISCONNECTED'
          : 'INVALID_INPUT',
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

export function useSerialConnection(
  sessionId: string,
  portName: string,
  config: PortConfig,
  options?: SerialConnectionOptions,
  dependencies: SerialConnectionDependencies = {},
) {
  const sessionStore = useSessionStore();
  const { addFrame, publishFrames } = useSessionFrames(sessionId);
  const { appendFrame } = useAutoLog();
  const createPort = dependencies.createPort ?? createTauriSerialPort;
  const closeGraceMs = dependencies.writeCloseGraceMs ?? SERIAL_WRITE_CLOSE_GRACE_MS;

  const port = shallowRef<SerialPortAdapter | null>(null);
  const isConnecting = ref(false);
  const isConnected = ref(false);
  const error = ref<string | null>(null);
  const totalDroppedBytes = ref(0);
  const reconnecting = ref(false);

  const rxQueue = new SerialRxQueue({
    maxBytes: MAX_RX_QUEUE_BYTES,
    maxChunks: MAX_RX_QUEUE_CHUNKS,
  });
  let rxOverflowErrorMessage: string | null = null;

  const isDocumentVisible =
    dependencies.isDocumentVisible ??
    (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const uiPublisher = new SerialUiPublishScheduler(
    () => {
      sessionStore.updateDroppedBytes(sessionId, totalDroppedBytes.value);
      publishFrames();
    },
    isDocumentVisible,
    dependencies.timerScheduler,
  );
  const rxDrain = new SerialRxDrainScheduler(
    () => ({ bytes: rxQueue.pendingBytes, chunks: rxQueue.pendingChunks }),
    flushQueue,
    dependencies.timerScheduler,
  );

  let activeConnection: ConnectionAttempt | null = null;
  let pendingAttempt: ConnectionAttempt | null = null;
  let connectionGeneration = 0;
  let intentionalClose = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let breakInFlight = false;

  const rawByteObservers = new Set<(bytes: Uint8Array) => void>();

  const onVisibilityChange = () => uiPublisher.visibilityChanged();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  onScopeDispose(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    void stop();
  });

  function assertCurrent(attempt: ConnectionAttempt): void {
    if (attempt.generation !== connectionGeneration || intentionalClose || attempt.disconnected) {
      throw new StaleConnectionError();
    }
  }

  async function openConnection(generation: number): Promise<ConnectionAttempt> {
    const attempt: ConnectionAttempt = {
      generation,
      port: createPort({
        path: portName,
        baudRate: config.baudRate,
        dataBits: mapDataBits(config.dataBits),
        stopBits: mapStopBits(config.stopBits),
        parity: mapParity(config.parity),
        flowControl: mapFlowControl(config.flowControl),
      }),
      watch: null,
      scheduler: null,
      committed: false,
      disconnected: false,
    };
    pendingAttempt = attempt;

    try {
      await attempt.port.open();
      assertCurrent(attempt);
      attempt.watch = await attempt.port.watch(
        {
          onData(data) {
            if (attempt.generation !== connectionGeneration || attempt.disconnected) return;
            enqueueReceivedBytes(data instanceof Uint8Array ? data : encodeUtf8(data));
          },
          onDisconnect() {
            attempt.disconnected = true;
            void handleDisconnect(attempt);
          },
          onError(message) {
            if (attempt.generation === connectionGeneration) {
              logger.warn('serial watch error for', portName, message);
            }
          },
        },
        { decode: false },
      );
      assertCurrent(attempt);

      // Unsupported control lines are non-fatal, but a generation change at
      // either await boundary still invalidates the whole transaction.
      try {
        await attempt.port.writeDataTerminalReady(config.dtr);
      } catch (controlError) {
        assertCurrent(attempt);
        logger.debug('serial DTR write unsupported for', portName, controlError);
      }
      assertCurrent(attempt);
      try {
        await attempt.port.writeRequestToSend(config.rts);
      } catch (controlError) {
        assertCurrent(attempt);
        logger.debug('serial RTS write unsupported for', portName, controlError);
      }
      assertCurrent(attempt);

      attempt.scheduler = new SerialWriteScheduler((chunk) => attempt.port.writeBinary(chunk));
      attempt.committed = true;
      activeConnection = attempt;
      port.value = attempt.port;
      return attempt;
    } catch (openError) {
      await cleanupAttempt(attempt);
      throw openError;
    } finally {
      if (pendingAttempt === attempt) pendingAttempt = null;
    }
  }

  async function start(): Promise<boolean> {
    const generation = ++connectionGeneration;
    intentionalClose = false;
    isConnecting.value = true;
    error.value = null;
    stopReconnect();

    flushRxAndPublish();
    rxDrain.cancel();
    uiPublisher.cancel();
    rxQueue.reset();
    rxOverflowErrorMessage = null;
    totalDroppedBytes.value = 0;
    sessionStore.updateDroppedBytes(sessionId, 0);

    const supersededAttempt = pendingAttempt;
    if (supersededAttempt) requestCandidateClose(supersededAttempt);
    const previous = detachActiveConnection();
    if (previous) await shutdownConnection(previous, closeGraceMs);
    if (generation !== connectionGeneration || intentionalClose)
      return finishStart(generation, false);

    try {
      await openConnection(generation);
      if (generation !== connectionGeneration || intentionalClose) {
        const stale = detachActiveConnection();
        if (stale) await shutdownConnection(stale, 0);
        return finishStart(generation, false);
      }
      isConnected.value = true;
      sessionStore.setConnected(sessionId, true);
      return finishStart(generation, true);
    } catch (openError) {
      if (generation === connectionGeneration && !intentionalClose) {
        if (!(openError instanceof StaleConnectionError)) {
          logger.warn('serial open failed for', portName, openError);
          error.value = String(openError);
        }
        isConnected.value = false;
        sessionStore.setConnected(sessionId, false);
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

    // Invalidate every callback and queued lifecycle continuation from this
    // connection before exposing the disconnected state.
    connectionGeneration += 1;
    activeConnection = null;
    port.value = null;
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
    flushRxAndPublish();
    await shutdownConnection(attempt, 0);

    if (intentionalClose) return;
    if (options?.autoReconnect?.()) {
      if (reconnecting.value) scheduleReconnect();
      else startReconnect();
    } else {
      options?.onDisconnect?.();
    }
  }

  function startReconnect(): void {
    if (reconnecting.value || intentionalClose) return;
    reconnecting.value = true;
    reconnectAttempts = 0;
    options?.onReconnecting?.();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || intentionalClose) return;
    reconnectTimer = setTimeout(attemptReconnect, RECONNECT_INTERVAL_MS);
  }

  async function attemptReconnect(): Promise<void> {
    reconnectTimer = null;
    if (intentionalClose) {
      reconnecting.value = false;
      return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      reconnecting.value = false;
      options?.onDisconnect?.();
      return;
    }

    const generation = ++connectionGeneration;
    try {
      await openConnection(generation);
      if (generation !== connectionGeneration || intentionalClose) {
        const stale = detachActiveConnection();
        if (stale) await shutdownConnection(stale, 0);
        return;
      }
      reconnecting.value = false;
      isConnected.value = true;
      error.value = null;
      rxOverflowErrorMessage = null;
      sessionStore.setConnected(sessionId, true);
      options?.onReconnected?.();
    } catch {
      if (generation === connectionGeneration && !intentionalClose) scheduleReconnect();
    }
  }

  function stopReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
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
      rxOverflowErrorMessage = t('serial.error.rxOverflow', {
        bytes: formatBytes(result.droppedSinceDrain),
      });
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
    const frame = addFrame(
      { direction: 'RX', data: concatUint8Arrays(chunks, byteLength) },
      { publish: false },
    );
    if (!frame) return;
    appendFrame(sessionId, frame);
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
    if (!built.ok) return failedSend(built.reason, 0);
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
    if (!connection?.scheduler || !isConnected.value) {
      return failedSend('not-connected', payload.length);
    }
    const result = await connection.scheduler.enqueue(payload, writeOptions);
    if (result.bytesWritten > 0) {
      const txFrame = addFrame({
        direction: 'TX',
        data: payload.slice(0, result.bytesWritten),
        txStatus: result.status === 'complete' ? 'complete' : 'partial-unknown',
        requestedBytes: result.requestedBytes,
      });
      if (txFrame) appendFrame(sessionId, txFrame);
    }
    if (!result.ok && result.reason === 'write-error') {
      logger.warn('serial write failed on', portName, result.error ?? result.reason);
    }
    return result;
  }

  function rawBytes(callback: (bytes: Uint8Array) => void): () => void {
    rawByteObservers.add(callback);
    return () => rawByteObservers.delete(callback);
  }

  async function sendBreak(durationMs = 250): Promise<boolean> {
    const connection = activeConnection;
    if (breakInFlight || !connection) return false;
    breakInFlight = true;
    try {
      await connection.port.setBreak();
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      await connection.port.clearBreak();
      return connection === activeConnection;
    } catch (breakError) {
      logger.warn('serial setBreak/clearBreak failed on', portName, breakError);
      return false;
    } finally {
      breakInFlight = false;
    }
  }

  function detachActiveConnection(): ConnectionAttempt | null {
    const connection = activeConnection;
    activeConnection = null;
    port.value = null;
    return connection;
  }

  function requestCandidateClose(attempt: ConnectionAttempt): void {
    void attempt.port.close().catch(() => undefined);
  }

  async function cleanupAttempt(attempt: ConnectionAttempt): Promise<void> {
    const watch = attempt.watch;
    attempt.watch = null;
    await Promise.allSettled([watch?.unwatch() ?? Promise.resolve(), attempt.port.close()]);
  }

  async function shutdownConnection(connection: ConnectionAttempt, graceMs: number): Promise<void> {
    const writeShutdown = await connection.scheduler?.shutdown(graceMs);
    if (writeShutdown?.timedOut) {
      // A native write can remain pending after its logical task has been
      // rejected.  Serial plugin v3 provides a path-scoped hard close for
      // that case; always continue with watch/port cleanup if it fails.
      await connection.port.forceClose?.().catch(() => undefined);
    }
    await cleanupAttempt(connection);
  }

  async function stop(): Promise<void> {
    const generation = ++connectionGeneration;
    intentionalClose = true;
    stopReconnect();
    isConnecting.value = false;

    const opening = pendingAttempt;
    if (opening) requestCandidateClose(opening);
    const connection = detachActiveConnection();

    flushRxAndPublish();
    rxDrain.cancel();
    uiPublisher.cancel();
    rxQueue.clearPending();
    error.value = null;

    if (connection) await shutdownConnection(connection, closeGraceMs);
    if (generation !== connectionGeneration) return;
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
  }

  return {
    port,
    isConnecting,
    isConnected,
    reconnecting,
    error,
    totalDroppedBytes,
    start,
    send,
    sendBytes,
    sendBreak,
    rawBytes,
    stop,
  };
}
