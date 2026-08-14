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
import { normalizeRxFrameGapMs } from '../lib/serial-framing';
import { MAX_INPUT_SIZE } from '../types';
import type {
  IpcError,
  PortLeaseConflict,
  SerialDrainCompletion,
} from '../generated/ipc-contracts';
import type { DataFrame, PortConfig, SerialSendResult, SerialWriteOptions } from '../types';
import {
  PortLeaseInUseError,
  type FrozenPortLeaseGrant,
  type HeldPortLeaseState,
  type PortLeaseClient,
} from '../features/serial/application/port-lease-registry';

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
  /** Fired once per connection when RX first overflows. */
  onOverflow?: (totalDroppedBytes: number) => void;
  autoReconnect?: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onRxFrame?: (frame: DataFrame) => void;
}

export interface SerialConnectionDependencies {
  /** Required process-level ownership boundary; native open never runs without it. */
  leaseClient: PortLeaseClient;
  /** Bounded display label copied into conflict navigation metadata. */
  sessionName: string | (() => string);
  createPort?: SerialPortFactory;
  timerScheduler?: SerialTimerScheduler;
  isDocumentVisible?: () => boolean;
  writeCloseGraceMs?: number;
}

export interface SerialConnectionFailure {
  readonly error: Readonly<IpcError>;
  readonly category:
    'port-in-use' | 'invalid-port' | 'device-missing' | 'permission-denied' | 'backend-failure';
  readonly conflict?: Readonly<PortLeaseConflict>;
}

/**
 * Native shutdown evidence returned to the application shutdown coordinator.
 *
 * `rxDrainGuarantee` is positive only after the native hub and driver have
 * remained empty for the bounded idle gap and all already-queued renderer
 * Channel events have been yielded and published.
 */
export interface SerialStopResult {
  readonly watch: 'not-installed' | 'unwatch-acknowledged' | 'unwatch-failed';
  readonly rxDrainGuarantee: 'guaranteed' | 'not-guaranteed';
  readonly rxDrainStatus:
    | SerialDrainCompletion
    | 'no-active-connection'
    | 'watch-not-installed'
    | 'unwatch-failed'
    | 'native-command-unavailable'
    | 'native-command-failed'
    | 'channel-yield-failed'
    | 'renderer-overflow';
  readonly nativeDrainedBytes: number;
  readonly pendingOpen: 'none' | 'settled' | 'unsettled';
  readonly portClose:
    | 'no-active-port'
    | 'close-acknowledged'
    | 'force-close-acknowledged'
    | 'close-failed'
    | 'pending-open-unsettled';
}

type PortCloseEvidence = Exclude<SerialStopResult['portClose'], 'pending-open-unsettled'>;

type SerialRxStopEvidence = Readonly<
  Pick<SerialStopResult, 'watch' | 'rxDrainGuarantee' | 'rxDrainStatus' | 'nativeDrainedBytes'>
>;

interface ConnectionAttempt {
  generation: number;
  target: Readonly<{ portName: string; config: Readonly<PortConfig> }>;
  port: SerialPortAdapter;
  watch: SerialWatchHandleAdapter | null;
  scheduler: SerialWriteScheduler | null;
  committed: boolean;
  disconnected: boolean;
  acceptingRx: boolean;
  readonly settled: Promise<void>;
  settle(): void;
  closeEvidence: PortCloseEvidence;
  watchInstalled: boolean;
  rxStopEvidence: SerialRxStopEvidence | null;
  shutdownTask: Promise<PortCloseEvidence> | null;
}

interface GenerationLease {
  readonly generation: number;
  readonly grant: FrozenPortLeaseGrant;
}

class StaleConnectionError extends Error {
  constructor() {
    super('stale serial connection generation');
  }
}

type SendFailureReason = 'empty' | 'bad-hex' | 'too-large' | 'not-connected';

const SERIAL_SEND_OPERATION = 'serial_send';
const SERIAL_OPEN_OPERATION = 'serial_open';

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

function createConnectionFailure(
  code: Extract<
    IpcError['code'],
    'PORT_IN_USE' | 'INVALID_INPUT' | 'SERIAL_DISCONNECTED' | 'IO_PERMISSION_DENIED' | 'BUSY'
  >,
  messageKey: string,
  category: SerialConnectionFailure['category'],
  conflict?: Readonly<PortLeaseConflict>,
): SerialConnectionFailure {
  const ipcError = Object.freeze<IpcError>({
    code,
    messageKey,
    retryable: code === 'SERIAL_DISCONNECTED' || code === 'BUSY',
    operation: SERIAL_OPEN_OPERATION,
  });
  return Object.freeze({
    error: ipcError,
    category,
    ...(conflict ? { conflict: Object.freeze({ ...conflict }) } : {}),
  });
}

