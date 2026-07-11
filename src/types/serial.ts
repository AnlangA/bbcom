import type { Direction } from './display';
import type { AppErrorCode } from './errors';

/** A single captured TX/RX frame. `data` is the raw byte payload. */
export interface DataFrame {
  id: string;
  direction: Direction;
  timestamp: number;
  data: Uint8Array;
  /**
   * Monotonic display-content revision. Normal source frames omit it; merged
   * rope rows use it so virtualized rendering can update a stable row id.
   */
  contentVersion?: number;
  /** Bytes intentionally omitted from a bounded UI display tail. */
  omittedBytes?: number;
  /** TX completion certainty. Absent for RX and legacy persisted frames. */
  txStatus?: 'complete' | 'partial-unknown';
  /** Original logical TX payload size when this is a TX frame. */
  requestedBytes?: number;
}

/** Serial port configuration — the open-options snapshot for a session. */
export interface PortConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'software' | 'hardware';
  dtr: boolean;
  rts: boolean;
}

/** Why a serial send did not complete. */
export type SerialSendFailureReason =
  | 'empty'
  | 'bad-hex'
  | 'too-large'
  | 'not-connected'
  | 'queue-full'
  | 'disconnecting'
  | 'write-error'
  | 'write-stalled';

/**
 * Result returned by every low-level serial send.
 *
 * `bytesWritten` is the confirmed prefix accepted by the driver. It may be
 * non-zero when `ok` is false (for example, a later 4 KiB chunk failed).
 */
export interface SerialSendResult {
  status: 'complete' | 'partial-unknown' | 'rejected';
  ok: boolean;
  requestedBytes: number;
  /** Confirmed driver-accepted prefix. A failed native call may still have
   * reached the device beyond this count, hence `partial-unknown`. */
  confirmedBytes: number;
  /** @deprecated Use `confirmedBytes`. Kept while internal callers migrate. */
  bytesWritten: number;
  reason: SerialSendFailureReason | null;
  code?: AppErrorCode;
  error?: string;
}

/** Hooks that must run when a queued operation reaches the physical writer. */
export interface SerialWriteOptions {
  onWriteStarted?: () => void;
}

/** One entry in the per-session send history (the send-panel dropdown). */
export interface SendHistoryEntry {
  data: string;
  isHex: boolean;
}

/** A user-saved quick command (one-click send button in the send panel). */
export interface QuickCommand {
  id: string;
  name: string;
  data: string;
  isHex: boolean;
}
