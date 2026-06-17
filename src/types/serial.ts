import type { Direction } from './display';

/** A single captured TX/RX frame. `data` is the raw byte payload. */
export interface DataFrame {
  id: string;
  direction: Direction;
  timestamp: number;
  data: Uint8Array;
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
