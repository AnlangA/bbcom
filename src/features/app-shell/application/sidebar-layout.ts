/**
 * Shared sidebar geometry.
 *
 * The store persists this value while AppShell changes it through pointer and
 * keyboard input. Keeping the limits and normalization here prevents those
 * paths from developing subtly different behavior.
 */
export const SIDEBAR_WIDTH_DEFAULT = 292;
export const SIDEBAR_WIDTH_MIN = 252;
export const SIDEBAR_WIDTH_MAX = 340;
export const SIDEBAR_WIDTH_STEP = 12;
export const SIDEBAR_WIDTH_LARGE_STEP = 24;

export function clampSidebarWidth(width: number, fallback = SIDEBAR_WIDTH_DEFAULT): number {
  const normalized = Number.isFinite(width) ? width : fallback;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(normalized)));
}
