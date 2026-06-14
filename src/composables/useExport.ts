import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame, DisplayMode } from '../types';
import { invokeExportData } from '../lib/ipc';
import { logger } from '../lib/logger';
import { resolveExportFormat, type ExportChoice } from '../lib/constants';

const EXT_MAP: Record<ExportChoice, { name: string; ext: string }> = {
  txt: { name: 'TXT', ext: 'txt' },
  csv: { name: 'CSV', ext: 'csv' },
  jsonl: { name: 'JSONL', ext: 'jsonl' },
  bin: { name: 'BIN', ext: 'bin' },
};

/** Distinguishes a user cancel from a real failure so callers don't surface a
 * spurious error when the user simply dismisses the save dialog. */
export type ExportResult = 'success' | 'cancelled' | 'error';

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
      if (!path) return 'cancelled';

      // The text export follows the selected display mode so the saved file
      // matches the encoding the user is viewing (HEX → hex, ASCII/UTF-8 →
      // decoded text). See resolveExportFormat.
      const format = resolveExportFormat(choice, displayMode);
      await invokeExportData(frames, format, path);
      return 'success';
    } catch (e) {
      logger.warn('export failed (choice=%s, displayMode=%s):', choice, displayMode, e);
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
