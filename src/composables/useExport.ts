import { ref } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import { invokeWithTimeout } from '../lib/tauri';
import type { DataFrame } from '../types';

const INVOKE_TIMEOUT_MS = 30_000;

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

export function useExport() {
  const isExporting = ref(false);

  async function exportData(frames: DataFrame[], format: string) {
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
      if (!path) return false;

      await invokeWithTimeout('export_data', {
        request: {
          frames,
          format,
          path,
        },
      }, INVOKE_TIMEOUT_MS);

      return true;
    } catch (err) {
      console.debug('export failed:', err);
      return false;
    } finally {
      isExporting.value = false;
    }
  }

  return {
    isExporting,
    exportData,
  };
}
