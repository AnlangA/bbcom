/**
 * Streaming protocol frame parser.
 *
 * Real serial RX arrives as an arbitrary byte stream — the OS coalesces/splits
 * logical messages unpredictably across reads. This parser reassembles discrete
 * frames according to a configurable template, so a user can see whole Modbus
 * packets, NMEA sentences, `$...CS\r\n` lines, or fixed-length binary records
 * instead of fragmented chunks. Mirrors RealTerm's frame-mode / serial-studio's
 * frame parsers.
 *
 * The parser is stateful (it retains a partial frame across feeds) but pure —
 * it has no DOM/Vue deps, so it is fully unit-testable.
 */

export type ParserKind = 'delimiter' | 'length' | 'fixed';

export interface DelimiterConfig {
  kind: 'delimiter';
  /** The byte sequence that terminates a frame (e.g. [0x0D, 0x0A] for CRLF). */
  delimiter: number[];
  /** Include the delimiter bytes in the emitted frame. */
  includeDelimiter: boolean;
}

export interface LengthConfig {
  kind: 'length';
  /** Byte offset of the length field within the frame header. */
  lengthOffset: number;
  /** Size of the length field in bytes (1, 2, or 4). */
  lengthSize: 1 | 2 | 4;
  /** Whether the length field is big-endian (default true). */
  bigEndian: boolean;
  /** Number of bytes (including the length field and any header) that the
   * length value must be adjusted by. If lengthValue counts the payload only,
   * set this to lengthOffset + lengthSize so the total frame size is correct. */
  lengthAdjust: number;
}

export interface FixedConfig {
  kind: 'fixed';
  /** Every frame is exactly this many bytes. */
  frameSize: number;
}

export type ParserConfig = DelimiterConfig | LengthConfig | FixedConfig;

export interface ParsedFrame {
  data: Uint8Array;
  /** Index of the first byte of this frame within the original stream. */
  offset: number;
}

/** Default ceiling for bytes retained while a delimiter has not been seen. */
export const DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES = 1_000_000;

export interface ProtocolParserOptions {
  /**
   * Maximum unframed bytes retained by delimiter mode. Once exceeded, the
   * oldest bytes are discarded and the parser resumes searching in the newest
   * suffix. Fixed/length modes are naturally bounded by their frame size.
   */
  maxPendingBytes?: number;
}

/** Cumulative loss/resynchronization counters since construction or reset. */
export interface ProtocolParserStats {
  /** Bytes intentionally discarded rather than emitted in a frame. */
  discardedBytes: number;
  /** Number of times delimiter mode exceeded its pending-byte ceiling. */
  overflowEvents: number;
  /** Number of recovery steps caused by overflow or an implausible length. */
  resyncEvents: number;
}

const MAX_LENGTH_FRAME_BYTES = 1_000_000;
const BUFFER_COMPACT_THRESHOLD = 64 * 1024;

/**
 * A stateful byte-stream → frame parser. Feed RX bytes via `feed()`; each call
 * returns zero or more complete frames that were finalized in that batch.
 */
export class ProtocolParser {
  private buffer: number[] = [];
  private consumed = 0;
  /** First absolute buffer index that delimiter mode still needs to inspect. */
  private delimiterSearchFrom = 0;
  private readonly maxPendingBytes: number;
  private discardedBytes = 0;
  private overflowEvents = 0;
  private resyncEvents = 0;
  readonly config: ParserConfig;

