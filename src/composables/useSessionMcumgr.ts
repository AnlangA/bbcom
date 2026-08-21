import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import {
  McumgrClient,
  McumgrError,
  MCUMGR_LEASE_OWNER,
  appendShellHistory,
  type McumgrWriteResult,
} from '../lib/mcumgr';
import {
  SerialTransactionLeaseError,
  type SerialTransactionLeaseCoordinator,
  type SerialTransactionLeaseToken,
} from '../features/serial';
import type {
  McumgrClientConfig,
  McumgrClientStatus,
  SerialSendResult,
  SerialSession,
} from '../types';

export const MCUMGR_OWNER_ID = MCUMGR_LEASE_OWNER;

export interface UseSessionMcumgrOptions {
  session: Ref<SerialSession>;
  serialTransactions: SerialTransactionLeaseCoordinator<SerialSendResult>;
  rawBytes: (callback: (bytes: Uint8Array) => void) => () => void;
  isConnected: Ref<boolean>;
  setConfig: (patch: Partial<McumgrClientConfig>) => void;
}

export function useSessionMcumgr({
  session,
  serialTransactions,
  rawBytes,
  isConnected,
  setConfig,
}: UseSessionMcumgrOptions) {
  const status = ref<McumgrClientStatus>({ kind: 'idle' });
  const lastResult = ref('');
  const busy = computed(() => status.value.kind === 'busy' || status.value.kind === 'progress');
  let activeToken: SerialTransactionLeaseToken | null = null;
  let operationAbort: AbortController | null = null;

  const client = new McumgrClient({
    write: async (payload) => {
      if (!activeToken) throw new McumgrError('io-error', 'MCUMgr has no serial lease');
      return mapWriteResult(await serialTransactions.write(activeToken, payload));
    },
    config: () => session.value.mcumgrConfig,
  });

  const stopRx = rawBytes((bytes) => client.receive(bytes));
  const stopTransportWatch = watch(
    () => [session.value.mcumgrConfig.transport, session.value.mcumgrConfig.lineLength] as const,
    () => {
      if (!client.hasPending()) client.rebuildTransport();
    },
  );
  const stopConnectionWatch = watch(isConnected, (connected) => {
    if (!connected) cancel();
  });

  async function run<T>(
    action: string,
    work: (instance: McumgrClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T | null> {
    if (busy.value) return null;
    if (!isConnected.value) {
      status.value = { kind: 'error', message: 'serial is disconnected' };
      return null;
    }
    status.value = { kind: 'busy', action };
    lastResult.value = '';
    operationAbort = new AbortController();
    try {
      const grant = await serialTransactions.acquire(MCUMGR_OWNER_ID, {
        signal: operationAbort.signal,
      });
      activeToken = grant.token;
      client.rebuildTransport();
      const result = await work(client, operationAbort.signal);
      status.value = { kind: 'idle' };
      return result;
    } catch (error) {
      const classified = mapError(error);
      status.value =
        classified.kind === 'timeout'
          ? { kind: 'timeout' }
          : classified.kind === 'cancelled'
            ? { kind: 'idle' }
            : {
                kind: 'error',
                message: classified.message,
                rc: classified.rc,
                group: classified.group,
              };
      lastResult.value = classified.message;
      return null;
    } finally {
      client.cancel();
      const token = activeToken;
      activeToken = null;
      operationAbort = null;
      if (token) {
        try {
          await serialTransactions.release(token);
        } catch {
          // Release is best-effort; a dropped connection already invalidated the lease.
        }
      }
    }
  }

  function cancel(): void {
    operationAbort?.abort();
    client.cancel();
  }

  function patchConfig(patch: Partial<McumgrClientConfig>): void {
    setConfig(patch);
  }

  function rememberShell(command: string): void {
    setConfig({
      shellHistory: appendShellHistory(session.value.mcumgrConfig.shellHistory, command),
    });
  }

  function reportProgress(action: string, offset: number, total: number): void {
    status.value = { kind: 'progress', action, offset, total };
  }

  function setResult(text: string): void {
    lastResult.value = text;
  }

  onScopeDispose(() => {
    cancel();
    stopRx();
    stopTransportWatch();
    stopConnectionWatch();
  });

  return {
    status,
    lastResult,
    busy,
    run,
    cancel,
    patchConfig,
    rememberShell,
    reportProgress,
    setResult,
    client,
  };
}

function mapWriteResult(result: SerialSendResult): McumgrWriteResult {
  if (result.outcome === 'cancelled') {
    throw new McumgrError('cancelled', 'serial write cancelled');
  }
  if (
    result.outcome === 'complete' ||
    result.outcome === 'partial' ||
    result.outcome === 'failed'
  ) {
    return {
      outcome: result.outcome,
      requestedBytes: result.requestedBytes,
      sentBytes: result.sentBytes,
    };
  }
  throw new McumgrError('unknown-outcome', 'serial write finished without a confirmed outcome');
}

function mapError(error: unknown): McumgrError {
  if (error instanceof McumgrError) return error;
  if (error instanceof SerialTransactionLeaseError) {
    if (error.code === 'cancelled') return new McumgrError('cancelled', error.message);
    if (error.code === 'timeout') return new McumgrError('timeout', error.message);
    if (error.code === 'partial-write') return new McumgrError('partial-write', error.message);
    if (error.code === 'unknown-outcome') return new McumgrError('unknown-outcome', error.message);
    return new McumgrError('io-error', error.message);
  }
  return new McumgrError('io-error', error instanceof Error ? error.message : 'MCUMgr failed');
}

export type SessionMcumgrController = ReturnType<typeof useSessionMcumgr>;
