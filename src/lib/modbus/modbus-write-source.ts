import type { ModbusStreamRecord } from './modbus-stream';
import type { ModbusFunctionCode, ModbusRegister } from '@/types';

export interface ModbusWriteTarget {
  reg: ModbusRegister;
  value: number;
}

export interface ModbusReplayWriteTarget extends ModbusWriteTarget {
  ts: number;
}

/**
 * Periodic-write data source for loaded `.bbreg` streams.
 *
 * Records are grouped by the writable row they can drive. Each key has its own
 * cursor so rows with different source sequences advance independently.
 */
export class ModbusWriteSource {
  private sourceName: string | null = null;
  private sequences: Map<string, number[]> = new Map();
  private cursors: Map<string, number> = new Map();

  load(records: readonly ModbusStreamRecord[], name: string): void {
    this.clear();
    for (const rec of records) {
      const key = writeSourceRecordKey(rec);
      const seq = this.sequences.get(key);
      if (seq) seq.push(rec.value);
      else this.sequences.set(key, [rec.value]);
    }
    for (const key of this.sequences.keys()) this.cursors.set(key, 0);
    this.sourceName = name;
  }

  clear(): void {
    this.sourceName = null;
    this.sequences = new Map();
    this.cursors = new Map();
  }

  getName(): string | null {
    return this.sourceName;
  }

  sequenceCount(): number {
    return this.sequences.size;
  }

  nextTargets(registers: readonly ModbusRegister[]): ModbusWriteTarget[] {
    const targets: ModbusWriteTarget[] = [];
    for (const reg of registers) {
      if (!reg.periodicWrite || !isPeriodicWritableFc(reg.functionCode)) continue;

      const key = writeSourceRegisterKey(reg);
      const seq = this.sequences.get(key);
      if (!seq || seq.length === 0) continue;

      const cursor = this.cursors.get(key) ?? 0;
      const value = seq[cursor] ?? seq[0];
      this.cursors.set(key, (cursor + 1) % seq.length);
      targets.push({ reg, value });
    }
    return targets;
  }
}

export function buildModbusReplayWriteTargets(
  records: readonly ModbusStreamRecord[],
  registers: readonly ModbusRegister[],
): ModbusReplayWriteTarget[] {
  const byKey = new Map<string, ModbusRegister>();
  for (const reg of registers) {
    if (isPeriodicWritableFc(reg.functionCode)) {
      byKey.set(writeSourceRegisterKey(reg), reg);
    }
  }

  const targets: ModbusReplayWriteTarget[] = [];
  for (const rec of records) {
    const reg = byKey.get(writeSourceRecordKey(rec));
    if (!reg) continue;
    targets.push({ ts: rec.t, reg, value: rec.value });
  }
  return targets;
}

export function hasPeriodicWritableRows(registers: readonly ModbusRegister[]): boolean {
  return registers.some((reg) => reg.periodicWrite && isPeriodicWritableFc(reg.functionCode));
}

export function writeSourceRecordKey(
  rec: Pick<ModbusStreamRecord, 'slave' | 'fc' | 'addr'>,
): string {
  return writeSourceKey(rec.slave, writeFcForRecord(rec.fc), rec.addr);
}

export function writeSourceRegisterKey(
  reg: Pick<ModbusRegister, 'slaveAddress' | 'functionCode' | 'address'>,
): string {
  return writeSourceKey(reg.slaveAddress, reg.functionCode, reg.address);
}

export function writeSourceKey(slave: number, fc: number, addr: number): string {
  return `${slave}:${fc}:${addr}`;
}

export function writeFcForRecord(fc: number): number {
  if (fc === 0x03) return 0x06;
  if (fc === 0x01) return 0x05;
  return fc;
}

export function isPeriodicWritableFc(fc: ModbusFunctionCode): boolean {
  return fc === 0x05 || fc === 0x06 || fc === 0x10;
}
