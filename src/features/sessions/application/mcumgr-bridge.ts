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
} from '@/features/platform/native/tauri-ipc';
import { bytesToBase64 } from '@/lib/base64';
import { appendShellHistory } from '@/lib/mcumgr-config';
import {
  formatMcumgrErrorDetail,
  getMcumgrErrorMessage,
  mcumgrFrontendError,
} from '@/lib/mcumgr-error';
import { t } from '@/lib/i18n';
import type {
  McumgrError,
  McumgrFilePick,
  McumgrFilePurpose,
  McumgrOp,
  McumgrPortRequest,
  McumgrProgress,
  McumgrSavePick,
  McumgrTraceFrame,
} from '@/generated/ipc-contracts';
import type { McumgrClientConfig, McumgrClientStatus, SerialSession } from '@/types';

export interface McumgrFirmwareUpdateOptions {
  skipReboot?: boolean;
  forceConfirm?: boolean;
  upgradeOnly?: boolean;
}

export interface McumgrBridgeCreateOptions {
  session: Ref<SerialSession>;
  isConnected: Ref<boolean>;
  /** Cleanly closes the frontend serial connection (port yield). */
  suspendConnection: () => Promise<void>;
  /** Re-opens the frontend serial connection after the operation. */
  resumeConnection: () => Promise<boolean>;
  /** Replays MCUmgr wire trace into the session capture buffer. */
  ingestTraceFrames: (frames: readonly McumgrTraceFrame[]) => void;
  setConfig: (patch: Partial<McumgrClientConfig>) => void;
}

const RESUME_RETRY_DELAYS_MS = [0, 1_000, 2_500];

/**
 * MCUmgr orchestration: yields the session's serial port to the Rust backend
 * (which opens it directly for `mcumgr-toolkit`), then restores the previous
 * connection state. Works on disconnected sessions without any yielding.
 */
export class McumgrBridge {
  readonly status = ref<McumgrClientStatus>({ kind: 'idle' });
  readonly lastResult = ref('');
  /** True while a yielded session port is suspended or being restored. */
  readonly portYielding = ref(false);
  readonly busy = computed(
    () =>
      this.portYielding.value ||
      this.status.value.kind === 'busy' ||
      this.status.value.kind === 'progress',
  );

  private readonly options: McumgrBridgeCreateOptions;
  private runGeneration = 0;
  private rejectActiveRun: ((error: McumgrError) => void) | null = null;

  constructor(options: McumgrBridgeCreateOptions) {
    this.options = options;
  }

  private portRequest(): McumgrPortRequest | null {
    const path = this.options.session.value.portName.trim();
    if (!path) return null;
    const config = this.options.session.value.mcumgrConfig;
    return {
      path,
      baudRate: this.options.session.value.portConfig.baudRate,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      autoFrameSize: config.autoFrameSize,
      frameSize: config.frameSize,
    };
  }

