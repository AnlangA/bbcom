import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame } from '../types';
import { getCommandErrorMessage, invokeExportData } from '../lib/ipc';
import type { ExportFormat } from '../lib/constants';

const EXT_MAP: Record<string, { name: string; ext: string }> = {
  'txt-hex': { name: 'TXT', ext: 'txt' },
  'txt-ascii': { name: 'TXT', ext: 'txt' },
  csv: { name: 'CSV', ext: 'csv' },
  jsonl: { name: 'JSONL', ext: 'jsonl' },
  bin: { name: 'BIN', ext: 'bin' },
};

function getExportFilter(format: string): { name: string; ext: string } {
  return EXT_MAP[format] ?? { name: format.toUpperCase(), ext: format };
}

/** `ok:true` on success; `ok:false` with no `error` when the user cancelled the save dialog. */
export type ExportResult = { ok: true } | { ok: false; error?: string };

export function useExport() {
  const isExporting = ref(false);

  async function exportData(frames: DataFrame[], format: ExportFormat): Promise<ExportResult> {
    isExporting.value = true;
    try {
      const filter = getExportFilter(format);
      const path = await save({
        filters: [
          {
            name: filter.name,
            extensions: [filter.ext],
          },
        ],
      });
      if (!path) return { ok: false };

      await invokeExportData(frames, format, path);
      return { ok: true };
    } catch (e) {
      // Surface the typed Rust error (path validation, IO, too-many-frames) instead
      // of a generic toast. The serialized AppError is { type, details: { message } }.
      return { ok: false, error: getCommandErrorMessage(e, '导出失败') };
    } finally {
      isExporting.value = false;
    }
  }

  return {
    isExporting,
    exportData,
  };
}
