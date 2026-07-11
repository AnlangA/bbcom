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

/** Hard ceiling for one frame or an unframed delimiter-mode suffix (1 MiB). */
export const DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES = 1024 * 1024;

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

const MAX_LENGTH_FRAME_BYTES = DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES;
const MAX_FIXED_FRAME_BYTES = 65_535;
const MAX_DELIMITER_BYTES = 256;
const BUFFER_COMPACT_THRESHOLD = 64 * 1024;

/**
 * A stateful byte-stream → frame parser. Feed RX bytes via `feed()`; each call
 * returns zero or more complete frames that were finalized in that batch.
 */
export class ProtocolParser {
  /** Backing capacity. Only bytes in `[start, end)` are valid stream data. */
  private buffer = new Uint8Array(0);
  private start = 0;
  private end = 0;
  /** Absolute stream offset represented by `buffer[start]`. */
  private absoluteStartOffset = 0;
  /** First absolute stream offset delimiter mode still needs to inspect. */
  private delimiterSearchOffset = 0;
  private readonly maxPendingBytes: number;
  private discardedBytes = 0;
  private overflowEvents = 0;
  private resyncEvents = 0;
  readonly config: ParserConfig;

  constructor(config: ParserConfig, options: ProtocolParserOptions = {}) {
    this.config = validateAndCloneConfig(config);
    const requestedLimit = options.maxPendingBytes ?? DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES;
    const normalizedLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.floor(requestedLimit))
      : DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES;
    // A limit smaller than the delimiter could never recognize that delimiter;
    // a custom test/embedding limit must never raise the global 1 MiB ceiling.
    this.maxPendingBytes =
      this.config.kind === 'delimiter'
        ? Math.min(
            DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES,
            Math.max(normalizedLimit, this.config.delimiter.length),
          )
        : DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES;
  }

  /** Total bytes currently held in the partial buffer. */
  get pending(): number {
    return this.end - this.start;
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
    if (input.length === 0) return [];

    // Delimiter input is processed in bounded slices. Appending at most one
    // byte past the ceiling lets a delimiter complete at the boundary, while
    // ensuring a delimiter later in one huge feed cannot create an oversized
    // frame. The result is independent of how callers chunk the same stream.
    if (this.config.kind === 'delimiter') {
      const frames: ParsedFrame[] = [];
      let inputOffset = 0;
      while (inputOffset < input.length) {
        const room = this.maxPendingBytes - this.pending;
        const take = Math.min(input.length - inputOffset, Math.max(1, room + 1));
        this.append(input.subarray(inputOffset, inputOffset + take));
        inputOffset += take;
        frames.push(...this.drain());
        this.enforcePendingLimit();
        this.compactBuffer();
      }
      return frames;
    }

    this.append(input);
    const frames = this.drain();
    this.compactBuffer();
    return frames;
  }

  /** Drop all buffered bytes (e.g. on a user-requested flush). */
  reset(): void {
    this.buffer = new Uint8Array(0);
    this.start = 0;
    this.end = 0;
    this.absoluteStartOffset = 0;
    this.delimiterSearchOffset = 0;
    this.discardedBytes = 0;
    this.overflowEvents = 0;
    this.resyncEvents = 0;
  }

  private drain(): ParsedFrame[] {
    const out: ParsedFrame[] = [];
    while (true) {
      const startBefore = this.start;
      const frame = this.extractOne();
      if (frame) out.push(frame);
      // extractOne can also make progress by dropping one implausible length
      // byte. Continue in that case so resynchronization is linear in one feed.
      if (this.start === startBefore) break;
    }
    return out;
  }

  private compactBuffer(): void {
    if (this.start === 0) return;

    // Keep reusable capacity after exhausting the live window. `end`, not the
    // backing-array length, defines validity, so spare zero-filled capacity can
    // never be parsed as serial input.
    if (this.start >= this.end) {
      this.start = 0;
      this.end = 0;
      this.delimiterSearchOffset = this.absoluteStartOffset;
      return;
    }

    if (this.start >= BUFFER_COMPACT_THRESHOLD || this.start >= this.pending) {
      this.buffer.copyWithin(0, this.start, this.end);
      this.end = this.pending;
      this.start = 0;
    }
  }

  private enforcePendingLimit(): void {
    if (this.config.kind !== 'delimiter' || this.pending <= this.maxPendingBytes) return;

    // A full scan found no delimiter. Only a suffix shorter than the delimiter
    // can possibly combine with future input, so retaining more is unnecessary.
    const retain = this.config.delimiter.length - 1;
    const discard = this.pending - retain;
    this.consume(discard);
    this.discardedBytes += discard;
    this.overflowEvents += 1;
    this.resyncEvents += 1;
    this.delimiterSearchOffset = Math.max(this.delimiterSearchOffset, this.absoluteStartOffset);
  }

  private extractOne(): ParsedFrame | null {
    const view = this.view();
    const frameOffset = this.absoluteStartOffset;

    if (this.config.kind === 'fixed') {
      const size = this.config.frameSize;
      if (view.length < size) return null;
      const data = sliceCopy(view, 0, size);
      this.consume(size);
      return { data, offset: frameOffset };
    }

    if (this.config.kind === 'delimiter') {
      const delim = this.config.delimiter;
      const relativeSearchFrom = Math.max(0, this.delimiterSearchOffset - this.absoluteStartOffset);
      const match = indexOfSubarrayBytes(view, delim, relativeSearchFrom);
      if (match === -1) {
        // On the next feed only recheck the suffix that could be the beginning
        // of a delimiter spanning the old/new input boundary.
        this.delimiterSearchOffset =
          this.absoluteStartOffset + Math.max(0, view.length - delim.length + 1);
        return null;
      }
      const dataLength = this.config.includeDelimiter ? match + delim.length : match;
      // The extra probe byte may complete a boundary delimiter. It may not
      // create a frame whose emitted bytes exceed the configured ceiling.
      if (dataLength > this.maxPendingBytes) return null;
      const data = sliceCopy(view, 0, dataLength);
      this.consume(match + delim.length);
      this.delimiterSearchOffset = this.absoluteStartOffset;
      return { data, offset: frameOffset };
    }

    // length-based
    const cfg = this.config;
    const headerEnd = cfg.lengthOffset + cfg.lengthSize;
    if (view.length < headerEnd) return null;
    let lengthValue = 0;
    if (cfg.bigEndian) {
      for (let i = 0; i < cfg.lengthSize; i += 1) {
        lengthValue = lengthValue * 256 + view[cfg.lengthOffset + i];
      }
    } else {
      for (let i = cfg.lengthSize - 1; i >= 0; i -= 1) {
        lengthValue = lengthValue * 256 + view[cfg.lengthOffset + i];
      }
    }
    const total = cfg.lengthAdjust + lengthValue;
    if (total < headerEnd || total > MAX_LENGTH_FRAME_BYTES) {
      // Implausible length — the stream is likely misaligned. Drop one byte to
      // resync rather than buffering megabytes waiting for a phantom frame.
      this.consume(1);
      this.discardedBytes += 1;
      this.resyncEvents += 1;
      return null;
    }
    if (view.length < total) return null;
    const data = sliceCopy(view, 0, total);
    this.consume(total);
    return { data, offset: frameOffset };
  }

  private append(input: Uint8Array): void {
    const live = this.pending;
    const need = live + input.length;

    if (this.buffer.length - this.end >= input.length) {
      this.buffer.set(input, this.end);
      this.end += input.length;
      return;
    }

    if (this.start > 0 && this.buffer.length >= need) {
      this.buffer.copyWithin(0, this.start, this.end);
      this.start = 0;
      this.end = live;
      this.buffer.set(input, this.end);
      this.end += input.length;
      return;
    }

    let capacity = Math.max(64, this.buffer.length || 64);
    while (capacity < need) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(this.start, this.end), 0);
    grown.set(input, live);
    this.buffer = grown;
    this.start = 0;
    this.end = need;
  }

  private consume(count: number): void {
    this.start += count;
    this.absoluteStartOffset += count;
  }

  /** Live valid bytes — spare backing capacity is deliberately excluded. */
  private view(): Uint8Array {
    return this.buffer.subarray(this.start, this.end);
  }
}

