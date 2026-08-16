import { getCurrentInstance, inject, ref } from 'vue';
import type { DataFrame, DisplayMode } from '../types';
import {
  EXPORT_FRAME_REFERENCE_LIMIT,
  iterateExportFrames,
  type ExportFrameSnapshot,
} from '../lib/export-filters';
import {
  getCommandErrorMessage,
  invokeAbortExport,
  invokeAppendExportBatch,
  invokeBeginExport,
  invokeFinishExport,
  requestSaveTarget,
  revokeFileGrant,
  type ExportAppendStats,
  type ExportFinishStats,
  type ExportFrameBytes,
  type ExportSource,
  type SaveTargetPurpose,
} from '../features/native';
import { resolveExportFormat, type ExportChoice, type ExportFormat } from '../lib/constants';
import { t } from '../lib/i18n';
import type { IpcError } from '../generated/ipc-contracts';
import type { OperationRegistry } from '../features/application/operation-registry';
import { SESSION_APPLICATION_SERVICES_KEY } from '../features/sessions/runtime/session-application-services';
import { WORKSPACE_APPLICATION_KEY } from '../features/workspace/application';
import type { WorkspaceApplicationService } from '../features/workspace/application';

const EXT_MAP: Record<ExportChoice, string> = {
  txt: 'txt',
  csv: 'csv',
  jsonl: 'jsonl',
  bin: 'bin',
};

/** `ok:true` on success; `ok:false` with no `error` when the user cancelled the save dialog. */
export type ExportResult =
  | {
      ok: true;
      /** DB-mode only: the durable source exported a different frame count
       *  than the in-memory selection (paused-capture buffering). Surfaced by
       *  the caller — never dropped silently. */
      divergence?: { persistedFrames: number; selectionFrames: number };
    }
  | { ok: false; error?: string; cancelled?: true };

export const EXPORT_BATCH_MAX_FRAMES = 256;
export const EXPORT_BATCH_MAX_BYTES = 512 * 1024;
export const EXPORT_FRAME_MAX_BYTES = 2 * 1024 * 1024;
export const EXPORT_MAX_FRAMES = EXPORT_FRAME_REFERENCE_LIMIT;
export const EXPORT_MAX_BYTES = 128 * 1024 * 1024;

export type ExportPhase =
  'idle' | 'selecting-target' | 'streaming' | 'finishing' | 'completed' | 'cancelled' | 'error';

export interface ExportProgress {
  phase: ExportPhase;
  totalFrames: number;
  totalRawBytes: number;
  completedFrames: number;
  completedRawBytes: number;
  outputBytes: number;
  durationMs: number;
}

/** Durable whole-session export selection resolved after the save queue flush. */
export interface WorkspaceDbExportSelection {
  readonly workspaceId: string;
  /** Exclusive seq ceiling: the renderer's next append sequence after flush. */
  readonly toSeqExclusive: number;
}

/**
 * Flush-first seam for DB-sourced exports. `prepare` must flush the workspace
 * save queue (so every frame below the ceiling is durable) and then resolve
 * the export selection, or return null to keep the renderer-memory mode.
 */
export interface WorkspaceDbExportSource {
  prepare(sessionId: string): Promise<WorkspaceDbExportSelection | null>;
}

export interface ExportSessionClient {
  begin(
    format: ExportFormat,
    targetGrant: string,
    expectedFrames: number,
    expectedRawBytes: number,
    source?: ExportSource,
  ): Promise<{ exportId: string; expectedFrames?: number }>;
  append(exportId: string, frames: readonly ExportFrameBytes[]): Promise<ExportAppendStats>;
  finish(exportId: string): Promise<ExportFinishStats>;
  abort(exportId: string): Promise<void>;
}

/** A re-iterable, fixed reference selection that does not copy frame payloads. */
export type ExportFrameInput = readonly DataFrame[] | ExportFrameSnapshot;

interface ResolvedExportFrameSource {
  iterate: () => Iterable<DataFrame>;
}

/** Injectable side-effects so the export flow can be unit-tested without a
 *  Tauri runtime. Defaults wire through to the real dialog + IPC. */
