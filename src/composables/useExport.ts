import { ref } from 'vue';
import type { DataFrame, DisplayMode } from '../types';
import { iterateExportFrames, type ExportFrameSnapshot } from '../lib/export-filters';
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
export const EXPORT_MAX_FRAMES = 100_000;
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

/** A re-iterable, fixed-prefix export selection that does not copy frame refs. */
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
}

const DEFAULT_SESSION_CLIENT: ExportSessionClient = {
  begin: invokeBeginExport,
  append: invokeAppendExportBatch,
  finish: invokeFinishExport,
  abort: invokeAbortExport,
};

export function useExport(deps: UseExportDeps = {}) {
  const isExporting = ref(false);
  const progress = ref<ExportProgress>(emptyProgress());
  let cancelRequested = false;

  function cancelExport(): void {
    if (isExporting.value) cancelRequested = true;
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
      const source = resolveExportFrameSource(sourceInput);
      const totals = summarizeExportFrames(source.iterate());
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
        return { ok: false, cancelled: true };
      }
      if (cancelRequested) {
        await (deps.revokeTarget ?? revokeFileGrant)(targetGrant).catch(() => undefined);
        progress.value.phase = 'cancelled';
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
        },
        () => {
          progress.value.phase = 'finishing';
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
      return { ok: true };
    } catch (e) {
      if (e instanceof ExportCancelledError) {
        progress.value.phase = 'cancelled';
        return { ok: false, cancelled: true };
      }
      progress.value.phase = 'error';
      // Surface the typed Rust error (path validation, IO, too-many-frames) instead
      // of a generic toast. The serialized AppError is { type, details: { message } }.
      return { ok: false, error: getCommandErrorMessage(e, t('message.exportFallbackFailed')) };
    } finally {
      isExporting.value = false;
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
): Promise<ExportFinishStats> {
  const { exportId } = await client.begin(format, targetGrant, expected.frames, expected.rawBytes);
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
      await client.abort(exportId).catch(() => undefined);
    }
  }
}

function resolveExportFrameSource(input: ExportFrameInput): ResolvedExportFrameSource {
  if (isExportFrameSnapshot(input)) {
    return { iterate: () => iterateExportFrames(input) };
  }
  return { iterate: () => input };
}

function isExportFrameSnapshot(input: ExportFrameInput): input is ExportFrameSnapshot {
  return !Array.isArray(input);
}
