import { inject, type InjectionKey } from 'vue';
import type { LegacyWorkspaceResetCoordinator } from './legacy-workspace-reset';
import type { LegacyResetActionOutcome } from './types';

/** Application boundary consumed by the blocking renderer gate. */
export interface LegacyResetContext {
  readonly coordinator: LegacyWorkspaceResetCoordinator;
  /** Idempotent startup check. Concurrent callers share the same operation. */
  start(): Promise<LegacyResetActionOutcome>;
  /** Passphrase is forwarded to Rust for this backup attempt and is never
   * retained in the coordinator, Pinia, localStorage, project, or logs. */
  createVerifiedBackup(passphrase: string): Promise<LegacyResetActionOutcome>;
}

export const LEGACY_RESET_CONTEXT_KEY: InjectionKey<LegacyResetContext> = Symbol(
  'bbcom-legacy-workspace-reset',
);

export function useOptionalLegacyResetContext(): LegacyResetContext | null {
  return inject(LEGACY_RESET_CONTEXT_KEY, null);
}
