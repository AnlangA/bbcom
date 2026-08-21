import { Cbor, cborBytes, cborText, cborUint, decodeCborMap, mapFromEntries } from '../cbor';
import { encodeMapPayload, SMP_GROUP } from '../smp';

export const FS_CMD = Object.freeze({
  file: 0,
  status: 1,
  hash: 2,
  hashTypes: 3,
  close: 4,
} as const);

export const FS_PATH_MAX_BYTES = 1024;

export function assertFsPath(path: string): string {
  if (!path.startsWith('/')) throw new RangeError('FS path must be absolute');
  if (path.includes('\\') || path.includes('..') || hasControlCharacters(path)) {
    throw new RangeError('FS path is not canonical');
  }
  if (new TextEncoder().encode(path).length > FS_PATH_MAX_BYTES) {
    throw new RangeError('FS path exceeds 1024 bytes');
  }
  return path;
}

export function encodeFsDownload(name: string, off: number): Uint8Array {
  return encodeMapPayload({ off: Cbor.uint(off), name: Cbor.text(assertFsPath(name)) });
}

export function encodeFsUpload(input: {
  name: string;
  off: number;
  data: Uint8Array;
  len?: number;
}): Uint8Array {
  return encodeMapPayload({
    off: Cbor.uint(input.off),
    data: Cbor.bytes(input.data),
    name: Cbor.text(assertFsPath(input.name)),
    len: input.len === undefined ? undefined : Cbor.uint(input.len),
  });
}

export function decodeFsFileChunk(payload: Uint8Array): {
  off: number;
  data: Uint8Array;
  len?: number;
} {
  const map = decodeCborMap(payload);
  return {
    off: cborUint(map, 'off') ?? 0,
    data: cborBytes(map, 'data') ?? new Uint8Array(0),
    len: cborUint(map, 'len'),
  };
}

export function decodeFsOffset(payload: Uint8Array): number {
  return cborUint(decodeCborMap(payload), 'off') ?? 0;
}

export function encodeFsStatus(name: string): Uint8Array {
  return encodeMapPayload({ name: Cbor.text(assertFsPath(name)) });
}

export function decodeFsStatus(payload: Uint8Array): number {
  return cborUint(decodeCborMap(payload), 'len') ?? 0;
}

export function encodeFsHash(input: {
  name: string;
  type?: string;
  off?: number;
  len?: number;
}): Uint8Array {
  return encodeMapPayload({
    name: Cbor.text(assertFsPath(input.name)),
    type: input.type === undefined ? undefined : Cbor.text(input.type),
    off: input.off === undefined ? undefined : Cbor.uint(input.off),
    len: input.len === undefined ? undefined : Cbor.uint(input.len),
  });
}

export function decodeFsHash(payload: Uint8Array): {
  type: string;
  off?: number;
  len: number;
  output: Uint8Array | number;
} {
  const map = decodeCborMap(payload);
  const output = cborBytes(map, 'output');
  return {
    type: cborText(map, 'type') ?? '',
    off: cborUint(map, 'off'),
    len: cborUint(map, 'len') ?? 0,
    output: output ?? cborUint(map, 'output') ?? 0,
  };
}

export function decodeFsHashTypes(
  payload: Uint8Array,
): Record<string, { format: number; size: number }> {
  const types = decodeCborMap(payload).get('types');
  const result: Record<string, { format: number; size: number }> = {};
  if (!types || types.kind !== 'map') return result;
  for (const [name, value] of mapFromEntries(types.value)) {
    if (value.kind !== 'map') continue;
    const fields = mapFromEntries(value.value);
    const format = fields.get('format');
    const size = fields.get('size');
    result[name] = {
      format: format?.kind === 'uint' ? format.value : 0,
      size: size?.kind === 'uint' ? size.value : 0,
    };
  }
  return result;
}

function hasControlCharacters(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (path.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

export const FS_GROUP = SMP_GROUP.fs;
