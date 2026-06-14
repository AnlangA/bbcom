import type { AiModel } from '../types';

export const BAUD_RATES = [
  { label: '9600', value: 9600 },
  { label: '19200', value: 19200 },
  { label: '38400', value: 38400 },
  { label: '57600', value: 57600 },
  { label: '115200', value: 115200 },
  { label: '230400', value: 230400 },
  { label: '460800', value: 460800 },
  { label: '921600', value: 921600 },
];

export const DATA_BITS_OPTIONS = [
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
];

export const STOP_BITS_OPTIONS = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
];

export const PARITY_OPTIONS = [
  { label: '无', value: 'none' },
  { label: '奇校验', value: 'odd' },
  { label: '偶校验', value: 'even' },
];

export const FLOW_CONTROL_OPTIONS = [
  { label: '无', value: 'none' },
  { label: '硬件', value: 'hardware' },
  { label: '软件', value: 'software' },
];

export const EXPORT_FORMATS = {
  txtHex: 'txt-hex',
  txtAscii: 'txt-ascii',
  csv: 'csv',
  jsonl: 'jsonl',
  bin: 'bin',
} as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[keyof typeof EXPORT_FORMATS];

export const EXPORT_OPTIONS: { label: string; key: ExportFormat }[] = [
  { label: '导出为 TXT (HEX)', key: EXPORT_FORMATS.txtHex },
  { label: '导出为 TXT (ASCII)', key: EXPORT_FORMATS.txtAscii },
  { label: '导出为 CSV', key: EXPORT_FORMATS.csv },
  { label: '导出为 JSON Lines', key: EXPORT_FORMATS.jsonl },
  { label: '导出为 BIN', key: EXPORT_FORMATS.bin },
];

export const AI_MODELS = {
  glm51: 'glm-5.1',
  glm5Turbo: 'glm-5-turbo',
  glm47: 'glm-4.7',
  glm45Air: 'glm-4.5-air',
} as const;

export const AI_MODEL_OPTIONS: { label: string; value: AiModel }[] = [
  { label: 'GLM-5.1', value: AI_MODELS.glm51 },
  { label: 'GLM-5 Turbo', value: AI_MODELS.glm5Turbo },
  { label: 'GLM-4.7', value: AI_MODELS.glm47 },
  { label: 'GLM-4.5 Air', value: AI_MODELS.glm45Air },
];
