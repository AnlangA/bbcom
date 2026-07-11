import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  boundModbusVirtualItems,
  MODBUS_REGISTER_MAX_DOM_ROWS,
  MODBUS_REGISTER_OVERSCAN,
  MODBUS_REGISTER_ROW_HEIGHT,
} from '../../src/lib/modbus-virtual-list.ts';

test('Modbus register virtualization uses the fixed editor geometry and overscan contract', () => {
  assert.equal(MODBUS_REGISTER_ROW_HEIGHT, 32);
  assert.equal(MODBUS_REGISTER_OVERSCAN, 10);
  assert.equal(MODBUS_REGISTER_MAX_DOM_ROWS, 40);
});

test('Modbus register virtualization never exposes more than 40 row components', () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => ({ index }));
  const bounded = boundModbusVirtualItems(rows);

  assert.equal(bounded.length, 40);
  assert.deepEqual(
    bounded.map((row) => row.index),
    Array.from({ length: 40 }, (_, index) => index),
  );
});

test('Modbus register virtualization preserves a window already within the DOM budget', () => {
  const rows = Array.from({ length: 27 }, (_, index) => ({ index }));
  assert.equal(boundModbusVirtualItems(rows), rows);
});
