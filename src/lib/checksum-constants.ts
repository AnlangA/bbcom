import type { ChecksumType } from '../types';

export const checksumOptions: { label: string; value: ChecksumType }[] = [
  { label: 'Checksum', value: 'CHECKSUM' },
  { label: 'CRC-8', value: 'CRC8' },
  { label: 'CRC-16', value: 'CRC16' },
  { label: 'CRC-32', value: 'CRC32' },
];

export const checksumAlgoOptionsWithNone: { label: string; value: 'none' | ChecksumType }[] = [
  { label: '无校验', value: 'none' },
  ...checksumOptions,
];
