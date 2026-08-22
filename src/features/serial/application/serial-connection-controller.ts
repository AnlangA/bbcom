import { SERIAL_WRITE_CLOSE_GRACE_MS } from '@/lib/serial-write-scheduler';
import { logger } from '@/lib/logger';
import type { PortConfig, SerialSendResult, SerialWriteOptions } from '@/types';
import { type SerialConnectionFailure } from './serial-connection-failure';
import { createPortLeaseController } from './serial-port-lease';
import {
  SerialTransactionLeaseCoordinator,
  SerialTransactionLeaseError,
  type SerialTransactionOutputLines,
} from './serial-transaction-lease';
import {
  createRxEvidenceDrainer,
  createShutdownProtocol,
  createUnsafeRxLatch,
  isPortCloseProven,
  type ConnectionAttempt,
  type SerialStopResult,
} from './serial-shutdown-evidence';
import { observableCell, type SerialConnectionRuntimeState } from './serial-connection-runtime';
import { createConnectLifecycle } from './connect-lifecycle';
import { createReconnectPolicy } from './reconnect-policy';
import { createRxPipeline } from './rx-pipeline';
import { createShutdownEvidenceController } from './shutdown-evidence';
import { createTxPipeline, type TxPipeline } from './tx-pipeline';

export { classifyOpenFailure, type SerialConnectionFailure } from './serial-connection-failure';
export type { SerialStopResult } from './serial-shutdown-evidence';
export { buildSendPayload, type SendPayloadResult } from './tx-pipeline';
export type {
  SerialConnectionController,
  SerialConnectionDependencies,
  SerialConnectionListener,
  SerialConnectionOptions,
  SerialConnectionSink,
  SerialConnectionSnapshot,
  TimerPort,
  VisibilityPort,
} from './serial-connection-types';

const DEFAULT_TIMER_PORT = {
  schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  delay: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
};