export function classifyOpenFailure(error: unknown): SerialConnectionFailure {
  const ipcCode =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  if (ipcCode === 'IO_PERMISSION_DENIED') {
    return createConnectionFailure(
      'IO_PERMISSION_DENIED',
      'error.io_permission_denied',
      'permission-denied',
    );
  }
  if (ipcCode === 'SERIAL_DISCONNECTED') {
    return createConnectionFailure(
      'SERIAL_DISCONNECTED',
      'error.serial_disconnected',
      'device-missing',
    );
  }
  if (ipcCode === 'INVALID_INPUT') {
    return createConnectionFailure('INVALID_INPUT', 'error.invalid_input', 'invalid-port');
  }
  const stableText = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalized = stableText.toLowerCase();
  if (/permission|access.?denied|eacces|eperm/.test(normalized)) {
    return createConnectionFailure(
      'IO_PERMISSION_DENIED',
      'error.io_permission_denied',
      'permission-denied',
    );
  }
  if (/not.?found|no such|disconnected|enoent|device.*missing/.test(normalized)) {
    return createConnectionFailure(
      'SERIAL_DISCONNECTED',
      'error.serial_disconnected',
      'device-missing',
    );
  }
  if (/invalid.*(?:port|path)|bad.*(?:port|path)|typeerror|dataerror/.test(normalized)) {
    return createConnectionFailure('INVALID_INPUT', 'error.invalid_input', 'invalid-port');
  }
  return createConnectionFailure('BUSY', 'error.busy', 'backend-failure');
}

export function serialConnectionFailureMessage(failure: SerialConnectionFailure): string {
  switch (failure.category) {
    case 'port-in-use':
      return t('serial.open.portInUse', {
        session: failure.conflict?.ownerSessionName ?? failure.conflict?.ownerSessionId ?? '',
      });
    case 'device-missing':
      return t('serial.open.deviceMissing');
    case 'permission-denied':
      return t('serial.open.permissionDenied');
    case 'backend-failure':
      return t('serial.open.backendFailure');
    case 'invalid-port':
      return t('error.invalid_input');
  }
}

