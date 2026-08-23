/**
 * Register data-stream format (`.bbreg`) — the shared on-disk contract between
 * the register table, the waveform plot, and file import/export.
 *
 * It is JSON Lines: one record per line. A record describes a single decoded
 * sample of a single register/coil at a point in time. The same schema serves
 * three flows:
 *  - **waveform live export**: the waveform's "save" button writes the current
 *    buffer as a stream (one record per sample per channel).
 *  - **waveform offline replay**: "load" parses a stream and pushes its values
 *    back into the plot.
 *  - **register-table snapshot**: "load .bbreg" reconstructs register rows from
 *    the latest record of each (slave, fc, addr) key.
 *
 * Tolerant on parse (like `waveform.parseSampleLine` tolerates log noise):
 * blank lines and records missing required fields are skipped, so a stream
 * interleaved with other log output still loads.
 *
 * Pure TS (no Vue/DOM) → unit-testable under the `node --test` runner.
 */

import { registerSpan } from './modbus-core';
import type { ModbusFunctionCode, ModbusRegister, ModbusValueType } from '@/types';

/** One decoded sample of one register. */
export interface ModbusStreamRecord {
  /** Epoch milliseconds. */
  t: number;
  /** Slave address (1..247). */
  slave: number;
  /** Function code (the family byte, e.g. 3). */
  fc: number;
  /** Starting register/coil address. */
  addr: number;
  /** Value encoding (matches the row's `type`). */
  type: ModbusValueType;
  /** Decoded numeric value (0/1 for coils). */
  value: number;
  /** Optional human-friendly name for the register. */
  name?: string;
  /** Optional waveform channel (0..7) this sample was plotted on. */
  ch?: number | null;
  /** Optional physical unit. */
  unit?: string;
}

const VALUE_TYPES: ReadonlySet<ModbusValueType> = new Set([
  'bool',
  'uint8',
  'int8',
  'uint16',
  'int16',
  'uint32-be',
  'int32-be',
  'float32-be',
  'uint32-le',
  'int32-le',
  'float32-le',
]);

const SUPPORTED_FUNCTION_CODES: ReadonlySet<ModbusFunctionCode> = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10,
]);

/** Encode a list of records as a `.bbreg` JSONL string. */
export function encodeStream(records: ModbusStreamRecord[]): string {
  const lines: string[] = [];
  for (const r of records) {
    // Order keys for stable, human-scannable files.
    const obj: Record<string, unknown> = {
      t: r.t,
      slave: r.slave,
      fc: r.fc,
      addr: r.addr,
      type: r.type,
      value: r.value,
    };
    if (r.name !== undefined) obj.name = r.name;
    if (r.ch !== undefined && r.ch !== null) obj.ch = r.ch;
    if (r.unit !== undefined) obj.unit = r.unit;
    lines.push(JSON.stringify(obj));
  }
  return lines.join('\n');
}

/**
 * Parse a `.bbreg` JSONL string into records. Tolerant of junk: lines that are
 * blank, not valid JSON, or missing required fields are skipped rather than
 * throwing — so a stream mixed with log output still loads its good records.
 */
export function parseStream(text: string): ModbusStreamRecord[] {
  const out: ModbusStreamRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // not JSON — skip
    }
    const rec = normalizeRecord(obj);
    if (rec) out.push(rec);
  }
  return out;
}

