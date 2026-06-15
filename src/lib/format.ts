/**
 * Unified formatting utilities for the application
 */

// Singleton decoders for better performance
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const asciiDecoder = new TextDecoder('ascii', { fatal: false });
const textEncoder = new TextEncoder();
const HEX_TABLE = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, '0')
);

/**
 * Format byte array as HEX string with spaces
 */
export function formatHex(data: Uint8Array): string {
  if (data.length === 0) return '';
  const parts = new Array<string>(data.length);
  for (let i = 0; i < data.length; i += 1) {
    parts[i] = HEX_TABLE[data[i] & 0xff];
  }
  return parts.join(' ');
}

/**
 * Format timestamp in milliseconds to readable time string
 */
export function formatTimestamp(ms: number | string): string {
  const timestamp = typeof ms === 'string' ? parseInt(ms, 10) : ms;
  const date = new Date(timestamp);

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
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd number of digits');
  }
  const result = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    result[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return result;
}

export function normalizeHex(input: string): string {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return cleaned.match(/.{1,2}/g)?.join(' ') ?? '';
}

/**
 * Validate HEX string
 */
export function isValidHex(input: string): boolean {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
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
