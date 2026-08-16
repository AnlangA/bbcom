import type { SerialDrainCompletion } from '../../../generated/ipc-contracts';
import type { PortConfig } from '../../../types';
import type { SerialPortAdapter, SerialWatchHandleAdapter } from './serial-port';
import type { SerialWriteScheduler } from '../../../lib/serial-write-scheduler';
import { logger } from '../../../lib/logger';

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

export type PortCloseEvidence = Exclude<SerialStopResult['portClose'], 'pending-open-unsettled'>;

export type SerialRxStopEvidence = Readonly<
  Pick<SerialStopResult, 'watch' | 'rxDrainGuarantee' | 'rxDrainStatus' | 'nativeDrainedBytes'>
>;

export interface ConnectionAttempt {
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

export const NO_ACTIVE_CONNECTION_EVIDENCE: SerialRxStopEvidence = Object.freeze({
  watch: 'not-installed',
  rxDrainGuarantee: 'guaranteed',
  rxDrainStatus: 'no-active-connection',
  nativeDrainedBytes: 0,
});

export const UNWATCHED_OPEN_EVIDENCE: SerialRxStopEvidence = Object.freeze({
  watch: 'not-installed',
  rxDrainGuarantee: 'not-guaranteed',
  rxDrainStatus: 'watch-not-installed',
  nativeDrainedBytes: 0,
});

export function isPortCloseProven(status: SerialStopResult['portClose']): boolean {
  return (
    status === 'no-active-port' ||
    status === 'close-acknowledged' ||
    status === 'force-close-acknowledged'
  );
}

/**
 * Once a watched connection cannot prove its final RX boundary, no later
 * empty stop may turn that historical data-loss risk into a safe result.
 * The latch lives for the runtime instance and is cleared only when the
 * runtime itself is discarded (or the user explicitly forces shutdown).
 */
export interface UnsafeRxLatch {
  remember(evidence: SerialRxStopEvidence): void;
  readonly current: SerialRxStopEvidence | null;
}

export function createUnsafeRxLatch(): UnsafeRxLatch {
  let latched: SerialRxStopEvidence | null = null;
  return {
    remember(evidence) {
      if (evidence.rxDrainGuarantee === 'not-guaranteed' && !latched) {
        latched = Object.freeze({ ...evidence });
      }
    },
    get current() {
      return latched;
    },
  };
}

export interface RxEvidenceDrainOptions {
  enqueueReceivedBytes(bytes: Uint8Array): void;
  flushRxAndPublish(): void;
  totalDroppedBytes(): number;
}

/**
 * Prove the final RX boundary for one attempt: unwatch, drain the native hub,
 * yield already-queued Channel events, flush the renderer queue, and only then
 * stop accepting RX. The evidence is memoized on the attempt.
 */
export function createRxEvidenceDrainer({
  enqueueReceivedBytes,
  flushRxAndPublish,
  totalDroppedBytes,
}: RxEvidenceDrainOptions): (attempt: ConnectionAttempt) => Promise<SerialRxStopEvidence> {
  return async function drainAttemptRx(attempt: ConnectionAttempt): Promise<SerialRxStopEvidence> {
    if (attempt.rxStopEvidence) return attempt.rxStopEvidence;
    if (!attempt.watchInstalled) {
      attempt.acceptingRx = false;
      attempt.rxStopEvidence = NO_ACTIVE_CONNECTION_EVIDENCE;
      return attempt.rxStopEvidence;
    }

    let watch: SerialStopResult['watch'] = 'not-installed';
    let rxDrainGuaranteed = false;
    let rxDrainStatus: SerialStopResult['rxDrainStatus'] = 'watch-not-installed';
    let nativeDrainedBytes = 0;
    const droppedBeforeDrain = totalDroppedBytes();
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
    if (totalDroppedBytes() > droppedBeforeDrain) {
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
  };
}

export interface ShutdownProtocolOptions {
  /** Grace window for graceful close and force-close fallbacks. */
  closeGraceMs: number;
  drainAttemptRx(attempt: ConnectionAttempt): Promise<SerialRxStopEvidence>;
  rememberUnsafeEvidence(evidence: SerialRxStopEvidence): void;
}

export interface ShutdownProtocol {
  closePort(attempt: ConnectionAttempt): Promise<PortCloseEvidence>;
  /** Teardown barrier for one attempt: write-scheduler shutdown, RX boundary,
   * then close/force-close. Joined by every concurrent stop path. */
  shutdownConnection(connection: ConnectionAttempt, graceMs: number): Promise<PortCloseEvidence>;
}

export function createShutdownProtocol({
  closeGraceMs,
  drainAttemptRx,
  rememberUnsafeEvidence,
}: ShutdownProtocolOptions): ShutdownProtocol {
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
      rememberUnsafeEvidence(await drainAttemptRx(connection));
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

  return { closePort, shutdownConnection };
}

export function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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

export function succeedsWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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
