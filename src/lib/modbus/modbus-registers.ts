import type {
  ModbusFunctionCode,
  ModbusMasterConfig,
  ModbusRegister,
  ModbusValueType,
} from '@/types';
import {
  MODBUS_LIMITS,
  isBitFc,
  isReadFc,
  maxValueCountForRegisters,
  registerCountForValues,
  registerSpan,
} from './modbus-core';

export const DEFAULT_MODBUS_CONFIG: ModbusMasterConfig = {
  transport: 'rtu',
  enabled: false,
  pollIntervalMs: 1000,
  writeIntervalMs: 1000,
  timeoutMs: 500,
};

const MODBUS_VALUE_TYPES: ReadonlySet<ModbusValueType> = new Set([
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

const MODBUS_FUNCTION_CODES: ReadonlySet<ModbusFunctionCode> = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10,
]);

export function isModbusWriteFc(fc: number): fc is 0x05 | 0x06 | 0x10 {
  return fc === 0x05 || fc === 0x06 || fc === 0x10;
}

/** Validate a Modbus FC into the supported family, else default to read-holding (03). */
export function normalizeModbusFunctionCode(raw: unknown): ModbusFunctionCode {
  return MODBUS_FUNCTION_CODES.has(raw as ModbusFunctionCode) ? (raw as ModbusFunctionCode) : 0x03;
}

/** Validate a value-type string into the supported set, else default to uint16. */
export function normalizeModbusValueType(raw: unknown): ModbusValueType {
  return MODBUS_VALUE_TYPES.has(raw as ModbusValueType) ? (raw as ModbusValueType) : 'uint16';
}

export function normalizeModbusQuantity(
  raw: unknown,
  fc: ModbusFunctionCode,
  type: ModbusValueType,
): number {
  const min = 1;
  const max =
    fc === 0x01 || fc === 0x02
      ? MODBUS_LIMITS.readBits
      : fc === 0x03 || fc === 0x04
        ? maxValueCountForRegisters(type, MODBUS_LIMITS.readRegisters)
        : fc === 0x10
          ? maxValueCountForRegisters(type, MODBUS_LIMITS.writeRegisters)
          : min;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : min;
  return Math.max(min, Math.min(max, n));
}

export function normalizeModbusValues(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : null;
}

export function modbusTypeForFunctionCode(
  fc: ModbusFunctionCode,
  currentType: ModbusValueType,
): ModbusValueType {
  if (isBitFc(fc)) return 'bool';
  return currentType === 'bool' ? 'uint16' : currentType;
}

export function isModbusDataCountEditable(fc: ModbusFunctionCode): boolean {
  return fc === 0x03 || fc === 0x10;
}

export function modbusDataQuantityMax(fc: ModbusFunctionCode, type: ModbusValueType): number {
  if (fc === 0x03) return maxValueCountForRegisters(type, MODBUS_LIMITS.readRegisters);
  if (fc === 0x10) return maxValueCountForRegisters(type, MODBUS_LIMITS.writeRegisters);
  return 1;
}

export function normalizeModbusDataQuantity(
  raw: unknown,
  fc: ModbusFunctionCode,
  type: ModbusValueType,
): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.max(1, Math.min(modbusDataQuantityMax(fc, type), n));
}

export function modbusAddressStepFor(
  fc: ModbusFunctionCode,
  type: ModbusValueType,
  quantity: number,
): number {
  if (fc === 0x03 || fc === 0x10) return registerCountForValues(type, quantity);
  return isBitFc(fc) ? 1 : registerSpan(type);
}

export function parseModbusValueInput(raw: string): number[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  // Commas and semicolons are explicit delimiters, so leading, trailing, or
  // repeated delimiters represent an empty token and invalidate the complete
  // edit. Repeated whitespace remains a valid visual separator.
  if (/(^|[,;，；])\s*([,;，；]|$)/u.test(trimmed)) {
    throw new RangeError('Modbus value input contains an empty token');
  }

  const tokens = trimmed.split(/[\s,;，；]+/u);
  const values = new Array<number>(tokens.length);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = Number(tokens[index]);
    if (!Number.isFinite(value)) {
      throw new RangeError(`Invalid Modbus value token at position ${index + 1}`);
    }
    values[index] = value;
  }
  return values;
}

