export const DEFAULT_RX_FRAME_GAP_MS = 5;
export const MIN_RX_FRAME_GAP_MS = 1;
export const MAX_RX_FRAME_GAP_MS = 1_000;

/**
 * Normalize the RX inactivity gap used to turn native serial chunks into
 * terminal frames. A frame closes after no new byte arrives for this long.
 */
export function normalizeRxFrameGapMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RX_FRAME_GAP_MS;
  return Math.max(MIN_RX_FRAME_GAP_MS, Math.min(MAX_RX_FRAME_GAP_MS, Math.floor(value)));
}
