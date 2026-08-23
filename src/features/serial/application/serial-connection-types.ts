import type { DataFrame, PortConfig, SerialSendResult, SerialWriteOptions } from '@/types';
import type { SerialPortAdapter, SerialPortFactory } from './serial-port';
import type { SerialConnectionFailure } from './serial-connection-failure';
import type { SerialTimerScheduler } from '@/lib/serial-rx-scheduler';

export interface SerialConnectionOptions {
  onDisconnect?: () => void;
  onOverflow?: (totalDroppedBytes: number) => void;
  autoReconnect?: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onRxFrame?: (frame: DataFrame) => void;
}

export interface SerialConnectionSink {
  setConnected(sessionId: string, connected: boolean): void;
  updateDroppedBytes(sessionId: string, totalDroppedBytes: number): void;
  addFrame(
    sessionId: string,
    frame: Omit<DataFrame, 'id' | 'timestamp'> & Partial<Pick<DataFrame, 'timestamp'>>,
    options?: { publish?: boolean },
  ): DataFrame | undefined;
  publishFrames(sessionId: string): void;
  appendAutoLogFrame(sessionId: string, frame: DataFrame): void;
}

export interface TimerPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  delay(delayMs: number): Promise<void>;
}

export interface VisibilityPort {
  isVisible(): boolean;
}

export interface SerialConnectionDependencies {
  leaseClient: import('./port-lease-registry').PortLeaseClient;
  sessionName: string | (() => string);
  createPort: SerialPortFactory;
  sink: SerialConnectionSink;
  timerScheduler?: SerialTimerScheduler;
  timerPort?: TimerPort;
  visibilityPort?: VisibilityPort;
  writeCloseGraceMs?: number;
}

export interface SerialConnectionSnapshot {
  readonly port: SerialPortAdapter | null;
  readonly isConnecting: boolean;
  readonly isConnected: boolean;
  readonly isClosing: boolean;
  readonly reconnecting: boolean;
  readonly error: string | null;
  readonly connectionFailure: SerialConnectionFailure | null;
  readonly totalDroppedBytes: number;
}

export type SerialConnectionListener = (snapshot: SerialConnectionSnapshot) => void;

export interface SerialConnectionController {
  snapshot(): SerialConnectionSnapshot;
  subscribe(listener: SerialConnectionListener): () => void;
  start(): Promise<boolean>;
  send(data: string, isHex: boolean, options?: SerialWriteOptions): Promise<SerialSendResult>;
  sendBytes(payload: Uint8Array, options?: SerialWriteOptions): Promise<SerialSendResult>;
  sendBreak(durationMs?: number): Promise<boolean>;
  rawBytes(callback: (bytes: Uint8Array) => void): () => void;
  /** Exclusive protocol transaction boundary for built-in writers. */
  readonly serialTransactions: import('./serial-transaction-lease').SerialTransactionLeaseCoordinator<SerialSendResult>;
  stop(): Promise<import('./serial-shutdown-evidence').SerialStopResult>;
  visibilityChanged(): void;
  dispose(): Promise<import('./serial-shutdown-evidence').SerialStopResult>;
}

export type PortConfigSource = PortConfig | (() => PortConfig);
export type PortNameSource = string | (() => string);
