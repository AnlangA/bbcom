import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeStream,
  parseStream,
  recordsToRegisterDefs,
  snapshotFromRegisters,
  type ModbusStreamRecord,
} from '../../src/lib/modbus-stream.ts';
import type { ModbusRegister } from '../../src/types/index.ts';

const sample: ModbusStreamRecord = {
  t: 1700000000000,
  slave: 1,
  fc: 3,
  addr: 100,
  type: 'uint16',
  value: 42,
  name: 'Temperature',
  ch: 0,
  unit: '°C',
};

test('encodeStream emits one JSON line per record with stable key order', () => {
  const out = encodeStream([sample]);
  const line = out.split('\n')[0];
  // Keys appear in the documented order.
  assert.ok(line.startsWith('{"t":'));
  assert.ok(line.includes('"slave":1'));
  assert.ok(line.includes('"fc":3'));
  assert.ok(line.includes('"addr":100'));
  assert.ok(line.includes('"type":"uint16"'));
  assert.ok(line.includes('"value":42'));
  assert.ok(line.includes('"name":"Temperature"'));
  assert.ok(line.includes('"ch":0'));
});

test('encodeStream omits ch when null/undefined', () => {
  const out = encodeStream([{ ...sample, ch: null }]);
  assert.ok(!out.includes('"ch"'));
  const out2 = encodeStream([{ ...sample, ch: undefined }]);
  assert.ok(!out2.includes('"ch"'));
});

test('parseStream round-trips an encoded stream', () => {
  const encoded = encodeStream([sample, { ...sample, addr: 101, value: 7 }]);
  const parsed = parseStream(encoded);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], sample);
  assert.equal(parsed[1].value, 7);
});

test('parseStream accepts little-endian 32-bit value types', () => {
  const parsed = parseStream(
    [
      '{"t":1,"slave":1,"fc":3,"addr":10,"type":"uint32-le","value":305419896}',
      '{"t":2,"slave":1,"fc":3,"addr":12,"type":"int32-le","value":-2}',
      '{"t":3,"slave":1,"fc":3,"addr":14,"type":"float32-le","value":1}',
    ].join('\n'),
  );
  assert.deepEqual(
    parsed.map((r) => r.type),
    ['uint32-le', 'int32-le', 'float32-le'],
  );
});

test('parseStream skips blank and junk lines without throwing', () => {
  const text = [
    encodeStream([sample]),
    '',
    '   ',
    'not json at all',
    '{"t":"bad","slave":1,"fc":3,"addr":1,"type":"uint16","value":1}',
    '{"t":1,"slave":1,"fc":3,"addr":1,"type":"bogus","value":1}',
    '{"t":1,"slave":1,"fc":3,"addr":1,"type":"uint16","value":9}',
  ].join('\n');
  const parsed = parseStream(text);
  assert.equal(parsed.length, 2); // sample + the last good record
  assert.equal(parsed[1].value, 9);
});

test('parseStream rejects out-of-range Modbus identity fields', () => {
  const lines = [
    '{"t":1,"slave":248,"fc":3,"addr":1,"type":"uint16","value":1}',
    '{"t":1,"slave":1.5,"fc":3,"addr":1,"type":"uint16","value":1}',
    '{"t":1,"slave":1,"fc":15,"addr":1,"type":"uint16","value":1}',
    '{"t":1,"slave":1,"fc":3.5,"addr":1,"type":"uint16","value":1}',
    '{"t":1,"slave":1,"fc":3,"addr":65536,"type":"uint16","value":1}',
    '{"t":1,"slave":1,"fc":3,"addr":1.5,"type":"uint16","value":1}',
    '{"t":-1,"slave":1,"fc":3,"addr":1,"type":"uint16","value":1}',
    '{"t":1,"slave":0,"fc":16,"addr":65535,"type":"uint16","value":7}',
  ];
  const parsed = parseStream(lines.join('\n'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].slave, 0);
  assert.equal(parsed[0].fc, 16);
  assert.equal(parsed[0].addr, 65535);
});

test('parseStream keeps only valid waveform channels', () => {
  const parsed = parseStream(
    [
      '{"t":1,"slave":1,"fc":3,"addr":1,"type":"uint16","value":1,"ch":7}',
      '{"t":1,"slave":1,"fc":3,"addr":2,"type":"uint16","value":2,"ch":8}',
      '{"t":1,"slave":1,"fc":3,"addr":3,"type":"uint16","value":3,"ch":1.5}',
      '{"t":1,"slave":1,"fc":3,"addr":4,"type":"uint16","value":4,"ch":null}',
    ].join('\n'),
  );
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].ch, 7);
  assert.equal(parsed[1].ch, undefined);
  assert.equal(parsed[2].ch, undefined);
  assert.equal(parsed[3].ch, null);
});

test('snapshotFromRegisters emits one record per valued row', () => {
  const regs: ModbusRegister[] = [
    {
      id: 'a',
      name: 'Temp',
      slaveAddress: 1,
      functionCode: 0x03,
      address: 100,
      type: 'uint16',
      unit: '°C',
      waveformChannel: 0,
      value: 23,
      valueTs: 1000,
    },
    {
      id: 'b',
      name: 'Humidity',
      slaveAddress: 1,
      functionCode: 0x03,
      address: 101,
      type: 'uint16',
      waveformChannel: null,
      value: null,
      valueTs: null,
    },
  ];
  const snap = snapshotFromRegisters(regs);
  assert.equal(snap.length, 1); // the null-value row is skipped
  assert.equal(snap[0].value, 23);
  assert.equal(snap[0].name, 'Temp');
});

test('recordsToRegisterDefs keeps latest value per (slave,fc,addr) and sorts', () => {
  const records: ModbusStreamRecord[] = [
    { t: 1, slave: 1, fc: 3, addr: 100, type: 'uint16', value: 1 },
    { t: 5, slave: 1, fc: 3, addr: 100, type: 'uint16', value: 5 }, // newer, same key
    { t: 2, slave: 1, fc: 3, addr: 99, type: 'uint16', value: 9 },
  ];
  const defs = recordsToRegisterDefs(records);
  assert.equal(defs.length, 2);
  assert.equal(defs[0].address, 99, 'sorted ascending by address');
  assert.equal(defs[1].address, 100);
  assert.equal(defs[1].value, 5, 'latest value wins');
});

test('recordsToRegisterDefs derives a default name and preserves channel/unit', () => {
  const defs = recordsToRegisterDefs([
    { t: 1, slave: 2, fc: 4, addr: 7, type: 'int16', value: -3, name: 'X', ch: 2, unit: 'A' },
  ]);
  assert.equal(defs[0].name, 'X');
  assert.equal(defs[0].waveformChannel, 2);
  assert.equal(defs[0].unit, 'A');
  assert.equal(defs[0].functionCode, 0x04);
  assert.equal(defs[0].value, -3);
});