  private async resumeWithRetry(): Promise<boolean> {
    for (const delay of RESUME_RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        if (await this.options.resumeConnection()) return true;
      } catch {
        // The controller records its own failure state; keep retrying.
      }
    }
    return false;
  }

  private async run<T>(
    action: string,
    work: (port: McumgrPortRequest) => Promise<T>,
  ): Promise<T | null> {
    if (this.busy.value) return null;
    const port = this.portRequest();
    if (!port) {
      this.status.value = {
        kind: 'error',
        message: t('mcumgr.error.noPort'),
      };
      return null;
    }
    const generation = ++this.runGeneration;
    this.status.value = { kind: 'busy', action };
    this.lastResult.value = '';
    const wasConnected = this.options.isConnected.value;
    this.portYielding.value = wasConnected;
    let outcome: T | null = null;
    const cancelRace = new Promise<never>((_, reject) => {
      this.rejectActiveRun = reject;
    });
    try {
      if (wasConnected) {
        await Promise.race([this.options.suspendConnection(), cancelRace]);
      }
      if (generation !== this.runGeneration) throw cancelledError();
      outcome = await Promise.race([work(port), cancelRace]);
    } catch (error) {
      if (generation === this.runGeneration) this.applyFailure(error);
    } finally {
      if (generation === this.runGeneration) this.rejectActiveRun = null;
      const statusKind = this.status.value.kind;
      const returnToIdle = statusKind === 'busy' || statusKind === 'progress';
      let resumeFailed = false;
      try {
        if (wasConnected && !(await this.resumeWithRetry())) {
          resumeFailed = true;
          this.status.value = { kind: 'error', message: t('mcumgr.error.resumeFailed') };
        }
      } finally {
        this.portYielding.value = false;
        if (returnToIdle && !resumeFailed) {
          this.status.value = { kind: 'idle' };
        }
      }
    }
    return generation === this.runGeneration ? outcome : null;
  }

  private applyFailure(error: unknown): void {
    const mapped = asMcumgrError(error) ?? fallbackError(error);
    if (mapped.kind === 'timeout') {
      this.status.value = { kind: 'timeout' };
      this.lastResult.value = formatMcumgrErrorDetail(mapped);
      return;
    }
    if (mapped.kind === 'cancelled') {
      this.status.value = { kind: 'idle' };
      return;
    }
    this.status.value = {
      kind: 'error',
      message: getMcumgrErrorMessage(mapped),
      rc: mapped.rc,
      group: mapped.group,
    };
    this.lastResult.value = formatMcumgrErrorDetail(mapped);
  }

  private progressChannel(action: string) {
    return createMcumgrProgressChannel((progress: McumgrProgress) => {
      if (this.status.value.kind !== 'busy' && this.status.value.kind !== 'progress') return;
      this.status.value = {
        kind: 'progress',
        action,
        phase: progress.phase,
        detail: progress.detail ?? undefined,
        offset: progress.offset ?? undefined,
        total: progress.total ?? undefined,
      };
    });
  }

  private replayTrace(result: { traceFrames?: McumgrTraceFrame[] } | null | undefined): void {
    const frames = result?.traceFrames;
    if (!frames?.length) return;
    this.options.ingestTraceFrames(frames);
  }

  async execute(action: string, op: McumgrOp): Promise<string | null> {
    const result = await this.run(action, async (port) => invokeMcumgrExecute({ port, op }));
    if (result === null) return null;
    this.replayTrace(result);
    this.lastResult.value = prettyJson(result.resultJson);
    return this.lastResult.value;
  }

  async firmwareUpdate(
    fileToken: string,
    options: McumgrFirmwareUpdateOptions = {},
  ): Promise<string | null> {
    const action = 'firmware-update';
    const result = await this.run(action, async (port) =>
      invokeMcumgrFirmwareUpdate(
        {
          port,
          fileToken,
          skipReboot: options.skipReboot ?? false,
          forceConfirm: options.forceConfirm ?? false,
          upgradeOnly: options.upgradeOnly ?? false,
        },
        this.progressChannel(action),
      ),
    );
    if (result === null) return null;
    this.replayTrace(result);
    this.lastResult.value = prettyJson(result.resultJson);
    return this.lastResult.value;
  }

  async imageUpload(fileToken: string, upgradeOnly = false): Promise<string | null> {
    const action = 'image-upload';
    const result = await this.run(action, async (port) =>
      invokeMcumgrImageUpload({ port, fileToken, upgradeOnly }, this.progressChannel(action)),
    );
    if (result === null) return null;
    this.replayTrace(result);
    this.lastResult.value = prettyJson(result.resultJson);
    return this.lastResult.value;
  }

  async fsUpload(fileToken: string, remotePath: string): Promise<string | null> {
    const action = 'fs-upload';
    const result = await this.run(action, async (port) =>
      invokeMcumgrFsUpload({ port, fileToken, remotePath }, this.progressChannel(action)),
    );
    if (result === null) return null;
    this.replayTrace(result);
    this.lastResult.value = prettyJson(result.resultJson);
    return this.lastResult.value;
  }

  async fsDownload(remotePath: string, saveToken: string): Promise<string | null> {
    const action = 'fs-download';
    const result = await this.run(action, async (port) =>
      invokeMcumgrFsDownload({ port, remotePath, saveToken }, this.progressChannel(action)),
    );
    if (result === null) return null;
    this.replayTrace(result);
    this.lastResult.value = prettyJson(
      JSON.stringify({ savedAs: result.displayName, bytes: result.bytes }),
    );
    return this.lastResult.value;
  }

  async pickFile(purpose: McumgrFilePurpose): Promise<McumgrFilePick | null> {
    try {
      return await invokeMcumgrPickFile(purpose);
    } catch (error) {
      this.applyFailure(error);
      return null;
    }
  }

  async pickSaveTarget(suggestedName: string): Promise<McumgrSavePick | null> {
    try {
      return await invokeMcumgrPickSaveTarget(suggestedName);
    } catch (error) {
      this.applyFailure(error);
      return null;
    }
  }

  cancel(): void {
    if (!this.busy.value) return;
    this.runGeneration += 1;
    this.status.value = { kind: 'idle' };
    const reject = this.rejectActiveRun;
    this.rejectActiveRun = null;
    reject?.(cancelledError());
    void invokeMcumgrCancel().catch(() => {
      // Cancellation is best-effort; the operation also ends on timeout.
    });
  }

  patchConfig(patch: Partial<McumgrClientConfig>): void {
    this.options.setConfig(patch);
  }

  rememberShell(command: string): void {
    this.options.setConfig({
      shellHistory: appendShellHistory(
        this.options.session.value.mcumgrConfig.shellHistory,
        command,
      ),
    });
  }

  setResult(text: string): void {
    this.lastResult.value = text;
  }

  async runOsEcho(message: string): Promise<string | null> {
    return this.execute('echo', { kind: 'os-echo', message });
  }

  async runImageTest(hashHex: string): Promise<string | null> {
    const hash = hashHex.trim();
    if (!hash) return null;
    return this.execute('image-test', { kind: 'image-test', hashHex: hash });
  }

  async runImageConfirm(hashHex: string): Promise<string | null> {
    const hash = hashHex.trim();
    return this.execute('image-confirm', { kind: 'image-confirm', hashHex: hash ? hash : null });
  }

  async pickAndFsUpload(remotePath: string): Promise<string | null> {
    const path = remotePath.trim();
    if (!path) return null;
    const pick = await this.pickFile('fs-upload');
    if (!pick) return null;
    return this.fsUpload(pick.token, path);
  }

  async pickAndFsDownload(remotePath: string): Promise<string | null> {
    const path = remotePath.trim();
    if (!path) return null;
    const suggested = path.split('/').filter(Boolean).pop() ?? 'download.bin';
    const pick = await this.pickSaveTarget(suggested);
    if (!pick) return null;
    return this.fsDownload(path, pick.token);
  }

  async runShellLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const result = await this.execute('shell', { kind: 'shell', line: trimmed });
    if (result !== null) this.rememberShell(trimmed);
    return result;
  }

  async runSettingsWrite(name: string, value: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return this.execute('settings-write', {
      kind: 'settings-write',
      name: trimmed,
      valueB64: bytesToBase64(textOrHexBytes(value)),
    });
  }

  async runRawOp(
    group: number,
    command: number,
    write: boolean,
    payload: string,
  ): Promise<string | null> {
    const trimmed = payload.trim();
    const op: McumgrOp = trimmed.startsWith('{')
      ? {
          kind: 'raw',
          group,
          command,
          write,
          payloadJson: trimmed,
          payloadB64: null,
        }
      : {
          kind: 'raw',
          group,
          command,
          write,
          payloadJson: null,
          payloadB64: trimmed ? bytesToBase64(parseHexBytes(trimmed)) : null,
        };
    return this.execute('raw', op);
  }
}

