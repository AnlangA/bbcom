/**
 * Unified formatting utilities for the application
 */

// Singleton decoders for better performance
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const asciiDecoder = new TextDecoder('ascii', { fatal: false });

/**
 * Format byte array as HEX string with spaces
 */
export function formatHex(data: number[] | Uint8Array): string {
  const arr = Array.isArray(data) ? data : Array.from(data);
  return arr.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
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
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format baud rate with K/M suffix
 */
export function formatBaudRate(rate: number): string {
  if (rate >= 1000000) {
    return `${(rate / 1000000).toFixed(1)}M`;
  }
  if (rate >= 1000) {
    return `${(rate / 1000).toFixed(0)}K`;
  }
  return `${rate}`;
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
export function parseHex(input: string): number[] {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd number of digits');
  }
  const result: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    result.push(parseInt(cleaned.substring(i, i + 2), 16));
  }
  return result;
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
export function formatUtf8(data: number[] | Uint8Array): string {
  const arr = Array.isArray(data) ? new Uint8Array(data) : data;
  return utf8Decoder.decode(arr);
}

/**
 * Format byte array as ASCII string
 */
export function formatAscii(data: number[] | Uint8Array): string {
  const arr = Array.isArray(data) ? new Uint8Array(data) : data;
  return asciiDecoder.decode(arr);
}
