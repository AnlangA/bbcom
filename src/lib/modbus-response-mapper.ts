import { decodeValues, type ModbusResponse } from './modbus';
import {
  modbusDataValueCount,
  modbusReadRowCount,
  type ModbusReadBatch,
  type ModbusWriteBatch,
} from './modbus-batches';
import type { ModbusTransport } from './modbus-transport';

/** A decoded value ready to apply to a register row + feed the waveform. */
export interface ModbusSample {
  registerId: string;
  /** Waveform channel from the row, or null. */
  channel: number | null;
  value: number;
  ts: number;
}

export interface ModbusRegisterValueUpdate {
  id: string;
  value: number;
  values?: number[] | null;
  valueTs: number;
}

export interface MappedModbusReadResponse {
  valueUpdates: ModbusRegisterValueUpdate[];
  samples: ModbusSample[];
}

/**
 * Decode a read response into store-ready value updates and waveform samples.
 *
 * The caller owns transport-level validation and status reporting. This mapper
 * deliberately has no Pinia/Vue dependency, so read response behavior can be
 * covered as a pure data contract.
 */
export function mapModbusReadResponse(
  batch: ModbusReadBatch,
  response: ModbusResponse,
  ts: number,
): MappedModbusReadResponse {
  if (response.kind === 'read-bits') return mapReadBits(batch, response.bits, ts);
  if (response.kind === 'read-regs') return mapReadRegisters(batch, response.regs, ts);
  return { valueUpdates: [], samples: [] };
}

export function isExpectedModbusWriteAck(
  response: ModbusResponse | null,
  batch: ModbusWriteBatch,
  transport: ModbusTransport,
): boolean {
  if (response?.kind !== 'write-ack') return false;
  if (transport === 'rtu' && response.slave !== (batch.slave & 0xff)) return false;
  if (response.fc !== batch.fc || response.addr !== batch.start) return false;
  const expectedCount = batch.fc === 0x05 || batch.fc === 0x06 ? 1 : batch.count;
  return response.count === expectedCount;
}

function mapReadBits(batch: ModbusReadBatch, bits: boolean[], ts: number): MappedModbusReadResponse {
  const mapped = emptyMapping();
  for (const { reg, offset } of batch.rows) {
    const dataCount = modbusDataValueCount(reg);
    const values = bits.slice(offset, offset + dataCount).map((bit) => (bit ? 1 : 0));
    addValues(mapped, reg.id, reg.waveformChannel, values, ts);
  }
  return mapped;
}

function mapReadRegisters(
  batch: ModbusReadBatch,
  regs: number[],
  ts: number,
): MappedModbusReadResponse {
  const mapped = emptyMapping();
  for (const { reg, offset } of batch.rows) {
    const registerCount = modbusReadRowCount(reg);
    const dataCount = modbusDataValueCount(reg);
    const window = regs.slice(offset, offset + registerCount);
    const values = decodeValues(reg.type, window).slice(0, dataCount);
    addValues(mapped, reg.id, reg.waveformChannel, values, ts);
  }
  return mapped;
}

function addValues(
  mapped: MappedModbusReadResponse,
  registerId: string,
  channel: number | null,
  values: number[],
  ts: number,
): void {
  if (values.length === 0) return;
  const value = values[0];
  mapped.valueUpdates.push({
    id: registerId,
    value,
    values: values.length > 1 ? values : null,
    valueTs: ts,
  });
  if (channel !== null) {
    mapped.samples.push({ registerId, channel, value, ts });
  }
}

function emptyMapping(): MappedModbusReadResponse {
  return { valueUpdates: [], samples: [] };
}
