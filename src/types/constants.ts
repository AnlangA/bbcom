// Numeric limits derived from the buffer/perf budgets. Kept here (rather than in
// each consumer) so a budget change is a single edit.

/** Default rolling frame-buffer cap per session (see buffer-config for the
 *  configurable 1000–100000 range). */
export const MAX_FRAMES = 10000;

/** Per-session send-history dropdown length. */
export const MAX_HISTORY = 20;

/** Hard ceiling on a single send payload (1 MiB). Guards both text and hex TX. */
export const MAX_INPUT_SIZE = 1024 * 1024; // 1MB

/** Maximum payload exposed by one MERGED terminal row to the UI. */
export const MAX_MERGED_VISIBLE_BYTES = 64 * 1024;

/** Shared ceiling for formatted and search-string caches. */
export const TERMINAL_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** A single formatted/search entry larger than this is never cached. */
export const TERMINAL_CACHE_ENTRY_MAX_BYTES = 64 * 1024;