export interface UseExportDeps {
  /** Backend save-dialog grant request seam used by tests. */
  requestTarget?: (
    purpose: SaveTargetPurpose,
    suggestedName: string,
  ) => ReturnType<typeof requestSaveTarget>;
  /** Injectable bounded-export client for unit tests. */
  sessionClient?: ExportSessionClient;
  revokeTarget?: (token: string) => Promise<void>;
  /** Application-owned lifecycle registry; omitted by isolated unit callers. */
  operations?: OperationRegistry;
  /** Stable ownership captured before the first async boundary. */
  workspaceId?: string;
  sessionId?: string;
  operationIdFactory?: () => string;
  /** Injectable DB-source seam (flush-first + seq ceiling). The default is
   *  derived from the injected workspace application context when it exposes
   *  a capture seq ceiling; null keeps renderer-memory mode. */
  dbSource?: WorkspaceDbExportSource;
}

/** Options for one export invocation. */
export interface ExportDataOptions {
  /** True only when the dialog applied no direction and no time filter, i.e.
   *  the selection is the whole session and a DB-sourced export is eligible. */
  unfiltered?: boolean;
}

const DEFAULT_SESSION_CLIENT: ExportSessionClient = {
  begin: invokeBeginExport,
  append: invokeAppendExportBatch,
  finish: invokeFinishExport,
  abort: invokeAbortExport,
};

export function useExport(deps: UseExportDeps = {}) {
  const applicationServices = getCurrentInstance()
    ? inject(SESSION_APPLICATION_SERVICES_KEY, null)
    : null;
  const workspace = getCurrentInstance() ? inject(WORKSPACE_APPLICATION_KEY, null) : null;
  const operations = deps.operations ?? applicationServices?.operationRegistry;
  const isExporting = ref(false);
  const progress = ref<ExportProgress>(emptyProgress());
  let cancelRequested = false;
  let activeOperationId: string | null = null;
  let abortNative: (() => Promise<void>) | null = null;

  function cancelExport(): void {
    if (!isExporting.value) return;
    cancelRequested = true;
    if (activeOperationId && operations) {
      void operations.cancel(activeOperationId);
    } else {
      void abortNative?.();
    }
  }

  function resetExportProgress(): void {
    if (!isExporting.value) progress.value = emptyProgress();
  }

  async function exportData(
    sourceInput: ExportFrameInput,
    choice: ExportChoice,
    displayMode: DisplayMode,
    options: ExportDataOptions = {},
  ): Promise<ExportResult> {
    isExporting.value = true;
    cancelRequested = false;
    progress.value = emptyProgress();
    try {
      const operationBinding = operations
        ? {
            workspaceId: requireOperationIdentity(
              'workspaceId',
              deps.workspaceId ?? workspace?.application.snapshot().currentWorkspace?.workspaceId,
            ),
            sessionId: requireOperationIdentity('sessionId', deps.sessionId),
          }
        : null;
      const source = resolveExportFrameSource(sourceInput);
      const totals = summarizeExportFrames(source.iterate());
      if (operations && operationBinding) {
        const operationId = createSessionExportOperationId(deps.operationIdFactory);
        activeOperationId = operationId;
        operations.create({
          operationId,
          kind: 'session-export',
          workspaceId: operationBinding.workspaceId,
          sessionId: operationBinding.sessionId,
          progress: { completedUnits: 0, totalUnits: totals.frames },
          cancel: async () => {
            cancelRequested = true;
            await abortNative?.();
          },
        });
        operations.start(operationId);
      }
      progress.value = {
        ...emptyProgress(),
        phase: 'selecting-target',
        totalFrames: totals.frames,
        totalRawBytes: totals.rawBytes,
      };
      const format = resolveExportFormat(choice, displayMode);
      const targetGrant = await requestExportTarget(
        choice,
        format,
        deps.requestTarget ?? requestSaveTarget,
      );
      if (!targetGrant) {
        progress.value.phase = 'cancelled';
        await cancelRegisteredOperation(operations, activeOperationId);
        return { ok: false, cancelled: true };
      }
      if (cancelRequested) {
        await (deps.revokeTarget ?? revokeFileGrant)(targetGrant).catch(() => undefined);
        progress.value.phase = 'cancelled';
        await cancelRegisteredOperation(operations, activeOperationId);
        return { ok: false, cancelled: true };
      }

      // DB mode is eligible only for a whole-session export (no direction and
      // no time filter) whose session lives in the active workspace. `prepare`
      // owns the flush-first obligation: everything below the returned seq
      // ceiling is durable before the backend begin reads it.
      let exportSource: ExportSource | undefined;
      if (options.unfiltered === true && deps.sessionId) {
        const dbSource = deps.dbSource ?? defaultWorkspaceDbExportSource(workspace?.application);
        const selection = await dbSource?.prepare(deps.sessionId);
        if (selection) {
          exportSource = {
            kind: 'workspace-frames',
            workspaceId: selection.workspaceId,
            sessionId: deps.sessionId,
            toSeqExclusive: selection.toSeqExclusive,
          };
        }
      }

      const { stats, divergence } = await exportWithSession(
        source.iterate(),
        format,
        targetGrant,
        deps.sessionClient ?? DEFAULT_SESSION_CLIENT,
        totals,
        () => cancelRequested,
        (appendStats) => {
          progress.value.phase = 'streaming';
          progress.value.completedFrames = appendStats.totalFrames;
          progress.value.completedRawBytes = appendStats.totalRawBytes;
          const operationId = activeOperationId;
          const record = operationId ? operations?.get(operationId) : undefined;
          if (operationId && record?.status === 'running') {
            operations?.updateProgress(operationId, {
              completedUnits: appendStats.totalFrames,
            });
          }
        },
        () => {
          progress.value.phase = 'finishing';
        },
        (_exportId, abort) => {
          abortNative = abort;
        },
        exportSource,
      );
      progress.value = {
        ...progress.value,
        phase: 'completed',
        totalFrames: divergence ? stats.frames : progress.value.totalFrames,
        completedFrames: stats.frames,
        completedRawBytes: stats.rawBytes,
        outputBytes: stats.outputBytes,
        durationMs: stats.durationMs,
      };
      completeRegisteredOperation(operations, activeOperationId);
      return divergence ? { ok: true, divergence } : { ok: true };
    } catch (e) {
      if (e instanceof ExportCancelledError) {
        progress.value.phase = 'cancelled';
        await cancelRegisteredOperation(operations, activeOperationId);
        return { ok: false, cancelled: true };
      }
      const operation = activeOperationId ? operations?.get(activeOperationId) : undefined;
      if (
        cancelRequested ||
        operation?.status === 'cancelling' ||
        operation?.status === 'cancelled' ||
        operation?.status === 'interrupted'
      ) {
        progress.value.phase = 'cancelled';
        return { ok: false, cancelled: true };
      }
      progress.value.phase = 'error';
      failRegisteredOperation(operations, activeOperationId, e);
      // Surface the typed Rust error (path validation, IO, too-many-frames) instead
      // of a generic toast. The serialized AppError is { type, details: { message } }.
      return { ok: false, error: getCommandErrorMessage(e, t('message.exportFallbackFailed')) };
    } finally {
      isExporting.value = false;
      activeOperationId = null;
      abortNative = null;
    }
  }

  return {
    isExporting,
    progress,
    cancelExport,
    resetExportProgress,
    exportData,
  };
}