  constructor(config: ParserConfig, options: ProtocolParserOptions = {}) {
    this.config = config;
    const requestedLimit = options.maxPendingBytes ?? DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES;
    const normalizedLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.floor(requestedLimit))
      : DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES;
    // A limit smaller than the delimiter could never recognize that delimiter.
    this.maxPendingBytes =
      config.kind === 'delimiter'
        ? Math.max(normalizedLimit, config.delimiter.length)
        : normalizedLimit;
  }

  /** Total bytes currently held in the partial buffer. */
  get pending(): number {
    return this.buffer.length - this.consumed;
  }

  /** Snapshot of cumulative overflow/resynchronization counters. */
  get stats(): ProtocolParserStats {
    return {
      discardedBytes: this.discardedBytes,
      overflowEvents: this.overflowEvents,
      resyncEvents: this.resyncEvents,
    };
  }

  /** Append bytes and return any frames that became complete. */
  feed(input: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < input.length; i += 1) this.buffer.push(input[i]);
    const frames = this.drain();
    this.enforcePendingLimit();
    this.compactBuffer();
    return frames;
  }

  /** Drop all buffered bytes (e.g. on a user-requested flush). */
  reset(): void {
    this.buffer = [];
    this.consumed = 0;
    this.delimiterSearchFrom = 0;
    this.discardedBytes = 0;
    this.overflowEvents = 0;
    this.resyncEvents = 0;
  }

  private drain(): ParsedFrame[] {
    const out: ParsedFrame[] = [];
    // A cursor advances over the shared buffer. Complete-frame extraction only
    // copies the frame itself, rather than slicing the entire remaining suffix
    // before every attempt (which made N one-byte frames O(N^2)).
    while (true) {
      const consumedBefore = this.consumed;
      const frame = this.extractOne();
      if (frame) out.push(frame);
      // extractOne can also make progress by dropping one implausible length
      // byte. Continue in that case so resynchronization is linear in one feed.
      if (this.consumed === consumedBefore) break;
    }
    return out;
  }

  private compactBuffer(): void {
    // Clear an exhausted buffer without allocating a replacement suffix.
    if (this.consumed > 0 && this.consumed >= this.buffer.length) {
      this.buffer = [];
      this.consumed = 0;
      this.delimiterSearchFrom = 0;
      return;
    }

    // Reclaim a dead prefix periodically. Waiting for a sizeable prefix (or
    // until dead bytes outnumber live bytes) amortizes the occasional slice.
    if (
      this.consumed > 0 &&
      (this.consumed >= BUFFER_COMPACT_THRESHOLD || this.consumed >= this.pending)
    ) {
      const removed = this.consumed;
      this.buffer = this.buffer.slice(this.consumed);
      this.consumed = 0;
      this.delimiterSearchFrom = Math.max(0, this.delimiterSearchFrom - removed);
    }
  }

  private enforcePendingLimit(): void {
    if (this.config.kind !== 'delimiter' || this.pending <= this.maxPendingBytes) return;

    const discard = this.pending - this.maxPendingBytes;
    this.consumed += discard;
    this.discardedBytes += discard;
    this.overflowEvents += 1;
    this.resyncEvents += 1;
    this.delimiterSearchFrom = Math.max(this.delimiterSearchFrom, this.consumed);
  }

  private extractOne(): ParsedFrame | null {
    const start = this.consumed;
    const available = this.buffer.length - start;

    if (this.config.kind === 'fixed') {
      const size = this.config.frameSize;
      if (!Number.isInteger(size) || size <= 0 || available < size) return null;
      const data = this.copyRange(start, start + size);
      this.consumed += size;
      return { data, offset: start };
    }

    if (this.config.kind === 'delimiter') {
      const delim = this.config.delimiter;
      if (delim.length === 0) return null;
      const match = indexOfSubarrayFrom(
        this.buffer,
        delim,
        Math.max(start, this.delimiterSearchFrom),
      );
      if (match === -1) {
        // On the next feed only recheck the suffix that could be the beginning
        // of a delimiter spanning the old/new input boundary.
        this.delimiterSearchFrom = Math.max(start, this.buffer.length - delim.length + 1);
        return null;
      }
      const frameEnd = this.config.includeDelimiter ? match + delim.length : match;
      const data = this.copyRange(start, frameEnd);
      this.consumed = match + delim.length;
      this.delimiterSearchFrom = this.consumed;
      return { data, offset: start };
    }

    // length-based
    const cfg = this.config;
    const headerEnd = cfg.lengthOffset + cfg.lengthSize;
    if (!Number.isInteger(cfg.lengthOffset) || cfg.lengthOffset < 0 || available < headerEnd) {
      return null;
    }
    let lengthValue = 0;
    if (cfg.bigEndian) {
      for (let i = 0; i < cfg.lengthSize; i += 1) {
        lengthValue = lengthValue * 256 + this.buffer[start + cfg.lengthOffset + i];
      }
    } else {
      for (let i = cfg.lengthSize - 1; i >= 0; i -= 1) {
        lengthValue = lengthValue * 256 + this.buffer[start + cfg.lengthOffset + i];
      }
    }
    const total = cfg.lengthAdjust + lengthValue;
    if (!Number.isInteger(total) || total <= 0 || total > MAX_LENGTH_FRAME_BYTES) {
      // Implausible length — the stream is likely misaligned. Drop one byte to
      // resync rather than buffering megabytes waiting for a phantom frame.
      this.consumed += 1;
      this.discardedBytes += 1;
      this.resyncEvents += 1;
      return null;
    }
    if (available < total) return null;
    const data = this.copyRange(start, start + total);
    this.consumed += total;
    return { data, offset: start };
  }

  private copyRange(start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start);
    for (let source = start, target = 0; source < end; source += 1, target += 1) {
      out[target] = this.buffer[source];
    }
    return out;
  }
}

