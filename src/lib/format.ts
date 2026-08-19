/**
 * Unified formatting utilities for the application
 */

import type { ChecksumType, Direction, DisplayMode, LineEnding, PortConfig } from '../types';
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

// Flat ASCII byte-pair lookup: for each byte value b, BYTE_HEX_PAIR[b*2..b*2+1]
// holds the two ASCII hex characters. Expanding into a pre-sized Uint8Array and
// decoding once avoids the per-byte String allocation + Array.join the previous
// implementation did (the measured top frontend hot path — see perf.bench.ts).
// Upper/lowercase variants split so formatHex (upper, spaced) and the lowercase
// continuous search index share one fast path.
const BYTE_HEX_PAIRS_UPPER = (() => {
  const table = new Uint8Array(256 * 2);
  for (let i = 0; i < 256; i += 1) {
    const s = HEX_TABLE[i];
    table[i * 2] = s.charCodeAt(0);
    table[i * 2 + 1] = s.charCodeAt(1);
  }
  return table;
})();
const BYTE_HEX_PAIRS_LOWER = (() => {
  const table = new Uint8Array(256 * 2);
  for (let i = 0; i < 256; i += 1) {
    const s = HEX_LOWER_TABLE[i];
    table[i * 2] = s.charCodeAt(0);
    table[i * 2 + 1] = s.charCodeAt(1);
  }
  return table;
})();
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

/** Strip everything except hex digits for display-only normalization helpers. */
function cleanHex(input: string): string {
  return input.replace(/[^0-9a-fA-F]/g, '');
}

const HEX_TOKEN = /^[0-9a-fA-F]+$/;

/**
 * Split strict HEX input. Whitespace and commas are the only separators; each
 * separated or continuous token must itself contain complete byte pairs.
 */
function strictHexTokens(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  const tokens = trimmed.split(/[\s,]+/u);
  for (const token of tokens) {
    if (!HEX_TOKEN.test(token)) {
      throw new Error(`Invalid hex token: ${token}`);
    }
    if (token.length % 2 !== 0) {
      throw new Error('Invalid hex string: odd number of digits');
    }
  }
  return tokens;
}

/** Format byte array as HEX string with spaces (uppercase). */
export function formatHex(data: Uint8Array): string {
  const n = data.length;
  if (n === 0) return '';
  // Each byte -> "XX " except the last (no trailing space): 3*n - 1 chars.
  const out = new Uint8Array(n * 3 - 1);
  const pairs = BYTE_HEX_PAIRS_UPPER;
  for (let i = 0; i < n; i += 1) {
    const p = data[i] * 2;
    const o = i * 3;
    out[o] = pairs[p];
    out[o + 1] = pairs[p + 1];
    if (i < n - 1) out[o + 2] = 0x20; // space separator
  }
  return asciiDecoder.decode(out);
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
 * Compact UART line-coding notation, e.g. "115200 8N1" (baud + dataBits +
 * parity initial + stopBits). The canonical shorthand embedded developers
 * scan at a glance.
 */
export function formatLineCoding(config: PortConfig): string {
  const parity = config.parity === 'none' ? 'N' : config.parity === 'even' ? 'E' : 'O';
  return `${config.baudRate} ${config.dataBits}${parity}${config.stopBits}`;
}

/**
 * Short flow-control tag: "none" | "hw" | "sw". Appended after the line
 * coding so the status chip reads e.g. "115200 8N1 · hw".
 */
export function formatFlowControlShort(flowControl: PortConfig['flowControl']): string {
  if (flowControl === 'hardware') return 'hw';
  if (flowControl === 'software') return 'sw';
  return 'none';
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
  const tokens = strictHexTokens(input);
  const byteLength = tokens.reduce((total, token) => total + token.length / 2, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const token of tokens) {
    for (let index = 0; index < token.length; index += 2) {
      const hi = HEX_VALUE[token.charCodeAt(index)];
      const lo = HEX_VALUE[token.charCodeAt(index + 1)];
      result[offset] = (hi << 4) | lo;
      offset += 1;
    }
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
  const n = data.length;
  if (n === 0) return '';
  const out = new Uint8Array(n * 2);
  const pairs = BYTE_HEX_PAIRS_LOWER;
  for (let i = 0; i < n; i += 1) {
    const p = data[i] * 2;
    const o = i * 2;
    out[o] = pairs[p];
    out[o + 1] = pairs[p + 1];
  }
  return asciiDecoder.decode(out);
}

/**
 * Validate HEX string
 */
export function isValidHex(input: string): boolean {
  try {
    return parseHex(input).length > 0;
  } catch {
    return false;
  }
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

/** Fixed row width of the HEXASCII dump; row-height estimation relies on it. */
export const HEXASCII_BYTES_PER_LINE = 16;

/**
 * Format bytes as a hex-editor dual view: hex pairs on the left, ASCII
 * representation on the right, grouped 16 bytes per line. This is the
 * professional hex-editor display mode: raw byte values and decoded characters
 * side by side, so a user can inspect a binary protocol without toggling modes.
 */
export function formatHexAscii(data: Uint8Array, bytesPerLine = HEXASCII_BYTES_PER_LINE): string {
  if (data.length === 0) return '';

  const lineCount = Math.ceil(data.length / bytesPerLine);
  let outputLength = lineCount - 1; // one LF between adjacent dump lines
  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const bytesOnLine = Math.min(bytesPerLine, data.length - offset);
    // `XX XX  |ascii...|`: 3 chars per populated byte, a fixed-width ASCII
    // gutter, and three delimiter characters. The final hex byte has no
    // trailing separator, which cancels the fourth delimiter character.
    outputLength += bytesOnLine * 3 + bytesPerLine + 3;
  }

  // Build the complete ASCII representation once. The previous implementation
  // allocated two growing strings per line and formatted every byte through
  // toString/padStart/toUpperCase; this reuses the same pair table as formatHex
  // and performs a single TextDecoder allocation at the boundary.
  const output = new Uint8Array(outputLength);
  let position = 0;
  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const bytesOnLine = Math.min(bytesPerLine, data.length - offset);
    if (offset > 0) output[position++] = 0x0a;

    for (let index = 0; index < bytesOnLine; index += 1) {
      if (index > 0) output[position++] = 0x20;
      const pairOffset = data[offset + index] * 2;
      output[position++] = BYTE_HEX_PAIRS_UPPER[pairOffset];
      output[position++] = BYTE_HEX_PAIRS_UPPER[pairOffset + 1];
    }

    output[position++] = 0x20;
    output[position++] = 0x20;
    output[position++] = 0x7c;
    for (let index = 0; index < bytesPerLine; index += 1) {
      if (index >= bytesOnLine) {
        output[position++] = 0x20;
        continue;
      }
      const byte = data[offset + index];
      output[position++] = byte >= 0x20 && byte <= 0x7e ? byte : 0x2e;
    }
    output[position++] = 0x7c;
  }
  return asciiDecoder.decode(output);
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
    case 'HEXASCII':
      return formatHexAscii(data);
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
