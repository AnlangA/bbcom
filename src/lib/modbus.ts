/**
 * Modbus PDU core — pure protocol logic, transport-agnostic.
 *
 * bbcom's serial port is owned by `tauri-plugin-serialplugin`, which every
 * Node-based Modbus library (`modbus-serial`, `jsmodbus`, …) would fight for.
 * So, mirroring `protocol-parser.ts` / `trigger-engine.ts`, this module is the
 * transport-agnostic PDU layer: it builds request PDUs and parses response PDUs
 * for all eight public function codes, verifies CRC-16/Modbus, and decodes
 * register/coil values. The transport wrappers (RTU addr+CRC, or raw PDU) live
 * in `modbus-transport.ts`; the master composable feeds it the port's raw bytes.
 *
 * PDU = Function Code (1B) + Data. The ADU (addr + PDU + CRC for RTU, or MBAP
 * header for TCP) is layered above. This module only ever sees/strips the slave
 * address byte + CRC when an ADU is handed to it, and returns PDU-only bodies
 * from the request builders so the transport layer does the wrapping.
 *
 * Pure TS (no Vue/DOM) → fully unit-testable under the `node --test` runner.
 */

/**
 * The eight public Modbus function codes. Plain `const` numbers (not a `const
 * enum`) so this file loads under Node's --experimental-strip-types runner,
 * whose parser rejects TypeScript enums.
 */
export const MODBUS_FC = {
  ReadCoils: 0x01,
  ReadDiscreteInputs: 0x02,
  ReadHoldingRegisters: 0x03,
  ReadInputRegisters: 0x04,
  WriteSingleCoil: 0x05,
  WriteSingleRegister: 0x06,
  WriteMultipleCoils: 0x0f,
  WriteMultipleRegisters: 0x10,
} as const;

/** Read family (FC 01–04) — share an identical request shape. */
export type ReadFc = 0x01 | 0x02 | 0x03 | 0x04;
/** Single-write family (FC 05/06). */
export type WriteSingleFc = 0x05 | 0x06;
/** Multiple-write family (FC 0F/10). */
export type WriteMultipleFc = 0x0f | 0x10;

/** Register value encodings users can pick per row. 32-bit types span 2 regs. */
export type ModbusValueType =
  | 'bool'
  | 'uint16'
  | 'int16'
  | 'uint32-be'
  | 'int32-be'
  | 'float32-be';

/** How many 16-bit registers a value type occupies (coils are 1 bit). */
export function registerSpan(type: ModbusValueType): 1 | 2 {
  return type === 'bool' || type === 'uint16' || type === 'int16' ? 1 : 2;
}

/** True for FC 01/02/05/0F (coil / discrete-input, 1-bit). */
export function isBitFc(fc: number): boolean {
  return fc === 0x01 || fc === 0x02 || fc === 0x05 || fc === 0x0f;
}

/** True for read FCs (01–04). */
export function isReadFc(fc: number): boolean {
  return fc === 0x01 || fc === 0x02 || fc === 0x03 || fc === 0x04;
}

/**
 * CRC-16/Modbus: poly 0xA001, init 0xFFFF, low byte transmitted first.
 * Validated against the standard vector `01 04 02 12 34` → `B4 47`.
 */
export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let _b = 0; _b < 8; _b += 1) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

/** True if `frame` carries a valid CRC over all but the last two bytes. */
export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false; // min ADU: addr + fc + crc(2)
  const n = frame.length;
  const crc = crc16Modbus(frame.subarray(0, n - 2));
  return (crc & 0xff) === frame[n - 2] && ((crc >>> 8) & 0xff) === frame[n - 1];
}

// ---------------------------------------------------------------------------
// Request builders — return the PDU body (fc + data). The transport layer wraps
// these with the slave address (RTU) and CRC as needed.
// ---------------------------------------------------------------------------

/** Build an FC 01/02/03/04 read request PDU: [fc][startHi][startLo][cntHi][cntLo]. */
export function buildReadRequestPdu(fc: ReadFc, start: number, count: number): Uint8Array {
  return new Uint8Array([
    fc,
    (start >>> 8) & 0xff,
    start & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ]);
}

