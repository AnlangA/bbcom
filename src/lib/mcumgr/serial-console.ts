import { base64ToBytes, bytesToBase64 } from '../base64';
import { crc16Xmodem } from './crc16-xmodem';

export const MCUMGR_CONSOLE_PKT = Object.freeze([0x06, 0x09] as const);
export const MCUMGR_CONSOLE_FRAG = Object.freeze([0x04, 0x14] as const);
export const MCUMGR_CONSOLE_DEFAULT_LINE_LENGTH = 127;
export const MCUMGR_CONSOLE_MIN_LINE_LENGTH = 16;
export const MCUMGR_CONSOLE_MAX_LINE_LENGTH = 8192;

export class McumgrConsoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McumgrConsoleError';
  }
}

/**
 * Frame an SMP packet for the Zephyr console transport.
 * Unencoded body is BE16(len=SMP+CRC) + SMP + CRC16-XMODEM(SMP).
 */
export function encodeConsolePacket(
  smpPacket: Uint8Array,
  lineLength = MCUMGR_CONSOLE_DEFAULT_LINE_LENGTH,
): Uint8Array {
  const length = clampLineLength(lineLength);
  const crc = crc16Xmodem(smpPacket);
  const unencoded = new Uint8Array(2 + smpPacket.length + 2);
  const total = smpPacket.length + 2;
  unencoded[0] = (total >>> 8) & 0xff;
  unencoded[1] = total & 0xff;
  unencoded.set(smpPacket, 2);
  unencoded[unencoded.length - 2] = (crc >>> 8) & 0xff;
  unencoded[unencoded.length - 1] = crc & 0xff;

  const maxBase64 = length - 3;
  const maxRaw = Math.max(3, Math.floor(maxBase64 / 4) * 3);
  const frames: Uint8Array[] = [];
  let offset = 0;
  let first = true;
  while (offset < unencoded.length) {
    const remaining = unencoded.length - offset;
    let chunkSize = Math.min(maxRaw, remaining);
    const last = offset + chunkSize >= unencoded.length;
    if (!last) chunkSize = Math.floor(chunkSize / 3) * 3;
    if (chunkSize <= 0)
      throw new McumgrConsoleError('console line length too small for a fragment');
    const encoded = bytesToBase64(unencoded.subarray(offset, offset + chunkSize));
    const marker = first ? MCUMGR_CONSOLE_PKT : MCUMGR_CONSOLE_FRAG;
    first = false;
    const frame = new Uint8Array(2 + encoded.length + 1);
    frame[0] = marker[0];
    frame[1] = marker[1];
    for (let i = 0; i < encoded.length; i += 1) frame[2 + i] = encoded.charCodeAt(i);
    frame[frame.length - 1] = 0x0a;
    frames.push(frame);
    offset += chunkSize;
  }
  return concatBytes(frames);
}

export class McumgrConsoleDecoder {
  private remainder: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private body: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private expected = 0;
  private assembling = false;

  reset(): void {
    this.remainder = new Uint8Array(0);
    this.body = new Uint8Array(0);
    this.expected = 0;
    this.assembling = false;
  }

  push(bytes: Uint8Array): Uint8Array[] {
    this.remainder = concatBytes([this.remainder, bytes]);
    const packets: Uint8Array[] = [];
    while (true) {
      const newline = this.remainder.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.remainder.subarray(0, newline);
      this.remainder = this.remainder.subarray(newline + 1);
      const packet = this.consumeLine(stripCr(line));
      if (packet) packets.push(packet);
    }
    return packets;
  }

  private consumeLine(line: Uint8Array): Uint8Array | null {
    const start = findMarker(line);
    if (!start) return null;
    const raw = decodeFragment(line.subarray(start.index + 2));
    if (start.kind === 'pkt') {
      if (raw.length < 2) throw new McumgrConsoleError('console packet missing length');
      this.expected = (raw[0] << 8) | raw[1];
      this.body = raw.subarray(2);
      this.assembling = true;
    } else if (!this.assembling) {
      return null;
    } else {
      this.body = concatBytes([this.body, raw]);
    }
    if (this.body.length < this.expected) return null;
    if (this.body.length < 2) throw new McumgrConsoleError('console packet shorter than CRC');
    const smp = this.body.subarray(0, this.expected - 2);
    const crc = (this.body[this.expected - 2] << 8) | this.body[this.expected - 1];
    this.assembling = false;
    this.body = new Uint8Array(0);
    this.expected = 0;
    if (crc16Xmodem(smp) !== crc) throw new McumgrConsoleError('console CRC mismatch');
    return smp;
  }
}

function findMarker(line: Uint8Array): { kind: 'pkt' | 'frag'; index: number } | null {
  for (let i = 0; i + 1 < line.length; i += 1) {
    if (line[i] === MCUMGR_CONSOLE_PKT[0] && line[i + 1] === MCUMGR_CONSOLE_PKT[1]) {
      return { kind: 'pkt', index: i };
    }
    if (line[i] === MCUMGR_CONSOLE_FRAG[0] && line[i + 1] === MCUMGR_CONSOLE_FRAG[1]) {
      return { kind: 'frag', index: i };
    }
  }
  return null;
}

function decodeFragment(bytes: Uint8Array): Uint8Array {
  const text = String.fromCharCode(...bytes).replace(/\s+/g, '');
  try {
    return base64ToBytes(text);
  } catch {
    throw new McumgrConsoleError('console fragment is not canonical base64');
  }
}

function stripCr(line: Uint8Array): Uint8Array {
  return line.length > 0 && line[line.length - 1] === 0x0d
    ? line.subarray(0, line.length - 1)
    : line;
}

function clampLineLength(lineLength: number): number {
  if (!Number.isSafeInteger(lineLength)) {
    throw new McumgrConsoleError('console line length must be an integer');
  }
  return Math.min(
    MCUMGR_CONSOLE_MAX_LINE_LENGTH,
    Math.max(MCUMGR_CONSOLE_MIN_LINE_LENGTH, lineLength),
  );
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
