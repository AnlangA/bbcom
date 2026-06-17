/**
 * SSE streaming token accumulator (F14 / T3.8).
 *
 * The Rust AI command streams response tokens via `enable_stream().stream_sse_for_each`
 * (zai-rs 0.1.15). On the frontend, these tokens arrive incrementally (via a Tauri
 * event or channel). This module provides a pure, testable accumulator that
 * reconstructs the full response from the incremental delta tokens, tracks
 * completion, and surfaces an error if the stream aborts mid-way.
 *
 * Decoupled from the Tauri event layer so the assembly logic is unit-testable
 * without a live SSE connection.
 */

/** One incremental token from the SSE stream (delta.content, per F14). */
export interface SseDelta {
  /** The incremental text token (may be empty for keep-alive). */
  delta: string;
  /** True when the stream signals completion (the final chunk). */
  done: boolean;
}

/** The accumulator's state after processing a batch of deltas. */
export interface StreamAccumulatorState {
  /** The full reconstructed text so far. */
  text: string;
  /** Whether the stream has signaled completion. */
  done: boolean;
  /** Total tokens received (non-empty deltas). */
  tokenCount: number;
  /** An error message if the stream aborted, or null. */
  error: string | null;
}

/**
 * Create a fresh SSE token accumulator. Call `push` for each arriving delta;
 * the state is mutated in place and also returned for convenience.
 *
 * Usage:
 *   const acc = createStreamAccumulator();
 *   for (const delta of deltas) acc.push(delta);
 *   if (acc.state.done) useResponse(acc.state.text);
 */
export function createStreamAccumulator(): {
  state: StreamAccumulatorState;
  push(delta: SseDelta): StreamAccumulatorState;
  abort(reason: string): StreamAccumulatorState;
} {
  const state: StreamAccumulatorState = {
    text: '',
    done: false,
    tokenCount: 0,
    error: null,
  };
  return {
    state,
    push(delta: SseDelta): StreamAccumulatorState {
      if (state.done || state.error) return state;
      if (delta.delta.length > 0) {
        state.text += delta.delta;
        state.tokenCount += 1;
      }
      if (delta.done) state.done = true;
      return state;
    },
    abort(reason: string): StreamAccumulatorState {
      if (state.done || state.error) return state;
      state.error = reason;
      return state;
    },
  };
}

/**
 * Process a complete batch of SSE deltas and return the final state. Convenience
 * for tests / one-shot assembly (the live stream uses `createStreamAccumulator`).
 */
export function assembleStream(deltas: readonly SseDelta[]): StreamAccumulatorState {
  const acc = createStreamAccumulator();
  for (const d of deltas) acc.push(d);
  return acc.state;
}