export function createMcumgrBridge(options: McumgrBridgeCreateOptions): McumgrBridge {
  return new McumgrBridge(options);
}

export function useSessionMcumgr(options: McumgrBridgeCreateOptions) {
  const bridge = createMcumgrBridge(options);
  return {
    status: bridge.status,
    lastResult: bridge.lastResult,
    busy: bridge.busy,
    portYielding: bridge.portYielding,
    execute: (action: string, op: McumgrOp) => bridge.execute(action, op),
    firmwareUpdate: (fileToken: string, opts?: McumgrFirmwareUpdateOptions) =>
      bridge.firmwareUpdate(fileToken, opts),
    imageUpload: (fileToken: string, upgradeOnly?: boolean) =>
      bridge.imageUpload(fileToken, upgradeOnly),
    fsUpload: (fileToken: string, remotePath: string) => bridge.fsUpload(fileToken, remotePath),
    fsDownload: (remotePath: string, saveToken: string) =>
      bridge.fsDownload(remotePath, saveToken),
    pickFile: (purpose: McumgrFilePurpose) => bridge.pickFile(purpose),
    pickSaveTarget: (suggestedName: string) => bridge.pickSaveTarget(suggestedName),
    cancel: () => bridge.cancel(),
    patchConfig: (patch: Partial<McumgrClientConfig>) => bridge.patchConfig(patch),
    rememberShell: (command: string) => bridge.rememberShell(command),
    setResult: (text: string) => bridge.setResult(text),
    runOsEcho: (message: string) => bridge.runOsEcho(message),
    runImageTest: (hashHex: string) => bridge.runImageTest(hashHex),
    runImageConfirm: (hashHex: string) => bridge.runImageConfirm(hashHex),
    pickAndFsUpload: (remotePath: string) => bridge.pickAndFsUpload(remotePath),
    pickAndFsDownload: (remotePath: string) => bridge.pickAndFsDownload(remotePath),
    runShellLine: (line: string) => bridge.runShellLine(line),
    runSettingsWrite: (name: string, value: string) => bridge.runSettingsWrite(name, value),
    runRawOp: (group: number, command: number, write: boolean, payload: string) =>
      bridge.runRawOp(group, command, write, payload),
  };
}

export type SessionMcumgrController = ReturnType<typeof useSessionMcumgr>;

function cancelledError(): McumgrError {
  return mcumgrFrontendError('cancelled', 'mcumgr.error.kind.cancelled');
}

function fallbackError(error: unknown): McumgrError {
  return {
    kind: 'protocol',
    message: error instanceof Error ? error.message : String(error ?? t('mcumgr.error.fallback')),
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

function parseHexBytes(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0) throw new RangeError('hash must be hex');
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function textOrHexBytes(value: string): Uint8Array {
  try {
    return parseHexBytes(value);
  } catch {
    return new TextEncoder().encode(value);
  }
}
