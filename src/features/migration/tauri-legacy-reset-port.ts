import { invoke } from '@tauri-apps/api/core';
import type {
  BeginLegacyDiscardRequest,
  BeginLegacyDiscardResponse,
  CompleteLegacyResetRequest,
  CompleteLegacyResetResponse,
  GetLegacyResetJournalRequest,
  GetLegacyResetJournalResponse,
  LegacyResetJournal as WireLegacyResetJournal,
  PrepareLegacyResetRequest,
  PrepareLegacyResetResponse,
} from '../../generated/ipc-contracts';
import type {
  LegacyReadContext,
  LegacyResetAuthorization,
  LegacyResetJournalSnapshot,
  LegacyResetNativePort,
} from './types';

let requestSequence = 0;

/** Typed Tauri transport for the native-authoritative reset journal. */
export class TauriLegacyResetPort implements LegacyResetNativePort {
  async getJournal(context: LegacyReadContext): Promise<LegacyResetJournalSnapshot> {
    const requestId = nextRequestId('journal');
    const request: GetLegacyResetJournalRequest = { requestId };
    const response = await invoke<GetLegacyResetJournalResponse>('get_legacy_reset_journal', {
      request,
    });
    throwIfAborted(context.signal);
    correlate(response.requestId, requestId);
    return validateJournal(response.journal);
  }

  async beginDiscard(context: LegacyReadContext): Promise<string> {
    throwIfAborted(context.signal);
    const requestId = nextRequestId('discard');
    const request: BeginLegacyDiscardRequest = { requestId };
    const response = await invoke<BeginLegacyDiscardResponse>('begin_legacy_discard', { request });
    correlate(response.requestId, requestId);
    if (!validOpaqueId(response.discardToken)) throw new Error('invalid native discard token');
    return response.discardToken;
  }

  async prepare(
    authorization: LegacyResetAuthorization,
    context: LegacyReadContext,
  ): Promise<LegacyResetJournalSnapshot> {
    throwIfAborted(context.signal);
    const requestId = nextRequestId('prepare');
    const request: PrepareLegacyResetRequest = {
      requestId,
      ...(authorization.verifiedBackupId
        ? { verifiedBackupId: authorization.verifiedBackupId }
        : {}),
      ...(authorization.discardToken ? { discardToken: authorization.discardToken } : {}),
      ...(authorization.emptyLegacyState ? { emptyLegacyState: true } : {}),
    };
    const response = await invoke<PrepareLegacyResetResponse>('prepare_legacy_reset', { request });
    correlate(response.requestId, requestId);
    return validateJournal(response.journal);
  }

  async complete(
    workspaceId: string,
    expectedRevision: number,
    context: LegacyReadContext,
  ): Promise<LegacyResetJournalSnapshot> {
    throwIfAborted(context.signal);
    const requestId = nextRequestId('complete');
    const request: CompleteLegacyResetRequest = { requestId, workspaceId, expectedRevision };
    const response = await invoke<CompleteLegacyResetResponse>('complete_legacy_reset', {
      request,
    });
    correlate(response.requestId, requestId);
    return validateJournal(response.journal);
  }
}

function validateJournal(value: WireLegacyResetJournal): LegacyResetJournalSnapshot {
  if (value.phase === 'required') {
    if (value.workspaceId !== undefined || value.expectedRevision !== undefined) {
      throw new Error('invalid required reset journal');
    }
    return Object.freeze({ phase: value.phase });
  }
  if (
    !validWorkspaceId(value.workspaceId) ||
    value.expectedRevision !== 0 ||
    !Number.isSafeInteger(value.expectedRevision)
  ) {
    throw new Error('invalid native reset journal');
  }
  return Object.freeze({
    phase: value.phase,
    workspaceId: value.workspaceId,
    expectedRevision: value.expectedRevision,
  });
}

function correlate(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('native reset response correlation failed');
}

function nextRequestId(scope: string): string {
  requestSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.() ?? requestSequence.toString(36);
  return `legacy-reset-${scope}-${uuid}`;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validWorkspaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('native reset operation aborted');
  error.name = 'AbortError';
  throw error;
}
