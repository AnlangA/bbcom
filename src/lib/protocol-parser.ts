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
 */
export class ProtocolParser {
  private buffer: number[] = [];
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
    for (let i = 0; i < input.length; i += 1) this.buffer.push(input[i]);
    return this.drain();
  }

  /** Drop all buffered bytes (e.g. on a user-requested flush). */
  reset(): void {
    this.buffer = [];
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
      this.buffer = [];
      this.consumed = 0;
    } else if (this.consumed > 4096) {
      this.buffer = this.buffer.slice(this.consumed);
      this.consumed = 0;
    }
    return out;
  }

  private view(): number[] {
    return this.consumed === 0 ? this.buffer : this.buffer.slice(this.consumed);
  }

  private extractOne(): ParsedFrame | null {
    const view = this.view();
    const offsetBase = this.consumed;

    if (this.config.kind === 'fixed') {
      const size = this.config.frameSize;
      if (view.length < size) return null;
      const data = new Uint8Array(view.slice(0, size));
      this.consumed += size;
      return { data, offset: offsetBase };
    }

    if (this.config.kind === 'delimiter') {
      const delim = this.config.delimiter;
      if (delim.length === 0) return null;
      const idx = indexOfSubarray(view, delim);
      if (idx === -1) return null;
      const end = this.config.includeDelimiter ? idx + delim.length : idx;
      const data = new Uint8Array(view.slice(0, end));
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
    const data = new Uint8Array(view.slice(0, total));
    this.consumed += total;
    return { data, offset: offsetBase };
  }
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
