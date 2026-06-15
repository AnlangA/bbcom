/**
 * Modbus RTU PDU layer — pure protocol logic with no transport deps.
 *
 * bbcom's serial port is owned by `tauri-plugin-serialplugin`, which every
 * Node-based Modbus library (`modbus-serial`, `jsmodbus`, …) would fight for.
 * So, mirroring `protocol-parser.ts` / `trigger-engine.ts`, this module is the
 * transport-agnostic core: it builds RTU request frames, parses response
 * frames (verifying CRC-16/Modbus), and decodes register values. The master
 * composable feeds it the port's raw TX/RX bytes.
 *
 * Pure TS (no Vue/DOM) → fully unit-testable under the `node --test` runner.
 */

/** Modbus function codes this layer supports. */
export type ModbusFunctionCode = 3 | 4;

/** Register value encodings users can pick per row. 32-bit types span 2 regs. */
export type ModbusValueType = 'uint16' | 'int16' | 'uint32-be' | 'int32-be' | 'float32-be';

/** How many 16-bit registers a value type occupies. */
export function registerSpan(type: ModbusValueType): 1 | 2 {
  return type === 'uint16' || type === 'int16' ? 1 : 2;
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
  // Low byte first is the RTU wire order; callers comparing as a u16 should use
  // (hi<<8)|lo. Returning the raw integer keeps both byte orders recoverable.
  return crc & 0xffff;
}

/** Append the 2-byte CRC (low byte first) to a frame. */
function withCrc(payload: number[]): Uint8Array {
  const body = new Uint8Array(payload);
  const crc = crc16Modbus(body);
  const out = new Uint8Array(body.length + 2);
  out.set(body, 0);
  out[body.length] = crc & 0xff; // low
  out[body.length + 1] = (crc >>> 8) & 0xff; // high
  return out;
}

/** Build an FC03/FC04 read request: [addr][fc][startHi][startLo][cntHi][cntLo][CRC]. */
export function buildReadRequest(
  slave: number,
  fc: ModbusFunctionCode,
  start: number,
  count: number,
): Uint8Array {
  return withCrc([
    clampByte(slave),
    fc,
    (start >>> 8) & 0xff,
    start & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ]);
}

/** Build an FC06 write-single-register request: [addr][06][addrHi][addrLo][valHi][valLo][CRC]. */
export function buildWriteSingleRequest(
  slave: number,
  register: number,
  value: number,
): Uint8Array {
  return withCrc([
    clampByte(slave),
    0x06,
    (register >>> 8) & 0xff,
    register & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** Build an FC16 write-multiple-registers request. */
export function buildWriteMultipleRequest(
  slave: number,
  start: number,
  values: number[],
): Uint8Array {
  const count = values.length;
  const payload = [
    clampByte(slave),
    0x10,
    (start >>> 8) & 0xff,
    start & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
    count * 2, // byte count
  ];
  for (const v of values) {
    payload.push((v >>> 8) & 0xff, v & 0xff);
  }
  return withCrc(payload);
}

/** A successfully parsed read response. `data` holds the raw 16-bit registers. */
export interface ModbusReadResult {
  slave: number;
  fc: ModbusFunctionCode;
  /** 16-bit register values, in the order returned by the slave. */
  data: number[];
}

/** A Modbus exception response (`fc | 0x80`). `code` is the exception code. */
export interface ModbusException {
  slave: number;
  fc: number;
  code: number;
}

export type ModbusParsedResponse = ModbusReadResult | ModbusException;

/** True if `frame` carries a valid CRC over all but the last two bytes. */
export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false; // min ADU: addr + fc + crc(2)
  const n = frame.length;
  const body = frame.subarray(0, n - 2);
  const crc = crc16Modbus(body);
  return (crc & 0xff) === frame[n - 2] && ((crc >>> 8) & 0xff) === frame[n - 1];
}

/**
 * Parse a complete read response (or exception). Returns null if the frame is
 * malformed (bad length, bad CRC, impossible byte count). The caller is
 * responsible for ensuring the frame boundaries are correct — on a real bus
 * this means a 3.5-char silence-delimited scan (see `useModbusMaster`).
 */
export function parseReadResponse(frame: Uint8Array): ModbusParsedResponse | null {
  if (frame.length < 4) return null;
  if (!verifyCrc(frame)) return null;
  const slave = frame[0];
  const fcRaw = frame[1];
  // Exception response: function code with the high bit set + 1 exception byte.
  if (fcRaw & 0x80) {
    if (frame.length !== 5) return null; // addr + fc + exCode + crc(2)
    return { slave, fc: fcRaw, code: frame[2] };
  }
  if (fcRaw !== 3 && fcRaw !== 4) return null;
  if (frame.length < 5) return null; // addr + fc + byteCount + crc(2) at minimum
  const byteCount = frame[2];
  // addr + fc + byteCount + bytes + crc(2)
  if (frame.length !== 3 + byteCount + 2) return null;
  const data: number[] = [];
  for (let i = 0; i < byteCount; i += 2) {
    data.push((frame[3 + i] << 8) | frame[3 + i + 1]);
  }
  return { slave, fc: fcRaw as ModbusFunctionCode, data };
}

/**
 * Decode a window of 16-bit registers into a single value per `type`.
 * `regs` must hold exactly `registerSpan(type)` entries, taken from the
 * response in big-endian register order (the Modbus wire order).
 */
export function decodeValue(type: ModbusValueType, regs: number[]): number {
  if (type === 'uint16') return regs[0] & 0xffff;
  if (type === 'int16') return toInt16(regs[0]);
  // 32-bit: big-endian register + big-endian word order (the common default;
  // "word-swap"/little-endian-order variants can be added later as new types).
  const hi = regs[0] >>> 0;
  const lo = regs[1] >>> 0;
  if (type === 'uint32-be') return hi * 0x10000 + lo;
  if (type === 'int32-be') return toInt32(hi, lo);
  if (type === 'float32-be') return decodeFloat32BE(hi, lo);
  return NaN;
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

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.floor(n)));
}

/** Clamp a Modbus slave address to the valid 1..247 range (0 broadcasts). */
export function clampSlave(n: number): number {
  return Math.max(0, Math.min(247, Math.floor(n)));
}

/** Clamp a register address / value to the 16-bit range. */
export function clampU16(n: number): number {
  return Math.max(0, Math.min(0xffff, Math.floor(n)));
}
