import {
  MODBUS_LIMITS,
  encodeValues,
  isBitFc,
  isReadFc,
  maxValueCountForRegisters,
  registerCountForValues,
  type ReadFc,
} from './modbus-core';
import type { ModbusRegister } from '../../types';

/** A grouped, contiguous read request the master will emit in one transaction. */
export interface ModbusReadBatch {
  slave: number;
  fc: ReadFc;
  /** Starting address (coil or register). */
  start: number;
  /** Number of coils or 16-bit registers to read. */
  count: number;
  /** Rows covered by this batch, with each row's offset within the read window. */
  rows: Array<{ reg: ModbusRegister; offset: number }>;
}

/** A grouped, contiguous write request. */
export interface ModbusWriteBatch {
  slave: number;
  /** Coil batches use FC05/0F; register batches use FC06/10. */
  kind: 'coil' | 'register';
  /** Single FC variant only when the batch writes exactly one 1-bit/16-bit item. */
  fc: 0x05 | 0x06 | 0x0f | 0x10;
  start: number;
  /** Number of coils or 16-bit registers the request writes. */
  count: number;
  rows: ModbusRegister[];
}

/** Group read-enabled rows into contiguous read batches. */
export function buildModbusReadBatches(regs: ModbusRegister[]): ModbusReadBatch[] {
  const readable = regs
    .filter((r) => isReadFc(r.functionCode))
    .slice()
    .sort(
      (a, b) =>
        a.slaveAddress - b.slaveAddress || a.functionCode - b.functionCode || a.address - b.address,
    );
  const batches: ModbusReadBatch[] = [];
  for (const reg of readable) {
    const fc = reg.functionCode as ReadFc;
    const span = modbusReadRowCount(reg);
    const last = batches[batches.length - 1];
    if (
      last &&
      last.slave === reg.slaveAddress &&
      last.fc === fc &&
      last.start + last.count === reg.address
    ) {
      last.count += span;
      last.rows.push({ reg, offset: reg.address - last.start });
    } else {
      batches.push({
        slave: reg.slaveAddress,
        fc,
        start: reg.address,
        count: span,
        rows: [{ reg, offset: 0 }],
      });
    }
  }
  return batches.flatMap(splitReadBatch);
}

/** Group write-enabled rows into contiguous write batches. */
export function buildModbusWriteBatches(regs: ModbusRegister[]): ModbusWriteBatch[] {
  const writable = regs
    .filter((r) => r.functionCode === 0x05 || r.functionCode === 0x06 || r.functionCode === 0x10)
    .filter((r) => modbusWriteRowValues(r).length > 0)
    .filter((r) => r.functionCode !== 0x06 || writeRowSpan(r) === 1)
    .slice()
    .sort(
      (a, b) =>
        a.slaveAddress - b.slaveAddress ||
        writeKindRank(a) - writeKindRank(b) ||
        a.address - b.address ||
        a.functionCode - b.functionCode,
    );
  const batches: ModbusWriteBatch[] = [];
  for (const reg of writable) {
    const kind: ModbusWriteBatch['kind'] = reg.functionCode === 0x05 ? 'coil' : 'register';
    const span = writeRowSpan(reg);
    const max = kind === 'coil' ? MODBUS_LIMITS.writeBits : MODBUS_LIMITS.writeRegisters;
    const last = batches[batches.length - 1];
    if (
      last &&
      last.slave === reg.slaveAddress &&
      last.kind === kind &&
      canMergeWriteRows(last, reg) &&
      last.start + last.count === reg.address &&
      last.count + span <= max
    ) {
      last.rows.push(reg);
      last.count += span;
      last.fc = writeBatchFc(kind, last.count, reg.functionCode);
    } else {
      batches.push({
        slave: reg.slaveAddress,
        kind,
        fc: writeBatchFc(kind, span, reg.functionCode),
        start: reg.address,
        count: span,
        rows: [reg],
      });
    }
  }
  return batches;
}

