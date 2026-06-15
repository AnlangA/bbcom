import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame, DisplayMode } from '../types';
import { getCommandErrorMessage, invokeExportData } from '../lib/ipc';
import { resolveExportFormat, type ExportChoice } from '../lib/constants';
import { t } from '../lib/i18n';

const EXT_MAP: Record<ExportChoice, { name: string; ext: string }> = {
  txt: { name: 'TXT', ext: 'txt' },
  csv: { name: 'CSV', ext: 'csv' },
  jsonl: { name: 'JSONL', ext: 'jsonl' },
  bin: { name: 'BIN', ext: 'bin' },
};

/** `ok:true` on success; `ok:false` with no `error` when the user cancelled the save dialog. */
export type ExportResult = { ok: true } | { ok: false; error?: string };

export function useExport() {
  const isExporting = ref(false);

  async function exportData(
    frames: DataFrame[],
    choice: ExportChoice,
    displayMode: DisplayMode,
  ): Promise<ExportResult> {
    isExporting.value = true;
    try {
      const filter = EXT_MAP[choice];
      const path = await save({
        filters: [
          {
            name: filter.name,
            extensions: [filter.ext],
          },
        ],
      });
      if (!path) return { ok: false };

      const format = resolveExportFormat(choice, displayMode);
      await invokeExportData(frames, format, path);
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
