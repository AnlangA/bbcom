import type { ModbusResponse } from './modbus';
import type { ModbusReadBatch, ModbusWriteBatch } from './modbus-batches';
import {
  modbusPeriodicReadBatchKey,
  modbusPeriodicWriteBatchKey,
  type ModbusPeriodicScope,
} from './modbus-periodic-outcome';
import { buildModbusReadWireRequest, buildModbusWriteWireRequest } from './modbus-request-builder';
import {
  isExpectedModbusWriteAck,
  mapModbusReadResponse,
  type ModbusRegisterValueUpdate,
  type ModbusSample,
} from './modbus-response-mapper';
import type { ModbusTransport } from './modbus-transport';

export interface ModbusBatchStatusEvent {
  kind: 'exception';
  code: number;
}

export interface ModbusPeriodicBatchContext {
  scope: ModbusPeriodicScope;
  key: string;
}

export type ModbusBatchTransact<TBatch> = (
  batch: TBatch,
  wire: Uint8Array,
  expectedLen: number | undefined,
  periodicContext?: ModbusPeriodicBatchContext,
) => Promise<ModbusResponse | null>;

export interface RunModbusReadBatchesOptions {
  batches: readonly ModbusReadBatch[];
  transport: ModbusTransport;
  transact: ModbusBatchTransact<ModbusReadBatch>;
  now?: () => number;
  periodicScope?: ModbusPeriodicScope;
  shouldStop?: () => boolean;
  shouldSkipBatch?: (batch: ModbusReadBatch, context: ModbusPeriodicBatchContext) => boolean;
}

export interface RunModbusReadBatchesResult {
  valueUpdates: ModbusRegisterValueUpdate[];
  samples: ModbusSample[];
  statuses: ModbusBatchStatusEvent[];
  stopped: boolean;
}

export interface RunModbusWriteBatchesOptions {
  batches: readonly ModbusWriteBatch[];
  transport: ModbusTransport;
  transact: ModbusBatchTransact<ModbusWriteBatch>;
  periodicScope?: ModbusPeriodicScope;
  shouldStop?: () => boolean;
  shouldSkipBatch?: (batch: ModbusWriteBatch, context: ModbusPeriodicBatchContext) => boolean;
}

export interface RunModbusWriteBatchesResult {
  sent: number;
  ok: number;
  statuses: ModbusBatchStatusEvent[];
  stopped: boolean;
}

export async function runModbusReadBatches(
  options: RunModbusReadBatchesOptions,
): Promise<RunModbusReadBatchesResult> {
  const result: RunModbusReadBatchesResult = {
    valueUpdates: [],
    samples: [],
    statuses: [],
    stopped: false,
  };
  const ts = options.now?.() ?? Date.now();

  for (const batch of options.batches) {
    if (options.shouldStop?.()) {
      result.stopped = true;
      return result;
    }

    const context = periodicContextForReadBatch(options.periodicScope, batch);
    if (context && options.shouldSkipBatch?.(batch, context)) continue;

    const { wire, expectedLen } = buildModbusReadWireRequest(options.transport, batch);
    const response = await options.transact(batch, wire, expectedLen, context);
    if (!response) continue;
    if (response.kind === 'exception') {
      result.statuses.push({ kind: 'exception', code: response.code });
      continue;
    }

    const mapped = mapModbusReadResponse(batch, response, ts);
    result.valueUpdates.push(...mapped.valueUpdates);
    result.samples.push(...mapped.samples);
  }

  return result;
}

export async function runModbusWriteBatches(
  options: RunModbusWriteBatchesOptions,
): Promise<RunModbusWriteBatchesResult> {
  const result: RunModbusWriteBatchesResult = {
    sent: 0,
    ok: 0,
    statuses: [],
    stopped: false,
  };

  for (const batch of options.batches) {
    if (options.shouldStop?.()) {
      result.stopped = true;
      return result;
    }

    const context = periodicContextForWriteBatch(options.periodicScope, batch);
    if (context && options.shouldSkipBatch?.(batch, context)) continue;

    result.sent += batch.rows.length;
    const { wire, expectedLen } = buildModbusWriteWireRequest(options.transport, batch);
    const response = await options.transact(batch, wire, expectedLen, context);
    if (isExpectedModbusWriteAck(response, batch, options.transport)) {
      result.ok += batch.rows.length;
    } else if (response?.kind === 'exception') {
      result.statuses.push({ kind: 'exception', code: response.code });
    }
  }

  return result;
}

function periodicContextForReadBatch(
  scope: ModbusPeriodicScope | undefined,
  batch: ModbusReadBatch,
): ModbusPeriodicBatchContext | undefined {
  return scope ? { scope, key: modbusPeriodicReadBatchKey(batch) } : undefined;
}

function periodicContextForWriteBatch(
  scope: ModbusPeriodicScope | undefined,
  batch: ModbusWriteBatch,
): ModbusPeriodicBatchContext | undefined {
  return scope ? { scope, key: modbusPeriodicWriteBatchKey(batch) } : undefined;
}
