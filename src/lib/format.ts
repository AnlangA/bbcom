/**
 * Unified formatting utilities for the application
 */

import type { ChecksumType, Direction, DisplayMode, LineEnding } from '../types';
import { CHECKSUM_BYTE_LENGTH } from './checksum-constants';

// Singleton decoders for better performance
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const asciiDecoder = new TextDecoder('ascii', { fatal: false });
const textEncoder = new TextEncoder();
const HEX_TABLE = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, '0'),
);
// Lowercase, space-less hex for search needles (toString(16) is already lowercase)
const HEX_LOWER_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
// Hex digit value per ASCII code point (-1 = not a hex digit) for fast parsing
const HEX_VALUE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < 10; i += 1) table[0x30 + i] = i; // '0'-'9'
  for (let i = 0; i < 6; i += 1) {
    table[0x61 + i] = 10 + i; // 'a'-'f'
    table[0x41 + i] = 10 + i; // 'A'-'F'
  }
  return table;
})();

/** Strip everything except hex digits from a (possibly messy) HEX input string. */
function cleanHex(input: string): string {
  return input.replace(/[^0-9a-fA-F]/g, '');
}

/** Build a hex string from bytes using a lookup table and separator. */
function bytesToHex(data: Uint8Array, table: string[], separator: string): string {
  if (data.length === 0) return '';
  const parts = new Array<string>(data.length);
  for (let i = 0; i < data.length; i += 1) {
    parts[i] = table[data[i]];
  }
  return parts.join(separator);
}

/**
 * Format byte array as HEX string with spaces (uppercase)
 */
export function formatHex(data: Uint8Array): string {
  return bytesToHex(data, HEX_TABLE, ' ');
}

/**
 * Format a timestamp in epoch milliseconds to a readable HH:MM:SS.mmm string
 */
export function formatTimestamp(ms: number): string {
  const date = new Date(ms);

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const millis = date.getMilliseconds().toString().padStart(3, '0');

  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * Format byte count to human-readable size
 */
export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format a bytes-per-second rate to a human-readable throughput string
 */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * Format an elapsed duration in milliseconds as HH:MM:SS
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const LINE_ENDING_STRINGS: Record<LineEnding, string> = {
  none: '',
  CR: '\r',
  LF: '\n',
  CRLF: '\r\n',
};

/**
 * Append the configured line ending to a text payload.
 */
export function appendLineEnding(data: string, lineEnding: LineEnding): string {
  return data + LINE_ENDING_STRINGS[lineEnding];
}

/**
 * Format a single serial log line: [timestamp] direction | data
 */
export function formatLogLine(timestamp: number, direction: Direction, dataText: string): string {
  return `[${formatTimestamp(timestamp)}] ${direction} | ${dataText}`;
}

/**
 * Count the bytes represented by a (possibly space/punctuation-separated) HEX string.
 */
export function hexByteCount(input: string): number {
  const cleaned = cleanHex(input);
  return Math.floor(cleaned.length / 2);
}

/**
 * Count the bytes that will actually be sent for a given input: HEX payload
 * bytes (plus any appended checksum) or UTF-8 bytes of the text with its line
 * ending. Matches what useSerialConnection.send() ultimately writes.
 */
export function computeSendByteCount(
  input: string,
  isHex: boolean,
  appendChecksum: 'none' | ChecksumType,
  lineEnding: LineEnding,
): number {
  if (!input.trim()) return 0;
  if (isHex) {
    const inputBytes = hexByteCount(input);
    return appendChecksum === 'none'
      ? inputBytes
      : inputBytes + CHECKSUM_BYTE_LENGTH[appendChecksum];
  }
  return encodeUtf8(appendLineEnding(input, lineEnding)).length;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Parse HEX string to byte array
 */
export function parseHex(input: string): Uint8Array {
  const cleaned = cleanHex(input);
  if (cleaned.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd number of digits');
  }
  const result = new Uint8Array(cleaned.length / 2);
  for (let i = 0, j = 0; i < cleaned.length; i += 2, j += 1) {
    const hi = HEX_VALUE[cleaned.charCodeAt(i)];
    const lo = HEX_VALUE[cleaned.charCodeAt(i + 1)];
    result[j] = (hi << 4) | lo;
  }
  return result;
}

export function normalizeHex(input: string): string {
  const cleaned = cleanHex(input).toUpperCase();
  return cleaned.match(/.{1,2}/g)?.join(' ') ?? '';
}

/**
 * Lowercase, space-less HEX string used as a search index.
 */
export function toContinuousHex(data: Uint8Array): string {
  return bytesToHex(data, HEX_LOWER_TABLE, '');
}

/**
 * Validate HEX string
 */
export function isValidHex(input: string): boolean {
  const cleaned = cleanHex(input);
  return cleaned.length > 0 && cleaned.length % 2 === 0;
}

/**
 * Format byte array as UTF-8 string
 */
export function formatUtf8(data: Uint8Array): string {
  return utf8Decoder.decode(data);
}

/**
 * Format byte array as ASCII string
 */
export function formatAscii(data: Uint8Array): string {
  return asciiDecoder.decode(data);
}

export function encodeUtf8(data: string): Uint8Array {
  return textEncoder.encode(data);
}

// Match any CSI escape sequence (ESC [ params final) — SGR colors, cursor
// moves, erases, DEC-private sequences. Built from a char code (rather than a
// \x1b literal) to satisfy eslint's no-control-regex rule. Shared by the packet
// formatter (search index) and the auto-log writer (clean log lines).
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Remove ANSI CSI escape sequences from text. */
export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Decode frame bytes into the representation used by the given display mode —
 * the same decoding the terminal uses, minus ANSI HTML rendering. The auto-log
 * writer uses this so logged lines match what the user sees on screen.
 */
export function formatFrameData(data: Uint8Array, displayMode: DisplayMode): string {
  switch (displayMode) {
    case 'HEX':
      return formatHex(data);
    case 'UTF8':
      return formatUtf8(data);
    case 'ASCII':
      return formatAscii(data);
    case 'ANSI':
      // ANSI mode is ASCII text with embedded escape codes; strip the escapes
      // so the log file stays readable.
      return stripAnsiEscapes(formatAscii(data));
    default:
      return formatAscii(data);
  }
}
