import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildModbusReadBatches,
  buildModbusWriteBatches,
  encodeModbusRegisterWriteValues,
  modbusDataValueCount,
} from '@/lib/modbus';
import type { ModbusFunctionCode, ModbusRegister, ModbusValueType } from '@/types/index.ts';

function reg(
  id: string,
  functionCode: ModbusFunctionCode,
  address: number,
  type: ModbusValueType,
  value: number | null = null,
  patch: Partial<ModbusRegister> = {},
): ModbusRegister {
  return {
    id,
    name: id,
    slaveAddress: 1,
    functionCode,
    address,
    type,
    value,
    valueTs: value === null ? null : 1,
    waveformChannel: null,
    periodicRead: true,
    periodicWrite: false,
    ...patch,
  };
}

test('buildModbusReadBatches counts 32-bit rows as two registers', () => {
  const batches = buildModbusReadBatches([
    reg('a', 0x03, 0, 'float32-be'),
    reg('b', 0x03, 2, 'uint16'),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].start, 0);
  assert.equal(batches[0].count, 3);
  assert.deepEqual(
    batches[0].rows.map((row) => row.offset),
    [0, 2],
  );
});

test('buildModbusReadBatches groups consecutive FC03 rows without explicit quantity', () => {
  const batches = buildModbusReadBatches([
    reg('r20', 0x03, 20, 'uint16'),
    reg('r21', 0x03, 21, 'uint16'),
    reg('r22', 0x03, 22, 'uint16'),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].start, 20);
  assert.equal(batches[0].count, 3);
  assert.deepEqual(
    batches[0].rows.map((row) => row.offset),
    [0, 1, 2],
  );
});

test('buildModbusReadBatches converts FC03 data quantity to register count', () => {
  const batches = buildModbusReadBatches([
    reg('bytes', 0x03, 0, 'uint8', null, { quantity: 10 }),
    reg('wide', 0x03, 5, 'uint32-be', null, { quantity: 2 }),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].start, 0);
  assert.equal(batches[0].count, 9);
  assert.deepEqual(
    batches[0].rows.map((row) => row.offset),
    [0, 5],
  );
  assert.equal(modbusDataValueCount(batches[0].rows[0].reg), 10);
});

test('buildModbusReadBatches converts FC03 quantities for all value widths', () => {
  const cases: Array<[ModbusValueType, number, number]> = [
    ['uint8', 10, 5],
    ['int8', 10, 5],
    ['uint16', 10, 10],
    ['int16', 10, 10],
    ['uint32-be', 10, 20],
    ['int32-le', 10, 20],
    ['float32-be', 10, 20],
  ];
  for (const [type, quantity, expectedRegisters] of cases) {
    const batches = buildModbusReadBatches([reg(type, 0x03, 0, type, null, { quantity })]);
    assert.equal(batches.length, 1, type);
    assert.equal(batches[0].count, expectedRegisters, type);
  }
});

test('buildModbusWriteBatches uses FC10 for one FC10 32-bit register row', () => {
  const batches = buildModbusWriteBatches([reg('setpoint', 0x10, 10, 'uint32-be', 0x12345678)]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[0].start, 10);
  assert.equal(batches[0].count, 2);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [0x1234, 0x5678]);
});

test('buildModbusWriteBatches sends explicit FC10 row value lists', () => {
  const batches = buildModbusWriteBatches([
    reg('multi', 0x10, 30, 'uint16', null, { quantity: 3, values: [1, 2, 3] }),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[0].start, 30);
  assert.equal(batches[0].count, 3);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [1, 2, 3]);
});

test('buildModbusWriteBatches packs FC10 uint8 data quantity into register count', () => {
  const batches = buildModbusWriteBatches([
    reg('bytes', 0x10, 30, 'uint8', null, {
      quantity: 5,
      values: [0x11, 0x22, 0x33, 0x44, 0x55],
    }),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[0].count, 3);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [0x1122, 0x3344, 0x5500]);
});

test('buildModbusWriteBatches packs FC10 int8 data quantity into register count', () => {
  const batches = buildModbusWriteBatches([
    reg('bytes', 0x10, 30, 'int8', null, {
      quantity: 3,
      values: [-1, -128, 127],
    }),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 2);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [0xff80, 0x7f00]);
});

test('buildModbusWriteBatches packs FC10 multi-values for 16/32-bit formats', () => {
  const batches = buildModbusWriteBatches([
    reg('i16', 0x10, 0, 'int16', null, { quantity: 2, values: [-1, -2] }),
    reg('u32', 0x10, 2, 'uint32-be', null, { quantity: 2, values: [0x12345678, 0x00010002] }),
    reg('f32', 0x10, 6, 'float32-le', null, { quantity: 2, values: [1, 2] }),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 10);
  assert.deepEqual(
    encodeModbusRegisterWriteValues(batches[0]),
    [0xffff, 0xfffe, 0x1234, 0x5678, 0x0001, 0x0002, 0x0000, 0x3f80, 0x0000, 0x4000],
  );
});

test('buildModbusWriteBatches waits for enough FC10 values to satisfy quantity', () => {
  const batches = buildModbusWriteBatches([
    reg('bytes', 0x10, 30, 'uint8', null, { quantity: 5, values: [0x11, 0x22] }),
  ]);
  assert.equal(batches.length, 0);
});

test('encodeModbusRegisterWriteValues preserves little-endian register order', () => {
  const batches = buildModbusWriteBatches([reg('setpoint', 0x10, 10, 'uint32-le', 0x12345678)]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fc, 0x10);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [0x5678, 0x1234]);
});

test('buildModbusWriteBatches keeps consecutive FC06 register rows as single writes', () => {
  const batches = buildModbusWriteBatches([
    reg('a', 0x06, 0, 'uint16', 1),
    reg('b', 0x06, 1, 'uint16', 2),
  ]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].fc, 0x06);
  assert.equal(batches[0].count, 1);
  assert.equal(batches[1].fc, 0x06);
  assert.equal(batches[1].count, 1);
});

test('buildModbusWriteBatches does not upgrade FC06 multi-word rows to FC10', () => {
  const batches = buildModbusWriteBatches([reg('wide', 0x06, 0, 'uint32-be', 0x12345678)]);
  assert.equal(batches.length, 0);
});

test('buildModbusWriteBatches merges contiguous FC10 register rows by register span', () => {
  const batches = buildModbusWriteBatches([
    reg('wide', 0x10, 0, 'int32-be', -1),
    reg('next', 0x10, 2, 'int16', -2),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[0].count, 3);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [0xffff, 0xffff, 0xfffe]);
});

test('buildModbusWriteBatches merges contiguous coil rows into FC0F', () => {
  const batches = buildModbusWriteBatches([
    reg('coil-a', 0x05, 7, 'bool', 1),
    reg('coil-b', 0x05, 8, 'bool', 0),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'coil');
  assert.equal(batches[0].fc, 0x0f);
  assert.equal(batches[0].count, 2);
});

test('buildModbusWriteBatches splits FC10 batches at the Modbus 123-register limit', () => {
  const rows = Array.from({ length: 124 }, (_, i) => reg(`r${i}`, 0x10, i, 'uint16', i));
  const batches = buildModbusWriteBatches(rows);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].count, 123);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[1].start, 123);
  assert.equal(batches[1].count, 1);
  assert.equal(batches[1].fc, 0x10);
});
