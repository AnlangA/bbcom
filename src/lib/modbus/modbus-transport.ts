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
 * - **RTU**: a frame is "complete" when the smallest prefix verifies as a valid
 *   CRC. Real Modbus RTU uses a 3.5-char inter-frame silence to delimit frames,
 *   but on a byte stream without timing we approximate it by scanning for the
 *   shortest CRC-correct frame at each offset. The master additionally flushes
 *   the buffer on a request timeout, so a partial trailing frame never blocks.
 *   Min RTU ADU length is 4 (addr + fc + crc); max is 256.
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
    if (buf.length >= 2 && (buf[0] & 0x80) !== 0) {
      return { frames: [buf.subarray(0, 2)], remainder: buf.subarray(2) };
    }
    if (expectedLength === undefined || buf.length < expectedLength) {
      return { frames: [], remainder: buf };
    }
    // Slice off as many fixed-length frames as are available.
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + expectedLength <= buf.length) {
      frames.push(buf.subarray(offset, offset + expectedLength));
      offset += expectedLength;
    }
    return { frames, remainder: buf.subarray(offset) };
  }

  // RTU: scan for the smallest CRC-valid frame.
  const frames: Uint8Array[] = [];
  let i = 0;
  const maxFrame = 256;
  while (i < buf.length) {
    let found = -1;
    // Min ADU 4B (addr+fc+crc); try increasing lengths from this offset.
    const upper = Math.min(buf.length - i, maxFrame);
    for (let len = 4; len <= upper; len += 1) {
      const candidate = buf.subarray(i, i + len);
      const crc = crc16Modbus(candidate.subarray(0, len - 2));
      if ((crc & 0xff) === candidate[len - 2] && ((crc >>> 8) & 0xff) === candidate[len - 1]) {
        found = len;
        break; // shortest valid frame wins
      }
    }
    if (found === -1) break; // need more bytes for a frame starting at i
    frames.push(buf.subarray(i, i + found));
    i += found;
  }
  return { frames, remainder: buf.subarray(i) };
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
