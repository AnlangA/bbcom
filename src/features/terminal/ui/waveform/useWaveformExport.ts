import type { MessageApi } from 'naive-ui';
import { t } from '@/lib/i18n';
import { buildWaveformCsv } from '@/lib/waveform';
import { parseStream } from '@/lib/modbus';
import type { RegisterWaveformSampleInput } from './useWaveformIngest';

export interface WaveformExportOptions {
  /** Bounded sample rows currently plotted. */
  samples(): readonly number[][];
  channelCount(): number;
  /** Hidden file input to click for the stream-loading path. */
  fileInputTarget(): HTMLInputElement | null;
  /** Feed parsed stream records into register-mode ingest. */
  onFileSamples(samples: readonly RegisterWaveformSampleInput[]): void;
  message: MessageApi;
}

/**
 * CSV export and stream-file loading for the waveform panel. CSV serializes
 * the bounded canvas buffer; stream loading parses `.bbreg/.jsonl/.txt`
 * records and replays them as register samples.
 */
export function useWaveformExport({
  samples,
  channelCount,
  fileInputTarget,
  onFileSamples,
  message,
}: WaveformExportOptions) {
  function exportCsv() {
    const rows = samples();
    if (rows.length === 0) return;
    const blob = new Blob([buildWaveformCsv(rows, channelCount())], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bbcom-waveform-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(t('waveform.exported', { count: rows.length }));
  }

  function loadStream() {
    fileInputTarget()?.click();
  }

  function onStreamFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const records = parseStream(String(reader.result ?? ''));
      if (records.length === 0) {
        message.warning(t('waveform.fileNoSamples'));
        return;
      }
      const parsed: RegisterWaveformSampleInput[] = [];
      for (const rec of records) {
        if (typeof rec.ch === 'number' && rec.ch >= 0) {
          parsed.push({ channel: rec.ch, value: rec.value, timestamp: rec.t });
        }
      }
      if (parsed.length === 0) {
        message.warning(t('waveform.fileNoSamples'));
        return;
      }
      onFileSamples(parsed);
      message.success(t('waveform.loadedStream', { count: parsed.length }));
    };
    reader.onerror = () => {
      message.error(t('common.fileReadFailed'));
    };
    reader.onabort = reader.onerror;
    reader.readAsText(file);
    input.value = '';
  }

  return { exportCsv, loadStream, onStreamFilePicked };
}
