import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameRequest,
  parseFrame,
  readRequest,
  scanResponse,
  writeSingleRegisterRequest,
  writeMultipleRegistersRequest,
  type ModbusTransport,
} from '../../src/lib/modbus-transport.ts';

function asString(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

test('frameRequest RTU prepends slave addr + appends CRC', () => {
  // PDU 03 00 00 00 02, slave 1 -> 01 03 00 00 00 02 c4 0b
  const pdu = new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x02]);
  assert.equal(asString(frameRequest('rtu', 1, pdu)), '01 03 00 00 00 02 c4 0b');
});

test('frameRequest PDU is passthrough (no addr, no CRC)', () => {
  const pdu = new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x02]);
  assert.equal(asString(frameRequest('pdu', 1, pdu)), '03 00 00 00 02');
});

test('readRequest RTU matches the canonical FC03 request', () => {
  assert.equal(asString(readRequest('rtu', 1, 0x03, 0, 2)), '01 03 00 00 00 02 c4 0b');
});

test('writeSingleRegisterRequest RTU matches FC06', () => {
  assert.equal(asString(writeSingleRegisterRequest('rtu', 1, 1, 3)), '01 06 00 01 00 03 98 0b');
});

test('writeMultipleRegistersRequest RTU matches FC10', () => {
  assert.equal(
    asString(writeMultipleRegistersRequest('rtu', 1, 1, [0x000a, 0x0102])),
    '01 10 00 01 00 02 04 00 0a 01 02 92 30',
  );
});

test('scanResponse RTU extracts one frame and returns the remainder', () => {
  // Two FC03 responses concatenated, plus a trailing partial byte.
  const a = new Uint8Array([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x07]);
  // FC03 read 1 reg = 0x0005 -> 01 03 02 00 05 + CRC(78 47)
  const b = new Uint8Array([0x01, 0x03, 0x02, 0x00, 0x05, 0x78, 0x47]);
  const partial = new Uint8Array([0xab]);
  const buf = new Uint8Array(a.length + b.length + partial.length);
  buf.set(a, 0);
  buf.set(b, a.length);
  buf.set(partial, a.length + b.length);

  const { frames, remainder } = scanResponse('rtu', buf);
  assert.equal(frames.length, 2);
  assert.equal(asString(frames[0]), asString(a));
  assert.equal(asString(frames[1]), asString(b));
  assert.equal(asString(remainder), 'ab');
});

test('scanResponse RTU holds a partial frame for the next call', () => {
  // A frame missing its last CRC byte should not yield a frame.
  const partial = new Uint8Array([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81]);
  const { frames, remainder } = scanResponse('rtu', partial);
  assert.equal(frames.length, 0);
  assert.equal(remainder.length, partial.length);
});

test('scanResponse PDU slices fixed-length frames when expectedLength is given', () => {
  // PDU transport: 2 fixed-length 5-byte frames, then a leftover byte.
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99]);
  const { frames, remainder } = scanResponse('pdu', buf, 5);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 5);
  assert.equal(remainder.length, 1);
  assert.equal(remainder[0], 99);
});

test('scanResponse PDU holds buffer when below expectedLength', () => {
  const buf = new Uint8Array([1, 2, 3]);
  const { frames, remainder } = scanResponse('pdu', buf, 5);
  assert.equal(frames.length, 0);
  assert.equal(remainder.length, 3);
});

test('parseFrame RTU decodes a read-regs response, PDU skips CRC', () => {
  const rtu = new Uint8Array([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x07]);
  const r = parseFrame('rtu', rtu);
  assert.equal(r?.kind, 'read-regs');
  // PDU transport: same bytes but no CRC; parseFrame should still decode it.
  const pdu = new Uint8Array([0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78]);
  const r2 = parseFrame('pdu', pdu);
  assert.equal(r2?.kind, 'read-regs');
});
