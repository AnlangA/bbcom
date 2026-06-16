import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReadRequestPdu,
  buildWriteSingleCoilPdu,
  buildWriteSingleRegisterPdu,
  buildWriteMultipleCoilsPdu,
  buildWriteMultipleRegistersPdu,
  clampSlave,
  clampU16,
  crc16Modbus,
  decodeBit,
  decodeValue,
  decodeValues,
  encodeValue,
  encodeValues,
  isBitFc,
  isReadFc,
  maxValueCountForRegisters,
  MODBUS_LIMITS,
  parseResponse,
  registerCountForValues,
  registerSpan,
  verifyCrc,
} from '../../src/lib/modbus.ts';

function hex(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function asString(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function withCrc(...bytes: number[]): Uint8Array {
  const body = hex(...bytes);
  const crc = crc16Modbus(body);
  const out = new Uint8Array(body.length + 2);
  out.set(body, 0);
  out[body.length] = crc & 0xff;
  out[body.length + 1] = (crc >>> 8) & 0xff;
  return out;
}

test('crc16Modbus matches the standard vector 01 04 02 12 34 -> 0x47B4', () => {
  // Low byte first on the wire; full frame is ...12 34 B4 47.
  assert.equal(crc16Modbus(hex(0x01, 0x04, 0x02, 0x12, 0x34)), 0x47b4);
});

test('verifyCrc accepts a good frame and rejects a corrupted one', () => {
  assert.equal(verifyCrc(hex(0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x07)), true);
  assert.equal(verifyCrc(hex(0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x08)), false);
  assert.equal(verifyCrc(hex(0x01, 0x03)), false); // too short
});

test('buildReadRequestPdu lays out FC03 read-2-regs', () => {
  // fc 03, start 0, count 2 -> 03 00 00 00 02
  assert.equal(asString(buildReadRequestPdu(0x03, 0, 2)), '03 00 00 00 02');
});

test('buildWriteSingleCoilPdu encodes ON as FF 00 and OFF as 00 00', () => {
  // addr 172 = 0x00AC. ON: 05 00 ac ff 00 ; OFF: 05 00 ac 00 00
  assert.equal(asString(buildWriteSingleCoilPdu(0xac, true)), '05 00 ac ff 00');
  assert.equal(asString(buildWriteSingleCoilPdu(0xac, false)), '05 00 ac 00 00');
});

test('buildWriteSingleRegisterPdu lays out FC06 write', () => {
  // addr 1 value 3 -> 06 00 01 00 03
  assert.equal(asString(buildWriteSingleRegisterPdu(1, 3)), '06 00 01 00 03');
});

test('buildWriteMultipleCoilsPdu packs bits LSB-first and reports byte count', () => {
  // 3 coils at addr 1: ON,OFF,ON -> byte 0x05. PDU: 0f 00 01 00 03 01 05
  assert.equal(
    asString(buildWriteMultipleCoilsPdu(1, [true, false, true])),
    '0f 00 01 00 03 01 05',
  );
  // 9 coils fills 2 bytes; the 9th bit lands in byte[1] bit0.
  const pdu = buildWriteMultipleCoilsPdu(0, [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  assert.equal(pdu[5], 2, 'byte count');
  assert.equal(pdu[6], 0x00, 'first byte all-zero');
  assert.equal(pdu[7], 0x01, '9th coil in bit0 of second byte');
});

test('buildWriteMultipleRegistersPdu lays out FC10 write', () => {
  // addr 1, values 0x000A 0x0102 -> 10 00 01 00 02 04 00 0a 01 02
  assert.equal(
    asString(buildWriteMultipleRegistersPdu(1, [0x000a, 0x0102])),
    '10 00 01 00 02 04 00 0a 01 02',
  );
});

test('request builders reject invalid Modbus quantities', () => {
  assert.throws(() => buildReadRequestPdu(0x03, 0, 0), /count/);
  assert.throws(() => buildReadRequestPdu(0x03, 0, MODBUS_LIMITS.readRegisters + 1), /count/);
  assert.throws(() => buildWriteMultipleCoilsPdu(0, []), /count/);
  assert.throws(
    () =>
      buildWriteMultipleRegistersPdu(
        0,
        Array.from({ length: MODBUS_LIMITS.writeRegisters + 1 }, () => 0),
      ),
    /count/,
  );
  assert.throws(() => buildWriteSingleRegisterPdu(0, 0x10000), /value/);
});

test('parseResponse reads holding-register values (FC03)', () => {
  const frame = hex(0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x07);
  const r = parseResponse(true, frame);
  assert.equal(r?.kind, 'read-regs');
  if (r?.kind === 'read-regs') {
    assert.deepEqual(r.regs, [0x1234, 0x5678]);
    assert.equal(r.fc, 0x03);
  }
});

test('parseResponse reads coil bits LSB-first (FC01)', () => {
  // 3 coils, byte 0x05 -> bits [1,0,1]
  const frame = hex(0x01, 0x01, 0x01, 0x05, 0x91, 0x8b);
  const r = parseResponse(true, frame);
  assert.equal(r?.kind, 'read-bits');
  if (r?.kind === 'read-bits') {
    assert.deepEqual(r.bits.slice(0, 3), [true, false, true]);
  }
});

test('parseResponse reads write-ack echo for FC10', () => {
  const frame = hex(0x01, 0x10, 0x00, 0x01, 0x00, 0x02, 0x10, 0x08);
  const r = parseResponse(true, frame);
  assert.equal(r?.kind, 'write-ack');
  if (r?.kind === 'write-ack') {
    assert.equal(r.addr, 1);
    assert.equal(r.count, 2);
  }
});

test('parseResponse reports count=1 for FC06 single-write ack', () => {
  const frame = withCrc(0x01, 0x06, 0x00, 0x01, 0x12, 0x34);
  const r = parseResponse(true, frame);
  assert.equal(r?.kind, 'write-ack');
  if (r?.kind === 'write-ack') {
    assert.equal(r.addr, 1);
    assert.equal(r.count, 1);
  }
});

test('parseResponse can decode a raw PDU-only read response', () => {
  const r = parseResponse(false, hex(0x03, 0x04, 0x12, 0x34, 0x56, 0x78), {
    pduOnly: true,
    slave: 7,
  });
  assert.equal(r?.kind, 'read-regs');
  if (r?.kind === 'read-regs') {
    assert.equal(r.slave, 7);
    assert.deepEqual(r.regs, [0x1234, 0x5678]);
  }
});

test('parseResponse decodes an exception frame (fc | 0x80)', () => {
  // slave 1, fc 0x83, code 0x02, crc c0 f1
  const frame = hex(0x01, 0x83, 0x02, 0xc0, 0xf1);
  const r = parseResponse(true, frame);
  assert.equal(r?.kind, 'exception');
  if (r?.kind === 'exception') {
    assert.equal(r.code, 0x02);
  }
});

test('parseResponse returns null on bad CRC', () => {
  const frame = hex(0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78, 0x81, 0x08);
  assert.equal(parseResponse(true, frame), null);
});

test('decodeValue handles all register types', () => {
  assert.equal(decodeValue('uint8', [0x1234]), 0x12);
  assert.equal(decodeValue('int8', [0xff34]), -1);
  assert.equal(decodeValue('uint16', [0x1234]), 0x1234);
  assert.equal(decodeValue('int16', [0xffff]), -1);
  assert.equal(decodeValue('int16', [0x7fff]), 32767);
  assert.equal(decodeValue('uint32-be', [0x1234, 0x5678]), 0x12345678);
  assert.equal(decodeValue('int32-be', [0xffff, 0xffff]), -1);
  // 1.0f = 0x3F800000 -> hi 0x3F80 lo 0x0000
  assert.ok(Math.abs(decodeValue('float32-be', [0x3f80, 0x0000]) - 1.0) < 1e-6);
  assert.equal(decodeValue('uint32-le', [0x5678, 0x1234]), 0x12345678);
  assert.equal(decodeValue('int32-le', [0x0000, 0x8000]), -0x80000000);
  assert.ok(Math.abs(decodeValue('float32-le', [0x0000, 0x3f80]) - 1.0) < 1e-6);
  assert.equal(decodeValue('bool', [0]), 0);
  assert.equal(decodeValue('bool', [1]), 1);
});

test('decodeValues decodes register windows into typed value lists', () => {
  assert.deepEqual(decodeValues('uint8', [0x1234, 0x5678]), [0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(decodeValues('int8', [0xff80, 0x017f]), [-1, -128, 1, 127]);
  assert.deepEqual(decodeValues('uint16', [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(decodeValues('int16', [0xffff, 0x0001]), [-1, 1]);
  assert.deepEqual(
    decodeValues('uint32-le', [0x5678, 0x1234, 0x0002, 0x0001]),
    [0x12345678, 0x00010002],
  );
});

test('encodeValue maps typed values to register words', () => {
  assert.deepEqual(encodeValue('bool', 2), [1]);
  assert.deepEqual(encodeValue('uint8', 0x12), [0x1200]);
  assert.deepEqual(encodeValue('int8', -1), [0xff00]);
  assert.deepEqual(encodeValue('uint16', 0x1234), [0x1234]);
  assert.deepEqual(encodeValue('int16', -1), [0xffff]);
  assert.deepEqual(encodeValue('uint32-be', 0x12345678), [0x1234, 0x5678]);
  assert.deepEqual(encodeValue('int32-be', -1), [0xffff, 0xffff]);
  assert.deepEqual(encodeValue('float32-be', 1), [0x3f80, 0x0000]);
  assert.deepEqual(encodeValue('uint32-le', 0x12345678), [0x5678, 0x1234]);
  assert.deepEqual(encodeValue('int32-le', -2), [0xfffe, 0xffff]);
  assert.deepEqual(encodeValue('float32-le', 1), [0x0000, 0x3f80]);
});

test('encodeValues flattens typed value lists into register words', () => {
  assert.deepEqual(encodeValues('uint8', [0x12, 0x34, 0x56]), [0x1234, 0x5600]);
  assert.deepEqual(encodeValues('int8', [-1, -128, 1]), [0xff80, 0x0100]);
  assert.deepEqual(encodeValues('uint16', [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(
    encodeValues('uint32-be', [0x12345678, 0x00010002]),
    [0x1234, 0x5678, 0x0001, 0x0002],
  );
  assert.deepEqual(encodeValues('uint32-le', [0x12345678]), [0x5678, 0x1234]);
});

test('decodeBit maps boolean to 0/1', () => {
  assert.equal(decodeBit(false), 0);
  assert.equal(decodeBit(true), 1);
});

test('registerSpan reports 1 for 16-bit/bool and 2 for 32-bit types', () => {
  assert.equal(registerSpan('uint8'), 1);
  assert.equal(registerSpan('int8'), 1);
  assert.equal(registerSpan('uint16'), 1);
  assert.equal(registerSpan('int16'), 1);
  assert.equal(registerSpan('bool'), 1);
  assert.equal(registerSpan('uint32-be'), 2);
  assert.equal(registerSpan('int32-be'), 2);
  assert.equal(registerSpan('float32-be'), 2);
  assert.equal(registerSpan('uint32-le'), 2);
  assert.equal(registerSpan('int32-le'), 2);
  assert.equal(registerSpan('float32-le'), 2);
});

test('registerCountForValues converts data counts to Modbus register counts', () => {
  assert.equal(registerCountForValues('uint8', 10), 5);
  assert.equal(registerCountForValues('int8', 10), 5);
  assert.equal(registerCountForValues('uint8', 9), 5);
  assert.equal(registerCountForValues('uint16', 10), 10);
  assert.equal(registerCountForValues('int16', 10), 10);
  assert.equal(registerCountForValues('uint32-be', 10), 20);
  assert.equal(registerCountForValues('int32-le', 10), 20);
  assert.equal(registerCountForValues('float32-be', 10), 20);
  assert.equal(maxValueCountForRegisters('uint8', MODBUS_LIMITS.readRegisters), 250);
  assert.equal(maxValueCountForRegisters('int8', MODBUS_LIMITS.readRegisters), 250);
  assert.equal(maxValueCountForRegisters('uint32-be', MODBUS_LIMITS.readRegisters), 62);
});

test('isBitFc and isReadFc classify function codes', () => {
  assert.equal(isBitFc(0x01), true);
  assert.equal(isBitFc(0x02), true);
  assert.equal(isBitFc(0x05), true);
  assert.equal(isBitFc(0x0f), true);
  assert.equal(isBitFc(0x03), false);
  assert.equal(isReadFc(0x03), true);
  assert.equal(isReadFc(0x04), true);
  assert.equal(isReadFc(0x06), false);
});

test('clampSlave and clampU16 bound inputs', () => {
  assert.equal(clampSlave(300), 247);
  assert.equal(clampSlave(-1), 0);
  assert.equal(clampU16(0x10000), 0xffff);
  assert.equal(clampU16(-5), 0);
});
