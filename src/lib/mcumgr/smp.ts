import type { McumgrSmpVersion } from '../../types/mcumgr';
import {
  Cbor,
  cborInt,
  cborMap,
  cborText,
  cborUint,
  decodeCborMap,
  emptyCborMap,
  encodeCborMap,
  type CborValue,
} from './cbor';

export const SMP_HEADER_BYTES = 8;
export const SMP_OP = Object.freeze({
  read: 0,
  readRsp: 1,
  write: 2,
  writeRsp: 3,
} as const);

export const SMP_GROUP = Object.freeze({
  os: 0,
  image: 1,
  stats: 2,
  settings: 3,
  fs: 8,
  shell: 9,
  enum: 10,
  zephyr: 63,
} as const);

export const MGMT_ERR = Object.freeze({
  ok: 0,
  unknown: 1,
  noMemory: 2,
  invalid: 3,
  timeout: 4,
  noEntry: 5,
  badState: 6,
  msgSize: 7,
  notSupported: 8,
  corrupt: 9,
  busy: 10,
  accessDenied: 11,
  tooOld: 12,
  tooNew: 13,
} as const);

export type SmpOp = (typeof SMP_OP)[keyof typeof SMP_OP];

export interface SmpHeader {
  version: McumgrSmpVersion;
  op: SmpOp;
  flags: number;
  length: number;
  group: number;
  sequence: number;
  command: number;
}

export interface SmpPacket {
  header: SmpHeader;
  payload: Uint8Array;
}

export interface SmpError {
  rc: number;
  group?: number;
  rsn?: string;
}

export function encodeSmpPacket(
  header: Omit<SmpHeader, 'length'>,
  payload: Uint8Array,
): Uint8Array {
  if (payload.length > 0xffff) throw new RangeError('SMP payload exceeds u16 length');
  const packet = new Uint8Array(SMP_HEADER_BYTES + payload.length);
  packet[0] = packByte0(header.version, header.op);
  packet[1] = header.flags & 0xff;
  packet[2] = (payload.length >>> 8) & 0xff;
  packet[3] = payload.length & 0xff;
  packet[4] = (header.group >>> 8) & 0xff;
  packet[5] = header.group & 0xff;
  packet[6] = header.sequence & 0xff;
  packet[7] = header.command & 0xff;
  packet.set(payload, SMP_HEADER_BYTES);
  return packet;
}

export function decodeSmpPacket(bytes: Uint8Array): SmpPacket {
  if (bytes.length < SMP_HEADER_BYTES) throw new RangeError('SMP packet shorter than header');
  const reserved = bytes[0] >> 5;
  if (reserved !== 0) throw new RangeError('SMP reserved bits must be zero');
  const versionBits = (bytes[0] >> 3) & 0x03;
  if (versionBits !== 0 && versionBits !== 1) throw new RangeError('unsupported SMP version');
  const op = bytes[0] & 0x07;
  if (op > 3) throw new RangeError('unsupported SMP op');
  const length = (bytes[2] << 8) | bytes[3];
  if (bytes.length !== SMP_HEADER_BYTES + length) {
    throw new RangeError('SMP packet length does not match header');
  }
  return {
    header: {
      version: versionBits === 1 ? 2 : 1,
      op: op as SmpOp,
      flags: bytes[1],
      length,
      group: (bytes[4] << 8) | bytes[5],
      sequence: bytes[6],
      command: bytes[7],
    },
    payload: bytes.subarray(SMP_HEADER_BYTES),
  };
}

export function encodeSmpRequest(input: {
  version: McumgrSmpVersion;
  op: typeof SMP_OP.read | typeof SMP_OP.write;
  group: number;
  command: number;
  sequence: number;
  payload?: Uint8Array;
}): Uint8Array {
  return encodeSmpPacket(
    {
      version: input.version,
      op: input.op,
      flags: 0,
      group: input.group,
      command: input.command,
      sequence: input.sequence,
    },
    input.payload ?? emptyCborMap(),
  );
}

export function responseOpFor(op: typeof SMP_OP.read | typeof SMP_OP.write): SmpOp {
  return op === SMP_OP.read ? SMP_OP.readRsp : SMP_OP.writeRsp;
}

export function packetMatchesRequest(request: SmpHeader, response: SmpHeader): boolean {
  return (
    response.version === request.version &&
    response.op === responseOpFor(request.op as typeof SMP_OP.read | typeof SMP_OP.write) &&
    response.group === request.group &&
    response.sequence === request.sequence &&
    response.command === request.command
  );
}

export function parseSmpError(payload: Uint8Array): SmpError | null {
  if (payload.length === 0) return null;
  const map = decodeCborMap(payload);
  const err = cborMap(map, 'err');
  if (err) {
    const rc = cborUint(err, 'rc') ?? 0;
    const group = cborUint(err, 'group');
    if (rc === 0 && group === undefined) return null;
    return { rc, group, rsn: cborText(map, 'rsn') };
  }
  const rc = cborInt(map, 'rc');
  if (rc === undefined || rc === 0) return null;
  return { rc, rsn: cborText(map, 'rsn') };
}

export function encodeMapPayload(entries: Record<string, CborValue | undefined>): Uint8Array {
  const defined = Object.entries(entries).some(([, value]) => value !== undefined);
  return defined ? encodeCborMap(entries) : emptyCborMap();
}

export function nextSequence(current: number): number {
  return (current + 1) & 0xff;
}

export function packByte0(version: McumgrSmpVersion, op: SmpOp): number {
  const versionBits = version === 2 ? 0b01 : 0b00;
  return (versionBits << 3) | (op & 0x07);
}

export function cborOptionalText(value: string | undefined): CborValue | undefined {
  return value === undefined ? undefined : Cbor.text(value);
}

export function cborOptionalUint(value: number | undefined): CborValue | undefined {
  return value === undefined ? undefined : Cbor.uint(value);
}

export function cborOptionalBytes(value: Uint8Array | undefined): CborValue | undefined {
  return value === undefined ? undefined : Cbor.bytes(value);
}

export function cborOptionalBool(value: boolean | undefined): CborValue | undefined {
  return value === undefined ? undefined : Cbor.bool(value);
}
