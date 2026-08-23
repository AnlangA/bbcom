import type { PortLeaseClient } from './port-lease-registry';
import type { PortLeaseController } from './serial-port-lease';
import {
  isPortCloseProven,
  NO_ACTIVE_CONNECTION_EVIDENCE,
  settlesWithin,
  UNWATCHED_OPEN_EVIDENCE,
  type ConnectionAttempt,
  type SerialRxStopEvidence,
  type SerialStopResult,
  type UnsafeRxLatch,
} from './serial-shutdown-evidence';
import type { SerialConnectionRuntimeRefs } from './serial-connection-runtime';
import type { ConnectLifecycle } from './connect-lifecycle';
import type { RxPipeline } from './rx-pipeline';
import type { ReconnectPolicy } from './reconnect-policy';
import type { SerialConnectionSink } from './serial-connection-types';

export interface ShutdownEvidenceDeps extends SerialConnectionRuntimeRefs {
  sessionId: string;
  sink: SerialConnectionSink;
  closeGraceMs: number;
  leaseClient: PortLeaseClient;
  leases: PortLeaseController;
  unsafeRxLatch: UnsafeRxLatch;
  rxPipeline: RxPipeline;
  reconnectPolicy: ReconnectPolicy;
  connectLifecycle: ConnectLifecycle;
  shutdownConnection(
    connection: ConnectionAttempt,
    graceMs: number,
  ): Promise<import('./serial-shutdown-evidence').PortCloseEvidence>;
  revokeSerialTransaction(generation: number): Promise<boolean> | null;
}

export interface ShutdownEvidenceController {
  performStop(): Promise<SerialStopResult>;
  stop(): Promise<SerialStopResult>;
}

export function createShutdownEvidenceController(
  deps: ShutdownEvidenceDeps,
): ShutdownEvidenceController {
  const {
    state,
    sessionId,
    sink,
    closeGraceMs,
    leaseClient,
    leases,
    unsafeRxLatch,
    rxPipeline,
    reconnectPolicy,
    connectLifecycle,
    shutdownConnection,
    revokeSerialTransaction,
  } = deps;

  async function performStop(): Promise<SerialStopResult> {
    const closingGeneration = state.connectionGeneration;
    state.isClosing.value = true;
    state.intentionalClose = true;
    reconnectPolicy.stopReconnect();
    state.isConnecting.value = false;
    const revocation = revokeSerialTransaction(closingGeneration);
    if (revocation) await revocation;

    let opening = state.pendingAttempt;
    const connection = connectLifecycle.detachActiveConnection();
    if (opening === connection) {
      state.pendingAttempt = null;
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
        if (state.connectionGeneration === closingGeneration) state.connectionGeneration += 1;
        physicalCloseProven = isPortCloseProven(portClose);
      } else if (!opening || pendingOpen === 'settled') {
        rxPipeline.flushRxAndPublish();
        if (state.connectionGeneration === closingGeneration) state.connectionGeneration += 1;
      }

      if (physicalCloseProven && pendingOpen !== 'unsettled') {
        rxPipeline.cancelPublishers();
        rxPipeline.clearPendingQueue();
      }
      state.error.value = null;
      state.connectionFailure.value = null;
    } finally {
      if (lease && physicalCloseProven) {
        unsafeRxLatch.remember(rxEvidence);
        leaseClient.release(lease.grant.leaseId, sessionId);
      } else if (lease && opening && pendingOpen === 'unsettled') {
        state.pendingAttempt = opening;
        leases.reattach({ generation: state.connectionGeneration, grant: lease.grant });
        void opening.settled.then(() => {
          if (isPortCloseProven(opening.closeEvidence)) {
            const settledEvidence = opening.rxStopEvidence;
            if (settledEvidence) unsafeRxLatch.remember(settledEvidence);
            leaseClient.release(lease.grant.leaseId, sessionId);
            leases.clearIfHeld(lease);
            if (state.pendingAttempt === opening) state.pendingAttempt = null;
          } else {
            connectLifecycle.retainUnclosedConnection(opening, state.connectionGeneration);
          }
        });
      } else if (lease && !physicalCloseProven) {
        leases.reattach({ generation: state.connectionGeneration, grant: lease.grant });
        const unresolvedAttempt = connection ?? opening;
        if (unresolvedAttempt && pendingOpen !== 'unsettled') {
          connectLifecycle.retainUnclosedConnection(unresolvedAttempt, state.connectionGeneration);
        }
      }
      state.isConnected.value = false;
      sink.setConnected(sessionId, false);
      state.isClosing.value = false;
    }

    const finalRxEvidence = unsafeRxLatch.current ?? rxEvidence;
    return {
      ...finalRxEvidence,
      pendingOpen,
      portClose,
    };
  }

  async function stop(): Promise<SerialStopResult> {
    if (state.closingPromise) return state.closingPromise;
    state.closingPromise = performStop();
    try {
      return await state.closingPromise;
    } finally {
      state.closingPromise = null;
    }
  }

  return { performStop, stop };
}
