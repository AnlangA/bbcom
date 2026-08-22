import { computed, ref, type Ref } from 'vue';
import {
  asMcumgrError,
  createMcumgrProgressChannel,
  invokeMcumgrCancel,
  invokeMcumgrExecute,
  invokeMcumgrFirmwareUpdate,
  invokeMcumgrFsDownload,
  invokeMcumgrFsUpload,
  invokeMcumgrImageUpload,
  invokeMcumgrPickFile,
  invokeMcumgrPickSaveTarget,
} from '../features/native/tauri-ipc';
import { appendShellHistory } from '../lib/mcumgr-config';
import { t } from '../lib/i18n';
import type {
  McumgrError,
  McumgrFilePick,
  McumgrFilePurpose,
  McumgrOp,
  McumgrPortRequest,
  McumgrProgress,
  McumgrSavePick,
} from '../generated/ipc-contracts';
import type { McumgrClientConfig, McumgrClientStatus, SerialSession } from '../types';

export interface McumgrFirmwareUpdateOptions {
  skipReboot?: boolean;
  forceConfirm?: boolean;
  upgradeOnly?: boolean;
}

export interface UseSessionMcumgrOptions {
  session: Ref<SerialSession>;
  isConnected: Ref<boolean>;
  /** Cleanly closes the frontend serial connection (port yield). */
  suspendConnection: () => Promise<void>;
  /** Re-opens the frontend serial connection after the operation. */
  resumeConnection: () => Promise<boolean>;
  setConfig: (patch: Partial<McumgrClientConfig>) => void;
}

const RESUME_RETRY_DELAYS_MS = [0, 1_000, 2_500];

/**
 * MCUmgr orchestration: yields the session's serial port to the Rust backend
 * (which opens it directly for `mcumgr-toolkit`), then restores the previous
 * connection state. Works on disconnected sessions without any yielding.
 */
