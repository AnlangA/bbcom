/**
 * Export filtering helpers.
 *
 * Filters captured frames by a time range (start/end in ms) and/or direction,
 * so a user can export just the relevant portion of a long capture. Pure so it
 * is unit-testable; the export composable applies it before formatting.
 */
import type { DataFrame } from '../types';

export interface TimeRangeFilter {
  /** Inclusive start timestamp (ms), or null for no lower bound. */
  startMs: number | null;
  /** Exclusive end timestamp (ms), or null for no upper bound. */
  endMs: number | null;
  /** Optional direction filter: 'TX', 'RX', or null for both. */
  direction: 'TX' | 'RX' | null;
}

export type ExportDirectionFilter = 'all' | 'TX' | 'RX';
export type ExportTimePreset = 'all' | 'last-1m' | 'last-5m' | 'custom';

export interface ExportFilterSelection {
  direction: ExportDirectionFilter;
  timePreset: ExportTimePreset;
  customStartMs: number | null;
  customEndMs: number | null;
}

export interface ExportPreview {
  frameCount: number;
  rawBytes: number;
  maxFrameBytes: number;
}

/**
 * A stable, zero-copy export selection. `endIndex` freezes the capture at the
 * confirmation point without duplicating its frame references; new RX/TX
 * frames can continue arriving while the selected prefix streams to Rust.
 */
export interface ExportFrameSnapshot {
  frames: readonly DataFrame[];
  endIndex: number;
  filter: TimeRangeFilter;
}

export function isValidCustomTimeRange(startMs: number | null, endMs: number | null): boolean {
  return (
    startMs !== null &&
    endMs !== null &&
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    startMs < endMs
  );
}

/** Resolve UI presets into the exact half-open backend-independent filter.
 * Relative windows are anchored to the newest captured frame, not wall time. */
export function resolveExportFilter(
  frames: readonly DataFrame[],
  selection: ExportFilterSelection,
): TimeRangeFilter {
  let startMs: number | null = null;
  let endMs: number | null = null;
  if (selection.timePreset === 'custom') {
    if (!isValidCustomTimeRange(selection.customStartMs, selection.customEndMs)) {
      throw new RangeError('custom export range requires start < end');
    }
    startMs = selection.customStartMs;
    endMs = selection.customEndMs;
  } else if (selection.timePreset !== 'all' && frames.length > 0) {
    const latest = frames.reduce(
      (maximum, frame) => Math.max(maximum, frame.timestamp),
      Number.NEGATIVE_INFINITY,
    );
    startMs = latest - (selection.timePreset === 'last-1m' ? 60_000 : 300_000);
    // No upper bound: this includes every frame at the latest timestamp.
    endMs = null;
  }
  return {
    startMs,
    endMs,
    direction: selection.direction === 'all' ? null : selection.direction,
  };
}

export function createExportPreview(
  frames: readonly DataFrame[],
  selection: ExportFilterSelection,
): ExportPreview {
  let frameCount = 0;
  let rawBytes = 0;
  let maxFrameBytes = 0;
  for (const frame of iterateExportFrames(createExportFrameSnapshot(frames, selection))) {
    const bytes = frame.data.byteLength;
    frameCount += 1;
    rawBytes += bytes;
    maxFrameBytes = Math.max(maxFrameBytes, bytes);
  }
  return {
    frameCount,
    rawBytes,
    maxFrameBytes,
  };
}

export function createExportFrameSnapshot(
  frames: readonly DataFrame[],
  selection: ExportFilterSelection,
): ExportFrameSnapshot {
  return {
    frames,
    endIndex: frames.length,
    filter: resolveExportFilter(frames, selection),
  };
}

/** Stream the selected capture prefix without allocating a filtered frame array. */
export function* iterateExportFrames(snapshot: ExportFrameSnapshot): Generator<DataFrame> {
  const upperBound = Math.min(snapshot.endIndex, snapshot.frames.length);
  for (let index = 0; index < upperBound; index += 1) {
    const frame = snapshot.frames[index];
    if (matchesExportFilter(frame, snapshot.filter)) yield frame;
  }
}

export function matchesExportFilter(frame: DataFrame, filter: TimeRangeFilter): boolean {
  const { startMs, endMs, direction } = filter;
  if (startMs !== null && frame.timestamp < startMs) return false;
  if (endMs !== null && frame.timestamp >= endMs) return false;
  if (direction !== null && frame.direction !== direction) return false;
  return true;
}

/**
 * Filter frames by a time range + optional direction. Returns a new array
 * (does not mutate the input). Frames with `timestamp` in `[startMs, endMs)`
 * and matching `direction` (if specified) are kept.
 */
export function filterFramesByTimeRange(
  frames: readonly DataFrame[],
  filter: TimeRangeFilter,
): DataFrame[] {
  return Array.from(iterateExportFrames({ frames, endIndex: frames.length, filter }));
}
