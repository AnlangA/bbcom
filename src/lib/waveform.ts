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

export interface WaveformChannelState extends WaveformChannel {
  visible: boolean;
}

export interface WaveformFrameLike {
  direction: string;
  data: Uint8Array;
  timestamp?: number;
}

export interface WaveformTextIngestOptions {
  startIndex: number;
  direction: string;
  paused: boolean;
  channels: readonly WaveformChannelState[];
}

export interface WaveformTextIngestResult {
  channels: WaveformChannelState[];
  consumed: number;
  pushedSamples: number;
}

export interface WaveformFrameIdentity {
  id?: string;
}

export interface WaveformFrameCursor {
  consumed: number;
  lastFrameId: string | null;
}

export interface WaveformFrameIngestPlan {
  startIndex: number;
  reset: boolean;
  nextCursor: WaveformFrameCursor;
}

export interface WaveformViewport {
  start: number;
  size: number;
}

export interface WaveformTimeViewport {
  startMs: number;
  durationMs: number;
}

export interface WaveformTimeRange {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface WaveformSampleIndexWindow {
  /** First sample whose timestamp is inside the visible time range. */
  sampleStartIndex: number;
  /** Exclusive end index for samples inside the visible time range. */
  sampleEndIndex: number;
  /** Inclusive scan start, including one leading sample for clipped segments. */
  scanStartIndex: number;
  /** Exclusive scan end, including one trailing sample for clipped segments. */
  scanEndIndex: number;
}

export type WaveformZoomDirection = 'in' | 'out';
export type WaveformPanDirection = 'left' | 'right';

export interface WaveformRegisterSampleResult {
  channels: WaveformChannelState[];
  pushed: boolean;
}

export const DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES = 8;
export const DEFAULT_WAVEFORM_VIEWPORT_MIN_MS = 1;
export const DEFAULT_WAVEFORM_SAMPLE_POINT_MIN_DISTANCE_PX = 6;

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
  timestamps: number[];
  originTimestamp: number | null;
  capacity: number;
  totalDroppedSamples: number;
}

export function createBuffer(capacity: number): WaveformBuffer {
  return { samples: [], timestamps: [], originTimestamp: null, capacity, totalDroppedSamples: 0 };
}

/** Push one multi-channel sample, trimming to capacity. Mutates and returns. */
export function pushSample(
  buf: WaveformBuffer,
  sample: number[],
  timestamp = nextSampleTimestamp(buf),
): WaveformBuffer {
  const normalizedTimestamp = normalizeSampleTimestamp(buf, timestamp);
  if (buf.originTimestamp === null) buf.originTimestamp = normalizedTimestamp;
  buf.samples.push(sample);
  buf.timestamps.push(normalizedTimestamp);
  if (buf.samples.length > buf.capacity) {
    // Drop from the front in bulk to amortize the shift cost.
    const dropCount = buf.samples.length - buf.capacity;
    buf.samples.splice(0, dropCount);
    buf.timestamps.splice(0, dropCount);
    buf.totalDroppedSamples += dropCount;
  }
  return buf;
}

function normalizeSampleTimestamp(buf: WaveformBuffer, timestamp: number): number {
  const fallback = nextSampleTimestamp(buf);
  if (!Number.isFinite(timestamp)) return fallback;
  const last = buf.timestamps[buf.timestamps.length - 1];
  if (Number.isFinite(last) && timestamp <= last) return last + 1;
  return timestamp;
}

function nextSampleTimestamp(buf: WaveformBuffer): number {
  const last = buf.timestamps[buf.timestamps.length - 1];
  return Number.isFinite(last) ? last + 1 : 0;
}

export function ensureWaveformChannels(
  channels: readonly WaveformChannelState[],
  count: number,
): WaveformChannelState[] {
  const target = Math.max(0, Math.floor(count));
  if (target <= channels.length) return channels.slice();
  const next = channels.slice();
  for (let i = next.length; i < target; i += 1) {
    next.push({ color: channelColor(i), latest: null, visible: true });
  }
  return next;
}

