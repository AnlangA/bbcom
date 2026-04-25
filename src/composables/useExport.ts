import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { DataFrame } from '../types';

export function useExport() {
  const isExporting = ref(false);

  async function exportData(frames: DataFrame[], format: string) {
    isExporting.value = true;
    try {
      const extMap: Record<string, { name: string; ext: string }> = {
        'txt-hex': { name: 'TXT', ext: 'txt' },
        'txt-ascii': { name: 'TXT', ext: 'txt' },
        csv: { name: 'CSV', ext: 'csv' },
        jsonl: { name: 'JSONL', ext: 'jsonl' },
        bin: { name: 'BIN', ext: 'bin' },
      };
      const filter = extMap[format] ?? { name: format.toUpperCase(), ext: format };
      const path = await save({
        filters: [
          {
            name: filter.name,
            extensions: [filter.ext],
          },
        ],
      });
      if (!path) return false;

      await invoke('export_data', {
        request: {
          frames,
          format,
          path,
        },
      });
      return true;
    } catch {
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
