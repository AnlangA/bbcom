import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  cloneModbusConfig,
  formatModbusNumber,
  formatModbusRegisterValue,
  isModbusDataCountEditable,
  isModbusWriteFc,
  modbusAddressStepFor,
  modbusDataQuantityMax,
  modbusTypeForFunctionCode,
  normalizeModbusConfig,
  normalizeModbusDataQuantity,
  normalizeModbusQuantity,
  normalizeModbusRegister,
  normalizeModbusRegisters,
  parseModbusValueInput,
  persistableModbusRegisters,
} from '@/lib/modbus';
import type { ModbusRegister } from '@/types/index.ts';

test('normalizeModbusRegister clamps identity fields and preserves runtime values', () => {
  const reg = normalizeModbusRegister({
    id: 'r1',
    name: 'Bad',
    slaveAddress: 999,
    functionCode: 0x99,
    address: -5,
    quantity: 999,
    type: 'bogus',
    unit: '',
    waveformChannel: 99,
    value: 7,
    values: [1, '2', Number.NaN],
    valueTs: 12.5,
    periodicRead: false,
    periodicWrite: true,
  } as unknown as Partial<ModbusRegister>);

  assert.equal(reg.id, 'r1');
  assert.equal(reg.name, 'Bad');
  assert.equal(reg.slaveAddress, 247);
  assert.equal(reg.functionCode, 0x03);
  assert.equal(reg.address, 0);
  assert.equal(reg.quantity, 125);
  assert.equal(reg.type, 'uint16');
  assert.equal(reg.unit, undefined);
  assert.equal(reg.waveformChannel, null);
  assert.equal(reg.value, 7);
  assert.deepEqual(reg.values, [1, 2]);
  assert.equal(reg.valueTs, 12.5);
  assert.equal(reg.periodicRead, false);
  assert.equal(reg.periodicWrite, false);
});

test('normalizeModbusRegister derives safe periodic defaults from function code', () => {
  const read = normalizeModbusRegister({ id: 'read', functionCode: 0x04 });
  assert.equal(read.periodicRead, true);
  assert.equal(read.periodicWrite, false);

  const write = normalizeModbusRegister({
    id: 'write',
    functionCode: 0x10,
    periodicRead: true,
    periodicWrite: true,
  });
  assert.equal(write.periodicRead, false);
  assert.equal(write.periodicWrite, true);
});

test('normalizeModbusQuantity respects Modbus limits by FC and value width', () => {
  assert.equal(normalizeModbusQuantity(9999, 0x01, 'bool'), 2000);
  assert.equal(normalizeModbusQuantity(9999, 0x03, 'uint8'), 250);
  assert.equal(normalizeModbusQuantity(9999, 0x03, 'float32-be'), 62);
  assert.equal(normalizeModbusQuantity(9999, 0x10, 'float32-be'), 61);
  assert.equal(normalizeModbusQuantity(9999, 0x06, 'uint16'), 1);
});

test('register editor helpers derive FC-specific editability and value type', () => {
  assert.equal(isModbusWriteFc(0x05), true);
  assert.equal(isModbusWriteFc(0x06), true);
  assert.equal(isModbusWriteFc(0x10), true);
  assert.equal(isModbusWriteFc(0x03), false);

  assert.equal(isModbusDataCountEditable(0x03), true);
  assert.equal(isModbusDataCountEditable(0x10), true);
  assert.equal(isModbusDataCountEditable(0x04), false);

  assert.equal(modbusTypeForFunctionCode(0x01, 'float32-be'), 'bool');
  assert.equal(modbusTypeForFunctionCode(0x05, 'uint16'), 'bool');
  assert.equal(modbusTypeForFunctionCode(0x03, 'bool'), 'uint16');
  assert.equal(modbusTypeForFunctionCode(0x10, 'float32-le'), 'float32-le');
});

