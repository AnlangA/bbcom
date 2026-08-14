export const SHUTDOWN_WAIT_LIMIT_MS = 8_000;

export type {
  ShutdownCancellation,
  ShutdownCloseRequest,
  ShutdownConfirmation,
  ShutdownDrainResult,
  ShutdownParticipantMessageKey,
  ShutdownParticipantReport,
  ShutdownParticipantStatus,
  ShutdownReport,
  ShutdownState,
} from '../../generated/ipc-contracts';

import type { ShutdownReport, ShutdownState } from '../../generated/ipc-contracts';

export interface ShutdownDrainContext {
  readonly attemptId: string;
  /** Aborted only when the user cancels or forces the close attempt. */
  readonly signal: AbortSignal;
}

export interface ShutdownDrainParticipant {
  /** Stable, path-free identifier such as `workspace-flush`. */
  readonly name: string;
  /** Higher numeric priorities run first. Equal priorities run concurrently. */
  readonly priority: number;
  /** Initial per-participant wait bound. Must be between 1 and 8,000 ms. */
  readonly timeoutMs: number;
  /**
   * Marks an idempotent persistence barrier that must run once in every wait
   * pass. Ordinary participants are never replayed: a timed-out invocation is
   * only awaited until it settles.
   */
  readonly repeatableBarrier?: boolean;
  drain(context: ShutdownDrainContext): void | Promise<void>;
}

export interface ShutdownCoordinatorSnapshot {
  readonly state: ShutdownState;
  readonly attemptId: string | null;
  readonly acceptsNewWork: boolean;
  readonly forced: boolean;
  readonly report: ShutdownReport | null;
}

export type ShutdownCoordinatorListener = (snapshot: ShutdownCoordinatorSnapshot) => void;