function emptyProgress(): ExportProgress {
  return {
    phase: 'idle',
    totalFrames: 0,
    totalRawBytes: 0,
    completedFrames: 0,
    completedRawBytes: 0,
    outputBytes: 0,
    durationMs: 0,
  };
}

export function summarizeExportFrames(frames: Iterable<DataFrame>): {
  frames: number;
  rawBytes: number;
} {
  let frameCount = 0;
  let rawBytes = 0;
  for (const frame of frames) {
    frameCount += 1;
    if (frameCount > EXPORT_MAX_FRAMES) {
      throw new Error(`Export contains more than ${EXPORT_MAX_FRAMES} frames`);
    }
    if (frame.data.length > EXPORT_FRAME_MAX_BYTES) {
      throw new Error(`Frame ${frame.id} exceeds the ${EXPORT_FRAME_MAX_BYTES}-byte export limit`);
    }
    rawBytes += frame.data.length;
    if (rawBytes > EXPORT_MAX_BYTES) {
      throw new Error(`Export data exceeds the ${EXPORT_MAX_BYTES}-byte limit`);
    }
  }
  if (frameCount === 0) throw new Error('No frames match the export filters');
  return { frames: frameCount, rawBytes };
}

async function requestExportTarget(
  choice: ExportChoice,
  format: ExportFormat,
  requestTarget: typeof requestSaveTarget,
): Promise<string | null> {
  const suggestedName = `bbcom-export-${Date.now()}.${EXT_MAP[choice]}`;
  const grant = await requestTarget(savePurposeForFormat(format), suggestedName);
  return grant?.token ?? null;
}

export function savePurposeForFormat(format: ExportFormat): SaveTargetPurpose {
  switch (format) {
    case 'txt-hex':
      return 'export-txt-hex';
    case 'txt-ascii':
      return 'export-txt-ascii';
    case 'csv':
      return 'export-csv';
    case 'jsonl':
      return 'export-jsonl';
    case 'bin':
      return 'export-bin';
  }
}