function validateAndCloneConfig(config: ParserConfig): ParserConfig {
  if (!config || typeof config !== 'object') throw new TypeError('parser config must be an object');

  if (config.kind === 'fixed') {
    assertIntegerRange('frameSize', config.frameSize, 1, MAX_FIXED_FRAME_BYTES);
    return { kind: 'fixed', frameSize: config.frameSize };
  }

  if (config.kind === 'delimiter') {
    if (!Array.isArray(config.delimiter)) throw new TypeError('delimiter must be an array');
    assertIntegerRange('delimiter.length', config.delimiter.length, 1, MAX_DELIMITER_BYTES);
    for (let i = 0; i < config.delimiter.length; i += 1) {
      assertIntegerRange(`delimiter[${i}]`, config.delimiter[i], 0, 0xff);
    }
    if (typeof config.includeDelimiter !== 'boolean') {
      throw new TypeError('includeDelimiter must be a boolean');
    }
    return {
      kind: 'delimiter',
      delimiter: [...config.delimiter],
      includeDelimiter: config.includeDelimiter,
    };
  }

  if (config.kind === 'length') {
    if (config.lengthSize !== 1 && config.lengthSize !== 2 && config.lengthSize !== 4) {
      throw new RangeError('lengthSize must be 1, 2, or 4');
    }
    assertIntegerRange(
      'lengthOffset',
      config.lengthOffset,
      0,
      MAX_LENGTH_FRAME_BYTES - config.lengthSize,
    );
    assertIntegerRange('lengthAdjust', config.lengthAdjust, 0, MAX_LENGTH_FRAME_BYTES);
    if (typeof config.bigEndian !== 'boolean') {
      throw new TypeError('bigEndian must be a boolean');
    }
    return { ...config };
  }

  throw new RangeError('unknown parser kind');
}

function assertIntegerRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

/** Copy `[start, start+length)` into an independent frame buffer. */
function sliceCopy(src: Uint8Array, start: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(src.subarray(start, start + length));
  return out;
}

/** Find the first index of `needle` within `haystack` (subarray search). */
export function indexOfSubarray(haystack: number[], needle: number[]): number {
  return indexOfArrayLike(haystack, needle, 0);
}

/** Typed-array variant used by the parser hot path. */
export function indexOfSubarrayBytes(
  haystack: Uint8Array,
  needle: ArrayLike<number>,
  from = 0,
): number {
  return indexOfArrayLike(haystack, needle, from);
}

function indexOfArrayLike(
  haystack: ArrayLike<number>,
  needle: ArrayLike<number>,
  from: number,
): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  const first = needle[0];
  const final = needle[needle.length - 1];
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (haystack[i] !== first || haystack[i + needle.length - 1] !== final) continue;
    let match = true;
    for (let j = 1; j < needle.length - 1; j += 1) {
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