export function useSerialConnection(
  sessionId: string,
  portName: string | (() => string),
  config: PortConfig | (() => PortConfig),
  options: SerialConnectionOptions | undefined,
  dependencies: SerialConnectionDependencies,
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
  const connectionFailure = shallowRef<SerialConnectionFailure | null>(null);
  const totalDroppedBytes = ref(0);
  const reconnecting = ref(false);
  const isClosing = ref(false);

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
  let rxDrain = createRxDrain(readPortConfig().rxFrameGapMs);

  let activeConnection: ConnectionAttempt | null = null;
  let pendingAttempt: ConnectionAttempt | null = null;
  let connectionGeneration = 0;
  let intentionalClose = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let breakInFlight = false;
  let heldLease: GenerationLease | null = null;
  let closingPromise: Promise<SerialStopResult> | null = null;
  // Once a watched connection cannot prove its final RX boundary, no later
  // empty stop may turn that historical data-loss risk into a safe result.
  // The latch lives for this runtime instance and is cleared only when the
  // runtime itself is discarded (or the user explicitly forces shutdown).
  let latchedUnsafeRxEvidence: SerialRxStopEvidence | null = null;

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

  function readSessionName(): string {
    const value =
      typeof dependencies.sessionName === 'function'
        ? dependencies.sessionName()
        : dependencies.sessionName;
    return value.slice(0, 256);
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

  function acquireLease(
    generation: number,
    target: Readonly<{ portName: string; config: Readonly<PortConfig> }>,
  ): boolean {
    try {
      const previousLease = heldLease;
      let grant = dependencies.leaseClient.acquire(target.portName, sessionId, readSessionName());
      // A previous stop may still be closing native resources. Releasing its
      // terminal identifier and acquiring a new one is synchronous, so no
      // competing session can enter between these registry operations.
      if (grant.state === 'closing' || grant.state === 'failed') {
        const failure = createConnectionFailure('BUSY', 'error.busy', 'backend-failure');
        connectionFailure.value = failure;
        error.value = failure.error.code;
        intentionalClose = true;
        return false;
      }
      if (grant.state === 'connected') {
        grant = dependencies.leaseClient.transition(grant.leaseId, sessionId, 'reconnecting');
      }
      heldLease = { generation, grant };
      if (previousLease && previousLease.grant.leaseId !== grant.leaseId) {
        dependencies.leaseClient.release(previousLease.grant.leaseId, sessionId);
      }
      return true;
    } catch (leaseError) {
      const failure =
        leaseError instanceof PortLeaseInUseError
          ? createConnectionFailure(
              'PORT_IN_USE',
              'error.port_in_use',
              'port-in-use',
              leaseError.conflict,
            )
          : createConnectionFailure('INVALID_INPUT', 'error.invalid_input', 'invalid-port');
      connectionFailure.value = failure;
      error.value = failure.error.code;
      intentionalClose = true;
      return false;
    }
  }

  function adoptLeaseGeneration(generation: number): void {
    if (heldLease) heldLease = { generation, grant: heldLease.grant };
  }

  function transitionLease(generation: number, state: HeldPortLeaseState): boolean {
    const lease = heldLease;
    if (!lease || lease.generation !== generation) return false;
    try {
      const grant = dependencies.leaseClient.transition(lease.grant.leaseId, sessionId, state);
      if (heldLease === lease) heldLease = { generation, grant };
      return heldLease?.generation === generation && heldLease.grant.leaseId === grant.leaseId;
    } catch {
      return false;
    }
  }

  function detachLease(generation?: number): GenerationLease | null {
    const lease = heldLease;
    if (!lease || (generation !== undefined && lease.generation !== generation)) return null;
    heldLease = null;
    return lease;
  }

  function transitionDetachedLease(lease: GenerationLease, state: 'failed' | 'closing'): void {
    if (lease.grant.state === 'failed' || lease.grant.state === 'closing') return;
    try {
      dependencies.leaseClient.transition(lease.grant.leaseId, sessionId, state);
    } catch {
      // Release remains authoritative even if a stale transition raced it.
    }
  }

  function failAndReleaseLease(generation: number): void {
    if (activeConnection && !isPortCloseProven(activeConnection.closeEvidence)) {
      activeConnection.disconnected = true;
      transitionLease(generation, 'closing');
      return;
    }
    const lease = detachLease(generation);
    if (!lease) return;
    transitionDetachedLease(lease, 'failed');
    dependencies.leaseClient.release(lease.grant.leaseId, sessionId);
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
      sessionStore.setConnected(sessionId, false);
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
    adoptLeaseGeneration(generation);
    resetRxDrain(target.config.rxFrameGapMs);
    if (!acquireLease(generation, target)) {
      failAndReleaseLease(generation);
      return finishStart(generation, false);
    }

    flushRxAndPublish();
    rxDrain.cancel();
    uiPublisher.cancel();
    rxQueue.reset();
    rxOverflowErrorMessage = null;
    totalDroppedBytes.value = 0;
    sessionStore.updateDroppedBytes(sessionId, 0);

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
      sessionStore.setConnected(sessionId, true);
      if (!transitionLease(generation, 'connected')) {
        const connected = detachActiveConnection();
        if (connected) {
          const closeEvidence = await shutdownConnection(connected, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(connected, generation);
            isConnected.value = false;
            sessionStore.setConnected(sessionId, false);
            return finishStart(generation, false);
          }
        }
        failAndReleaseLease(generation);
        isConnected.value = false;
        sessionStore.setConnected(sessionId, false);
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
        sessionStore.setConnected(sessionId, false);
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
    sessionStore.setConnected(sessionId, false);
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
    adoptLeaseGeneration(connectionGeneration);
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
    if (!transitionLease(connectionGeneration, 'reconnecting')) {
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
    reconnectTimer = setTimeout(attemptReconnect, RECONNECT_INTERVAL_MS);
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
    adoptLeaseGeneration(generation);
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
      if (!transitionLease(generation, 'connected')) {
        const connected = detachActiveConnection();
        if (connected) {
          const closeEvidence = await shutdownConnection(connected, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(connected, generation);
            reconnecting.value = false;
            isConnected.value = false;
            sessionStore.setConnected(sessionId, false);
            options?.onDisconnect?.();
            return;
          }
        }
        failAndReleaseLease(generation);
        reconnecting.value = false;
        isConnected.value = false;
        sessionStore.setConnected(sessionId, false);
        options?.onDisconnect?.();
        return;
      }
      sessionStore.setConnected(sessionId, true);
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
      const txFrame = addFrame({
        direction: 'TX',
        data: payload.slice(0, result.sentBytes),
        txStatus: result.outcome === 'complete' ? 'complete' : 'partial-unknown',
        requestedBytes: result.requestedBytes,
      });
      if (txFrame) appendFrame(sessionId, txFrame);
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
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      await connection.port.clearBreak();
      return connection === activeConnection;
    } catch (breakError) {
      logger.warn('serial setBreak/clearBreak failed on', connection.target.portName, breakError);
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

  function retainUnclosedConnection(attempt: ConnectionAttempt, leaseGeneration: number): void {
    attempt.disconnected = true;
    if (pendingAttempt === attempt) pendingAttempt = null;
    activeConnection = attempt;
    port.value = null;
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
    transitionLease(leaseGeneration, 'closing');
  }

  async function closePort(attempt: ConnectionAttempt): Promise<PortCloseEvidence> {
    if (isPortCloseProven(attempt.closeEvidence)) {
      return attempt.closeEvidence;
    }
    if (await succeedsWithin(attempt.port.close(), closeGraceMs)) {
      attempt.closeEvidence = 'close-acknowledged';
    } else {
      if (
        attempt.port.forceClose &&
        (await succeedsWithin(attempt.port.forceClose(), closeGraceMs))
      ) {
        attempt.closeEvidence = 'force-close-acknowledged';
      } else if (!isPortCloseProven(attempt.closeEvidence)) {
        attempt.closeEvidence = 'close-failed';
      }
    }
    return attempt.closeEvidence;
  }

  function rememberUnsafeRxEvidence(evidence: SerialRxStopEvidence): void {
    if (evidence.rxDrainGuarantee === 'not-guaranteed' && !latchedUnsafeRxEvidence) {
      latchedUnsafeRxEvidence = Object.freeze({ ...evidence });
    }
  }

  async function drainAttemptRx(attempt: ConnectionAttempt): Promise<SerialRxStopEvidence> {
    if (attempt.rxStopEvidence) return attempt.rxStopEvidence;
    if (!attempt.watchInstalled) {
      attempt.acceptingRx = false;
      attempt.rxStopEvidence = Object.freeze({
        watch: 'not-installed',
        rxDrainGuarantee: 'guaranteed',
        rxDrainStatus: 'no-active-connection',
        nativeDrainedBytes: 0,
      });
      return attempt.rxStopEvidence;
    }

    let watch: SerialStopResult['watch'] = 'not-installed';
    let rxDrainGuaranteed = false;
    let rxDrainStatus: SerialStopResult['rxDrainStatus'] = 'watch-not-installed';
    let nativeDrainedBytes = 0;
    const droppedBeforeDrain = totalDroppedBytes.value;
    const watchHandle = attempt.watch;
    attempt.watch = null;
    if (watchHandle) {
      try {
        await watchHandle.unwatch();
        watch = 'unwatch-acknowledged';
      } catch {
        watch = 'unwatch-failed';
        rxDrainStatus = 'unwatch-failed';
        logger.warn('serial watch unwatch failed for', attempt.target.portName);
      }
    }

    if (watch === 'unwatch-acknowledged') {
      if (attempt.port.drainNativeInput) {
        try {
          const nativeDrain = await attempt.port.drainNativeInput();
          nativeDrainedBytes = nativeDrain.bytes.length;
          if (nativeDrain.bytes.length > 0) {
            enqueueReceivedBytes(Uint8Array.from(nativeDrain.bytes));
          }
          rxDrainGuaranteed =
            nativeDrain.guaranteed && nativeDrain.completion === 'idle-gap-observed';
          rxDrainStatus = nativeDrain.completion;
        } catch {
          rxDrainStatus = 'native-command-failed';
          logger.warn('native serial drain command failed');
        }
      } else {
        rxDrainStatus = 'native-command-unavailable';
      }
    }

    // A native response can overtake Channel tasks already queued for this
    // generation. Yield them before the final renderer flush and before close.
    try {
      await attempt.port.yieldQueuedChannelEvents?.();
    } catch {
      rxDrainGuaranteed = false;
      rxDrainStatus = 'channel-yield-failed';
      logger.warn('serial Channel event yield failed during stop');
    }
    flushRxAndPublish();
    // Only after the native idle-gap response and queued Channel yield have
    // been published may late callbacks from this attempt be discarded.
    attempt.acceptingRx = false;
    if (totalDroppedBytes.value > droppedBeforeDrain) {
      rxDrainGuaranteed = false;
      rxDrainStatus = 'renderer-overflow';
    }
    attempt.rxStopEvidence = Object.freeze({
      watch,
      rxDrainGuarantee: rxDrainGuaranteed ? 'guaranteed' : 'not-guaranteed',
      rxDrainStatus,
      nativeDrainedBytes,
    });
    return attempt.rxStopEvidence;
  }

  async function cleanupAttempt(attempt: ConnectionAttempt): Promise<PortCloseEvidence> {
    return shutdownConnection(attempt, closeGraceMs);
  }

  async function shutdownConnection(
    connection: ConnectionAttempt,
    graceMs: number,
  ): Promise<PortCloseEvidence> {
    if (connection.shutdownTask) return connection.shutdownTask;
    const task = (async (): Promise<PortCloseEvidence> => {
      let writeTimedOut = false;
      try {
        writeTimedOut = (await connection.scheduler?.shutdown(graceMs))?.timedOut ?? false;
      } catch {
        logger.warn('serial write scheduler shutdown failed for', connection.target.portName);
      }
      rememberUnsafeRxEvidence(await drainAttemptRx(connection));
      if (
        writeTimedOut &&
        connection.port.forceClose &&
        (await succeedsWithin(connection.port.forceClose(), closeGraceMs))
      ) {
        connection.closeEvidence = 'force-close-acknowledged';
        return connection.closeEvidence;
      }
      return closePort(connection);
    })();
    connection.shutdownTask = task;
    try {
      return await task;
    } finally {
      if (connection.shutdownTask === task) connection.shutdownTask = null;
    }
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
    const lease = detachLease();
    if (lease) transitionDetachedLease(lease, 'closing');

    let rxEvidence: SerialRxStopEvidence =
      latchedUnsafeRxEvidence ??
      connection?.rxStopEvidence ??
      opening?.rxStopEvidence ??
      (opening
        ? Object.freeze({
            watch: 'not-installed',
            rxDrainGuarantee: 'not-guaranteed',
            rxDrainStatus: 'watch-not-installed',
            nativeDrainedBytes: 0,
          })
        : Object.freeze({
            watch: 'not-installed',
            rxDrainGuarantee: 'guaranteed',
            rxDrainStatus: 'no-active-connection',
            nativeDrainedBytes: 0,
          }));
    let pendingOpen: SerialStopResult['pendingOpen'] = opening ? 'unsettled' : 'none';
    let portClose: SerialStopResult['portClose'] =
      connection || opening ? 'close-failed' : 'no-active-port';
    let physicalCloseProven = connection === null && opening === null;
    try {
      if (opening) {
        if (await settlesWithin(opening.settled, closeGraceMs)) {
          pendingOpen = 'settled';
          rxEvidence = opening.rxStopEvidence ?? rxEvidence;
          rememberUnsafeRxEvidence(rxEvidence);
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
        rememberUnsafeRxEvidence(rxEvidence);
        dependencies.leaseClient.release(lease.grant.leaseId, sessionId);
      } else if (lease && opening && pendingOpen === 'unsettled') {
        pendingAttempt = opening;
        heldLease = { generation: connectionGeneration, grant: lease.grant };
        // Fail closed while native open is unresolved. Only release the
        // process lease after the stale transaction has settled and its final
        // cleanup produced positive close evidence.
        void opening.settled.then(() => {
          if (isPortCloseProven(opening.closeEvidence)) {
            const settledEvidence = opening.rxStopEvidence;
            if (settledEvidence) rememberUnsafeRxEvidence(settledEvidence);
            dependencies.leaseClient.release(lease.grant.leaseId, sessionId);
            if (heldLease?.grant.leaseId === lease.grant.leaseId) heldLease = null;
            if (pendingAttempt === opening) pendingAttempt = null;
          } else {
            retainUnclosedConnection(opening, connectionGeneration);
          }
        });
      } else if (lease && !physicalCloseProven) {
        heldLease = { generation: connectionGeneration, grant: lease.grant };
        const unresolvedAttempt = connection ?? opening;
        if (unresolvedAttempt && pendingOpen !== 'unsettled') {
          retainUnclosedConnection(unresolvedAttempt, connectionGeneration);
        }
      }
      isConnected.value = false;
      sessionStore.setConnected(sessionId, false);
      isClosing.value = false;
    }

    const finalRxEvidence = latchedUnsafeRxEvidence ?? rxEvidence;
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

  return {
    port,
    isConnecting,
    isConnected,
    isClosing,
    reconnecting,
    error,
    connectionFailure,
    totalDroppedBytes,
    start,
    send,
    sendBytes,
    sendBreak,
    rawBytes,
    stop,
  };
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isPortCloseProven(status: SerialStopResult['portClose']): boolean {
  return (
    status === 'no-active-port' ||
    status === 'close-acknowledged' ||
    status === 'force-close-acknowledged'
  );
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    void promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function succeedsWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    void promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