test('register editor helpers clamp editable data quantity and advance addresses', () => {
  assert.equal(modbusDataQuantityMax(0x03, 'uint8'), 250);
  assert.equal(modbusDataQuantityMax(0x10, 'float32-be'), 61);
  assert.equal(modbusDataQuantityMax(0x04, 'uint16'), 1);

  assert.equal(normalizeModbusDataQuantity(9999, 0x03, 'float32-be'), 62);
  assert.equal(normalizeModbusDataQuantity(0, 0x10, 'uint16'), 1);
  assert.equal(normalizeModbusDataQuantity(2.9, 0x10, 'uint16'), 2);
  assert.equal(normalizeModbusDataQuantity(12, 0x06, 'uint16'), 1);

  assert.equal(modbusAddressStepFor(0x03, 'uint8', 5), 3);
  assert.equal(modbusAddressStepFor(0x03, 'float32-be', 5), 10);
  assert.equal(modbusAddressStepFor(0x06, 'float32-be', 1), 2);
  assert.equal(modbusAddressStepFor(0x05, 'bool', 1), 1);
});

test('register editor helpers parse and format value input consistently', () => {
  assert.deepEqual(parseModbusValueInput('1, 2;3 4，5；6'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseModbusValueInput('   '), []);
  for (const invalid of ['1 bad 2', '1 NaN 2', '1 Infinity 2', '1,,2', ',1', '1;', '1, ,2']) {
    assert.throws(
      () => parseModbusValueInput(invalid),
      RangeError,
      `${invalid} must reject the entire value list`,
    );
  }

  assert.equal(formatModbusNumber(12), '12');
  assert.equal(formatModbusNumber(12.345), '12.3');
  assert.equal(formatModbusNumber(1.234), '1.23');
  assert.equal(formatModbusNumber(1234.56), '1235');
  assert.equal(formatModbusRegisterValue({ value: null, values: null }), '—');
  assert.equal(formatModbusRegisterValue({ value: Number.NaN, values: null }), '—');
  assert.equal(formatModbusRegisterValue({ value: 7, values: null }), '7');
  assert.equal(formatModbusRegisterValue({ value: 7, values: [1, 2.25, 1200.5] }), '1 2.25 1201');
});

test('normalizeModbusConfig and cloneModbusConfig clamp timing and transport', () => {
  assert.deepEqual(
    normalizeModbusConfig({
      transport: 'pdu',
      enabled: true,
      pollIntervalMs: 5,
      writeIntervalMs: 99_999,
      timeoutMs: 99_999,
    }),
    {
      transport: 'pdu',
      enabled: true,
      pollIntervalMs: 100,
      writeIntervalMs: 10_000,
      timeoutMs: 5_000,
    },
  );

  assert.deepEqual(
    cloneModbusConfig({
      transport: 'invalid',
      enabled: false,
      pollIntervalMs: Number.NaN,
      writeIntervalMs: 0,
      timeoutMs: 0,
    } as unknown as ReturnType<typeof normalizeModbusConfig>),
    {
      transport: 'rtu',
      enabled: false,
      pollIntervalMs: 1000,
      writeIntervalMs: 1000,
      timeoutMs: 500,
    },
  );
});

test('persistableModbusRegisters strips runtime values before session snapshots', () => {
  const reg = normalizeModbusRegister({
    id: 'r1',
    name: 'Setpoint',
    slaveAddress: 2,
    functionCode: 0x10,
    address: 10,
    quantity: 999,
    type: 'float32-be',
    unit: 'V',
    waveformChannel: 2,
    value: 12,
    values: [12, 13],
    valueTs: 123,
    periodicWrite: true,
  });

  const [persisted] = persistableModbusRegisters([reg]);
  assert.equal(persisted.quantity, 61);
  assert.equal(persisted.unit, 'V');
  assert.equal(persisted.waveformChannel, 2);
  assert.equal(persisted.periodicWrite, true);
  assert.equal(persisted.value, null);
  assert.equal(persisted.values, null);
  assert.equal(persisted.valueTs, null);
});

test('normalizeModbusRegisters drops non-object rows and normalizes the rest', () => {
  const regs = normalizeModbusRegisters([
    null,
    1,
    { id: 'ok', functionCode: 0x05, type: 'bool', value: 1, periodicWrite: true },
  ]);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].id, 'ok');
  assert.equal(regs[0].functionCode, 0x05);
  assert.equal(regs[0].type, 'bool');
  assert.equal(regs[0].periodicRead, false);
  assert.equal(regs[0].periodicWrite, true);
});