export function createSerialConnectionController(
  sessionId: string,
  portName: string | (() => string),
  config: PortConfig | (() => PortConfig),
  options: import('./serial-connection-types').SerialConnectionOptions | undefined,
  dependencies: import('./serial-connection-types').SerialConnectionDependencies,
): import('./serial-connection-types').SerialConnectionController {
  const listeners = new Set<import('./serial-connection-types').SerialConnectionListener>();
  let initialized = false;
  const notify = () => {
    if (!initialized) return;
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };

  const timerPort = dependencies.timerPort ?? DEFAULT_TIMER_PORT;
  const closeGraceMs = dependencies.writeCloseGraceMs ?? SERIAL_WRITE_CLOSE_GRACE_MS;

  const state: SerialConnectionRuntimeState = {
    port: observableCell(null, notify),
    isConnecting: observableCell(false, notify),
    isConnected: observableCell(false, notify),
    error: observableCell<string | null>(null, notify),
    connectionFailure: observableCell<SerialConnectionFailure | null>(null, notify),
    totalDroppedBytes: observableCell(0, notify),
    reconnecting: observableCell(false, notify),
    isClosing: observableCell(false, notify),
    activeConnection: null,
    pendingAttempt: null,
    connectionGeneration: 0,
    intentionalClose: true,
    closingPromise: null,
    trackedOutputLines: Object.freeze({ dtr: false, rts: false, breakActive: false }),
    trackedOutputLinesGeneration: -1,
    breakInFlight: false,
  };

  const leases = createPortLeaseController({
    leaseClient: dependencies.leaseClient,
    sessionId,
    sessionName: dependencies.sessionName,
    onLeaseFailure: (failure) => {
      state.connectionFailure.value = failure;
      state.error.value = failure.error.code;
      state.intentionalClose = true;
    },
  });

  const unsafeRxLatch = createUnsafeRxLatch();
  const txPipelineRef: { current: TxPipeline | null } = { current: null };

  const serialTransactions = new SerialTransactionLeaseCoordinator<SerialSendResult>({
    io: {
      snapshot: () => ({
        generation: state.connectionGeneration,
        connected:
          state.isConnected.value &&
          state.activeConnection?.generation === state.connectionGeneration &&
          state.activeConnection.scheduler !== null,
      }),
      async waitForWriteDrain({ generation, signal }) {
        const connection = state.activeConnection;
        if (!connection?.scheduler || connection.generation !== generation) {
          throw new SerialTransactionLeaseError('stale-handle');
        }
        await connection.scheduler.waitForIdle(signal);
      },
      async write(_payload, context) {
        if (context.signal.aborted) {
          throw new SerialTransactionLeaseError('cancelled');
        }
        throw new SerialTransactionLeaseError('unavailable');
      },
      async clearBuffers(selection, context) {
        const connection = txPipelineRef.current!.currentTransactionConnection(context);
        if (!connection.port.clearBuffer) {
          throw new SerialTransactionLeaseError('unavailable');
        }
        await connection.port.clearBuffer(selection);
      },
      async pendingBytes(context) {
        const connection = txPipelineRef.current!.currentTransactionConnection(context);
        if (!connection.port.bytesToRead || !connection.port.bytesToWrite) {
          throw new SerialTransactionLeaseError('unavailable');
        }
        const [rx, tx] = await Promise.all([
          connection.port.bytesToRead(),
          connection.port.bytesToWrite(),
        ]);
        return { rx, tx };
      },
      async setOutputLines(lines, context) {
        const connection = txPipelineRef.current!.currentTransactionConnection(context);
        await connection.port.writeDataTerminalReady(lines.dtr);
        txPipelineRef.current!.currentTransactionConnection(context);
        txPipelineRef.current!.trackOutputLines(context.generation, { dtr: lines.dtr });
        await connection.port.writeRequestToSend(lines.rts);
        txPipelineRef.current!.currentTransactionConnection(context);
        txPipelineRef.current!.trackOutputLines(context.generation, { rts: lines.rts });
        if (lines.breakActive) await connection.port.setBreak();
        else await connection.port.clearBreak();
        txPipelineRef.current!.currentTransactionConnection(context);
        txPipelineRef.current!.trackOutputLines(context.generation, { breakActive: lines.breakActive });
      },
      snapshotOutputLines(generation) {
        txPipelineRef.current!.currentGenerationConnection(generation);
        if (state.trackedOutputLinesGeneration !== generation) {
          throw new SerialTransactionLeaseError('stale-handle');
        }
        return state.trackedOutputLines;
      },
      async restoreOutputLines(lines, context) {
        const connection = txPipelineRef.current!.currentGenerationConnection(context.generation);
        const failures: string[] = [];
        const restore = async (
          name: string,
          operation: () => Promise<void>,
          applied: Partial<SerialTransactionOutputLines>,
        ) => {
          try {
            assertRestoreConnection(connection, context.generation);
            await operation();
            assertRestoreConnection(connection, context.generation);
            txPipelineRef.current!.trackOutputLines(context.generation, applied);
          } catch {
            failures.push(name);
          }
        };
        await restore('dtr', () => connection.port.writeDataTerminalReady(lines.dtr), {
          dtr: lines.dtr,
        });
        await restore('rts', () => connection.port.writeRequestToSend(lines.rts), {
          rts: lines.rts,
        });
        await restore(
          'break',
          () => (lines.breakActive ? connection.port.setBreak() : connection.port.clearBreak()),
          { breakActive: lines.breakActive },
        );
        if (failures.length > 0) {
          logger.warn(
            'serial transaction output-line restore failed for',
            sessionId,
            failures.join(','),
          );
          throw new SerialTransactionLeaseError('io-error');
        }
      },
      async readInputLines(context) {
        const connection = txPipelineRef.current!.currentTransactionConnection(context);
        if (
          !connection.port.readClearToSend ||
          !connection.port.readDataSetReady ||
          !connection.port.readRingIndicator ||
          !connection.port.readCarrierDetect
        ) {
          throw new SerialTransactionLeaseError('unavailable');
        }
        const [cts, dsr, ri, cd] = await Promise.all([
          connection.port.readClearToSend(),
          connection.port.readDataSetReady(),
          connection.port.readRingIndicator(),
          connection.port.readCarrierDetect(),
        ]);
        txPipelineRef.current!.currentTransactionConnection(context);
        return { cts, dsr, ri, cd };
      },
    },
  });

  const runtimeRefs = { state, serialTransactions };

  const rxPipeline = createRxPipeline({
    ...runtimeRefs,
    sessionId,
    sink: dependencies.sink,
    options,
    timerScheduler: dependencies.timerScheduler,
    visibilityPort: dependencies.visibilityPort,
  });

  const drainAttemptRx = createRxEvidenceDrainer({
    enqueueReceivedBytes: (bytes) => rxPipeline.enqueueReceivedBytes(bytes),
    flushRxAndPublish: () => rxPipeline.flushRxAndPublish(),
    totalDroppedBytes: () => state.totalDroppedBytes.value,
  });

  const { shutdownConnection } = createShutdownProtocol({
    closeGraceMs,
    drainAttemptRx,
    rememberUnsafeEvidence: (evidence) => unsafeRxLatch.remember(evidence),
  });

  const txPipeline = createTxPipeline({
    ...runtimeRefs,
    sessionId,
    sink: dependencies.sink,
    timerPort,
  });
  txPipelineRef.current = txPipeline;

  function assertRestoreConnection(connection: ConnectionAttempt, generation: number): void {
    if (txPipelineRef.current!.currentGenerationConnection(generation) !== connection) {
      throw new SerialTransactionLeaseError('stale-handle');
    }
  }

  function revokeSerialTransaction(generation: number): Promise<boolean> | null {
    const phase = serialTransactions.snapshot().phase;
    return phase === 'acquiring' || phase === 'active' || phase === 'releasing'
      ? serialTransactions.notifyDisconnected(generation)
      : null;
  }

  function failAndReleaseLease(generation: number): void {
    if (state.activeConnection && !isPortCloseProven(state.activeConnection.closeEvidence)) {
      state.activeConnection.disconnected = true;
      leases.transition(generation, 'closing');
      return;
    }
    leases.failAndRelease(generation);
  }

  // Wire lifecycle and reconnect with deferred references to break circular deps.
  const { connectLifecycle, shutdownEvidence } = (() => {
    const cl = createConnectLifecycle({
    ...runtimeRefs,
    sessionId,
    portName,
    config,
    options,
    sink: dependencies.sink,
    createPort: dependencies.createPort,
    closeGraceMs,
    leases,
    rxPipeline,
    reconnectPolicy: {
      startReconnect: () => rp.startReconnect(),
      scheduleReconnect: () => rp.scheduleReconnect(),
      stopReconnect: () => rp.stopReconnect(),
      attemptReconnect: () => rp.attemptReconnect(),
    },
    shutdownConnection,
    revokeSerialTransaction,
    failAndReleaseLease,
    synchronizeConnection: async () => {
      await serialTransactions.synchronizeConnection();
    },
    onOpenCommitted(attempt) {
      state.trackedOutputLinesGeneration = attempt.generation;
      state.trackedOutputLines = Object.freeze({
        dtr: attempt.target.config.dtr,
        rts: attempt.target.config.rts,
        breakActive: false,
      });
    },
  });

    const rp = createReconnectPolicy({
    ...runtimeRefs,
    sessionId,
    sink: dependencies.sink,
    options,
    timerPort,
    leases,
    readConnectionTarget: () => cl.readConnectionTarget(),
    resetRxDrain: (rxFrameGapMs) => rxPipeline.resetRxDrain(rxFrameGapMs),
    clearOverflowTracking: () => rxPipeline.clearOverflowTracking(),
    openConnection: (generation, target) => cl.openConnection(generation, target),
    shutdownConnection,
    detachActiveConnection: () => cl.detachActiveConnection(),
    retainUnclosedConnection: (attempt, leaseGeneration) =>
      cl.retainUnclosedConnection(attempt, leaseGeneration),
    failAndReleaseLease,
    revokeSerialTransaction,
  });

    const se = createShutdownEvidenceController({
    ...runtimeRefs,
    sessionId,
    sink: dependencies.sink,
    closeGraceMs,
    leaseClient: dependencies.leaseClient,
    leases,
    unsafeRxLatch,
    rxPipeline,
    reconnectPolicy: rp,
    connectLifecycle: cl,
    shutdownConnection,
    revokeSerialTransaction,
  });

    return { connectLifecycle: cl, shutdownEvidence: se };
  })();

  function snapshot() {
    return Object.freeze({
      port: state.port.value,
      isConnecting: state.isConnecting.value,
      isConnected: state.isConnected.value,
      isClosing: state.isClosing.value,
      reconnecting: state.reconnecting.value,
      error: state.error.value,
      connectionFailure: state.connectionFailure.value,
      totalDroppedBytes: state.totalDroppedBytes.value,
    });
  }

  function subscribe(listener: import('./serial-connection-types').SerialConnectionListener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  async function dispose(): Promise<SerialStopResult> {
    try {
      return await shutdownEvidence.stop();
    } finally {
      await serialTransactions.dispose();
      listeners.clear();
      rxPipeline.clearRawByteObservers();
    }
  }

  initialized = true;
  return {
    snapshot,
    subscribe,
    start: () => connectLifecycle.start(),
    send: (data: string, isHex: boolean, writeOptions?: SerialWriteOptions) =>
      txPipeline.send(data, isHex, writeOptions),
    sendBytes: (payload: Uint8Array, writeOptions?: SerialWriteOptions) =>
      txPipeline.sendBytes(payload, writeOptions),
    sendBreak: (durationMs?: number) => txPipeline.sendBreak(durationMs),
    rawBytes: (callback: (bytes: Uint8Array) => void) => rxPipeline.rawBytes(callback),
    serialTransactions,
    stop: () => shutdownEvidence.stop(),
    visibilityChanged: () => rxPipeline.visibilityChanged(),
    dispose,
  };
}
