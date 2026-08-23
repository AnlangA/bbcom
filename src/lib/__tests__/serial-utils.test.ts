import { test } from 'vitest';
import assert from 'node:assert/strict';
import { escapeSerialPath, isRealSerialPort, mergePortLists } from '@/lib/serial-utils.ts';

test('escapes dots and slashes to match the plugin event-name transformation', () => {
  // macOS / Linux style paths contain both '.' and '/' — both must be replaced
  // or the disconnect listener name won't match the emitted event.
  assert.equal(escapeSerialPath('/dev/cu.usbserial-1234'), '-dev-cu-usbserial-1234');
  assert.equal(escapeSerialPath('/dev/ttyUSB0'), '-dev-ttyUSB0');
});

test('leaves Windows-style port names unchanged', () => {
  assert.equal(escapeSerialPath('COM3'), 'COM3');
  assert.equal(escapeSerialPath('COM12'), 'COM12');
});

test('produces names matching the plugin read/disconnect channel format', () => {
  // The plugin builds event names as `plugin-serialplugin-<kind>-<escaped>`.
  // Only '.' and '/' are replaced; other characters (underscore) are preserved.
  const path = '/dev/cu.SLAB_USBtoUART';
  const escaped = escapeSerialPath(path);
  assert.equal(escaped, '-dev-cu-SLAB_USBtoUART');
  assert.ok(!escaped.includes('.') && !escaped.includes('/'));
});

test('isRealSerialPort hides Bluetooth/AirPods/Watch but keeps real devices', () => {
  // real serial devices pass
  assert.equal(isRealSerialPort('COM3'), true);
  assert.equal(isRealSerialPort('/dev/cu.usbserial-1234'), true);
  assert.equal(isRealSerialPort('/dev/ttyUSB0'), true);
  // non-serial / system ports are filtered out
  assert.equal(isRealSerialPort('/dev/cu.Bluetooth-Incoming-Port'), false);
  assert.equal(isRealSerialPort('/dev/cu.AirPods'), false);
  assert.equal(isRealSerialPort('/dev/cu.Watch'), false);
});

test('mergePortLists preserves existing order and appends new ports', () => {
  // existing ports still detected keep their order; unplugged ports drop; new ones append
  assert.deepEqual(mergePortLists(['COM1', 'COM2'], ['COM2', 'COM3']), ['COM2', 'COM3']);
  assert.deepEqual(mergePortLists([], ['COM1']), ['COM1']);
  assert.deepEqual(mergePortLists(['COM1'], []), []); // unplugged -> dropped
  // existing order wins even if detected order differs
  assert.deepEqual(mergePortLists(['COM1', 'COM2'], ['COM2', 'COM1']), ['COM1', 'COM2']);
});