export function formatModbusNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function formatModbusRegisterValue(reg: Pick<ModbusRegister, 'value' | 'values'>): string {
  const values = Array.isArray(reg.values) && reg.values.length > 0 ? reg.values : null;
  if (values) return values.map(formatModbusNumber).join(' ');
  if (reg.value === null || !Number.isFinite(reg.value)) return '—';
  return formatModbusNumber(reg.value);
}

export function normalizeModbusRegister(raw: Partial<ModbusRegister>): ModbusRegister {
  const fc = normalizeModbusFunctionCode(raw.functionCode);
  const type = normalizeModbusValueType(raw.type);
  return {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    name: typeof raw.name === 'string' ? raw.name : 'Register',
    slaveAddress:
      typeof raw.slaveAddress === 'number' && Number.isFinite(raw.slaveAddress)
        ? Math.max(0, Math.min(247, Math.floor(raw.slaveAddress)))
        : 1,
    functionCode: fc,
    address:
      typeof raw.address === 'number' && Number.isFinite(raw.address)
        ? Math.max(0, Math.min(0xffff, Math.floor(raw.address)))
        : 0,
    quantity: normalizeModbusQuantity(raw.quantity, fc, type),
    type,
    unit: typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : undefined,
    waveformChannel:
      typeof raw.waveformChannel === 'number' &&
      Number.isInteger(raw.waveformChannel) &&
      raw.waveformChannel >= 0 &&
      raw.waveformChannel <= 7
        ? raw.waveformChannel
        : null,
    value: typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null,
    values: normalizeModbusValues(raw.values),
    valueTs: typeof raw.valueTs === 'number' && Number.isFinite(raw.valueTs) ? raw.valueTs : null,
    periodicRead: isReadFc(fc) ? raw.periodicRead !== false : false,
    periodicWrite: isModbusWriteFc(fc) ? raw.periodicWrite === true : false,
  };
}

/**
 * Hydrate the register table from storage or imported data. Runtime value fields
 * are preserved here so `.bbreg` snapshot import can carry values; persistence
 * uses `persistableModbusRegisters` to strip them before writing session state.
 */
export function normalizeModbusRegisters(raw: unknown): ModbusRegister[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((reg) => normalizeModbusRegister(reg as Partial<ModbusRegister>));
}

export function cloneModbusConfig(cfg: ModbusMasterConfig): ModbusMasterConfig {
  return {
    transport: cfg.transport === 'pdu' ? 'pdu' : 'rtu',
    enabled: cfg.enabled === true,
    pollIntervalMs: Math.max(100, Math.min(10_000, Math.floor(cfg.pollIntervalMs || 1000))),
    writeIntervalMs: Math.max(100, Math.min(10_000, Math.floor(cfg.writeIntervalMs || 1000))),
    timeoutMs: Math.max(50, Math.min(5_000, Math.floor(cfg.timeoutMs || 500))),
  };
}

export function normalizeModbusConfig(raw: unknown): ModbusMasterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MODBUS_CONFIG };
  const cfg = raw as Partial<ModbusMasterConfig>;
  return cloneModbusConfig({
    transport: cfg.transport === 'pdu' ? 'pdu' : 'rtu',
    enabled: cfg.enabled === true,
    pollIntervalMs:
      typeof cfg.pollIntervalMs === 'number' && Number.isFinite(cfg.pollIntervalMs)
        ? cfg.pollIntervalMs
        : 1000,
    writeIntervalMs:
      typeof cfg.writeIntervalMs === 'number' && Number.isFinite(cfg.writeIntervalMs)
        ? cfg.writeIntervalMs
        : 1000,
    timeoutMs:
      typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 500,
  });
}

/** Strip runtime-only values before persisting session snapshots. */
export function persistableModbusRegisters(regs: ModbusRegister[]): ModbusRegister[] {
  return regs.map((reg) => ({
    id: reg.id,
    name: reg.name,
    slaveAddress: reg.slaveAddress,
    functionCode: reg.functionCode,
    address: reg.address,
    quantity: normalizeModbusQuantity(reg.quantity, reg.functionCode, reg.type),
    type: reg.type,
    unit: reg.unit,
    waveformChannel: reg.waveformChannel,
    periodicRead: reg.periodicRead,
    periodicWrite: reg.periodicWrite,
    value: null,
    values: null,
    valueTs: null,
  }));
}
