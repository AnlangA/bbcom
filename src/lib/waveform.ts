/**
 * Streaming numeric parser for the waveform view.
 *
 * Mirrors how serial-studio / Arduino Serial Plotter work: the latest chunk of
 * RX text is split into lines, the trailing line is parsed for comma/space/
 * semicolon-separated numbers, and each value becomes one channel sample.
 * Non-numeric lines (log text, prompts) yield an empty array and are skipped,
 * so a mixed log+data stream still plots cleanly.
 */

// RegExp constructor (not a /.../ literal) so this file also loads under Node's
// --experimental-strip-types runner, whose parser mishandles regex literals in
// some multi-function files (treats them as division).
const NUMBER_RE = new RegExp('-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'g');
const LINE_SPLIT_RE = new RegExp('\\r?\\n');
const TRAILING_NEWLINE_RE = new RegExp('\\r?\\n$');
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** Parse the last non-empty line of a text chunk into numeric samples. */
export function parseSampleLine(text: string): number[] {
  if (!text) return [];
  // Drop a trailing newline so a partial line doesn't create a bogus empty
  // final entry, then take the last meaningful line.
  const trimmed = text.replace(TRAILING_NEWLINE_RE, '');
  const lines = trimmed.split(LINE_SPLIT_RE);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    // Split on commas/semicolons/whitespace, then keep only real numbers.
    const matches = line.match(NUMBER_RE);
    if (matches && matches.length > 0) {
      const out: number[] = [];
      for (let j = 0; j < matches.length; j += 1) {
        const n = Number(matches[j]);
        if (Number.isFinite(n)) out.push(n);
      }
      return out;
    }
  }
  return [];
}

/** Decode a Uint8Array frame to text using the same UTF-8 path as the terminal. */
export function decodeFrameText(data: Uint8Array): string {
  return textDecoder.decode(data);
}

export interface WaveformChannel {
  color: string;
  latest: number | null;
}

/** Per-channel statistics computed across the live buffer. Cheap (O(n·c)) and
 * re-derived on demand — the buffer is bounded by CAPACITY. */
export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
}

export function channelStats(buf: WaveformBuffer, channelCount: number): ChannelStats[] {
  const out: ChannelStats[] = [];
  const n = buf.samples.length;
  for (let c = 0; c < channelCount; c += 1) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const v = buf.samples[i][c];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count += 1;
    }
    if (count === 0 || !Number.isFinite(min) || !Number.isFinite(max)) {
      out.push({ min: 0, max: 0, mean: 0 });
    } else {
      out.push({ min, max, mean: sum / count });
    }
  }
  return out;
}

/** A bounded ring buffer of per-channel samples, newest last. */
export interface WaveformBuffer {
  samples: number[][];
  capacity: number;
}

export function createBuffer(capacity: number): WaveformBuffer {
  return { samples: [], capacity };
}

/** Push one multi-channel sample, trimming to capacity. Mutates and returns. */
export function pushSample(buf: WaveformBuffer, sample: number[]): WaveformBuffer {
  buf.samples.push(sample);
  if (buf.samples.length > buf.capacity) {
    // Drop from the front in bulk to amortize the shift cost.
    buf.samples.splice(0, buf.samples.length - buf.capacity);
  }
  return buf;
}

/**
 * Compute per-channel min/max across the buffer for autoscaling, with a small
 * padding band so a flat line doesn't sit on the edge. Returns [min, max] per
 * channel; a channel with no data yields [0, 1].
 */
export function channelRanges(buf: WaveformBuffer, channelCount: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let c = 0; c < channelCount; c += 1) {
    let min = Infinity;
    let max = -Infinity;
    const n = buf.samples.length;
    for (let i = 0; i < n; i += 1) {
      const v = buf.samples[i][c];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      ranges.push([0, 1]);
    } else if (min === max) {
      // Flat line — give it a 1-unit band either side so it renders mid-canvas.
      const pad = Math.max(1, Math.abs(min) * 0.1);
      ranges.push([min - pad, max + pad]);
    } else {
      const pad = (max - min) * 0.08;
      ranges.push([min - pad, max + pad]);
    }
  }
  return ranges;
}

/** Distinct, color-blind-friendly hues for up to N channels. */
export function channelColor(index: number): string {
  const PALETTE = [
    '#3ddc97',
    '#5aa9ff',
    '#ffbf5f',
    '#ff6b7a',
    '#a78bfa',
    '#ff9f5a',
    '#60a5fa',
    '#2dd4bf',
  ];
  return PALETTE[index % PALETTE.length];
}
