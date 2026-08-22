import type { DisplayMode } from '@/types';
import type { ExportFormat as ContractExportFormat } from '@/generated/ipc-contracts';

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
  { label: 'None', value: 'none' },
  { label: 'Odd', value: 'odd' },
  { label: 'Even', value: 'even' },
];

export const FLOW_CONTROL_OPTIONS = [
  { label: 'None', value: 'none' },
  { label: 'Hardware', value: 'hardware' },
  { label: 'Software', value: 'software' },
];

// Wire formats the Rust backend deserializes (commands::export::ExportFormat).
// Kept as the source of truth for the frontend -> Rust contract.
export const EXPORT_FORMATS = {
  txtHex: 'txt-hex',
  txtAscii: 'txt-ascii',
  csv: 'csv',
  jsonl: 'jsonl',
  bin: 'bin',
} as const satisfies Record<string, ContractExportFormat>;

export type ExportFormat = ContractExportFormat;

// User-facing export choices. The text export ("txt") follows the selected
// display mode so the saved file matches what the user sees on screen — HEX or
// HEX+ASCII display yields a hex dump, ASCII/UTF-8/ANSI yields decoded text.
// See useExport.resolveExportFormat. Decoupling the two (a separate "TXT (HEX)"
// vs "TXT (ASCII)" picker) was the root cause of saved logs always landing as
// hex regardless of the encoding the user had selected.
export type ExportChoice = 'txt' | 'csv' | 'jsonl' | 'bin';

export const EXPORT_OPTIONS: { label: string; key: ExportChoice }[] = [
  { label: 'Export TXT (current display format)', key: 'txt' },
  { label: 'Export CSV', key: 'csv' },
  { label: 'Export JSON Lines', key: 'jsonl' },
  { label: 'Export BIN', key: 'bin' },
];

/**
 * Map a user-facing export choice to the wire format the Rust backend expects.
 * The text export ("txt") follows the selected display mode so the saved file
 * matches what the user sees on screen — HEX/HEX+ASCII display yields a hex
 * dump, ASCII/UTF-8/ANSI yields decoded text. Structured/binary choices pass
 * through. Mirrors the auto-log mapping in useAutoLog.ts.
 */
export function resolveExportFormat(choice: ExportChoice, displayMode: DisplayMode): ExportFormat {
  if (choice === 'txt') {
    return displayMode === 'HEX' || displayMode === 'HEXASCII'
      ? EXPORT_FORMATS.txtHex
      : EXPORT_FORMATS.txtAscii;
  }
  return choice;
}
