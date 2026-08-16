import {
  PortLeaseInUseError,
  type FrozenPortLeaseGrant,
  type HeldPortLeaseState,
  type PortLeaseClient,
} from './port-lease-registry';
import { createConnectionFailure, type SerialConnectionFailure } from './serial-connection-failure';

export interface GenerationLease {
  readonly generation: number;
  readonly grant: FrozenPortLeaseGrant;
}

export interface PortLeaseController {
  /**
   * Acquire (or re-adopt) the process-level lease for one connection
   * generation. On failure the sink receives the classified connection
   * failure; the composable latches `intentionalClose` in that case.
   */
  acquire(generation: number, portName: string): boolean;
  /** Re-tag the held lease after a generation bump (reconnect attempts). */
  adoptGeneration(generation: number): void;
  /** Transition the held lease for one generation. */
  transition(generation: number, state: HeldPortLeaseState): boolean;
  /** Detach the held lease (optionally generation-checked) for shutdown. */
  detach(generation?: number): GenerationLease | null;
  /** Transition a detached lease; release remains authoritative on races. */
  transitionDetached(lease: GenerationLease, state: 'failed' | 'closing'): void;
  /** Detach, mark failed, and release the lease for one generation. */
  failAndRelease(generation: number): void;
  /**
   * Re-attach a previously detached lease after a stop that could not prove
   * its terminal state (fail-closed path keeps the lease as retry token).
   */
  reattach(lease: GenerationLease): void;
  /** Drop the held lease when it is still the given detached one. */
  clearIfHeld(lease: GenerationLease): void;
  /** Current held lease, if any (diagnostics/stop accounting). */
  readonly held: GenerationLease | null;
}

export interface PortLeaseControllerOptions {
  /** Required process-level ownership boundary; native open never runs without it. */
  leaseClient: PortLeaseClient;
  sessionId: string;
  /** Bounded display label copied into conflict navigation metadata. */
  sessionName: string | (() => string);
  /** Receives classified failures (lease busy/in-use/invalid) to surface. */
  onLeaseFailure(failure: SerialConnectionFailure): void;
}

/**
 * Port-lease acquire/transition/release bookkeeping for one connection
 * composable instance, extracted from useSerialConnection. Framework-free.
 */
export function createPortLeaseController({
  leaseClient,
  sessionId,
  sessionName,
  onLeaseFailure,
}: PortLeaseControllerOptions): PortLeaseController {
  let heldLease: GenerationLease | null = null;

  function readSessionName(): string {
    const value = typeof sessionName === 'function' ? sessionName() : sessionName;
    return value.slice(0, 256);
  }

  function acquire(generation: number, portName: string): boolean {
    try {
      const previousLease = heldLease;
      let grant = leaseClient.acquire(portName, sessionId, readSessionName());
      // A previous stop may still be closing native resources. Releasing its
      // terminal identifier and acquiring a new one is synchronous, so no
      // competing session can enter between these registry operations.
      if (grant.state === 'closing' || grant.state === 'failed') {
        onLeaseFailure(createConnectionFailure('BUSY', 'error.busy', 'backend-failure'));
        return false;
      }
      if (grant.state === 'connected') {
        grant = leaseClient.transition(grant.leaseId, sessionId, 'reconnecting');
      }
      heldLease = { generation, grant };
      if (previousLease && previousLease.grant.leaseId !== grant.leaseId) {
        leaseClient.release(previousLease.grant.leaseId, sessionId);
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
      onLeaseFailure(failure);
      return false;
    }
  }

  function adoptGeneration(generation: number): void {
    if (heldLease) heldLease = { generation, grant: heldLease.grant };
  }

  function transition(generation: number, state: HeldPortLeaseState): boolean {
    const lease = heldLease;
    if (!lease || lease.generation !== generation) return false;
    try {
      const grant = leaseClient.transition(lease.grant.leaseId, sessionId, state);
      if (heldLease === lease) heldLease = { generation, grant };
      return heldLease?.generation === generation && heldLease.grant.leaseId === grant.leaseId;
    } catch {
      return false;
    }
  }

  function detach(generation?: number): GenerationLease | null {
    const lease = heldLease;
    if (!lease || (generation !== undefined && lease.generation !== generation)) return null;
    heldLease = null;
    return lease;
  }

  function transitionDetached(lease: GenerationLease, state: 'failed' | 'closing'): void {
    if (lease.grant.state === 'failed' || lease.grant.state === 'closing') return;
    try {
      leaseClient.transition(lease.grant.leaseId, sessionId, state);
    } catch {
      // Release remains authoritative even if a stale transition raced it.
    }
  }

  function failAndRelease(generation: number): void {
    const lease = detach(generation);
    if (!lease) return;
    transitionDetached(lease, 'failed');
    leaseClient.release(lease.grant.leaseId, sessionId);
  }

  function reattach(lease: GenerationLease): void {
    heldLease = lease;
  }

  function clearIfHeld(lease: GenerationLease): void {
    if (heldLease?.grant.leaseId === lease.grant.leaseId) heldLease = null;
  }

  return {
    acquire,
    adoptGeneration,
    transition,
    detach,
    transitionDetached,
    failAndRelease,
    reattach,
    clearIfHeld,
    get held() {
      return heldLease;
    },
  };
}