/** Find the first index of `needle` within `haystack` (subarray search). */
export function indexOfSubarray(haystack: number[], needle: number[]): number {
  return indexOfSubarrayFrom(haystack, needle, 0);
}

/** Internal variant that avoids allocating a sliced haystack for cursor scans. */
function indexOfSubarrayFrom(haystack: number[], needle: number[], from: number): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** Parse a hex string (e.g. "0D 0A" or "0D0A") into a byte array for a delimiter. */
export function parseDelimiterHex(input: string): number[] {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

const PRINTABLE_RE = /^[\x20-\x7e]$/;
const HEX_NIBBLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

/** Render a byte as a 2-char lowercase hex pair. */
export function byteHex(byte: number): string {
  return HEX_NIBBLE[(byte >> 4) & 0xf] + HEX_NIBBLE[byte & 0xf];
}

/** Render a byte as ASCII, using `.` for non-printable values (Docklight/YAT
 * side-panel convention so the ASCII column stays aligned). */
export function byteAscii(byte: number): string {
  return PRINTABLE_RE.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '.';
}

/** A classic hex-editor dump of a frame, grouped into rows of `bytesPerRow`
 * bytes with an offset column, a spaced-hex column, and an ASCII column. Used
 * by the parser's frame-detail view to show whole frames instead of just the
 * truncated one-line hex. */
export interface HexDumpRow {
  offset: number;
  hex: string;
  ascii: string;
}

export function hexDump(data: Uint8Array, bytesPerRow = 16): HexDumpRow[] {
  const rows: HexDumpRow[] = [];
  for (let i = 0; i < data.length; i += bytesPerRow) {
    const slice = data.subarray(i, Math.min(i + bytesPerRow, data.length));
    const hex = Array.from(slice, byteHex).join(' ');
    let ascii = '';
    for (let j = 0; j < slice.length; j += 1) ascii += byteAscii(slice[j]);
    rows.push({ offset: i, hex, ascii });
  }
  return rows;
}

/** Case-insensitive substring match against a frame's decoded text, used by the
 * parser panel's search filter. Decoded with UTF-8 (lossy) so ASCII/UTF-8
 * protocols both match; binary protocols fall back to no match (expected). */
export function frameMatchesText(data: Uint8Array, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data).toLowerCase();
  return text.includes(trimmed);
}
