import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
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

async function invokeWithTimeout<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const result = await Promise.race([
    invoke<T>(cmd, args),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`操作超时 (${timeoutMs / 1000}s)`)), timeoutMs),
    ),
  ]);
  return result;
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
