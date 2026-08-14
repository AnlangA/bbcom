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
  type ExportFramePayload,
  type ExportFinishStats,
  type SaveTargetPurpose,
} from '../lib/ipc';
import { resolveExportFormat, type ExportChoice, type ExportFormat } from '../lib/constants';
import { t } from '../lib/i18n';
import type { IpcError } from '../generated/ipc-contracts';
import type { OperationRegistry } from '../features/application/operation-registry';
import { SESSION_APPLICATION_SERVICES_KEY } from '../features/sessions/runtime/session-application-services';
import { WORKSPACE_APPLICATION_KEY } from '../features/workspace/application';

const EXT_MAP: Record<ExportChoice, string> = {
  txt: 'txt',
  csv: 'csv',
  jsonl: 'jsonl',
  bin: 'bin',
};

/** `ok:true` on success; `ok:false` with no `error` when the user cancelled the save dialog. */
export type ExportResult = { ok: true } | { ok: false; error?: string; cancelled?: true };

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

export interface ExportSessionClient {
  begin(
    format: ExportFormat,
    targetGrant: string,
    expectedFrames: number,
    expectedRawBytes: number,
  ): Promise<{ exportId: string }>;
  append(exportId: string, frames: ExportFramePayload[]): Promise<ExportAppendStats>;
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

      const stats = await exportWithSession(
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
      );
      progress.value = {
        ...progress.value,
        phase: 'completed',
        completedFrames: stats.frames,
        completedRawBytes: stats.rawBytes,
        outputBytes: stats.outputBytes,
        durationMs: stats.durationMs,
      };
      completeRegisteredOperation(operations, activeOperationId);
      return { ok: true };
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
export function* createExportBatches(frames: Iterable<DataFrame>): Generator<ExportFramePayload[]> {
  let batch: ExportFramePayload[] = [];
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

function toExportFramePayload(frame: DataFrame): ExportFramePayload {
  return {
    id: frame.id,
    direction: frame.direction,
    timestamp: frame.timestamp,
    // Tauri's JSON command boundary deserializes Rust `Vec<u8>` from a plain
    // number array.  This is intentionally only one bounded IPC batch at a
    // time, never a full-capture conversion or duplicate frame array.
    data: Array.from(frame.data),
  };
}

class ExportCancelledError extends Error {}

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
): Promise<ExportFinishStats> {
  const { exportId } = await client.begin(format, targetGrant, expected.frames, expected.rawBytes);
  let abortTask: Promise<void> | null = null;
  const abort = (): Promise<void> => {
    abortTask ??= Promise.resolve().then(() => client.abort(exportId));
    return abortTask;
  };
  onStarted(exportId, abort);
  let finished = false;
  try {
    for (const batch of createExportBatches(frames)) {
      if (isCancelled()) throw new ExportCancelledError('export cancelled');
      onProgress(await client.append(exportId, batch));
    }
    if (isCancelled()) throw new ExportCancelledError('export cancelled');
    onFinishing();
    const stats = await client.finish(exportId);
    finished = true;
    return stats;
  } finally {
    if (!finished) {
      // Preserve the original batching/IPC error if cleanup itself fails.
      await abort().catch(() => undefined);
    }
  }
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
