import type { PersistedSessionsFile } from './session-persistence';
import type { SessionStateDatabaseLoadResult } from './session-state-database';

export type SessionStateWorkerRequest =
  | { id: number; kind: 'load' }
  | { id: number; kind: 'save'; file: PersistedSessionsFile; includeFrames: boolean };

export type SessionStateWorkerResponse =
  | { id: number; ok: true; result: SessionStateDatabaseLoadResult | null }
  | { id: number; ok: false; error: string };
