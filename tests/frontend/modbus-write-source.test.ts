import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ModbusWriteSource,
  buildModbusReplayWriteTargets,
  hasPeriodicWritableRows,
  isPeriodicWritableFc,
  writeFcForRecord,
  writeSourceKey,
  writeSourceRecordKey,
  writeSourceRegisterKey,
} from '../../src/lib/modbus';
import type { ModbusRegister } from '../../src/types/index.ts';

function reg(
  patch: Partial<ModbusRegister> & Pick<ModbusRegister, 'id' | 'functionCode' | 'address'>,
): ModbusRegister {
  return {
    id: patch.id,
    name: patch.name ?? patch.id,
    slaveAddress: patch.slaveAddress ?? 1,
    functionCode: patch.functionCode,
    address: patch.address,
    quantity: patch.quantity ?? 1,
    type: patch.type ?? 'uint16',
    unit: patch.unit ?? '',
    waveformChannel: patch.waveformChannel ?? null,
    value: patch.value ?? null,
    values: patch.values ?? null,
    valueTs: patch.valueTs ?? null,
    periodicRead: patch.periodicRead ?? false,
    periodicWrite: patch.periodicWrite ?? true,
  };
}

test('write source keys map recorded read function codes to writable rows', () => {
  assert.equal(writeFcForRecord(0x03), 0x06);
  assert.equal(writeFcForRecord(0x01), 0x05);
  assert.equal(writeFcForRecord(0x10), 0x10);
  assert.equal(writeSourceKey(2, 0x06, 9), '2:6:9');
  assert.equal(writeSourceRecordKey({ slave: 2, fc: 0x03, addr: 9 }), '2:6:9');
  assert.equal(
    writeSourceRegisterKey(reg({ id: 'target', slaveAddress: 2, functionCode: 0x06, address: 9 })),
    '2:6:9',
  );
});

test('isPeriodicWritableFc accepts only Modbus write function codes', () => {
  assert.equal(isPeriodicWritableFc(0x05), true);
  assert.equal(isPeriodicWritableFc(0x06), true);
  assert.equal(isPeriodicWritableFc(0x10), true);
  assert.equal(isPeriodicWritableFc(0x03), false);
});

test('hasPeriodicWritableRows requires both periodic opt-in and a write function code', () => {
  assert.equal(hasPeriodicWritableRows([]), false);
  assert.equal(
    hasPeriodicWritableRows([
      reg({ id: 'read-row', functionCode: 0x03, address: 5, periodicWrite: true }),
      reg({ id: 'manual-write', functionCode: 0x06, address: 5, periodicWrite: false }),
    ]),
    false,
  );
  assert.equal(
    hasPeriodicWritableRows([
      reg({ id: 'periodic-write', functionCode: 0x06, address: 5, periodicWrite: true }),
    ]),
    true,
  );
});

test('buildModbusReplayWriteTargets reuses write-source key mapping without periodic opt-in', () => {
  const regs = [
    reg({ id: 'holding', functionCode: 0x06, address: 5, periodicWrite: false }),
    reg({ id: 'coil', slaveAddress: 2, functionCode: 0x05, address: 8, periodicWrite: false }),
    reg({ id: 'multi', functionCode: 0x10, address: 12, periodicWrite: false }),
    reg({ id: 'read-row', functionCode: 0x03, address: 5, periodicWrite: true }),
  ];

  const targets = buildModbusReplayWriteTargets(
    [
      { t: 3, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 },
      { t: 1, slave: 2, fc: 0x01, addr: 8, type: 'bool', value: 1 },
      { t: 2, slave: 1, fc: 0x10, addr: 12, type: 'uint16', value: 99 },
      { t: 4, slave: 1, fc: 0x04, addr: 5, type: 'uint16', value: 123 },
      { t: 5, slave: 1, fc: 0x03, addr: 99, type: 'uint16', value: 456 },
    ],
    regs,
  );

  assert.deepEqual(
    targets.map((target) => [target.ts, target.reg.id, target.value]),
    [
      [3, 'holding', 77],
      [1, 'coil', 1],
      [2, 'multi', 99],
    ],
  );
});

test('nextTargets advances each matched row cursor independently and wraps', () => {
  const source = new ModbusWriteSource();
  source.load(
    [
      { t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 },
      { t: 2, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 88 },
      { t: 3, slave: 2, fc: 0x01, addr: 8, type: 'bool', value: 1 },
      { t: 4, slave: 2, fc: 0x01, addr: 8, type: 'bool', value: 0 },
    ],
    'source.bbreg',
  );

  const regs = [
    reg({ id: 'holding', functionCode: 0x06, address: 5 }),
    reg({ id: 'coil', slaveAddress: 2, functionCode: 0x05, address: 8 }),
  ];

  assert.equal(source.getName(), 'source.bbreg');
  assert.equal(source.sequenceCount(), 2);
  assert.deepEqual(
    source.nextTargets(regs).map((target) => [target.reg.id, target.value]),
    [
      ['holding', 77],
      ['coil', 1],
    ],
  );
  assert.deepEqual(
    source.nextTargets(regs).map((target) => [target.reg.id, target.value]),
    [
      ['holding', 88],
      ['coil', 0],
    ],
  );
  assert.deepEqual(
    source.nextTargets(regs).map((target) => [target.reg.id, target.value]),
    [
      ['holding', 77],
      ['coil', 1],
    ],
  );
});

test('nextTargets skips rows without opt-in, writable FC, or matching source sequence', () => {
  const source = new ModbusWriteSource();
  source.load([{ t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 }], 'source.bbreg');

  assert.deepEqual(
    source
      .nextTargets([
        reg({ id: 'matched', functionCode: 0x06, address: 5 }),
        reg({ id: 'not-periodic', functionCode: 0x06, address: 5, periodicWrite: false }),
        reg({ id: 'read-row', functionCode: 0x03, address: 5 }),
        reg({ id: 'missing-sequence', functionCode: 0x06, address: 6 }),
      ])
      .map((target) => target.reg.id),
    ['matched'],
  );
});

test('clear and reload reset source name and cursors', () => {
  const source = new ModbusWriteSource();
  const regs = [reg({ id: 'holding', functionCode: 0x06, address: 5 })];

  source.load(
    [
      { t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 },
      { t: 2, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 88 },
    ],
    'first.bbreg',
  );
  assert.equal(source.nextTargets(regs)[0].value, 77);
  assert.equal(source.nextTargets(regs)[0].value, 88);

  source.clear();
  assert.equal(source.getName(), null);
  assert.deepEqual(source.nextTargets(regs), []);

  source.load([{ t: 3, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 99 }], 'second.bbreg');
  assert.equal(source.getName(), 'second.bbreg');
  assert.equal(source.nextTargets(regs)[0].value, 99);
});
