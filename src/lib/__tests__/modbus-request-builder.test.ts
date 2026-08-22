import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildModbusReadWireRequest,
  buildModbusWriteWireRequest,
  expectedReadResponseLength,
  expectedWriteResponseLength,
} from '@/lib/modbus';
import { buildModbusWriteBatches, type ModbusReadBatch } from '@/lib/modbus';
import {
  readRequest,
  writeMultipleCoilsRequest,
  writeMultipleRegistersRequest,
  writeSingleRegisterRequest,
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
    quantity: 1,
    type,
    unit: '',
    waveformChannel: null,
    value,
    values: null,
    valueTs: value === null ? null : 1,
    periodicRead: true,
    periodicWrite: false,
    ...patch,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

test('builds RTU read wire requests without an explicit expected length', () => {
  const batch: ModbusReadBatch = {
    slave: 1,
    fc: 0x03,
    start: 10,
    count: 2,
    rows: [],
  };

  const request = buildModbusReadWireRequest('rtu', batch);

  assert.equal(hex(request.wire), hex(readRequest('rtu', 1, 0x03, 10, 2)));
  assert.equal(request.expectedLen, undefined);
});

test('builds PDU read wire requests with fixed normal response lengths', () => {
  const registerBatch: ModbusReadBatch = {
    slave: 1,
    fc: 0x03,
    start: 10,
    count: 2,
    rows: [],
  };
  const bitBatch: ModbusReadBatch = {
    slave: 1,
    fc: 0x01,
    start: 0,
    count: 9,
    rows: [],
  };

  assert.equal(hex(buildModbusReadWireRequest('pdu', registerBatch).wire), '03 00 0a 00 02');
  assert.equal(expectedReadResponseLength(registerBatch, 'pdu'), 6);
  assert.equal(expectedReadResponseLength(bitBatch, 'pdu'), 4);
});

test('builds FC06 register write requests and expected PDU ack length', () => {
  const [batch] = buildModbusWriteBatches([reg('setpoint', 0x06, 5, 'uint16', 0x1234)]);
  const request = buildModbusWriteWireRequest('rtu', batch);

  assert.equal(hex(request.wire), hex(writeSingleRegisterRequest('rtu', 1, 5, 0x1234)));
  assert.equal(request.expectedLen, undefined);
  assert.equal(expectedWriteResponseLength('pdu'), 5);
});

test('builds FC10 register write requests from encoded multi-register values', () => {
  const [batch] = buildModbusWriteBatches([reg('wide', 0x10, 7, 'uint32-be', 0x12345678)]);
  const request = buildModbusWriteWireRequest('pdu', batch);

  assert.equal(
    hex(request.wire),
    hex(writeMultipleRegistersRequest('pdu', 1, 7, [0x1234, 0x5678])),
  );
  assert.equal(request.expectedLen, 5);
});

test('builds FC0F coil write requests from numeric row values', () => {
  const batches = buildModbusWriteBatches([
    reg('coil-a', 0x05, 0, 'bool', 1),
    reg('coil-b', 0x05, 1, 'bool', 0),
    reg('coil-c', 0x05, 2, 'bool', 1),
  ]);
  assert.equal(batches.length, 1);

  const request = buildModbusWriteWireRequest('rtu', batches[0]);

  assert.equal(hex(request.wire), hex(writeMultipleCoilsRequest('rtu', 1, 0, [true, false, true])));
  assert.equal(request.expectedLen, undefined);
});