/** Lazily convert frames into bounded IPC payloads so only one batch is
 * materialized at a time. The limits mirror the Rust session validator. */
export function* createExportBatches(frames: Iterable<DataFrame>): Generator<ExportFrameBytes[]> {
  let batch: ExportFrameBytes[] = [];
  let batchBytes = 0;

  for (const frame of frames) {
    const frameBytes = frame.data.length;
    if (frameBytes > EXPORT_FRAME_MAX_BYTES) {
      throw new Error(`Frame ${frame.id} exceeds the ${EXPORT_FRAME_MAX_BYTES}-byte export limit`);
    }

    if (frameBytes > EXPORT_BATCH_MAX_BYTES) {
      if (batch.length > 0) {
        yield batch;
        batch = [];
        batchBytes = 0;
      }
      yield [toExportFramePayload(frame)];
      continue;
    }

    if (
      batch.length >= EXPORT_BATCH_MAX_FRAMES ||
      (batch.length > 0 && batchBytes + frameBytes > EXPORT_BATCH_MAX_BYTES)
    ) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }

    batch.push(toExportFramePayload(frame));
    batchBytes += frameBytes;
  }

  if (batch.length > 0) yield batch;
}

function toExportFramePayload(frame: DataFrame): ExportFrameBytes {
  return {
    id: frame.id,
    direction: frame.direction,
    timestamp: frame.timestamp,
    // Bytes stay on the raw capture buffer; the typed IPC wrapper widens them
    // to the base64 channel. This is intentionally only one bounded IPC batch
    // at a time, never a full-capture conversion or duplicate frame array.
    data: frame.data,
  };
}

class ExportCancelledError extends Error {}

/** One completed export: final stats plus any persisted/selection divergence
 *  the backend-source mode surfaced at begin time. */
interface ExportWithSessionResult {
  stats: ExportFinishStats;
  divergence?: { persistedFrames: number; selectionFrames: number };
}

async function exportWithSession(
  frames: Iterable<DataFrame>,
  format: ExportFormat,
  targetGrant: string,
  client: ExportSessionClient,
  expected: { frames: number; rawBytes: number },
  isCancelled: () => boolean,
  onProgress: (stats: ExportAppendStats) => void,
  onFinishing: () => void,
  onStarted: (exportId: string, abort: () => Promise<void>) => void = () => undefined,
  exportSource?: ExportSource,
): Promise<ExportWithSessionResult> {
  const begin = await client.begin(
    format,
    targetGrant,
    expected.frames,
    expected.rawBytes,
    exportSource,
  );
  const exportId = begin.exportId;
  let abortTask: Promise<void> | null = null;
  const abort = (): Promise<void> => {
    abortTask ??= Promise.resolve().then(() => client.abort(exportId));
    return abortTask;
  };
  onStarted(exportId, abort);
  let finished = false;
  try {
    if (exportSource) {
      // Backend-source mode: the backend paged the durable frames in during
      // begin, so nothing is streamed from renderer memory. Appends for this
      // export id are rejected by the backend by design.
      const persisted = begin.expectedFrames ?? expected.frames;
      onProgress({ totalFrames: persisted, totalRawBytes: expected.rawBytes });
      if (persisted !== expected.frames) {
        return {
          stats: await finish(),
          divergence: { persistedFrames: persisted, selectionFrames: expected.frames },
        };
      }
      return { stats: await finish() };
    }
    for (const batch of createExportBatches(frames)) {
      if (isCancelled()) throw new ExportCancelledError('export cancelled');
      onProgress(await client.append(exportId, batch));
    }
    if (isCancelled()) throw new ExportCancelledError('export cancelled');
    return { stats: await finish() };
  } finally {
    if (!finished) {
      // Preserve the original batching/IPC error if cleanup itself fails.
      await abort().catch(() => undefined);
    }
  }

  async function finish(): Promise<ExportFinishStats> {
    if (isCancelled()) throw new ExportCancelledError('export cancelled');
    onFinishing();
    const stats = await client.finish(exportId);
    finished = true;
    return stats;
  }
}

/**
 * Default DB-source seam over the injected workspace application: whole-session
 * eligibility (the session belongs to the active workspace), the durable seq
 * ceiling, and the flush-first barrier. Returns null (renderer-memory mode)
 * when the application context is absent, the session is foreign, the seq
 * ceiling is unavailable, or the flush did not complete.
 */
