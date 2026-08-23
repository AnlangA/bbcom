import { classifyOpenFailure } from './serial-connection-failure';
import type { PortLeaseController } from './serial-port-lease';
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
  SerialConnectionOptions,
  SerialConnectionSink,
  TimerPort,
} from './serial-connection-types';

const RECONNECT_INTERVAL_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;

export interface ReconnectPolicyDeps extends SerialConnectionRuntimeRefs {
  sessionId: string;
  sink: SerialConnectionSink;
  options: SerialConnectionOptions | undefined;
  timerPort: TimerPort;
  leases: PortLeaseController;
  readConnectionTarget(): Readonly<{
    portName: string;
    config: Readonly<import('@/types').PortConfig>;
  }>;
  resetRxDrain(rxFrameGapMs: number): void;
  clearOverflowTracking(): void;
  openConnection(
    generation: number,
    target: Readonly<{ portName: string; config: Readonly<import('@/types').PortConfig> }>,
  ): Promise<ConnectionAttempt>;
  shutdownConnection(connection: ConnectionAttempt, graceMs: number): Promise<PortCloseEvidence>;
  detachActiveConnection(): ConnectionAttempt | null;
  retainUnclosedConnection(attempt: ConnectionAttempt, leaseGeneration: number): void;
  failAndReleaseLease(generation: number): void;
  revokeSerialTransaction(generation: number): Promise<boolean> | null;
}

export interface ReconnectPolicy {
  startReconnect(): void;
  scheduleReconnect(): void;
  stopReconnect(): void;
  attemptReconnect(): Promise<void>;
}

export function createReconnectPolicy(deps: ReconnectPolicyDeps): ReconnectPolicy {
  const {
    state,
    serialTransactions,
    sessionId,
    sink,
    options,
    timerPort,
    leases,
    readConnectionTarget,
    resetRxDrain,
    clearOverflowTracking,
    openConnection,
    shutdownConnection,
    detachActiveConnection,
    retainUnclosedConnection,
    failAndReleaseLease,
  } = deps;

  let reconnectTimer: unknown | null = null;
  let reconnectAttempts = 0;

  function startReconnect(): void {
    if (state.reconnecting.value || state.intentionalClose || state.isClosing.value) return;
    state.reconnecting.value = true;
    reconnectAttempts = 0;
    if (!leases.transition(state.connectionGeneration, 'reconnecting')) {
      state.reconnecting.value = false;
      failAndReleaseLease(state.connectionGeneration);
      options?.onDisconnect?.();
      return;
    }
    options?.onReconnecting?.();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (
      reconnectTimer ||
      state.intentionalClose ||
      state.isClosing.value ||
      state.pendingAttempt !== null ||
      (state.activeConnection !== null && !isPortCloseProven(state.activeConnection.closeEvidence))
    ) {
      return;
    }
    reconnectTimer = timerPort.schedule(() => void attemptReconnect(), RECONNECT_INTERVAL_MS);
  }

  async function attemptReconnect(): Promise<void> {
    reconnectTimer = null;
    if (
      state.intentionalClose ||
      state.isClosing.value ||
      state.pendingAttempt !== null ||
      (state.activeConnection !== null && !isPortCloseProven(state.activeConnection.closeEvidence))
    ) {
      state.reconnecting.value = false;
      return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      state.reconnecting.value = false;
      failAndReleaseLease(state.connectionGeneration);
      options?.onDisconnect?.();
      return;
    }

    const generation = ++state.connectionGeneration;
    leases.adoptGeneration(generation);
    try {
      const target = readConnectionTarget();
      resetRxDrain(target.config.rxFrameGapMs);
      await openConnection(generation, target);
      if (generation !== state.connectionGeneration || state.intentionalClose) {
        const stale = detachActiveConnection();
        if (stale) {
          const closeEvidence = await shutdownConnection(stale, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(stale, generation);
            state.reconnecting.value = false;
            return;
          }
        }
        failAndReleaseLease(generation);
        return;
      }
      state.reconnecting.value = false;
      state.isConnected.value = true;
      state.error.value = null;
      state.connectionFailure.value = null;
      clearOverflowTracking();
      if (!leases.transition(generation, 'connected')) {
        const connected = detachActiveConnection();
        if (connected) {
          const closeEvidence = await shutdownConnection(connected, 0);
          if (!isPortCloseProven(closeEvidence)) {
            retainUnclosedConnection(connected, generation);
            state.reconnecting.value = false;
            state.isConnected.value = false;
            sink.setConnected(sessionId, false);
            options?.onDisconnect?.();
            return;
          }
        }
        failAndReleaseLease(generation);
        state.reconnecting.value = false;
        state.isConnected.value = false;
        sink.setConnected(sessionId, false);
        options?.onDisconnect?.();
        return;
      }
      await serialTransactions.synchronizeConnection();
      sink.setConnected(sessionId, true);
      options?.onReconnected?.();
    } catch (reconnectError) {
      if (generation === state.connectionGeneration && !state.intentionalClose) {
        if (!(reconnectError instanceof StaleConnectionError)) {
          const failure = classifyOpenFailure(reconnectError);
          state.connectionFailure.value = failure;
          state.error.value = failure.error.code;
        }
        if (state.activeConnection && !isPortCloseProven(state.activeConnection.closeEvidence)) {
          state.reconnecting.value = false;
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
    state.reconnecting.value = false;
  }

  return {
    startReconnect,
    scheduleReconnect,
    stopReconnect,
    attemptReconnect,
  };
}