export function pushRegisterWaveformSample(
  buf: WaveformBuffer,
  channels: readonly WaveformChannelState[],
  channel: number,
  value: number,
  paused: boolean,
  timestamp = Date.now(),
): WaveformRegisterSampleResult {
  if (paused || channel < 0 || !Number.isFinite(value)) {
    return { channels: channels.slice(), pushed: false };
  }
  const next = ensureWaveformChannels(channels, channel + 1);
  // Sparse sample: only the bound channel carries a new value; others hold
  // their previous latest so unrelated channels keep steady lines.
  const sample: number[] = [];
  for (let i = 0; i < next.length; i += 1) {
    sample[i] = i === channel ? value : (next[i]?.latest ?? 0);
  }
  pushSample(buf, sample, timestamp);
  next[channel] = { ...next[channel], latest: value };
  return { channels: next, pushed: true };
}

export function ingestWaveformTextFrames(
  buf: WaveformBuffer,
  frames: readonly WaveformFrameLike[],
  options: WaveformTextIngestOptions,
): WaveformTextIngestResult {
  let channelCount = options.channels.length;
  let pushedSamples = 0;
  for (let i = options.startIndex; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.direction !== options.direction) continue;
    const sample = parseSampleLine(decodeFrameText(frame.data));
    if (sample.length === 0) continue;
    if (sample.length > channelCount) channelCount = sample.length;
    if (!options.paused) {
      pushSample(buf, sample, frame.timestamp);
      pushedSamples += 1;
    }
  }

  let channels = ensureWaveformChannels(options.channels, channelCount);
  const last = buf.samples.length > 0 ? buf.samples[buf.samples.length - 1] : null;
  if (last) {
    channels = channels.map((channel, i) => ({
      ...channel,
      latest: last[i] ?? null,
    }));
  }
  return { channels, consumed: frames.length, pushedSamples };
}

export function waveformFrameCursorAtEnd(
  frames: readonly WaveformFrameIdentity[],
): WaveformFrameCursor {
  const last = frames[frames.length - 1];
  return {
    consumed: frames.length,
    lastFrameId: typeof last?.id === 'string' ? last.id : null,
  };
}

/**
 * Plan incremental ingestion for a shallow/non-reactive frame array. Length
 * alone is not reliable because the session store can mutate in place and trim
 * old entries while the visible length remains unchanged. The frame id keeps a
 * stable overlap anchor; when that anchor disappears, the local waveform cache
 * must be rebuilt from the current frame window.
 */
export function planWaveformFrameIngest(
  frames: readonly WaveformFrameIdentity[],
  cursor: WaveformFrameCursor,
): WaveformFrameIngestPlan {
  const nextCursor = waveformFrameCursorAtEnd(frames);
  if (frames.length === 0) {
    return {
      startIndex: 0,
      reset: cursor.consumed > 0 || cursor.lastFrameId !== null,
      nextCursor,
    };
  }

  if (cursor.lastFrameId) {
    const previousIndex = frames.findIndex((frame) => frame.id === cursor.lastFrameId);
    if (previousIndex !== -1) {
      return {
        startIndex: previousIndex + 1,
        reset: false,
        nextCursor,
      };
    }
    return {
      startIndex: 0,
      reset: true,
      nextCursor,
    };
  }

  if (cursor.consumed > frames.length) {
    return {
      startIndex: 0,
      reset: true,
      nextCursor,
    };
  }

  return {
    startIndex: Math.max(0, cursor.consumed),
    reset: false,
    nextCursor,
  };
}

