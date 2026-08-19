import type { Direction } from './display';

/** Rust-owned serial send contract. Do not redefine these shapes in TS. */
export type { SerialSendOutcome, SerialSendResult } from '../generated/ipc-contracts';

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
  /** RX frame closes after this many milliseconds without a new byte. */
  rxFrameGapMs: number;
  dtr: boolean;
  rts: boolean;
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
  /** Native plugin contribution owner. Missing/null means a normal user item. */
  ownerPluginId?: string | null;
}
