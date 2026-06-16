import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModbusReadBatches,
  buildModbusWriteBatches,
  encodeModbusRegisterWriteValues,
} from '../../src/lib/modbus-batches.ts';
import type { ModbusFunctionCode, ModbusRegister, ModbusValueType } from '../../src/types/index.ts';

function reg(
  id: string,
  functionCode: ModbusFunctionCode,
  address: number,
  type: ModbusValueType,
  value: number | null = null,
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

test('buildModbusWriteBatches uses FC10 for one 32-bit register row', () => {
  const batches = buildModbusWriteBatches([reg('setpoint', 0x06, 10, 'uint32-be', 0x12345678)]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[0].start, 10);
  assert.equal(batches[0].count, 2);
  assert.deepEqual(encodeModbusRegisterWriteValues(batches[0]), [0x1234, 0x5678]);
});

test('buildModbusWriteBatches merges contiguous register rows by register span', () => {
  const batches = buildModbusWriteBatches([
    reg('wide', 0x06, 0, 'int32-be', -1),
    reg('next', 0x06, 2, 'int16', -2),
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
  const rows = Array.from({ length: 124 }, (_, i) => reg(`r${i}`, 0x06, i, 'uint16', i));
  const batches = buildModbusWriteBatches(rows);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].count, 123);
  assert.equal(batches[0].fc, 0x10);
  assert.equal(batches[1].start, 123);
  assert.equal(batches[1].count, 1);
  assert.equal(batches[1].fc, 0x06);
});
