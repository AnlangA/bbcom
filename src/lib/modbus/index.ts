/**
 * Modbus domain barrel.
 *
 * Aggregates the previously-flat `modbus-*.ts` modules into a single import
 * surface so callers can `import { ... } from '@/lib/modbus'` (or
 * `'.../lib/modbus'`) instead of reaching into individual files. This is pure
 * re-export — no logic, no new symbols — so the consolidation is a move +
 * re-export (AP-9).
 *
 * Domain grouping (informal):
 *   - core/PDU ....... modbus-core, modbus-batches, modbus-request-builder,
 *                      modbus-response-mapper, modbus-transport
 *   - registers ...... modbus-registers, modbus-stream
 *   - master/runtime . modbus-transaction-runner, modbus-backoff,
 *                      modbus-batch-runner, modbus-periodic-outcome,
 *                      modbus-loop-coordinator, modbus-replay-coordinator,
 *                      modbus-write-source
 */
export * from './modbus-core';
export * from './modbus-backoff';
export * from './modbus-batch-runner';
export * from './modbus-batches';
export * from './modbus-loop-coordinator';
export * from './modbus-periodic-outcome';
export * from './modbus-registers';
export * from './modbus-replay-coordinator';
export * from './modbus-request-builder';
export * from './modbus-response-mapper';
export * from './modbus-stream';
export * from './modbus-transaction-runner';
export * from './modbus-transport';
export * from './modbus-write-source';
