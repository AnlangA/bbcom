import { encodeUtf8 } from '@/lib/format';
import { mapDataBits, mapFlowControl, mapParity, mapStopBits } from '@/lib/serial-config';
import { SerialWriteScheduler } from '@/lib/serial-write-scheduler';
import { logger } from '@/lib/logger';
import type { PortConfig } from '@/types';
import { classifyOpenFailure } from './serial-connection-failure';
import type { PortLeaseController } from './serial-port-lease';
import type { SerialPortFactory } from './serial-port';
import {
  isPortCloseProven,
  type ConnectionAttempt,
  type PortCloseEvidence,
} from './serial-shutdown-evidence';
import {
  StaleConnectionError,
  type SerialConnectionRuntimeRefs,
} from './serial-connection-runtime';
import type {
  PortConfigSource,
  PortNameSource,
  SerialConnectionOptions,
  SerialConnectionSink,
} from './serial-connection-types';
import type { ReconnectPolicy } from './reconnect-policy';
import type { RxPipeline } from './rx-pipeline';

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface ConnectLifecycleDeps extends SerialConnectionRuntimeRefs {
  sessionId: string;
  portName: PortNameSource;
  config: PortConfigSource;
  options: SerialConnectionOptions | undefined;
  sink: SerialConnectionSink;
  createPort: SerialPortFactory;
  closeGraceMs: number;
  leases: PortLeaseController;
  rxPipeline: RxPipeline;
  reconnectPolicy: ReconnectPolicy;
  shutdownConnection(connection: ConnectionAttempt, graceMs: number): Promise<PortCloseEvidence>;
  revokeSerialTransaction(generation: number): Promise<boolean> | null;
  failAndReleaseLease(generation: number): void;
  synchronizeConnection(): Promise<void>;
  onOpenCommitted(attempt: ConnectionAttempt): void;
}

export interface ConnectLifecycle {
  readPortConfig(): Readonly<PortConfig>;
  readConnectionTarget(): Readonly<{ portName: string; config: Readonly<PortConfig> }>;
  openConnection(
    generation: number,
    target: Readonly<{ portName: string; config: Readonly<PortConfig> }>,
  ): Promise<ConnectionAttempt>;
  start(): Promise<boolean>;
  handleDisconnect(attempt: ConnectionAttempt): Promise<void>;
  detachActiveConnection(): ConnectionAttempt | null;
  retainUnclosedConnection(attempt: ConnectionAttempt, leaseGeneration: number): void;
  cleanupAttempt(attempt: ConnectionAttempt): Promise<PortCloseEvidence>;
}

