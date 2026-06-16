import { MODBUS_LIMITS, encodeValue, isBitFc, isReadFc, registerSpan, type ReadFc } from './modbus';
import type { ModbusRegister } from '../types';

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
    const span = isBitFc(fc) ? 1 : registerSpan(reg.type);
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
    .filter((r) => r.functionCode === 0x05 || r.functionCode === 0x06)
    .filter((r) => r.value !== null && Number.isFinite(r.value))
    .slice()
    .sort(
      (a, b) =>
        a.slaveAddress - b.slaveAddress || a.functionCode - b.functionCode || a.address - b.address,
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
      last.start + last.count === reg.address &&
      last.count + span <= max
    ) {
      last.rows.push(reg);
      last.count += span;
      last.fc = writeBatchFc(kind, last.count);
    } else {
      batches.push({
        slave: reg.slaveAddress,
        kind,
        fc: writeBatchFc(kind, span),
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
    out.push(...encodeValue(reg.type, reg.value ?? 0));
  }
  return out;
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
      const span = isBitFc(batch.fc) ? 1 : registerSpan(row.reg.type);
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
  return reg.functionCode === 0x05 ? 1 : registerSpan(reg.type);
}

function writeBatchFc(kind: ModbusWriteBatch['kind'], count: number): ModbusWriteBatch['fc'] {
  if (kind === 'coil') return count === 1 ? 0x05 : 0x0f;
  return count === 1 ? 0x06 : 0x10;
}
