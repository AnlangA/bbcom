import type { ChecksumType } from '../types';

export const checksumOptions: { label: string; value: ChecksumType }[] = [
  { label: 'Checksum', value: 'CHECKSUM' },
  { label: 'CRC-8', value: 'CRC8' },
  { label: 'CRC-16', value: 'CRC16' },
  { label: 'CRC-32', value: 'CRC32' },
];

export const checksumAlgoOptionsWithNone: { label: string; value: 'none' | ChecksumType }[] = [
  { label: 'No checksum', value: 'none' },
  ...checksumOptions,
];

/** Number of bytes each checksum algorithm appends to the payload. */
export const CHECKSUM_BYTE_LENGTH: Record<ChecksumType, number> = {
  CHECKSUM: 1,
  CRC8: 1,
  CRC16: 2,
  CRC32: 4,
};