export function createConnectLifecycle(deps: ConnectLifecycleDeps): ConnectLifecycle {
  const {
    state,
    sessionId,
    portName,
    config,
    options,
    sink,
    createPort,
    closeGraceMs,
    leases,
    rxPipeline,
    reconnectPolicy,
    shutdownConnection,
    revokeSerialTransaction,
    failAndReleaseLease,
    synchronizeConnection,
    onOpenCommitted,
  } = deps;

  function assertCurrent(attempt: ConnectionAttempt): void {
    if (
      attempt.generation !== state.connectionGeneration ||
      state.intentionalClose ||
      attempt.disconnected
    ) {
      throw new StaleConnectionError();
    }
  }

  function readPortConfig(): Readonly<PortConfig> {
    const current = typeof config === 'function' ? config() : config;
    return Object.freeze({ ...current });
  }

  function readConnectionTarget(): Readonly<{ portName: string; config: Readonly<PortConfig> }> {
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
    state.pendingAttempt = attempt;

    try {
      await attempt.port.open();
      assertCurrent(attempt);
      attempt.watch = await attempt.port.watch(
        {
          onData(data) {
            if (!attempt.acceptingRx) return;
            rxPipeline.enqueueReceivedBytes(
              data instanceof Uint8Array ? data : encodeUtf8(data),
              attempt.generation,
            );
          },
          onDisconnect() {
            if (
              attempt.shutdownTask ||
              (state.isClosing.value && attempt.generation === state.connectionGeneration)
            ) {
              return;
            }
            attempt.disconnected = true;
            void handleDisconnect(attempt);
          },
          onError(message) {
            if (attempt.generation === state.connectionGeneration) {
              logger.warn('serial watch error for', target.portName, message);
            }
          },
        },
        {
          decode: false,
          serialDataFlushIntervalMs: 0,
        },
      );
      attempt.watchInstalled = true;
      assertCurrent(attempt);

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

      attempt.scheduler = new SerialWriteScheduler(
        (chunk) => attempt.port.writeBinary(chunk),
        {},
        { authorize: (admission) => deps.serialTransactions.authorizesSchedulerWrite(admission) },
      );
      attempt.committed = true;
      state.activeConnection = attempt;
      onOpenCommitted(attempt);
      if (state.pendingAttempt === attempt) state.pendingAttempt = null;
      state.port.value = attempt.port;
      return attempt;
    } catch (openError) {
      let closeEvidence: PortCloseEvidence;
      try {
        closeEvidence = await cleanupAttempt(attempt);
      } catch {
        logger.warn('serial candidate rollback failed for', target.portName);
        state.pendingAttempt = attempt;
        retainUnclosedConnection(attempt, generation);
        throw openError;
      }
      if (!isPortCloseProven(closeEvidence)) {
        state.pendingAttempt = attempt;
        retainUnclosedConnection(attempt, generation);
      }
      throw openError;
    } finally {
      if (
        !attempt.committed &&
        state.pendingAttempt === attempt &&
        isPortCloseProven(attempt.closeEvidence)
      ) {
        state.pendingAttempt = null;
      }
      attempt.settle();
    }
  }

  function finishStart(generation: number, result: boolean): boolean {
    if (generation === state.connectionGeneration) state.isConnecting.value = false;
    return result;
  }

  async function start(): Promise<boolean> {
    if (
      state.isConnecting.value ||
      state.isClosing.value ||
      state.pendingAttempt !== null ||
      (state.activeConnection !== null &&
        state.activeConnection.disconnected &&
        !isPortCloseProven(state.activeConnection.closeEvidence))
    ) {
      return false;
    }
    state.intentionalClose = false;
    state.isConnecting.value = true;
    state.error.value = null;
    state.connectionFailure.value = null;
    reconnectPolicy.stopReconnect();

    let target: ReturnType<typeof readConnectionTarget>;
    try {
      target = readConnectionTarget();
    } catch (targetError) {
      const failure = classifyOpenFailure(targetError);
      state.connectionFailure.value = failure;
      state.error.value = failure.error.code;
      state.intentionalClose = true;
      state.isConnecting.value = false;
      return false;
    }

    const previous = state.activeConnection;
    if (previous) {
      state.isClosing.value = true;
      state.port.value = null;
      state.isConnected.value = false;
      sink.setConnected(sessionId, false);
      const revocation = revokeSerialTransaction(previous.generation);
      if (revocation) await revocation;
      try {
        const closeEvidence = await shutdownConnection(previous, closeGraceMs);
        if (!isPortCloseProven(closeEvidence)) {
          retainUnclosedConnection(previous, state.connectionGeneration);
          state.isConnecting.value = false;
          if (!state.closingPromise) state.isClosing.value = false;
          return false;
        }
        if (previous.rxStopEvidence?.rxDrainGuarantee !== 'guaranteed') {
          if (state.activeConnection === previous) detachActiveConnection();
          failAndReleaseLease(state.connectionGeneration);
          state.isConnecting.value = false;
          if (!state.closingPromise) state.isClosing.value = false;
          return false;
        }
      } catch {
        retainUnclosedConnection(previous, state.connectionGeneration);
        state.isConnecting.value = false;
        if (!state.closingPromise) state.isClosing.value = false;
        return false;
      }
      if (
        state.intentionalClose ||
        state.activeConnection !== previous ||
        previous.generation !== state.connectionGeneration
      ) {
        state.isConnecting.value = false;
        if (!state.closingPromise) state.isClosing.value = false;
        return false;
      }
      detachActiveConnection();
      state.isClosing.value = false;
    }

    const generation = ++state.connectionGeneration;
    leases.adoptGeneration(generation);
    rxPipeline.resetRxDrain(target.config.rxFrameGapMs);
    if (!leases.acquire(generation, target.portName)) {
      failAndReleaseLease(generation);
      return finishStart(generation, false);
    }

    rxPipeline.flushRxAndPublish();
    rxPipeline.cancelRxDrain();
    rxPipeline.cancelUiPublisher();
    rxPipeline.resetQueue();
    state.totalDroppedBytes.value = 0;
    sink.updateDroppedBytes(sessionId, 0);

    if (generation !== state.connectionGeneration || state.intentionalClose) {
      return finishStart(generation, false);
    }

    try {
      await openConnection(generation, target);
      if (generation !== state.connectionGeneration || state.intentionalClose) {
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
      state.isConnected.value = true;
      sink.setConnected(sessionId, true);
      if (!leases.transition(generation, 'connected')) {
        const connected = detachActiveConnection();
        if (connected) {
          const closeEvidence = await shutdownConnection(connected, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(connected, generation);
            state.isConnected.value = false;
            sink.setConnected(sessionId, false);
            return finishStart(generation, false);
          }
        }
        failAndReleaseLease(generation);
        state.isConnected.value = false;
        sink.setConnected(sessionId, false);
        return finishStart(generation, false);
      }
      await synchronizeConnection();
      return finishStart(generation, true);
    } catch (openError) {
      if (generation === state.connectionGeneration && !state.intentionalClose) {
        if (!(openError instanceof StaleConnectionError)) {
          logger.warn('serial open failed for', target.portName, openError);
          const failure = classifyOpenFailure(openError);
          state.connectionFailure.value = failure;
          state.error.value = failure.error.code;
        }
        state.isConnected.value = false;
        sink.setConnected(sessionId, false);
        const unresolved = state.activeConnection;
        if (!unresolved || isPortCloseProven(unresolved.closeEvidence)) {
          failAndReleaseLease(generation);
        }
      }
      return finishStart(generation, false);
    }
  }

  async function handleDisconnect(attempt: ConnectionAttempt): Promise<void> {
    if (!attempt.committed) return;
    if (attempt.generation !== state.connectionGeneration || state.activeConnection !== attempt)
      return;

    state.isClosing.value = true;
    state.port.value = null;
    state.isConnected.value = false;
    sink.setConnected(sessionId, false);
    const revocation = revokeSerialTransaction(attempt.generation);
    if (revocation) await revocation;
    let closeEvidence: PortCloseEvidence;
    try {
      closeEvidence = await shutdownConnection(attempt, 0);
    } catch {
      logger.warn('serial disconnect shutdown failed for', attempt.target.portName);
      retainUnclosedConnection(attempt, state.connectionGeneration);
      if (!state.closingPromise) state.isClosing.value = false;
      return;
    }
    if (!isPortCloseProven(closeEvidence)) {
      retainUnclosedConnection(attempt, state.connectionGeneration);
      if (!state.closingPromise) state.isClosing.value = false;
      return;
    }
    if (state.intentionalClose || state.activeConnection !== attempt) return;

    detachActiveConnection();
    state.connectionGeneration += 1;
    leases.adoptGeneration(state.connectionGeneration);
    state.isClosing.value = false;
    if (attempt.rxStopEvidence?.rxDrainGuarantee !== 'guaranteed') {
      failAndReleaseLease(state.connectionGeneration);
      options?.onDisconnect?.();
      return;
    }

    if (options?.autoReconnect?.()) {
      if (state.reconnecting.value) reconnectPolicy.scheduleReconnect();
      else reconnectPolicy.startReconnect();
    } else {
      failAndReleaseLease(state.connectionGeneration);
      options?.onDisconnect?.();
    }
  }

  function detachActiveConnection(): ConnectionAttempt | null {
    const connection = state.activeConnection;
    state.activeConnection = null;
    state.port.value = null;
    return connection;
  }

  function retainUnclosedConnection(attempt: ConnectionAttempt, leaseGeneration: number): void {
    attempt.disconnected = true;
    if (state.pendingAttempt === attempt) state.pendingAttempt = null;
    state.activeConnection = attempt;
    state.port.value = null;
    state.isConnected.value = false;
    sink.setConnected(sessionId, false);
    leases.transition(leaseGeneration, 'closing');
  }

  async function cleanupAttempt(attempt: ConnectionAttempt): Promise<PortCloseEvidence> {
    return shutdownConnection(attempt, closeGraceMs);
  }

  return {
    readPortConfig,
    readConnectionTarget,
    openConnection,
    start,
    handleDisconnect,
    detachActiveConnection,
    retainUnclosedConnection,
    cleanupAttempt,
  };
}
