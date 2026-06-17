/**
 * Export filtering helpers (F-e / T3.9).
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

/**
 * Filter frames by a time range + optional direction. Returns a new array
 * (does not mutate the input). Frames with `timestamp` in `[startMs, endMs)`
 * and matching `direction` (if specified) are kept.
 */
export function filterFramesByTimeRange(
  frames: readonly DataFrame[],
  filter: TimeRangeFilter,
): DataFrame[] {
  const { startMs, endMs, direction } = filter;
  return frames.filter((f) => {
    if (startMs !== null && f.timestamp < startMs) return false;
    if (endMs !== null && f.timestamp >= endMs) return false;
    if (direction !== null && f.direction !== direction) return false;
    return true;
  });
}