/** Validate a parsed JSON object into a ModbusStreamRecord, or null if invalid. */
function normalizeRecord(raw: unknown): ModbusStreamRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = typeof r.t === 'number' ? (r.t as number) : Number(r.t);
  const slave = typeof r.slave === 'number' ? (r.slave as number) : Number(r.slave);
  const fc = typeof r.fc === 'number' ? (r.fc as number) : Number(r.fc);
  const addr = typeof r.addr === 'number' ? (r.addr as number) : Number(r.addr);
  const value = typeof r.value === 'number' ? (r.value as number) : Number(r.value);
  const type = r.type;
  if (
    !Number.isFinite(t) ||
    !Number.isFinite(slave) ||
    !Number.isFinite(fc) ||
    !Number.isFinite(addr) ||
    !Number.isFinite(value)
  ) {
    return null;
  }
  if (
    t < 0 ||
    !Number.isInteger(slave) ||
    slave < 0 ||
    slave > 247 ||
    !Number.isInteger(fc) ||
    !SUPPORTED_FUNCTION_CODES.has(fc as ModbusFunctionCode) ||
    !Number.isInteger(addr) ||
    addr < 0 ||
    addr > 0xffff
  ) {
    return null;
  }
  if (typeof type !== 'string' || !VALUE_TYPES.has(type as ModbusValueType)) return null;
  const rec: ModbusStreamRecord = {
    t,
    slave,
    fc,
    addr,
    type: type as ModbusValueType,
    value,
  };
  if (typeof r.name === 'string') rec.name = r.name;
  if (typeof r.ch === 'number' && Number.isInteger(r.ch) && r.ch >= 0 && r.ch <= 7) {
    rec.ch = r.ch;
  } else if (r.ch === null) rec.ch = null;
  if (typeof r.unit === 'string') rec.unit = r.unit;
  return rec;
}

/**
 * Build a single-snapshot stream (one record per register) from the current
 * register table state. Used by the table's "save snapshot" action. Each row
 * with a non-null value emits one record.
 */
export function snapshotFromRegisters(regs: ModbusRegister[]): ModbusStreamRecord[] {
  const now = Date.now();
  const out: ModbusStreamRecord[] = [];
  for (const reg of regs) {
    const values =
      Array.isArray(reg.values) && reg.values.length > 0
        ? reg.values.filter((value) => Number.isFinite(value))
        : reg.value !== null && Number.isFinite(reg.value)
          ? [reg.value]
          : [];
    if (values.length === 0) continue;
    const span = registerSpan(reg.type);
    values.forEach((value, index) => {
      out.push({
        t: reg.valueTs ?? now,
        slave: reg.slaveAddress,
        fc: reg.functionCode,
        addr: reg.address + index * span,
        type: reg.type,
        value,
        name: index === 0 ? reg.name : `${reg.name}[${index}]`,
        ch: reg.waveformChannel,
        unit: reg.unit,
      });
    });
  }
  return out;
}

/**
 * Reduce a stream to register-row definitions, keeping the latest record per
 * (slave, fc, addr) key and preserving name/channel/unit when present. Used by
 * the table's "load .bbreg" action to reconstruct rows.
 */
export function recordsToRegisterDefs(records: ModbusStreamRecord[]): Omit<ModbusRegister, 'id'>[] {
  const latest = new Map<string, ModbusStreamRecord>();
  for (const rec of records) {
    const key = `${rec.slave}:${rec.fc}:${rec.addr}`;
    const prev = latest.get(key);
    if (!prev || rec.t >= prev.t) latest.set(key, rec);
  }
  const out: Omit<ModbusRegister, 'id'>[] = [];
  for (const rec of latest.values()) {
    out.push({
      name: rec.name ?? `s${rec.slave}.${rec.addr}`,
      slaveAddress: rec.slave,
      functionCode: rec.fc as ModbusFunctionCode,
      address: rec.addr,
      type: rec.type,
      unit: rec.unit,
      waveformChannel: rec.ch ?? null,
      // Stream records carry no periodic flags — default like new rows:
      // read-FC rows poll, write-FC rows don't auto-write.
      periodicRead: rec.fc === 0x01 || rec.fc === 0x02 || rec.fc === 0x03 || rec.fc === 0x04,
      periodicWrite: false,
      value: rec.value,
      valueTs: rec.t,
    });
  }
  // Stable order: by slave, then fc, then address — so reloads look consistent.
  out.sort(
    (a, b) =>
      a.slaveAddress - b.slaveAddress || a.functionCode - b.functionCode || a.address - b.address,
  );
  return out;
}
