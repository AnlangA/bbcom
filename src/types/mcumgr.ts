/** Per-session MCUMgr client settings. Persisted; transfer payloads are not. */

export type McumgrTransportMode = 'console' | 'raw-uart';
export type McumgrSmpVersion = 1 | 2;

export interface McumgrClientConfig {
  transport: McumgrTransportMode;
  /** Console line length including marker and newline. Default 127. */
  lineLength: number;
  /** SMP request body budget used to size image/FS chunks. Default 512. */
  mtu: number;
  /** Per-request timeout in ms (read-only retries share this). */
  timeoutMs: number;
  /** First image/FS chunk timeout in ms. */
  firstChunkTimeoutMs: number;
  /** Subsequent transfer chunk timeout in ms. */
  subsequentTimeoutMs: number;
  /** Extra read-only attempts after the first try. Writes never retry. */
  retries: number;
  smpVersion: McumgrSmpVersion;
  /** Shell command history, newest last. Text only. */
  shellHistory: string[];
}

export type McumgrClientStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; action: string }
  | { kind: 'progress'; action: string; offset: number; total: number }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string; rc?: number; group?: number };
