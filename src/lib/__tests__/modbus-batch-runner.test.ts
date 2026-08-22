import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runModbusReadBatches, runModbusWriteBatches } from '@/lib/modbus';
import type { ModbusReadBatch, ModbusWriteBatch } from '@/lib/modbus';
import type { ModbusFunctionCode, ModbusRegister, ModbusValueType } from '@/types/index.ts';

function reg(
  id: string,
  functionCode: ModbusFunctionCode,
  address: number,
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
    type: (patch.type as ModbusValueType | undefined) ?? 'uint16',
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

test('runModbusReadBatches builds requests, maps values, and reports exceptions', async () => {
  const valueReg = reg('temperature', 0x03, 5, null, { waveformChannel: 2 });
  const exceptionReg = reg('bad', 0x03, 9);
  const batches: ModbusReadBatch[] = [
    { slave: 1, fc: 0x03, start: 5, count: 1, rows: [{ reg: valueReg, offset: 0 }] },
    { slave: 1, fc: 0x03, start: 9, count: 1, rows: [{ reg: exceptionReg, offset: 0 }] },
  ];
  const calls: Array<[number, string, number | undefined, string | undefined, string | undefined]> =
    [];

  const result = await runModbusReadBatches({
    batches,
    transport: 'pdu',
    periodicScope: 'read',
    now: () => 1234,
    async transact(batch, wire, expectedLen, context) {
      calls.push([batch.start, hex(wire), expectedLen, context?.scope, context?.key]);
      if (batch.start === 9) return { kind: 'exception', slave: 1, fc: 0x83, code: 2 };
      return { kind: 'read-regs', slave: 1, fc: 0x03, regs: [42] };
    },
  });

  assert.deepEqual(calls, [
    [5, '03 00 05 00 01', 4, 'read', '1:3:5:1'],
    [9, '03 00 09 00 01', 4, 'read', '1:3:9:1'],
  ]);
  assert.deepEqual(result.valueUpdates, [
    { id: 'temperature', value: 42, values: null, valueTs: 1234 },
  ]);
  assert.deepEqual(result.samples, [
    { registerId: 'temperature', channel: 2, value: 42, ts: 1234 },
  ]);
  assert.deepEqual(result.statuses, [{ kind: 'exception', code: 2 }]);
  assert.equal(result.stopped, false);
});

test('runModbusReadBatches returns a stopped marker before starting the next batch', async () => {
  const firstReg = reg('first', 0x03, 1);
  const secondReg = reg('second', 0x03, 2);
  const batches: ModbusReadBatch[] = [
    { slave: 1, fc: 0x03, start: 1, count: 1, rows: [{ reg: firstReg, offset: 0 }] },
    { slave: 1, fc: 0x03, start: 2, count: 1, rows: [{ reg: secondReg, offset: 0 }] },
  ];
  let calls = 0;

  const result = await runModbusReadBatches({
    batches,
    transport: 'pdu',
    now: () => 10,
    shouldStop: () => calls > 0,
    async transact() {
      calls += 1;
      return { kind: 'read-regs', slave: 1, fc: 0x03, regs: [11] };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.valueUpdates, [{ id: 'first', value: 11, values: null, valueTs: 10 }]);
});

test('runModbusReadBatches skips cooled-down periodic batch keys', async () => {
  const skippedReg = reg('skipped', 0x03, 1);
  const sentReg = reg('sent', 0x03, 2);
  const batches: ModbusReadBatch[] = [
    { slave: 1, fc: 0x03, start: 1, count: 1, rows: [{ reg: skippedReg, offset: 0 }] },
    { slave: 1, fc: 0x03, start: 2, count: 1, rows: [{ reg: sentReg, offset: 0 }] },
  ];
  const sentStarts: number[] = [];

  const result = await runModbusReadBatches({
    batches,
    transport: 'pdu',
    periodicScope: 'read',
    now: () => 10,
    shouldSkipBatch: (_batch, context) => context.key === '1:3:1:1',
    async transact(batch) {
      sentStarts.push(batch.start);
      return { kind: 'read-regs', slave: 1, fc: 0x03, regs: [22] };
    },
  });

  assert.deepEqual(sentStarts, [2]);
  assert.deepEqual(result.valueUpdates, [{ id: 'sent', value: 22, values: null, valueTs: 10 }]);
  assert.equal(result.stopped, false);
});

test('runModbusWriteBatches counts sent rows, accepted acks, and exception events', async () => {
  const okBatch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 5,
    count: 1,
    rows: [reg('setpoint', 0x06, 5, 0x1234)],
  };
  const exceptionBatch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 6,
    count: 1,
    rows: [reg('bad-write', 0x06, 6, 0x5678)],
  };
  const calls: Array<[number, string, number | undefined, string | undefined, string | undefined]> =
    [];

  const result = await runModbusWriteBatches({
    batches: [okBatch, exceptionBatch],
    transport: 'pdu',
    periodicScope: 'write',
    async transact(batch, wire, expectedLen, context) {
      calls.push([batch.start, hex(wire), expectedLen, context?.scope, context?.key]);
      if (batch.start === 6) return { kind: 'exception', slave: 1, fc: 0x86, code: 3 };
      return { kind: 'write-ack', slave: 1, fc: 0x06, addr: 5, count: 1 };
    },
  });

  assert.deepEqual(calls, [
    [5, '06 00 05 12 34', 5, 'write', '1:register:6:5:1'],
    [6, '06 00 06 56 78', 5, 'write', '1:register:6:6:1'],
  ]);
  assert.deepEqual(result, {
    sent: 2,
    ok: 1,
    statuses: [{ kind: 'exception', code: 3 }],
    stopped: false,
  });
});

test('runModbusWriteBatches skips cooled-down periodic batch keys without counting them', async () => {
  const skippedBatch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 5,
    count: 1,
    rows: [reg('skipped', 0x06, 5, 1)],
  };
  const sentBatch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 6,
    count: 1,
    rows: [reg('sent', 0x06, 6, 2)],
  };
  const sentStarts: number[] = [];

  const result = await runModbusWriteBatches({
    batches: [skippedBatch, sentBatch],
    transport: 'pdu',
    periodicScope: 'write',
    shouldSkipBatch: (_batch, context) => context.key === '1:register:6:5:1',
    async transact(batch) {
      sentStarts.push(batch.start);
      return { kind: 'write-ack', slave: 1, fc: 0x06, addr: 6, count: 1 };
    },
  });

  assert.deepEqual(sentStarts, [6]);
  assert.deepEqual(result, { sent: 1, ok: 1, statuses: [], stopped: false });
});

test('runModbusWriteBatches preserves partial counts when stopped between batches', async () => {
  const firstBatch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 5,
    count: 1,
    rows: [reg('first', 0x06, 5, 1)],
  };
  const secondBatch: ModbusWriteBatch = {
    slave: 1,
    kind: 'register',
    fc: 0x06,
    start: 6,
    count: 1,
    rows: [reg('second', 0x06, 6, 2)],
  };
  let calls = 0;

  const result = await runModbusWriteBatches({
    batches: [firstBatch, secondBatch],
    transport: 'pdu',
    shouldStop: () => calls > 0,
    async transact() {
      calls += 1;
      return { kind: 'write-ack', slave: 1, fc: 0x06, addr: 5, count: 1 };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { sent: 1, ok: 1, statuses: [], stopped: true });
});
