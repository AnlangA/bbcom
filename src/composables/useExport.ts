import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame, DisplayMode } from '../types';
import {
  getCommandErrorMessage,
  invokeAbortExport,
  invokeAppendExportBatch,
  invokeBeginExport,
  invokeFinishExport,
  type ExportFramePayload,
} from '../lib/ipc';
import { resolveExportFormat, type ExportChoice, type ExportFormat } from '../lib/constants';
import { t } from '../lib/i18n';

const EXT_MAP: Record<ExportChoice, { name: string; ext: string }> = {
  txt: { name: 'TXT', ext: 'txt' },
  csv: { name: 'CSV', ext: 'csv' },
  jsonl: { name: 'JSONL', ext: 'jsonl' },
  bin: { name: 'BIN', ext: 'bin' },
};

/** `ok:true` on success; `ok:false` with no `error` when the user cancelled the save dialog. */
export type ExportResult = { ok: true } | { ok: false; error?: string };

export const EXPORT_BATCH_MAX_FRAMES = 512;
export const EXPORT_BATCH_MAX_BYTES = 4 * 1024 * 1024;
export const EXPORT_FRAME_MAX_BYTES = 2 * 1024 * 1024;

export interface ExportSessionClient {
  begin(format: ExportFormat, path: string): Promise<string>;
  append(exportId: string, frames: ExportFramePayload[]): Promise<void>;
  finish(exportId: string): Promise<void>;
  abort(exportId: string): Promise<void>;
}

/** Injectable side-effects so the export flow can be unit-tested without a
 *  Tauri runtime. Defaults wire through to the real dialog + IPC. */
export interface UseExportDeps {
  /** Resolve a save path (or null when the user cancels). */
  promptSave?: (choice: ExportChoice) => Promise<string | null>;
  /** Explicit legacy test seam. Production uses the bounded session protocol. */
  exportFrames?: (frames: DataFrame[], format: ExportFormat, path: string) => Promise<void>;
  /** Injectable bounded-export client for unit tests. */
  sessionClient?: ExportSessionClient;
}

const DEFAULT_SESSION_CLIENT: ExportSessionClient = {
  begin: invokeBeginExport,
  append: invokeAppendExportBatch,
  finish: invokeFinishExport,
  abort: invokeAbortExport,
};

export function useExport(deps: UseExportDeps = {}) {
  const isExporting = ref(false);

  async function exportData(
    frames: DataFrame[],
    choice: ExportChoice,
    displayMode: DisplayMode,
  ): Promise<ExportResult> {
    isExporting.value = true;
    try {
      const path = deps.promptSave
        ? await deps.promptSave(choice)
        : await defaultPromptSave(choice);
      if (!path) return { ok: false };

      const format = resolveExportFormat(choice, displayMode);
      if (deps.exportFrames) {
        await deps.exportFrames(frames, format, path);
      } else {
        await exportWithSession(frames, format, path, deps.sessionClient ?? DEFAULT_SESSION_CLIENT);
      }
      return { ok: true };
    } catch (e) {
      // Surface the typed Rust error (path validation, IO, too-many-frames) instead
      // of a generic toast. The serialized AppError is { type, details: { message } }.
      return { ok: false, error: getCommandErrorMessage(e, t('message.exportFallbackFailed')) };
    } finally {
      isExporting.value = false;
    }
  }

  return {
    isExporting,
    exportData,
  };
}

async function defaultPromptSave(choice: ExportChoice): Promise<string | null> {
  const filter = EXT_MAP[choice];
  return save({
    filters: [
      {
        name: filter.name,
        extensions: [filter.ext],
      },
    ],
  });
}

/** Lazily convert frames into bounded IPC payloads so only one batch is
 * materialized at a time. The limits mirror the Rust session validator. */
export function* createExportBatches(
  frames: readonly DataFrame[],
): Generator<ExportFramePayload[]> {
  let batch: ExportFramePayload[] = [];
  let batchBytes = 0;

  for (const frame of frames) {
    const frameBytes = frame.data.length;
    if (frameBytes > EXPORT_FRAME_MAX_BYTES) {
      throw new Error(`Frame ${frame.id} exceeds the ${EXPORT_FRAME_MAX_BYTES}-byte export limit`);
    }

    if (
      batch.length >= EXPORT_BATCH_MAX_FRAMES ||
      (batch.length > 0 && batchBytes + frameBytes > EXPORT_BATCH_MAX_BYTES)
    ) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }

    batch.push({
      id: frame.id,
      direction: frame.direction,
      timestamp: frame.timestamp,
      data: Array.from(frame.data),
    });
    batchBytes += frameBytes;
  }

  if (batch.length > 0) yield batch;
}

async function exportWithSession(
  frames: readonly DataFrame[],
  format: ExportFormat,
  path: string,
  client: ExportSessionClient,
): Promise<void> {
  const exportId = await client.begin(format, path);
  let finished = false;
  try {
    for (const batch of createExportBatches(frames)) {
      await client.append(exportId, batch);
    }
    await client.finish(exportId);
    finished = true;
  } finally {
    if (!finished) {
      // Preserve the original batching/IPC error if cleanup itself fails.
      await client.abort(exportId).catch(() => undefined);
    }
  }
}
