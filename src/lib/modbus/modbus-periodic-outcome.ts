import type { ModbusResponse } from './modbus-core';
import { ModbusBackoff, type ModbusBackoffOptions } from './modbus-backoff';
import type { ModbusTransactionStatus } from './modbus-transaction-runner';

export type ModbusPeriodicScope = 'read' | 'write';

export interface ModbusTransactionOutcome {
  response: ModbusResponse | null;
  failure: ModbusTransactionStatus | null;
}

export interface ModbusPeriodicBackoffStatus {
  kind: 'backoff';
  scope: ModbusPeriodicScope;
  key: string;
  delayMs: number;
  consecutiveFailures: number;
}

export interface ModbusPeriodicOutcomeRecordOptions {
  baseDelayMs: number;
  trackFailure: boolean;
  now?: number;
}

export interface ModbusPeriodicOutcomeTrackerOptions {
  read?: ModbusBackoffOptions;
  write?: ModbusBackoffOptions;
}

interface ModbusPeriodicBackoffEntry {
  backoff: ModbusBackoff;
  nextAllowedAtMs: number;
}

/**
 * Owns periodic read/write outcome accounting.
 *
 * The composable decides whether a failure should be counted in the current
 * runtime state; this tracker owns the deterministic counters and resulting
 * backoff status shape.
 */
export class ModbusPeriodicOutcomeTracker {
  private readonly entries = new Map<string, ModbusPeriodicBackoffEntry>();
  private readonly options: ModbusPeriodicOutcomeTrackerOptions;

  constructor(options: ModbusPeriodicOutcomeTrackerOptions = {}) {
    this.options = options;
  }

  isCoolingDown(scope: ModbusPeriodicScope, key: string, now = Date.now()): boolean {
    const entry = this.entries.get(entryKey(scope, key));
    return entry ? entry.nextAllowedAtMs > now : false;
  }

  record(
    scope: ModbusPeriodicScope,
    key: string,
    outcome: ModbusTransactionOutcome,
    options: ModbusPeriodicOutcomeRecordOptions,
  ): ModbusPeriodicBackoffStatus | null {
    if (outcome.response) {
      this.resetKey(scope, key);
      return null;
    }
    if (!options.trackFailure || !isTrackablePeriodicFailure(outcome.failure)) return null;

    const entry = this.entryFor(scope, key);
    const { backoff } = entry;
    backoff.recordFailure();
    if (!backoff.isBackingOff()) return null;

    const delayMs = backoff.delayFor(options.baseDelayMs);
    entry.nextAllowedAtMs = (options.now ?? Date.now()) + delayMs;
    return {
      kind: 'backoff',
      scope,
      key,
      delayMs,
      consecutiveFailures: backoff.getConsecutiveFailures(),
    };
  }

  reset(): void {
    this.entries.clear();
  }

  resetKey(scope: ModbusPeriodicScope, key: string): void {
    this.entries.delete(entryKey(scope, key));
  }

  getConsecutiveFailures(scope: ModbusPeriodicScope, key: string): number {
    return this.entries.get(entryKey(scope, key))?.backoff.getConsecutiveFailures() ?? 0;
  }

  private entryFor(scope: ModbusPeriodicScope, key: string): ModbusPeriodicBackoffEntry {
    const id = entryKey(scope, key);
    const existing = this.entries.get(id);
    if (existing) return existing;

    const entry: ModbusPeriodicBackoffEntry = {
      backoff: new ModbusBackoff(scope === 'read' ? this.options.read : this.options.write),
      nextAllowedAtMs: 0,
    };
    this.entries.set(id, entry);
    return entry;
  }
}

export function modbusPeriodicReadBatchKey(batch: {
  slave: number;
  fc: number;
  start: number;
  count: number;
}): string {
  return `${batch.slave}:${batch.fc}:${batch.start}:${batch.count}`;
}

export function modbusPeriodicWriteBatchKey(batch: {
  slave: number;
  kind: string;
  fc: number;
  start: number;
  count: number;
}): string {
  return `${batch.slave}:${batch.kind}:${batch.fc}:${batch.start}:${batch.count}`;
}

export function isTrackablePeriodicFailure(
  failure: ModbusTransactionStatus | null,
): failure is ModbusTransactionStatus {
  return failure?.kind === 'timeout' || failure?.kind === 'error';
}

function entryKey(scope: ModbusPeriodicScope, key: string): string {
  return `${scope}:${key}`;
}
