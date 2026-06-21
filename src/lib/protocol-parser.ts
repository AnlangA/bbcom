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

/**
 * A stateful byte-stream → frame parser. Feed RX bytes via `feed()`; each call
 * returns zero or more complete frames that were finalized in that batch.
 *
 * Backed by a growable `Uint8Array` with a `consumed` head index. Bytes are
 * appended whole-chunk via `set()` (no per-byte push) and frame scanning reads
 * the live window through a zero-copy `subarray` — the prior `number[]`-backed
 * design pushed one boxed number per byte and sliced the live region on every
 * extraction, which made a single feed carrying K frames over N buffered bytes
 * cost O(K·N). This design is O(N) per feed regardless of frame count.
 */
export class ProtocolParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private consumed = 0;
  readonly config: ParserConfig;

  constructor(config: ParserConfig) {
    this.config = config;
  }

  /** Total bytes currently held in the partial buffer. */
  get pending(): number {
    return this.buffer.length - this.consumed;
  }

  /** Append bytes and return any frames that became complete. */
  feed(input: Uint8Array): ParsedFrame[] {
    if (input.length === 0) return [];
    this.append(input);
    return this.drain();
  }

  /** Drop all buffered bytes (e.g. on a user-requested flush). */
  reset(): void {
    this.buffer = new Uint8Array(0);
    this.consumed = 0;
  }

  /**
   * Append `input` to the live tail. Always produces a fresh backing array
   * holding exactly `[live][input]` with `consumed` reset to 0 — a single
   * allocation per feed regardless of input size. Capacity is doubled when it
   * would help amortize growth across many small feeds.
   */
  private append(input: Uint8Array): void {
    const live = this.buffer.length - this.consumed;
    const need = live + input.length;
    // Pick a capacity with room to grow so a stream of small feeds doesn't
    // reallocate every time; never smaller than exactly what we need.
    const cap = need > 64 && need <= this.buffer.length * 2 ? this.buffer.length * 2 : need;
    const grown = new Uint8Array(cap);
    grown.set(this.buffer.subarray(this.consumed), 0);
    grown.set(input, live);
    this.buffer = grown;
    this.consumed = 0;
  }

  /** Drop the consumed head, shifting live bytes to the front. */
  private compact(): void {
    if (this.consumed === 0) return;
    const live = this.buffer.subarray(this.consumed);
    const fresh = new Uint8Array(live.length);
    fresh.set(live);
    this.buffer = fresh;
    this.consumed = 0;
  }

  private drain(): ParsedFrame[] {
    const out: ParsedFrame[] = [];
    let progress = true;
    // Keep extracting while a complete frame is available. `progress` guards
    // against an accidental infinite loop if a config is mis-specified.
    while (progress) {
      progress = false;
      const frame = this.extractOne();
      if (frame) {
        out.push(frame);
        progress = true;
      }
    }
    // Compact the buffer occasionally so it doesn't grow without bound when no
    // delimiter ever arrives (e.g. misconfigured length field).
    if (this.consumed > 0 && this.consumed >= this.buffer.length) {
      this.buffer = new Uint8Array(0);
      this.consumed = 0;
    } else if (this.consumed > 4096) {
      this.compact();
    }
    return out;
  }

  /** Live window `[consumed, length)` — zero-copy; do not retain across appends. */
  private view(): Uint8Array {
    return this.consumed === 0 ? this.buffer : this.buffer.subarray(this.consumed);
  }

  private extractOne(): ParsedFrame | null {
    const view = this.view();
    const offsetBase = this.consumed;

    if (this.config.kind === 'fixed') {
      const size = this.config.frameSize;
      if (view.length < size) return null;
      const data = sliceCopy(view, 0, size);
      this.consumed += size;
      return { data, offset: offsetBase };
    }

    if (this.config.kind === 'delimiter') {
      const delim = this.config.delimiter;
      if (delim.length === 0) return null;
      const idx = indexOfSubarrayBytes(view, delim);
      if (idx === -1) return null;
      const end = this.config.includeDelimiter ? idx + delim.length : idx;
      const data = sliceCopy(view, 0, end);
      this.consumed += idx + delim.length;
      return { data, offset: offsetBase };
    }

    // length-based
    const cfg = this.config;
    const headerEnd = cfg.lengthOffset + cfg.lengthSize;
    if (view.length < headerEnd) return null;
    let lengthValue = 0;
    if (cfg.bigEndian) {
      for (let i = 0; i < cfg.lengthSize; i += 1) {
        lengthValue = (lengthValue << 8) | view[cfg.lengthOffset + i];
      }
    } else {
      for (let i = cfg.lengthSize - 1; i >= 0; i -= 1) {
        lengthValue = (lengthValue << 8) | view[cfg.lengthOffset + i];
      }
    }
    const total = cfg.lengthAdjust + lengthValue;
    if (total <= 0 || total > 1_000_000) {
      // Implausible length — the stream is likely misaligned. Drop one byte to
      // resync rather than buffering megabytes waiting for a phantom frame.
      this.consumed += 1;
      return null;
    }
    if (view.length < total) return null;
    const data = sliceCopy(view, 0, total);
    this.consumed += total;
    return { data, offset: offsetBase };
  }
}

/** Copy `[start, start+len)` of `src` into a fresh standalone Uint8Array. */
function sliceCopy(src: Uint8Array, start: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(src.subarray(start, start + len));
  return out;
}

/**
 * Find the first index of `needle` within `haystack` (subarray search), for the
 * typed-array hot path. Fast-rejects on first/last byte before the inner compare
 * loop so most non-matching offsets skip after 1–2 reads.
 */
export function indexOfSubarrayBytes(haystack: Uint8Array, needle: ArrayLike<number>): number {
  const nLen = needle.length;
  if (nLen === 0) return 0;
  if (nLen > haystack.length) return -1;
  const last = haystack.length - nLen;
  const first = needle[0];
  const final = needle[nLen - 1];
  for (let i = 0; i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    if (haystack[i + nLen - 1] !== final) continue;
    let match = true;
    for (let j = 1; j < nLen - 1; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** Find the first index of `needle` within `haystack` (subarray search). */
export function indexOfSubarray(haystack: number[], needle: number[]): number {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
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
