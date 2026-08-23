import type { SerialPortAdapter } from './serial-port';
import type { SerialConnectionFailure } from './serial-connection-failure';
import type { ConnectionAttempt, SerialStopResult } from './serial-shutdown-evidence';
import type {
  SerialTransactionLeaseCoordinator,
  SerialTransactionOutputLines,
} from './serial-transaction-lease';
import type { SerialSendResult } from '@/types';

/** Observable mutable cell used for snapshot-driven listener notification. */
export interface MutableCell<T> {
  value: T;
}

export function observableCell<T>(initial: T, changed: () => void): MutableCell<T> {
  let current = initial;
  return {
    get value() {
      return current;
    },
    set value(value: T) {
      if (Object.is(value, current)) return;
      current = value;
      changed();
    },
  };
}

export class StaleConnectionError extends Error {
  constructor() {
    super('stale serial connection generation');
  }
}

export interface SerialConnectionRuntimeState {
  port: MutableCell<SerialPortAdapter | null>;
  isConnecting: MutableCell<boolean>;
  isConnected: MutableCell<boolean>;
  isClosing: MutableCell<boolean>;
  reconnecting: MutableCell<boolean>;
  error: MutableCell<string | null>;
  connectionFailure: MutableCell<SerialConnectionFailure | null>;
  totalDroppedBytes: MutableCell<number>;

  activeConnection: ConnectionAttempt | null;
  pendingAttempt: ConnectionAttempt | null;
  connectionGeneration: number;
  intentionalClose: boolean;
  closingPromise: Promise<SerialStopResult> | null;

  trackedOutputLines: Readonly<SerialTransactionOutputLines>;
  trackedOutputLinesGeneration: number;
  breakInFlight: boolean;
}

export interface SerialConnectionRuntimeRefs {
  state: SerialConnectionRuntimeState;
  serialTransactions: SerialTransactionLeaseCoordinator<SerialSendResult>;
}
