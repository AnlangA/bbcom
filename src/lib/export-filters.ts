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

export const EXPORT_FRAME_REFERENCE_LIMIT = 100_000;

/**
 * A stable export selection. The array of already-filtered frame references is
 * copied at confirmation time, but each DataFrame and its Uint8Array payload
 * remain shared. Capture trimming/appending can therefore mutate the source
 * array without changing this selection or allocating the payload again.
 */
export interface ExportFrameSnapshot {
  frames: readonly DataFrame[];
  preview: ExportPreview;
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
  const filter = resolveExportFilter(frames, selection);
  let frameCount = 0;
  let rawBytes = 0;
  let maxFrameBytes = 0;
  for (const frame of frames) {
    if (!matchesExportFilter(frame, filter)) continue;
    frameCount += 1;
    const bytes = frame.data.byteLength;
    rawBytes += bytes;
    maxFrameBytes = Math.max(maxFrameBytes, bytes);
  }
  return { frameCount, rawBytes, maxFrameBytes };
}

export function createExportFrameSnapshot(
  frames: readonly DataFrame[],
  selection: ExportFilterSelection,
): ExportFrameSnapshot {
  const filter = resolveExportFilter(frames, selection);
  const selected: DataFrame[] = [];
  let rawBytes = 0;
  let maxFrameBytes = 0;
  for (const frame of frames) {
    if (!matchesExportFilter(frame, filter)) continue;
    if (selected.length >= EXPORT_FRAME_REFERENCE_LIMIT) {
      throw new RangeError(
        `Export contains more than ${EXPORT_FRAME_REFERENCE_LIMIT} frame references`,
      );
    }
    selected.push(frame);
    const bytes = frame.data.byteLength;
    rawBytes += bytes;
    maxFrameBytes = Math.max(maxFrameBytes, bytes);
  }
  return {
    frames: Object.freeze(selected),
    preview: {
      frameCount: selected.length,
      rawBytes,
      maxFrameBytes,
    },
  };
}

/** Iterate the immutable reference selection without copying frame payloads. */
export function* iterateExportFrames(snapshot: ExportFrameSnapshot): Generator<DataFrame> {
  yield* snapshot.frames;
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
  return frames.filter((frame) => matchesExportFilter(frame, filter));
}
