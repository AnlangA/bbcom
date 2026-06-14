import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame } from '../types';
import { invokeExportData } from '../lib/ipc';
import { logger } from '../lib/logger';
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

/** Distinguishes a user cancel from a real failure so callers don't surface a
 * spurious error when the user simply dismisses the save dialog. */
export type ExportResult = 'success' | 'cancelled' | 'error';

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
      if (!path) return 'cancelled';

      await invokeExportData(frames, format, path);
      return 'success';
    } catch (e) {
      logger.warn('export failed (format=%s):', format, e);
      return 'error';
    } finally {
      isExporting.value = false;
    }
  }

  return {
    isExporting,
    exportData,
  };
}
