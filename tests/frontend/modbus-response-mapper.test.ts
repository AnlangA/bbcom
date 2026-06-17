import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExpectedModbusWriteAck,
  mapModbusReadResponse,
} from '../../src/lib/modbus';
import type { ModbusReadBatch, ModbusWriteBatch } from '../../src/lib/modbus';
import type { ModbusResponse } from '../../src/lib/modbus';
import type { ModbusFunctionCode, ModbusRegister, ModbusValueType } from '../../src/types/index.ts';

function reg(
  id: string,
  functionCode: ModbusFunctionCode,
  address: number,
  type: ModbusValueType,
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
    value: null,
    values: null,
    valueTs: null,
    periodicRead: true,
    periodicWrite: false,
    ...patch,
  };
}

test('maps register read responses into value updates and waveform samples', () => {
  const batch: ModbusReadBatch = {
    slave: 1,
    fc: 0x03,
    start: 10,
    count: 3,
    rows: [
      { reg: reg('single', 0x03, 10, 'uint16', { waveformChannel: 2 }), offset: 0 },
      { reg: reg('multi', 0x03, 11, 'uint16', { quantity: 2 }), offset: 1 },
    ],
  };

  const mapped = mapModbusReadResponse(
    batch,
    { kind: 'read-regs', slave: 1, fc: 0x03, regs: [10, 20, 21] },
    1234,
  );

  assert.deepEqual(mapped.valueUpdates, [
    { id: 'single', value: 10, values: null, valueTs: 1234 },
    { id: 'multi', value: 20, values: [20, 21], valueTs: 1234 },
  ]);
  assert.deepEqual(mapped.samples, [{ registerId: 'single', channel: 2, value: 10, ts: 1234 }]);
});

test('maps bit read responses into numeric values and multi-bit arrays', () => {
  const batch: ModbusReadBatch = {
    slave: 1,
    fc: 0x01,
    start: 0,
    count: 4,
    rows: [
      {
        reg: reg('bits', 0x01, 1, 'bool', { quantity: 3, waveformChannel: 0 }),
        offset: 1,
      },
    ],
  };

  const mapped = mapModbusReadResponse(
    batch,
    { kind: 'read-bits', slave: 1, fc: 0x01, bits: [true, false, true, false] },
    5678,
  );

  assert.deepEqual(mapped.valueUpdates, [
    { id: 'bits', value: 0, values: [0, 1, 0], valueTs: 5678 },
  ]);
  assert.deepEqual(mapped.samples, [{ registerId: 'bits', channel: 0, value: 0, ts: 5678 }]);
});

test('returns an empty mapping for non-read responses', () => {
  const batch: ModbusReadBatch = {
    slave: 1,
    fc: 0x03,
    start: 0,
    count: 1,
    rows: [{ reg: reg('row', 0x03, 0, 'uint16'), offset: 0 }],
  };

  const response: ModbusResponse = {
    kind: 'write-ack',
    slave: 1,
    fc: 0x06,
    addr: 0,
    count: 1,
  };

  assert.deepEqual(mapModbusReadResponse(batch, response, 1), { valueUpdates: [], samples: [] });
});

test('validates write acknowledgements against transport and batch shape', () => {
  const batch: ModbusWriteBatch = {
    slave: 3,
    kind: 'register',
    fc: 0x10,
    start: 5,
    count: 2,
    rows: [],
  };

  assert.equal(
    isExpectedModbusWriteAck(
      { kind: 'write-ack', slave: 3, fc: 0x10, addr: 5, count: 2 },
      batch,
      'rtu',
    ),
    true,
  );
  assert.equal(
    isExpectedModbusWriteAck(
      { kind: 'write-ack', slave: 4, fc: 0x10, addr: 5, count: 2 },
      batch,
      'rtu',
    ),
    false,
  );
  assert.equal(
    isExpectedModbusWriteAck(
      { kind: 'write-ack', slave: 4, fc: 0x10, addr: 5, count: 2 },
      batch,
      'pdu',
    ),
    true,
  );
  assert.equal(
    isExpectedModbusWriteAck(
      { kind: 'write-ack', slave: 3, fc: 0x10, addr: 6, count: 2 },
      batch,
      'rtu',
    ),
    false,
  );
});

test('single-write acknowledgement expects a count of one', () => {
  const batch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 9,
    count: 1,
    rows: [],
  };

  assert.equal(
    isExpectedModbusWriteAck(
      { kind: 'write-ack', slave: 1, fc: 0x06, addr: 9, count: 1 },
      batch,
      'rtu',
    ),
    true,
  );
  assert.equal(
    isExpectedModbusWriteAck(
      { kind: 'write-ack', slave: 1, fc: 0x06, addr: 9, count: 2 },
      batch,
      'rtu',
    ),
    false,
  );
});