function defaultWorkspaceDbExportSource(
  application: WorkspaceApplicationService | null | undefined,
): WorkspaceDbExportSource | null {
  if (!application) return null;
  return {
    async prepare(sessionId: string): Promise<WorkspaceDbExportSelection | null> {
      const current = application.snapshot().currentWorkspace;
      if (!current || !current.sessionIds.includes(sessionId)) return null;
      const toSeqExclusive = readCaptureSeqCeiling(application, sessionId);
      if (toSeqExclusive === null || !Number.isSafeInteger(toSeqExclusive)) return null;
      // Flush first so every frame below the ceiling is durable before the
      // backend reads it; a failed flush keeps the renderer-memory export.
      const outcome = await application.flush();
      if (outcome.outcome !== 'completed') return null;
      return { workspaceId: current.workspaceId, toSeqExclusive };
    },
  };
}

/** The workspace application owns the per-session append sequence (seq
 *  ceiling). Until it exposes that capture accounting publicly, DB mode only
 *  activates when the capability is present; otherwise renderer mode runs. */
function readCaptureSeqCeiling(
  application: WorkspaceApplicationService,
  sessionId: string,
): number | null {
  const provider = application as WorkspaceApplicationService & {
    captureSeqCeiling?: (sessionId: string) => number | null;
  };
  return typeof provider.captureSeqCeiling === 'function'
    ? provider.captureSeqCeiling(sessionId)
    : null;
}

let fallbackOperationSequence = 0;

function createSessionExportOperationId(factory: (() => string) | undefined): string {
  const generated = factory
    ? factory()
    : typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${++fallbackOperationSequence}`;
  const normalized = generated.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,223}$/.test(normalized)) {
    throw new Error('session export operationId must be a path-free opaque identifier');
  }
  return `session-export:${normalized}`;
}

function requireOperationIdentity(field: string, value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new Error(`${field} is required when registering an export operation`);
  }
  return value;
}

function completeRegisteredOperation(
  operations: OperationRegistry | undefined,
  operationId: string | null,
): void {
  if (!operations || !operationId) return;
  const record = operations.get(operationId);
  if (record?.status === 'running') operations.complete(operationId);
}

async function cancelRegisteredOperation(
  operations: OperationRegistry | undefined,
  operationId: string | null,
): Promise<void> {
  if (!operations || !operationId) return;
  const record = operations.get(operationId);
  if (record?.status === 'queued' || record?.status === 'running') {
    await operations.cancel(operationId);
  }
}

function failRegisteredOperation(
  operations: OperationRegistry | undefined,
  operationId: string | null,
  error: unknown,
): void {
  if (!operations || !operationId) return;
  const record = operations.get(operationId);
  if (record?.status !== 'running' && record?.status !== 'queued') return;
  operations.fail(operationId, exportFailure(error, operationId));
}

function exportFailure(error: unknown, operationId: string): IpcError {
  if (isIpcError(error)) return error;
  return Object.freeze({
    code: 'EXPORT_REPLACE_FAILED',
    messageKey: 'message.exportFallbackFailed',
    retryable: false,
    operation: 'session-export',
    requestId: operationId,
  });
}

function isIpcError(value: unknown): value is IpcError {
  if (!value || typeof value !== 'object') return false;
  const error = value as Partial<IpcError>;
  return (
    typeof error.code === 'string' &&
    typeof error.messageKey === 'string' &&
    typeof error.retryable === 'boolean' &&
    typeof error.operation === 'string'
  );
}

function resolveExportFrameSource(input: ExportFrameInput): ResolvedExportFrameSource {
  if (isExportFrameSnapshot(input)) {
    return { iterate: () => iterateExportFrames(input) };
  }
  // Public callers may still provide a raw array. Freeze its references before
  // awaiting the save dialog so capture trimming/appending cannot change the
  // totals between begin and finish. Copying stops before a 100,001st ref is
  // retained, while each DataFrame/Uint8Array remains zero-copy.
  const frames: DataFrame[] = [];
  for (const frame of input) {
    if (frames.length >= EXPORT_MAX_FRAMES) {
      throw new Error(`Export contains more than ${EXPORT_MAX_FRAMES} frames`);
    }
    frames.push(frame);
  }
  return { iterate: () => frames };
}

function isExportFrameSnapshot(input: ExportFrameInput): input is ExportFrameSnapshot {
  return !Array.isArray(input);
}