/** Build an FC05 write-single-coil PDU. ON encodes as 0xFF00, OFF as 0x0000. */
export function buildWriteSingleCoilPdu(addr: number, on: boolean): Uint8Array {
  return new Uint8Array([0x05, (addr >>> 8) & 0xff, addr & 0xff, on ? 0xff : 0x00, 0x00]);
}

/** Build an FC06 write-single-register PDU. */
export function buildWriteSingleRegisterPdu(addr: number, value: number): Uint8Array {
  return new Uint8Array([0x06, (addr >>> 8) & 0xff, addr & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/**
 * Build an FC0F write-multiple-coils PDU. Coils pack LSB-first within each byte
 * (coil at the lowest address ⇒ least-significant bit of the first byte), per
 * the Modbus spec. The byte count is ceil(count/8).
 */
export function buildWriteMultipleCoilsPdu(start: number, bits: boolean[]): Uint8Array {
  const count = bits.length;
  const byteCount = Math.ceil(count / 8);
  const data = new Uint8Array(byteCount);
  for (let i = 0; i < count; i += 1) {
    if (bits[i]) data[i >> 3] |= 1 << (i & 7);
  }
  const out = new Uint8Array(6 + byteCount);
  out[0] = 0x0f;
  out[1] = (start >>> 8) & 0xff;
  out[2] = start & 0xff;
  out[3] = (count >>> 8) & 0xff;
  out[4] = count & 0xff;
  out[5] = byteCount;
  out.set(data, 6);
  return out;
}

/** Build an FC10 write-multiple-registers PDU: [10][startHi][startLo][cntHi][cntLo][byteCount][data…]. */
export function buildWriteMultipleRegistersPdu(start: number, values: number[]): Uint8Array {
  const count = values.length;
  const out = new Uint8Array(6 + count * 2);
  out[0] = 0x10;
  out[1] = (start >>> 8) & 0xff;
  out[2] = start & 0xff;
  out[3] = (count >>> 8) & 0xff;
  out[4] = count & 0xff;
  out[5] = count * 2;
  for (let i = 0; i < count; i += 1) {
    out[6 + i * 2] = (values[i] >>> 8) & 0xff;
    out[6 + i * 2 + 1] = values[i] & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response parsing. Input is a full ADU frame (addr + PDU + CRC for RTU, or
// addr + PDU for PDU transport). CRC is verified for RTU; PDU transport callers
// pass an already-trimmed frame with a synthetic shape (addr byte + pdu).
// ---------------------------------------------------------------------------

export interface ReadBitsResult {
  kind: 'read-bits';
  slave: number;
  fc: ReadFc;
  /** Coil/input states, one boolean per requested index (LSB-first unpacked). */
  bits: boolean[];
}
export interface ReadRegsResult {
  kind: 'read-regs';
  slave: number;
  fc: ReadFc;
  /** 16-bit register values, in the order returned by the slave. */
  regs: number[];
}
export interface WriteAckResult {
  kind: 'write-ack';
  slave: number;
  fc: WriteSingleFc | WriteMultipleFc;
  /** Echoed starting address. */
  addr: number;
  /** Echoed count (1 for single writes). */
  count: number;
}
export interface ExceptionResult {
  kind: 'exception';
  slave: number;
  /** Original FC with the high bit set. */
  fc: number;
  /** Modbus exception code (01..04 typically). */
  code: number;
}
export type ModbusResponse = ReadBitsResult | ReadRegsResult | WriteAckResult | ExceptionResult;

/**
 * Parse a complete ADU response. Returns null if the frame is malformed (bad
 * length, bad CRC, impossible byte count). The caller ensures frame boundaries
 * — on a real bus that's the transport's `scanResponse` (RTU: smallest
 * CRC-valid window; PDU: fixed by the outstanding request's FC).
 */
export function parseResponse(verifyCrcFlag: boolean, frame: Uint8Array): ModbusResponse | null {
  if (frame.length < 4) return null;
  if (verifyCrcFlag && !verifyCrc(frame)) return null;

  // For RTU the CRC is the trailing 2 bytes; for PDU transport there's no CRC.
  // Strip the slave byte first, then work on a PDU view that excludes the CRC.
  const slave = frame[0];
  const pduLen = verifyCrcFlag ? frame.length - 2 : frame.length;
  const fc = frame[1];
  const pdu = frame.subarray(1, pduLen);

  // Exception response: function code with the high bit set + 1 exception byte.
  if (fc & 0x80) {
    if (pdu.length !== 2) return null; // fc + exCode
    return { kind: 'exception', slave, fc, code: pdu[1] };
  }

  if (fc === 0x01 || fc === 0x02) {
    // [fc][byteCount][data…]
    if (pdu.length < 2) return null;
    const byteCount = pdu[1];
    if (pdu.length !== 2 + byteCount) return null;
    const bits: boolean[] = [];
    for (let i = 0; i < byteCount; i += 1) {
      const b = pdu[2 + i];
      for (let bit = 0; bit < 8; bit += 1) bits.push(((b >> bit) & 1) === 1);
    }
    return { kind: 'read-bits', slave, fc: fc as ReadFc, bits };
  }

  if (fc === 0x03 || fc === 0x04) {
    if (pdu.length < 2) return null;
    const byteCount = pdu[1];
    if (pdu.length !== 2 + byteCount || byteCount % 2 !== 0) return null;
    const regs: number[] = [];
    for (let i = 0; i < byteCount; i += 2) {
      regs.push((pdu[2 + i] << 8) | pdu[2 + i + 1]);
    }
    return { kind: 'read-regs', slave, fc: fc as ReadFc, regs };
  }

  if (fc === 0x05 || fc === 0x06 || fc === 0x0f || fc === 0x10) {
    // write-ack echo: [fc][addrHi][addrLo][countHi][countLo]
    if (pdu.length !== 5) return null;
    const addr = (pdu[1] << 8) | pdu[2];
    const count = (pdu[3] << 8) | pdu[4];
    return { kind: 'write-ack', slave, fc: fc as WriteSingleFc | WriteMultipleFc, addr, count };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Value decoders. Register values arrive as 16-bit words (big-endian register
// order, the wire order); coil values arrive as booleans.
// ---------------------------------------------------------------------------

/**
 * Decode a window of 16-bit registers into a single value per `type`.
 * `regs` must hold exactly `registerSpan(type)` entries. For 'bool', pass the
 * single coil state in `regs[0]` (1 = true) — or use `decodeBit` directly.
 */
export function decodeValue(type: ModbusValueType, regs: number[]): number {
  if (type === 'bool') return regs[0] ? 1 : 0;
  if (type === 'uint16') return regs[0] & 0xffff;
  if (type === 'int16') return toInt16(regs[0]);
  const hi = regs[0] >>> 0;
  const lo = regs[1] >>> 0;
  if (type === 'uint32-be') return hi * 0x10000 + lo;
  if (type === 'int32-be') return toInt32(hi, lo);
  if (type === 'float32-be') return decodeFloat32BE(hi, lo);
  return NaN;
}

/** Decode a single coil/discrete-input bit into 0/1. */
export function decodeBit(bit: boolean): number {
  return bit ? 1 : 0;
}

function toInt16(u16: number): number {
  const v = u16 & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
}

function toInt32(hi: number, lo: number): number {
  const v = (hi & 0xffff) * 0x10000 + (lo & 0xffff);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

/** Reassemble two 16-bit halves into a big-endian float32 (IEEE 754). */
function decodeFloat32BE(hi: number, lo: number): number {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint16(0, hi & 0xffff, false); // big-endian
  view.setUint16(2, lo & 0xffff, false);
  return view.getFloat32(0, false);
}

// ---------------------------------------------------------------------------
// Small clamp helpers for the UI / store normalization.
// ---------------------------------------------------------------------------

/** Clamp a Modbus slave address to the valid 1..247 range (0 = broadcast). */
export function clampSlave(n: number): number {
  return Math.max(0, Math.min(247, Math.floor(n)));
}

/** Clamp a register address / value to the 16-bit range. */
export function clampU16(n: number): number {
  return Math.max(0, Math.min(0xffff, Math.floor(n)));
}