/** Flatten a register write batch into the 16-bit words used by FC06/FC10. */
export function encodeModbusRegisterWriteValues(batch: ModbusWriteBatch): number[] {
  if (batch.kind !== 'register') return [];
  const out: number[] = [];
  for (const reg of batch.rows) {
    out.push(...encodeValues(reg.type, modbusWriteRowValues(reg)));
  }
  return out;
}

/** Flatten a coil write batch into booleans used by FC05/FC0F. */
export function encodeModbusCoilWriteValues(batch: ModbusWriteBatch): boolean[] {
  if (batch.kind !== 'coil') return [];
  return batch.rows.flatMap((reg) => modbusWriteRowValues(reg).map((value) => value !== 0));
}

/** Number of coils/register words a read row requests. */
export function modbusReadRowCount(reg: ModbusRegister): number {
  const max = isBitFc(reg.functionCode) ? MODBUS_LIMITS.readBits : MODBUS_LIMITS.readRegisters;
  const dataCount = modbusDataValueCount(reg);
  return isBitFc(reg.functionCode)
    ? dataCount
    : Math.min(max, registerCountForValues(reg.type, dataCount));
}

/** Number of typed data values represented by a row. */
export function modbusDataValueCount(reg: ModbusRegister): number {
  const max = isBitFc(reg.functionCode)
    ? MODBUS_LIMITS.readBits
    : reg.functionCode === 0x10
      ? maxValueCountForRegisters(reg.type, MODBUS_LIMITS.writeRegisters)
      : isReadFc(reg.functionCode)
        ? maxValueCountForRegisters(reg.type, MODBUS_LIMITS.readRegisters)
        : 1;
  return clampInt(reg.quantity, 1, max);
}

/** UI-level values a write row is ready to send. */
export function modbusWriteRowValues(reg: ModbusRegister): number[] {
  const count = modbusDataValueCount(reg);
  if (Array.isArray(reg.values)) {
    const values = reg.values.filter((value) => Number.isFinite(value));
    if (reg.functionCode === 0x10) return values.length >= count ? values.slice(0, count) : [];
    if (values.length > 0) return values.slice(0, count);
  }
  if (reg.functionCode === 0x10 && count > 1) return [];
  return reg.value !== null && Number.isFinite(reg.value) ? [reg.value] : [];
}

function splitReadBatch(batch: ModbusReadBatch): ModbusReadBatch[] {
  const max = isBitFc(batch.fc) ? MODBUS_LIMITS.readBits : MODBUS_LIMITS.readRegisters;
  if (batch.count <= max) return [batch];
  const out: ModbusReadBatch[] = [];
  let remaining = batch.rows;
  let cursor = batch.start;
  while (remaining.length > 0) {
    const sliceRows: ModbusReadBatch['rows'] = [];
    let used = 0;
    for (const row of remaining) {
      const span = modbusReadRowCount(row.reg);
      if (used + span > max) break;
      sliceRows.push({ reg: row.reg, offset: row.offset - (cursor - batch.start) });
      used += span;
    }
    out.push({ slave: batch.slave, fc: batch.fc, start: cursor, count: used, rows: sliceRows });
    cursor += used;
    remaining = remaining.slice(sliceRows.length);
  }
  return out;
}

function writeRowSpan(reg: ModbusRegister): number {
  const values = modbusWriteRowValues(reg);
  if (reg.functionCode === 0x05) return values.length;
  return encodeValues(reg.type, values).length;
}

function writeBatchFc(
  kind: ModbusWriteBatch['kind'],
  count: number,
  requestedFc: ModbusRegister['functionCode'],
): ModbusWriteBatch['fc'] {
  if (kind === 'coil') return count === 1 ? 0x05 : 0x0f;
  return requestedFc === 0x10 ? 0x10 : 0x06;
}

function writeKindRank(reg: ModbusRegister): number {
  return reg.functionCode === 0x05 ? 0 : 1;
}

function canMergeWriteRows(last: ModbusWriteBatch, reg: ModbusRegister): boolean {
  if (last.kind === 'coil') return reg.functionCode === 0x05;
  return last.fc === 0x10 && reg.functionCode === 0x10;
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, n));
}