export function formatWaveformNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function buildWaveformCsv(samples: readonly number[][], channelCount: number): string {
  const count = Math.max(0, Math.floor(channelCount));
  const header = Array.from({ length: count }, (_, i) => `ch${i}`).join(',');
  const lines = [header];
  for (let i = 0; i < samples.length; i += 1) {
    const row: string[] = [];
    for (let channel = 0; channel < count; channel += 1) {
      const value = samples[i][channel];
      row.push(value === undefined || !Number.isFinite(value) ? '' : String(value));
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function paddedRange(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  if (min === max) {
    // Flat line — give it a 1-unit band either side so it renders mid-canvas.
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
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
    ranges.push(paddedRange(min, max));
  }
  return ranges;
}

/**
 * Compute the shared Y-axis range for the visible waveform. Hidden channels do
 * not affect the scale; if every channel is hidden, all channels are considered
 * so the axis remains stable while toggling visibility back on.
 */
export function visibleChannelRange(
  buf: WaveformBuffer,
  channelCount: number,
  visible: readonly boolean[] = [],
): [number, number] {
  return visibleChannelRangeInWindow(buf, channelCount, visible, 0, buf.samples.length);
}

export function visibleChannelRangeInWindow(
  buf: WaveformBuffer,
  channelCount: number,
  visible: readonly boolean[] = [],
  startIndex = 0,
  endIndex = buf.samples.length,
): [number, number] {
  const hasVisibleChannel = visible.some((isVisible, i) => isVisible && i < channelCount);
  let min = Infinity;
  let max = -Infinity;
  const start = clampInt(startIndex, 0, buf.samples.length);
  const end = clampInt(endIndex, start, buf.samples.length);
  for (let c = 0; c < channelCount; c += 1) {
    if (hasVisibleChannel && !visible[c]) continue;
    for (let i = start; i < end; i += 1) {
      const v = buf.samples[i][c];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return paddedRange(min, max);
}

export function normalizeWaveformViewport(
  viewport: WaveformViewport,
  sampleCount: number,
  minSamples = DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES,
): WaveformViewport {
  const count = Math.max(0, Math.floor(sampleCount));
  if (count === 0) return { start: 0, size: 0 };
  const requestedMinSize =
    Number.isFinite(minSamples) && minSamples > 0
      ? Math.floor(minSamples)
      : DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES;
  const minSize = Math.max(1, Math.min(count, requestedMinSize));
  const rawSize = Number.isFinite(viewport.size) ? Math.floor(viewport.size) : count;
  const size = clampInt(rawSize, minSize, count);
  const rawStart = Number.isFinite(viewport.start) ? Math.floor(viewport.start) : 0;
  return {
    start: clampInt(rawStart, 0, Math.max(0, count - size)),
    size,
  };
}

export function zoomWaveformViewport(
  viewport: WaveformViewport,
  sampleCount: number,
  direction: WaveformZoomDirection,
  minSamples = DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES,
  factor = 2,
): WaveformViewport {
  const zoomFactor = Number.isFinite(factor) && factor > 1 ? factor : 2;
  return scaleWaveformViewport(
    viewport,
    sampleCount,
    0.5,
    direction === 'in' ? 1 / zoomFactor : zoomFactor,
    minSamples,
  );
}

export function scaleWaveformViewport(
  viewport: WaveformViewport,
  sampleCount: number,
  anchorRatio: number,
  scale: number,
  minSamples = DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES,
): WaveformViewport {
  const current = normalizeWaveformViewport(viewport, sampleCount, minSamples);
  if (current.size === 0) return current;
  const count = Math.max(0, Math.floor(sampleCount));
  const minSize =
    Number.isFinite(minSamples) && minSamples > 0
      ? Math.min(count, Math.floor(minSamples))
      : Math.min(count, DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES);
  const zoomScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (zoomScale < 1 && current.size <= minSize) return current;
  if (zoomScale > 1 && current.size >= count) return current;
  if (zoomScale === 1) return current;
  const targetSize = Math.round(current.size * zoomScale);
  if (targetSize === current.size) return current;
  const ratio = clampNumber(anchorRatio, 0, 1);
  const anchor = current.start + ratio * Math.max(0, current.size - 1);
  const targetSpan = Math.max(0, targetSize - 1);
  return normalizeWaveformViewport(
    {
      start: Math.round(anchor - ratio * targetSpan),
      size: targetSize,
    },
    sampleCount,
    minSamples,
  );
}

export function panWaveformViewport(
  viewport: WaveformViewport,
  sampleCount: number,
  direction: WaveformPanDirection,
  minSamples = DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES,
  fraction = 0.25,
): WaveformViewport {
  const current = normalizeWaveformViewport(viewport, sampleCount, minSamples);
  if (current.size === 0) return current;
  const panFraction = Number.isFinite(fraction) && fraction > 0 ? fraction : 0.25;
  const step = Math.max(1, Math.floor(current.size * panFraction));
  return normalizeWaveformViewport(
    {
      start: current.start + (direction === 'left' ? -step : step),
      size: current.size,
    },
    sampleCount,
    minSamples,
  );
}

export function panWaveformViewportBySamples(
  viewport: WaveformViewport,
  sampleCount: number,
  sampleOffset: number,
  minSamples = DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES,
): WaveformViewport {
  const current = normalizeWaveformViewport(viewport, sampleCount, minSamples);
  if (current.size === 0) return current;
  const offset = Number.isFinite(sampleOffset) ? Math.trunc(sampleOffset) : 0;
  if (offset === 0) return current;
  return normalizeWaveformViewport(
    {
      start: current.start + offset,
      size: current.size,
    },
    sampleCount,
    minSamples,
  );
}

export function waveformTimeRange(timestamps: readonly number[]): WaveformTimeRange | null {
  const start = firstFiniteTimestamp(timestamps);
  const end = lastFiniteTimestamp(timestamps);
  if (start === null || end === null) return null;
  const duration = Math.max(DEFAULT_WAVEFORM_VIEWPORT_MIN_MS, end - start);
  return {
    startMs: start,
    endMs: start + duration,
    durationMs: duration,
  };
}

export function waveformSampleIndexWindow(
  timestamps: readonly number[],
  startMs: number,
  endMs: number,
): WaveformSampleIndexWindow {
  const count = timestamps.length;
  if (count === 0) {
    return { sampleStartIndex: 0, sampleEndIndex: 0, scanStartIndex: 0, scanEndIndex: 0 };
  }

  const start = Number.isFinite(startMs) ? startMs : -Infinity;
  const end = Number.isFinite(endMs) ? endMs : Infinity;
  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  const sampleStartIndex = lowerBoundTimestamp(timestamps, normalizedStart);
  const sampleEndIndex = upperBoundTimestamp(timestamps, normalizedEnd);
  const scanStartIndex = Math.max(0, sampleStartIndex - 1);
  const scanEndIndex = Math.min(count, sampleEndIndex + (sampleEndIndex < count ? 1 : 0));
  return { sampleStartIndex, sampleEndIndex, scanStartIndex, scanEndIndex };
}

export function normalizeWaveformTimeViewport(
  viewport: WaveformTimeViewport,
  timestamps: readonly number[],
  minDurationMs = DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
): WaveformTimeViewport {
  const range = waveformTimeRange(timestamps);
  if (!range) return { startMs: 0, durationMs: 0 };
  const minDuration = normalizeMinDuration(minDurationMs, range.durationMs);
  const rawDuration = Number.isFinite(viewport.durationMs) ? viewport.durationMs : range.durationMs;
  const duration = clampNumber(rawDuration, minDuration, range.durationMs);
  const rawStart = Number.isFinite(viewport.startMs) ? viewport.startMs : range.startMs;
  return {
    startMs: clampNumber(rawStart, range.startMs, range.endMs - duration),
    durationMs: duration,
  };
}

export function scaleWaveformTimeViewport(
  viewport: WaveformTimeViewport,
  timestamps: readonly number[],
  anchorRatio: number,
  scale: number,
  minDurationMs = DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
): WaveformTimeViewport {
  const range = waveformTimeRange(timestamps);
  if (!range) return { startMs: 0, durationMs: 0 };
  const current = normalizeWaveformTimeViewport(viewport, timestamps, minDurationMs);
  const minDuration = normalizeMinDuration(minDurationMs, range.durationMs);
  const zoomScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (zoomScale === 1) return current;
  if (zoomScale < 1 && current.durationMs <= minDuration) return current;
  if (zoomScale > 1 && current.durationMs >= range.durationMs) return current;
  const targetDuration = current.durationMs * zoomScale;
  if (Math.abs(targetDuration - current.durationMs) < 0.001) return current;
  const ratio = clampNumber(anchorRatio, 0, 1);
  const anchor = current.startMs + current.durationMs * ratio;
  return normalizeWaveformTimeViewport(
    {
      startMs: anchor - targetDuration * ratio,
      durationMs: targetDuration,
    },
    timestamps,
    minDurationMs,
  );
}

export function panWaveformTimeViewport(
  viewport: WaveformTimeViewport,
  timestamps: readonly number[],
  direction: WaveformPanDirection,
  fraction = 0.25,
  minDurationMs = DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
): WaveformTimeViewport {
  const current = normalizeWaveformTimeViewport(viewport, timestamps, minDurationMs);
  if (current.durationMs === 0) return current;
  const panFraction = Number.isFinite(fraction) && fraction > 0 ? fraction : 0.25;
  const offset = current.durationMs * panFraction * (direction === 'left' ? -1 : 1);
  return panWaveformTimeViewportByMs(current, timestamps, offset, minDurationMs);
}

export function panWaveformTimeViewportByMs(
  viewport: WaveformTimeViewport,
  timestamps: readonly number[],
  offsetMs: number,
  minDurationMs = DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
): WaveformTimeViewport {
  const current = normalizeWaveformTimeViewport(viewport, timestamps, minDurationMs);
  if (current.durationMs === 0) return current;
  const offset = Number.isFinite(offsetMs) ? offsetMs : 0;
  if (offset === 0) return current;
  return normalizeWaveformTimeViewport(
    {
      startMs: current.startMs + offset,
      durationMs: current.durationMs,
    },
    timestamps,
    minDurationMs,
  );
}

export function syncWaveformTimeViewportAfterSampleChange(
  viewport: WaveformTimeViewport,
  previousTimestamps: readonly number[],
  timestamps: readonly number[],
  minDurationMs = DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
): WaveformTimeViewport {
  const nextRange = waveformTimeRange(timestamps);
  if (!nextRange) return { ...viewport, startMs: 0 };
  if (!Number.isFinite(viewport.durationMs)) {
    return { ...viewport, startMs: nextRange.startMs };
  }
  const previousRange = waveformTimeRange(previousTimestamps);
  if (!previousRange) {
    return normalizeWaveformTimeViewport(
      { startMs: nextRange.startMs, durationMs: nextRange.durationMs },
      timestamps,
      minDurationMs,
    );
  }
  const previousView = normalizeWaveformTimeViewport(viewport, previousTimestamps, minDurationMs);
  const wasFollowingLatest = previousView.startMs + previousView.durationMs >= previousRange.endMs;
  if (wasFollowingLatest) {
    return normalizeWaveformTimeViewport(
      {
        startMs: nextRange.endMs - previousView.durationMs,
        durationMs: previousView.durationMs,
      },
      timestamps,
      minDurationMs,
    );
  }
  return normalizeWaveformTimeViewport(previousView, timestamps, minDurationMs);
}

export function syncWaveformViewportAfterSampleChange(
  viewport: WaveformViewport,
  previousSampleCount: number,
  sampleCount: number,
  minSamples = DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES,
  droppedSamples = 0,
): WaveformViewport {
  const count = Math.max(0, Math.floor(sampleCount));
  if (count === 0) return { ...viewport, start: 0 };
  const previousView = normalizeWaveformViewport(viewport, previousSampleCount, minSamples);
  const wasFollowingLatest =
    previousSampleCount <= 0 || previousView.start + previousView.size >= previousSampleCount;
  if (wasFollowingLatest) {
    const nextView = normalizeWaveformViewport(
      {
        start: count - viewport.size,
        size: viewport.size,
      },
      count,
      minSamples,
    );
    return { ...viewport, start: nextView.start };
  }
  const dropped = Number.isFinite(droppedSamples) ? Math.max(0, Math.floor(droppedSamples)) : 0;
  const clamped = normalizeWaveformViewport(
    { start: previousView.start - dropped, size: viewport.size },
    count,
    minSamples,
  );
  return { ...viewport, start: clamped.start };
}

function clampInt(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (max <= min) return min;
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeMinDuration(minDurationMs: number, maxDurationMs: number): number {
  const requested =
    Number.isFinite(minDurationMs) && minDurationMs > 0
      ? minDurationMs
      : DEFAULT_WAVEFORM_VIEWPORT_MIN_MS;
  return Math.max(DEFAULT_WAVEFORM_VIEWPORT_MIN_MS, Math.min(maxDurationMs, requested));
}

function firstFiniteTimestamp(timestamps: readonly number[]): number | null {
  for (const timestamp of timestamps) {
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function lastFiniteTimestamp(timestamps: readonly number[]): number | null {
  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    const timestamp = timestamps[i];
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function lowerBoundTimestamp(timestamps: readonly number[], target: number): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const timestamp = timestamps[mid];
    if (Number.isFinite(timestamp) && timestamp < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundTimestamp(timestamps: readonly number[], target: number): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const timestamp = timestamps[mid];
    if (Number.isFinite(timestamp) && timestamp <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface WaveformPathPoint {
  x: number;
  y: number;
  value: number;
  timestamp: number;
}

export interface WaveformHoverPathPoint extends WaveformPathPoint {
  distanceSq: number;
}

export function thinWaveformSamplePoints(
  points: readonly WaveformPathPoint[],
  minDistancePx = DEFAULT_WAVEFORM_SAMPLE_POINT_MIN_DISTANCE_PX,
): WaveformPathPoint[] {
  const distance = Number.isFinite(minDistancePx)
    ? Math.max(0, minDistancePx)
    : DEFAULT_WAVEFORM_SAMPLE_POINT_MIN_DISTANCE_PX;
  if (distance === 0) return points.filter(isFinitePathPoint);

  const minDistanceSq = distance * distance;
  const out: WaveformPathPoint[] = [];
  let lastFinite: WaveformPathPoint | null = null;

  for (const point of points) {
    if (!isFinitePathPoint(point)) continue;
    lastFinite = point;
    const previous = out[out.length - 1];
    if (!previous || distanceSq(previous.x, previous.y, point.x, point.y) >= minDistanceSq) {
      out.push(point);
    }
  }

  if (lastFinite && out.length > 0 && out[out.length - 1] !== lastFinite) {
    const previous = out.length > 1 ? out[out.length - 2] : null;
    if (
      !previous ||
      distanceSq(previous.x, previous.y, lastFinite.x, lastFinite.y) >= minDistanceSq
    ) {
      out[out.length - 1] = lastFinite;
    }
  }

  return out;
}

/**
 * Find the nearest point on a rendered waveform polyline. Unlike snapping to
 * discrete samples, this projects the cursor onto each line segment, so hover
 * readouts move smoothly between samples.
 */
export function closestPointOnWaveformPath(
  cursor: Pick<WaveformPathPoint, 'x' | 'y'>,
  points: readonly WaveformPathPoint[],
): WaveformHoverPathPoint | null {
  let best: WaveformHoverPathPoint | null = null;
  let previous: WaveformPathPoint | null = null;

  for (const point of points) {
    if (!isFinitePathPoint(point)) continue;
    if (previous === null) {
      best = closerPoint(best, {
        ...point,
        distanceSq: distanceSq(cursor.x, cursor.y, point.x, point.y),
      });
      previous = point;
      continue;
    }

    const projected = projectToSegment(cursor, previous, point);
    best = closerPoint(best, projected);
    previous = point;
  }

  return best;
}

function isFinitePathPoint(point: WaveformPathPoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.value) &&
    Number.isFinite(point.timestamp)
  );
}

function closerPoint(
  current: WaveformHoverPathPoint | null,
  candidate: WaveformHoverPathPoint,
): WaveformHoverPathPoint {
  return current === null || candidate.distanceSq < current.distanceSq ? candidate : current;
}

function projectToSegment(
  cursor: Pick<WaveformPathPoint, 'x' | 'y'>,
  a: WaveformPathPoint,
  b: WaveformPathPoint,
): WaveformHoverPathPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const ratio =
    lenSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / lenSq));
  const x = a.x + dx * ratio;
  const y = a.y + dy * ratio;
  return {
    x,
    y,
    value: a.value + (b.value - a.value) * ratio,
    timestamp: a.timestamp + (b.timestamp - a.timestamp) * ratio,
    distanceSq: distanceSq(cursor.x, cursor.y, x, y),
  };
}

function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
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