export function useSessionMcumgr({
  session,
  isConnected,
  suspendConnection,
  resumeConnection,
  setConfig,
}: UseSessionMcumgrOptions) {
  const status = ref<McumgrClientStatus>({ kind: 'idle' });
  const lastResult = ref('');
  const busy = computed(() => status.value.kind === 'busy' || status.value.kind === 'progress');
  let runGeneration = 0;
  let rejectActiveRun: ((error: McumgrError) => void) | null = null;

  function portRequest(): McumgrPortRequest | null {
    const path = session.value.portName.trim();
    if (!path) return null;
    const config = session.value.mcumgrConfig;
    return {
      path,
      baudRate: session.value.portConfig.baudRate,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      autoFrameSize: config.autoFrameSize,
      frameSize: config.frameSize,
    };
  }

  async function resumeWithRetry(): Promise<boolean> {
    // Reset-style operations drop the USB CDC port for a moment; retry with
    // backoff so the session comes back without manual intervention.
    for (const delay of RESUME_RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        if (await resumeConnection()) return true;
      } catch {
        // The controller records its own failure state; keep retrying.
      }
    }
    return false;
  }

  async function run<T>(
    action: string,
    work: (port: McumgrPortRequest) => Promise<T>,
  ): Promise<T | null> {
    if (busy.value) return null;
    const port = portRequest();
    if (!port) {
      status.value = { kind: 'error', message: t('mcumgr.error.noPort') };
      return null;
    }
    const generation = ++runGeneration;
    status.value = { kind: 'busy', action };
    lastResult.value = '';
    const wasConnected = isConnected.value;
    let outcome: T | null = null;
    const cancelRace = new Promise<never>((_, reject) => {
      rejectActiveRun = reject;
    });
    try {
      if (wasConnected) {
        await Promise.race([suspendConnection(), cancelRace]);
      }
      if (generation !== runGeneration) throw cancelledError();
      outcome = await Promise.race([work(port), cancelRace]);
      if (generation === runGeneration) status.value = { kind: 'idle' };
    } catch (error) {
      if (generation === runGeneration) applyFailure(error);
    } finally {
      if (generation === runGeneration) rejectActiveRun = null;
      // Always restore a yielded port, including after a UI-side cancel that
      // abandoned the in-flight invoke so controls can recover immediately.
      if (wasConnected && !(await resumeWithRetry())) {
        status.value = { kind: 'error', message: t('mcumgr.error.resumeFailed') };
      }
    }
    return generation === runGeneration ? outcome : null;
  }

  function applyFailure(error: unknown): void {
    const mapped = asMcumgrError(error) ?? fallbackError(error);
    if (mapped.kind === 'timeout') {
      status.value = { kind: 'timeout' };
    } else if (mapped.kind === 'cancelled') {
      status.value = { kind: 'idle' };
    } else {
      status.value = {
        kind: 'error',
        message: mapped.message,
        rc: mapped.rc,
        group: mapped.group,
      };
    }
    lastResult.value = mapped.message;
  }

  function progressChannel(action: string) {
    return createMcumgrProgressChannel((progress: McumgrProgress) => {
      if (status.value.kind !== 'busy' && status.value.kind !== 'progress') return;
      status.value = {
        kind: 'progress',
        action,
        phase: progress.phase,
        detail: progress.detail ?? undefined,
        offset: progress.offset ?? undefined,
        total: progress.total ?? undefined,
      };
    });
  }

  async function execute(action: string, op: McumgrOp): Promise<string | null> {
    const result = await run(action, async (port) => invokeMcumgrExecute({ port, op }));
    if (result === null) return null;
    lastResult.value = prettyJson(result.resultJson);
    return lastResult.value;
  }

  async function firmwareUpdate(
    fileToken: string,
    options: McumgrFirmwareUpdateOptions = {},
  ): Promise<string | null> {
    const action = 'firmware-update';
    const result = await run(action, async (port) =>
      invokeMcumgrFirmwareUpdate(
        {
          port,
          fileToken,
          skipReboot: options.skipReboot ?? false,
          forceConfirm: options.forceConfirm ?? false,
          upgradeOnly: options.upgradeOnly ?? false,
        },
        progressChannel(action),
      ),
    );
    if (result === null) return null;
    lastResult.value = prettyJson(result.resultJson);
    return lastResult.value;
  }

  async function imageUpload(fileToken: string, upgradeOnly = false): Promise<string | null> {
    const action = 'image-upload';
    const result = await run(action, async (port) =>
      invokeMcumgrImageUpload({ port, fileToken, upgradeOnly }, progressChannel(action)),
    );
    if (result === null) return null;
    lastResult.value = prettyJson(result.resultJson);
    return lastResult.value;
  }

  async function fsUpload(fileToken: string, remotePath: string): Promise<string | null> {
    const action = 'fs-upload';
    const result = await run(action, async (port) =>
      invokeMcumgrFsUpload({ port, fileToken, remotePath }, progressChannel(action)),
    );
    if (result === null) return null;
    lastResult.value = prettyJson(result.resultJson);
    return lastResult.value;
  }

  async function fsDownload(remotePath: string, saveToken: string): Promise<string | null> {
    const action = 'fs-download';
    const result = await run(action, async (port) =>
      invokeMcumgrFsDownload({ port, remotePath, saveToken }, progressChannel(action)),
    );
    if (result === null) return null;
    lastResult.value = prettyJson(
      JSON.stringify({ savedAs: result.displayName, bytes: result.bytes }),
    );
    return lastResult.value;
  }

  async function pickFile(purpose: McumgrFilePurpose): Promise<McumgrFilePick | null> {
    try {
      return await invokeMcumgrPickFile(purpose);
    } catch (error) {
      applyFailure(error);
      return null;
    }
  }

  async function pickSaveTarget(suggestedName: string): Promise<McumgrSavePick | null> {
    try {
      return await invokeMcumgrPickSaveTarget(suggestedName);
    } catch (error) {
      applyFailure(error);
      return null;
    }
  }

  function cancel(): void {
    if (!busy.value) return;
    // Unblock the UI immediately. Rust cancel is best-effort for open/auto-frame
    // and long transfers; the in-flight invoke may still finish in the background.
    runGeneration += 1;
    status.value = { kind: 'idle' };
    const reject = rejectActiveRun;
    rejectActiveRun = null;
    reject?.(cancelledError());
    void invokeMcumgrCancel().catch(() => {
      // Cancellation is best-effort; the operation also ends on timeout.
    });
  }

  function patchConfig(patch: Partial<McumgrClientConfig>): void {
    setConfig(patch);
  }

  function rememberShell(command: string): void {
    setConfig({
      shellHistory: appendShellHistory(session.value.mcumgrConfig.shellHistory, command),
    });
  }

  function setResult(text: string): void {
    lastResult.value = text;
  }

  return {
    status,
    lastResult,
    busy,
    execute,
    firmwareUpdate,
    imageUpload,
    fsUpload,
    fsDownload,
    pickFile,
    pickSaveTarget,
    cancel,
    patchConfig,
    rememberShell,
    setResult,
  };
}

function cancelledError(): McumgrError {
  return { kind: 'cancelled', message: 'cancelled' };
}

function fallbackError(error: unknown): McumgrError {
  return {
    kind: 'protocol',
    message: error instanceof Error ? error.message : String(error ?? 'MCUmgr failed'),
  };
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type SessionMcumgrController = ReturnType<typeof useSessionMcumgr>;
