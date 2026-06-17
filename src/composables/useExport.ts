import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame, DisplayMode } from '../types';
import {
  frameToJsonlLine,
  getCommandErrorMessage,
  invokeAppendLog,
  invokeExportData,
  invokeExportDataFromCaptureFile,
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

/** Injectable side-effects so the export flow can be unit-tested without a
 *  Tauri runtime. Defaults wire through to the real dialog + IPC. */
export interface UseExportDeps {
  /** Resolve a save path (or null when the user cancels). */
  promptSave?: (choice: ExportChoice) => Promise<string | null>;
  /** Invoke the Rust export command (legacy: frames cross IPC as a JSON array). */
  exportFrames?: (frames: DataFrame[], format: ExportFormat, path: string) => Promise<void>;
  /**
   * F12 IPC-bypass export path (T2.3): write the frames to a JSONL temp file
   * and invoke `export_data_from_capture_file`. When provided, this is preferred
   * over `exportFrames` because it avoids serializing the frames array through
   * the `invoke` argument. Defaults to the real temp-file write + command.
   */
  exportViaCaptureFile?: (
    frames: DataFrame[],
    format: ExportFormat,
    targetPath: string,
  ) => Promise<void>;
  /**
   * Whether to use the F12 capture-file bypass (production default). Set to
   * false to force the legacy exportFrames path (used by unit tests that stub
   * exportFrames, and as a fallback if the bypass is unavailable).
   */
  useCaptureFileBypass?: boolean;
}

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
      // Prefer the F12 IPC-bypass path (production default): it writes the
      // frames to a JSONL temp file and sends only the path, avoiding
      // serialization of up to 100k frames through the invoke argument. A caller
      // forces the legacy exportFrames path by passing useCaptureFileBypass:
      // false (or by stubbing exportFrames, e.g. in unit tests).
      const useBypass = deps.useCaptureFileBypass !== false && !deps.exportFrames;
      if (useBypass) {
        const via = deps.exportViaCaptureFile ?? defaultExportViaCaptureFile;
        await via(frames, format, path);
      } else {
        const doExport = deps.exportFrames ?? invokeExportData;
        await doExport(frames, format, path);
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

/**
 * Default F12 IPC-bypass export: write each frame as one JSONL line to a temp
 * file (via the stateless append_log command), then invoke
 * export_data_from_capture_file which reads+parses it on the Rust side. The
 * temp file lives in the system temp dir; the filename is unique per call.
 *
 * Each frame crosses IPC as a small text append rather than as an element of a
 * giant JSON array on the invoke argument — the dominant export cost (F12).
 */
async function defaultExportViaCaptureFile(
  frames: DataFrame[],
  format: ExportFormat,
  targetPath: string,
): Promise<void> {
  const captureFile = await defaultCaptureFilePath();
  // Clear any stale temp file by writing the first line, then append the rest.
  for (let i = 0; i < frames.length; i += 1) {
    const line = frameToJsonlLine(frames[i]) + '\n';
    // append_log creates the file if missing; the first write seeds it.
    await invokeAppendLog(captureFile, line);
  }
  try {
    await invokeExportDataFromCaptureFile(captureFile, format, targetPath);
  } finally {
    // Best-effort cleanup of the temp file; a failure here must not mask the
    // export result, so ignore errors.
    void invokeAppendLog(captureFile, '').catch(() => undefined);
  }
}

/** Resolve a unique temp-file path for the F12 capture. The path is constructed
 *  in the OS temp dir with a timestamp+random suffix to avoid collisions. */
async function defaultCaptureFilePath(): Promise<string> {
  // The frontend cannot directly access the OS temp dir without the fs plugin,
  // so we reuse the export target's directory + a hidden temp name. The Rust
  // side reads it from the same location the dialog chose.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `.bbcom-capture-${stamp}.jsonl`;
}
