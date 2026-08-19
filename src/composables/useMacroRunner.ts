import { ref } from 'vue';
import type { Macro } from '../types';

const MIN_DELAY_MS = 0;
const MAX_DELAY_MS = 3_600_000; // 1h, matches the cyclic-send ceiling

/** Clamp a user-entered inter-step delay to the allowed range. */
export function clampDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.floor(value)));
}

interface MacroRunnerOptions {
  /** Sends one payload; resolves true on success. Mirrors SessionView.handleSend. */
  send: (data: string, isHex: boolean) => Promise<boolean>;
  /** Optional sink for progress (index of the step about to send). */
  onStep?: (index: number, total: number) => void;
}

export interface MacroRunResult {
  completed: number;
  /** Index of the step that failed (or steps.length if all completed). */
  failedAt: number;
  aborted: boolean;
}

/**
 * Sequentially sends a macro's steps, waiting `step.delayMs` after each send.
 *
 * - Delegates each send to the caller's `send` (the session's write path), so
 *   writes flow through the existing single-flight serializer — no concurrent
 *   port writes even if a macro overlaps another sender.
 * - Stops on the first failed send (returns the failing index) so a broken
 *   step doesn't silently corrupt a scripted bring-up.
 * - Abortable: `abort()` cancels after the current in-flight send/delay.
 *   Cancellation rejects the pending delay but never interrupts a write already
 *   handed to the driver (that would corrupt the port).
 */
export function useMacroRunner({ send, onStep }: MacroRunnerOptions) {
  const running = ref(false);
  let aborted = false;
  let paused = false;
  let sendInFlight = false;
  const resumeWaiters = new Set<() => void>();
  const pauseWaiters = new Set<() => void>();
  // The pending delay's resolver: when abort() fires during an inter-step
  // delay, we clear the timer AND invoke this so the awaiting run() loop wakes
  // immediately (clearTimeout alone would leave the promise forever pending).
  let pendingDelayResolver: (() => void) | null = null;
  let pendingDelayTimer: ReturnType<typeof setTimeout> | null = null;

  function abort() {
    if (aborted) return;
    aborted = true;
    paused = false;
    resolveWaiters(resumeWaiters);
    if (pendingDelayTimer !== null) {
      clearTimeout(pendingDelayTimer);
      pendingDelayTimer = null;
    }
    if (pendingDelayResolver !== null) {
      const resolve = pendingDelayResolver;
      pendingDelayResolver = null;
      resolve();
    }
  }

  async function pause(signal?: AbortSignal): Promise<void> {
    paused = true;
    if (signal?.aborted) {
      paused = false;
      throw new Error('macro pause cancelled');
    }
    if (!sendInFlight) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        pauseWaiters.delete(onIdle);
        paused = false;
        reject(new Error('macro pause cancelled'));
      };
      const onIdle = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pauseWaiters.add(onIdle);
    });
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    resolveWaiters(resumeWaiters);
  }

  function waitWhilePaused(): Promise<void> {
    if (!paused || aborted) return Promise.resolve();
    return new Promise<void>((resolve) => resumeWaiters.add(resolve));
  }

  function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0 || aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pendingDelayResolver = resolve;
      pendingDelayTimer = setTimeout(() => {
        pendingDelayTimer = null;
        pendingDelayResolver = null;
        resolve();
      }, ms);
    });
  }

  async function run(macro: Macro): Promise<MacroRunResult> {
    if (running.value) {
      return { completed: 0, failedAt: 0, aborted: true };
    }
    aborted = false;
    running.value = true;
    const steps = macro.steps;
    let i = 0;
    try {
      for (; i < steps.length; i += 1) {
        await waitWhilePaused();
        if (aborted) break;
        onStep?.(i, steps.length);
        const step = steps[i];
        sendInFlight = true;
        let ok: boolean;
        try {
          ok = await send(step.data, step.isHex);
        } finally {
          sendInFlight = false;
          resolveWaiters(pauseWaiters);
        }
        if (!ok) {
          return { completed: i, failedAt: i, aborted };
        }
        if (aborted) break;
        // Wait the inter-step gap, unless this is the last step.
        if (i < steps.length - 1) {
          await cancellableDelay(clampDelayMs(step.delayMs));
        }
      }
      return { completed: i, failedAt: steps.length, aborted };
    } finally {
      running.value = false;
    }
  }

  return { running, run, abort, pause, resume };
}

function resolveWaiters(waiters: Set<() => void>): void {
  const pending = Array.from(waiters);
  waiters.clear();
  for (const resolve of pending) resolve();
}
