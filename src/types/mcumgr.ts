/** Per-session MCUMgr client settings. Persisted; transfer payloads are not. */

import type { McumgrPhase } from '@/generated/ipc-contracts';

export interface McumgrClientConfig {
  /** Negotiate the SMP frame size from the device (os mcumgr params). */
  autoFrameSize: boolean;
  /** Manual SMP frame size used when negotiation is off or unsupported. */
  frameSize: number;
  /** Per-request response timeout in ms. */
  timeoutMs: number;
  /** Extra read-only attempts after the first try. */
  retries: number;
  /** Shell command history, newest last. Text only. */
  shellHistory: string[];
}

export type McumgrClientStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; action: string }
  | {
      kind: 'progress';
      action: string;
      phase: McumgrPhase;
      detail?: string;
      offset?: number;
      total?: number;
    }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string; rc?: number; group?: number };
