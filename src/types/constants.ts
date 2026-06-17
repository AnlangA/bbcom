// Numeric limits derived from the buffer/perf budgets. Kept here (rather than in
// each consumer) so a budget change is a single edit.

/** Default rolling frame-buffer cap per session (see buffer-config for the
 *  configurable 1000–100000 range). */
export const MAX_FRAMES = 10000;

/** Per-session send-history dropdown length. */
export const MAX_HISTORY = 20;

/** Hard ceiling on a single send payload (1 MiB). Guards both text and hex TX. */
export const MAX_INPUT_SIZE = 1024 * 1024; // 1MB

/** LRU format-cache size (per-frame display string memoization). */
export const CACHE_SIZE = 5000;
