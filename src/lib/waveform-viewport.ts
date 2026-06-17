/**
 * Waveform viewport transforms (sample-index + time-domain).
 *
 * Extracted from `lib/waveform.ts` so the pure windowing math — normalize /
 * zoom / scale / pan / clamp / follow-latest, in both the integer sample-index
 * space and the continuous time-ms space — lives in its own focused, unit-
 * testable module (precedent: the modbus/ barrel split). Nothing here imports
 * Vue; the functions take plain viewports + sample/timestamp arrays.
 */

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

export const DEFAULT_WAVEFORM_VIEWPORT_MIN_SAMPLES = 8;
export const DEFAULT_WAVEFORM_VIEWPORT_MIN_MS = 1;

// ---------------------------------------------------------------------------
// Private numeric helpers.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sample-index viewport (integer space).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Time-domain viewport (continuous ms space).
// ---------------------------------------------------------------------------

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
