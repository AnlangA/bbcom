export interface ModbusBackoffOptions {
  /** Number of consecutive failures before the delay starts increasing. */
  failureThreshold?: number;
  /** Multiplier applied once the threshold is reached. */
  multiplier?: number;
  /** Upper bound for the computed delay. */
  maxDelayMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Small deterministic backoff policy for Modbus periodic loops.
 *
 * A single transient miss keeps the normal cadence. Once the configured number
 * of consecutive failures is reached, the next loop delay grows exponentially
 * until a valid response resets the policy.
 */
export class ModbusBackoff {
  private consecutiveFailures = 0;
  private readonly failureThreshold: number;
  private readonly multiplier: number;
  private readonly maxDelayMs: number;

  constructor(options: ModbusBackoffOptions = {}) {
    this.failureThreshold = positiveInteger(options.failureThreshold, DEFAULT_FAILURE_THRESHOLD);
    this.multiplier = positiveNumber(options.multiplier, DEFAULT_MULTIPLIER);
    this.maxDelayMs = positiveInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  recordSuccess(): void {
    this.reset();
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  isBackingOff(): boolean {
    return this.consecutiveFailures >= this.failureThreshold;
  }

  delayFor(baseDelayMs: number): number {
    const baseDelay = positiveInteger(baseDelayMs, 1);
    if (!this.isBackingOff()) return baseDelay;

    const exponent = this.consecutiveFailures - this.failureThreshold + 1;
    const delay = Math.round(baseDelay * this.multiplier ** exponent);
    return Math.min(Math.max(baseDelay, this.maxDelayMs), Math.max(baseDelay, delay));
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}
