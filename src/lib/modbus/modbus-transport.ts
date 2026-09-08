/**
 * Modbus transport layer — wraps the pure PDU core (`modbus.ts`) with the
 * address/checksum framing a given bus needs.
 *
 * Two transports, switchable per session:
 * - **RTU**: ADU = Address(1) + PDU + CRC-16(2). The serial default; the CRC is
 *   verified on RX and appended on TX.
 * - **PDU**: raw PDU bytes only (no address, no CRC). For TCP-style gateways or
 *   devices that pre-frame; the slave address travels out-of-band or is fixed.
 *
 * The request builders here take a `slave` + PDU-build params and return the
 * full wire bytes for TX; the response scanner takes a raw RX buffer and yields
 * complete ADU frames. The master composable never touches CRC or framing.
 */

import {
  buildReadRequestPdu,
  buildWriteSingleCoilPdu,
  buildWriteSingleRegisterPdu,
  buildWriteMultipleCoilsPdu,
  buildWriteMultipleRegistersPdu,
  crc16Modbus,
  parseResponse,
  type ModbusResponse,
  type ReadFc,
} from './modbus-core';

export type ModbusTransport = 'rtu' | 'pdu';

/** Append the CRC (low byte first) to an addr+PDU buffer. */
function withCrc(addrAndPdu: Uint8Array): Uint8Array {
  const crc = crc16Modbus(addrAndPdu);
  const out = new Uint8Array(addrAndPdu.length + 2);
  out.set(addrAndPdu, 0);
  out[addrAndPdu.length] = crc & 0xff;
  out[addrAndPdu.length + 1] = (crc >>> 8) & 0xff;
  return out;
}

/**
 * Wrap a PDU body into the full wire frame for the given transport.
 * - RTU: [slave] + PDU + CRC.
 * - PDU: PDU bytes only (slave is ignored — travels out-of-band for this transport).
 */
export function frameRequest(
  transport: ModbusTransport,
  slave: number,
  pdu: Uint8Array,
): Uint8Array {
  if (transport === 'pdu') return pdu;
  const addrAndPdu = new Uint8Array(pdu.length + 1);
  addrAndPdu[0] = slave & 0xff;
  addrAndPdu.set(pdu, 1);
  return withCrc(addrAndPdu);
}

// ---------------------------------------------------------------------------
// High-level TX helpers — build the PDU and frame it in one call. These are the
// only TX entry points the master uses.
// ---------------------------------------------------------------------------

export function readRequest(
  transport: ModbusTransport,
  slave: number,
  fc: ReadFc,
  start: number,
  count: number,
): Uint8Array {
  return frameRequest(transport, slave, buildReadRequestPdu(fc, start, count));
}

export function writeSingleCoilRequest(
  transport: ModbusTransport,
  slave: number,
  addr: number,
  on: boolean,
): Uint8Array {
  return frameRequest(transport, slave, buildWriteSingleCoilPdu(addr, on));
}

export function writeSingleRegisterRequest(
  transport: ModbusTransport,
  slave: number,
  addr: number,
  value: number,
): Uint8Array {
  return frameRequest(transport, slave, buildWriteSingleRegisterPdu(addr, value));
}

export function writeMultipleCoilsRequest(
  transport: ModbusTransport,
  slave: number,
  start: number,
  bits: boolean[],
): Uint8Array {
  return frameRequest(transport, slave, buildWriteMultipleCoilsPdu(start, bits));
}

export function writeMultipleRegistersRequest(
  transport: ModbusTransport,
  slave: number,
  start: number,
  values: number[],
): Uint8Array {
  return frameRequest(transport, slave, buildWriteMultipleRegistersPdu(start, values));
}

// ---------------------------------------------------------------------------
// RX scanning. The master hands raw RX bytes to scanResponse; it returns any
// complete frames found plus the leftover bytes to carry into the next call.
// ---------------------------------------------------------------------------

export interface ScanResult {
  frames: Uint8Array[];
  /** Bytes after the last extracted frame boundary; feed back in next call. */
  remainder: Uint8Array;
}

/**
 * Extract complete response frames from a raw RX buffer.
 *
 * - **RTU**: the response function and byte count determine its length, then
 *   CRC verifies that boundary. Scan past corrupt prefixes so serial noise
 *   cannot hide a complete response later in the same native RX chunk. Bytes
 *   after the last verified frame remain available for the next call.
 * - **PDU**: there is no delimiter or length field in the PDU alone, so the
 *   caller must pass `expectedLength` (derived from the outstanding request's
 *   FC). Exception responses are always 2 bytes (`fc | 0x80`, code), so those
 *   are emitted as soon as their short shape is visible; normal responses are
 *   sliced by `expectedLength`.
 */
export function scanResponse(
  transport: ModbusTransport,
  buf: Uint8Array,
  expectedLength?: number,
): ScanResult {
  if (transport === 'pdu') {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const length = (buf[offset] & 0x80) !== 0 ? 2 : expectedLength;
      if (
        length === undefined ||
        !Number.isInteger(length) ||
        length < 1 ||
        length > 253 ||
        offset + length > buf.length
      ) {
        break;
      }
      frames.push(buf.subarray(offset, offset + length));
      offset += length;
    }
    return { frames, remainder: buf.subarray(offset) };
  }

  const frames: Uint8Array[] = [];
  let offset = 0;
  let consumed = 0;
  while (offset + 4 < buf.length) {
    const length = rtuResponseLength(buf, offset);
    if (length === null || offset + length > buf.length) {
      offset += 1;
      continue;
    }
    const end = offset + length;
    const crc = crc16Modbus(buf.subarray(offset, end - 2));
    if ((crc & 0xff) !== buf[end - 2] || crc >>> 8 !== buf[end - 1]) {
      offset += 1;
      continue;
    }
    frames.push(buf.subarray(offset, end));
    offset = end;
    consumed = end;
  }
  return { frames, remainder: buf.subarray(consumed) };
}

function rtuResponseLength(buf: Uint8Array, offset: number): number | null {
  const fc = buf[offset + 1];
  if ((fc & 0x80) !== 0) return 5;
  if (fc === 0x05 || fc === 0x06 || fc === 0x0f || fc === 0x10) return 8;
  if (fc !== 0x01 && fc !== 0x02 && fc !== 0x03 && fc !== 0x04) return null;
  const byteCount = buf[offset + 2];
  if (byteCount < 1 || byteCount > 250) return null;
  if ((fc === 0x03 || fc === 0x04) && byteCount % 2 !== 0) return null;
  return byteCount + 5;
}

/**
 * Parse a scanned frame into a typed response. For RTU the CRC is verified; for
 * PDU it is skipped (integrity is the transport's job).
 */
export function parseFrame(transport: ModbusTransport, frame: Uint8Array): ModbusResponse | null {
  if (transport === 'pdu') {
    return parseResponse(false, frame, { pduOnly: true, slave: PDU_DEFAULT_SLAVE });
  }
  return parseResponse(true, frame);
}

/** Default per-slave address used when transport is PDU (slave is out-of-band). */
export const PDU_DEFAULT_SLAVE = 1;
