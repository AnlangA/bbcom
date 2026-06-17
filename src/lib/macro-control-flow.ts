/**
 * Conditional macro control-flow engine (T3.7).
 *
 * Extends the flat send+delay macro model with Tera-Term-TTL-style control
 * flow: `wait` (block until an RX pattern appears, with a timeout), `if`
 * (conditional branch on the last RX text), `goto`/`label` (jump), and a
 * per-run `timeout`. This closes the "scripted device bring-up" gap — e.g.
 * "send AT, wait for OK, if ERROR goto recovery, else send the firmware command".
 *
 * The interpreter is pure (no DOM/Vue deps) and step-indexed: it advances
 * through a flat step list, executing each step's effect through injected
 * side-effects (`send`, `delay`, `lastRxText`). A step counter cap prevents
 * infinite goto loops. Fully unit-testable.
 */

/** A condition evaluated against the last-received RX text. */
export interface IfCondition {
  /** Substring to search for in the decoded RX text (case-insensitive). */
  contains: string;
}

/** One step in a conditional macro. Discriminated by `type`. */
export type ControlStep =
  | { type: 'send'; data: string; isHex: boolean }
  | { type: 'delay'; ms: number }
  | { type: 'label'; name: string }
  | { type: 'goto'; target: string }
  | { type: 'wait'; pattern: string; timeoutMs: number; isHex: boolean }
  | { type: 'if'; condition: IfCondition; then: string; else?: string };

/** A named conditional macro — the extended counterpart to the simple `Macro`. */
export interface ControlFlowMacro {
  id: string;
  name: string;
  steps: ControlStep[];
  /** Maximum total step executions before the interpreter aborts (anti-loop). */
  maxSteps?: number;
}

export interface ControlFlowResult {
  /** Steps executed (each goto/label counts as a step). */
  stepsExecuted: number;
  /** Index where execution stopped (or steps.length if it ran to completion). */
  stoppedAt: number;
  /** True if a `wait` timed out without matching. */
  timedOut: boolean;
  /** True if the maxSteps guard fired. */
  hitStepLimit: boolean;
  /** A send failed at this step index (or null if none failed). */
  failedAt: number | null;
}

/** Default anti-loop ceiling (a macro that runs 10 000 steps is almost certainly
 *  an infinite goto loop). Overridable per-macro via `maxSteps`. */
export const DEFAULT_MAX_STEPS = 10_000;

/** Side-effects the interpreter needs from its host (all injectable for testing). */
export interface ControlFlowHost {
  /** Send a payload; resolve true on success. */
  send: (data: string, isHex: boolean) => Promise<boolean>;
  /** Delay for `ms` (cancellable by the host). Resolve to continue. */
  delay: (ms: number) => Promise<void>;
  /** Resolve the decoded RX text accumulated since the last call (for `if`/`wait`). */
  lastRxText: () => string;
  /** Subscribe to new RX bytes; the host calls `onBytes` when data arrives.
   *  Used by `wait` to detect a pattern without polling. Returns an unsubscribe. */
  onRxBytes: (onBytes: (text: string) => void) => () => void;
  /** Optional progress sink (step about to execute). */
  onStep?: (index: number, total: number) => void;
}

/** Does `text` contain `pattern` (case-insensitive substring)? */
export function matchesCondition(text: string, pattern: string): boolean {
  if (pattern.length === 0) return true;
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Run a conditional macro to completion (or timeout/limit/failure). The
 * interpreter is a simple step-indexed loop with a goto label map.
 *
 * `wait` blocks until the host reports RX bytes whose decoded text matches the
 * pattern, or until `timeoutMs` elapses (→ `timedOut: true`, execution stops).
 */
export async function runControlFlow(
  macro: ControlFlowMacro,
  host: ControlFlowHost,
): Promise<ControlFlowResult> {
  const steps = macro.steps;
  const maxSteps = macro.maxSteps ?? DEFAULT_MAX_STEPS;
  const labels = buildLabelMap(steps);
  let i = 0;
  let stepsExecuted = 0;
  let timedOut = false;
  let failedAt: number | null = null;

  while (i < steps.length) {
    if (stepsExecuted >= maxSteps) {
      return { stepsExecuted, stoppedAt: i, timedOut, hitStepLimit: true, failedAt };
    }
    stepsExecuted += 1;
    host.onStep?.(i, steps.length);
    const step = steps[i];

    switch (step.type) {
      case 'send': {
        const ok = await host.send(step.data, step.isHex);
        if (!ok) {
          failedAt = i;
          return { stepsExecuted, stoppedAt: i, timedOut, hitStepLimit: false, failedAt };
        }
        i += 1;
        break;
      }
      case 'delay': {
        await host.delay(step.ms);
        i += 1;
        break;
      }
      case 'label': {
        i += 1;
        break;
      }
      case 'goto': {
        const target = labels.get(step.target);
        if (target === undefined) {
          // Unknown label — stop to avoid a silent infinite loop.
          return { stepsExecuted, stoppedAt: i, timedOut, hitStepLimit: false, failedAt };
        }
        i = target;
        break;
      }
      case 'wait': {
        const matched = await waitForPattern(step.pattern, step.timeoutMs, host);
        if (!matched) {
          timedOut = true;
          return { stepsExecuted, stoppedAt: i, timedOut, hitStepLimit: false, failedAt };
        }
        i += 1;
        break;
      }
      case 'if': {
        const text = host.lastRxText();
        const taken = matchesCondition(text, step.condition.contains);
        const targetLabel = taken ? step.then : step.else;
        if (targetLabel) {
          const target = labels.get(targetLabel);
          if (target !== undefined) {
            i = target;
            break;
          }
        }
        // No label to jump to → continue to next step.
        i += 1;
        break;
      }
    }
  }

  return { stepsExecuted, stoppedAt: i, timedOut, hitStepLimit: false, failedAt };
}

/** Build a `label name → step index` map for goto/if resolution. */
function buildLabelMap(steps: ControlStep[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].type === 'label') {
      map.set((steps[i] as { name: string }).name, i);
    }
  }
  return map;
}

/**
 * Wait until the host reports RX bytes whose decoded text contains `pattern`,
 * or until `timeoutMs` elapses. Resolves true on match, false on timeout.
 * Checks the current RX text first (the pattern may have already arrived).
 */
function waitForPattern(
  pattern: string,
  timeoutMs: number,
  host: ControlFlowHost,
): Promise<boolean> {
  // Fast path: the pattern already arrived.
  if (matchesCondition(host.lastRxText(), pattern)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(result);
    };
    const unsub = host.onRxBytes((text) => {
      if (matchesCondition(text, pattern)) finish(true);
    });
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
  });
}
