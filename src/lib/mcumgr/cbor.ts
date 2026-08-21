/**
 * Minimal definite-length CBOR codec for MCUMgr SMP payloads.
 * Supports uint/nint, bstr, tstr, array, map (text keys), bool, and null.
 */

export const CBOR_LIMITS = Object.freeze({
  maxDepth: 32,
  maxItems: 4096,
  maxBytes: 256 * 1024,
});

export type CborValue =
  | { kind: 'uint'; value: number }
  | { kind: 'nint'; value: number }
  | { kind: 'bstr'; value: Uint8Array }
  | { kind: 'tstr'; value: string }
  | { kind: 'array'; value: CborValue[] }
  | { kind: 'map'; value: CborMapEntry[] }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

export interface CborMapEntry {
  readonly key: string;
  readonly value: CborValue;
}

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

export const Cbor = {
  uint(value: number): CborValue {
    assertSafeNonNegative(value, 'uint');
    return { kind: 'uint', value };
  },
  int(value: number): CborValue {
    if (!Number.isSafeInteger(value)) throw new CborError('integer is not a safe integer');
    return value >= 0 ? { kind: 'uint', value } : { kind: 'nint', value };
  },
  bytes(value: Uint8Array): CborValue {
    return { kind: 'bstr', value };
  },
  text(value: string): CborValue {
    return { kind: 'tstr', value };
  },
  array(value: readonly CborValue[]): CborValue {
    return { kind: 'array', value: [...value] };
  },
  map(entries: Record<string, CborValue | undefined>): CborValue {
    const value: CborMapEntry[] = [];
    for (const [key, item] of Object.entries(entries)) {
      if (item === undefined) continue;
      value.push({ key, value: item });
    }
    return { kind: 'map', value };
  },
  bool(value: boolean): CborValue {
    return { kind: 'bool', value };
  },
  null(): CborValue {
    return { kind: 'null' };
  },
};

export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  writeValue(value, out, 0, { items: 0 });
  return Uint8Array.from(out);
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  if (bytes.byteLength > CBOR_LIMITS.maxBytes)
    throw new CborError('payload exceeds CBOR byte limit');
  const cursor = { offset: 0, items: 0 };
  const value = readValue(bytes, cursor, 0);
  if (cursor.offset !== bytes.byteLength) throw new CborError('trailing CBOR bytes');
  return value;
}

export function encodeCborMap(entries: Record<string, CborValue | undefined>): Uint8Array {
  return encodeCbor(Cbor.map(entries));
}

export function decodeCborMap(bytes: Uint8Array): Map<string, CborValue> {
  const value = bytes.byteLength === 0 ? Cbor.map({}) : decodeCbor(bytes);
  if (value.kind !== 'map') throw new CborError('SMP payload is not a CBOR map');
  return mapFromEntries(value.value);
}

export function emptyCborMap(): Uint8Array {
  return Uint8Array.of(0xa0);
}

export function cborMapGet(map: Map<string, CborValue>, key: string): CborValue | undefined {
  return map.get(key);
}

export function cborText(map: Map<string, CborValue>, key: string): string | undefined {
  const value = map.get(key);
  return value?.kind === 'tstr' ? value.value : undefined;
}

export function cborBytes(map: Map<string, CborValue>, key: string): Uint8Array | undefined {
  const value = map.get(key);
  return value?.kind === 'bstr' ? value.value : undefined;
}

export function cborUint(map: Map<string, CborValue>, key: string): number | undefined {
  const value = map.get(key);
  return value?.kind === 'uint' ? value.value : undefined;
}

export function cborInt(map: Map<string, CborValue>, key: string): number | undefined {
  const value = map.get(key);
  if (value?.kind === 'uint' || value?.kind === 'nint') return value.value;
  return undefined;
}

export function cborBool(map: Map<string, CborValue>, key: string): boolean | undefined {
  const value = map.get(key);
  return value?.kind === 'bool' ? value.value : undefined;
}

export function cborArray(map: Map<string, CborValue>, key: string): CborValue[] | undefined {
  const value = map.get(key);
  return value?.kind === 'array' ? value.value : undefined;
}

export function cborMap(
  map: Map<string, CborValue>,
  key: string,
): Map<string, CborValue> | undefined {
  const value = map.get(key);
  return value?.kind === 'map' ? mapFromEntries(value.value) : undefined;
}

export function mapFromEntries(entries: readonly CborMapEntry[]): Map<string, CborValue> {
  const map = new Map<string, CborValue>();
  for (const entry of entries) map.set(entry.key, entry.value);
  return map;
}

function assertSafeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CborError(`${label} is not a safe non-negative integer`);
  }
}

function writeValue(
  value: CborValue,
  out: number[],
  depth: number,
  budget: { items: number },
): void {
  if (depth > CBOR_LIMITS.maxDepth) throw new CborError('CBOR depth exceeds limit');
  budget.items += 1;
  if (budget.items > CBOR_LIMITS.maxItems) throw new CborError('CBOR item count exceeds limit');
  switch (value.kind) {
    case 'uint':
      writeType(0, value.value, out);
      return;
    case 'nint':
      writeType(1, -1 - value.value, out);
      return;
    case 'bstr':
      writeType(2, value.value.length, out);
      appendBytes(out, value.value);
      return;
    case 'tstr': {
      const encoded = textEncoder.encode(value.value);
      writeType(3, encoded.length, out);
      appendBytes(out, encoded);
      return;
    }
    case 'array':
      writeType(4, value.value.length, out);
      for (const item of value.value) writeValue(item, out, depth + 1, budget);
      return;
    case 'map':
      writeType(5, value.value.length, out);
      for (const entry of value.value) {
        writeValue({ kind: 'tstr', value: entry.key }, out, depth + 1, budget);
        writeValue(entry.value, out, depth + 1, budget);
      }
      return;
    case 'bool':
      out.push(value.value ? 0xf5 : 0xf4);
      return;
    case 'null':
      out.push(0xf6);
      return;
  }
}

function writeType(major: number, argument: number, out: number[]): void {
  assertSafeNonNegative(argument, 'CBOR argument');
  const hi = (major & 0x07) << 5;
  if (argument <= 23) {
    out.push(hi | argument);
  } else if (argument <= 0xff) {
    out.push(hi | 24, argument);
  } else if (argument <= 0xffff) {
    out.push(hi | 25, (argument >>> 8) & 0xff, argument & 0xff);
  } else if (argument <= 0xffff_ffff) {
    out.push(
      hi | 26,
      (argument >>> 24) & 0xff,
      (argument >>> 16) & 0xff,
      (argument >>> 8) & 0xff,
      argument & 0xff,
    );
  } else {
    const high = Math.floor(argument / 0x1_0000_0000);
    const low = argument >>> 0;
    out.push(
      hi | 27,
      (high >>> 24) & 0xff,
      (high >>> 16) & 0xff,
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff,
    );
  }
}

function readValue(
  bytes: Uint8Array,
  cursor: { offset: number; items: number },
  depth: number,
): CborValue {
  if (depth > CBOR_LIMITS.maxDepth) throw new CborError('CBOR depth exceeds limit');
  cursor.items += 1;
  if (cursor.items > CBOR_LIMITS.maxItems) throw new CborError('CBOR item count exceeds limit');
  const initial = readByte(bytes, cursor);
  if (initial === 0xf4) return { kind: 'bool', value: false };
  if (initial === 0xf5) return { kind: 'bool', value: true };
  if (initial === 0xf6) return { kind: 'null' };
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info === 31) throw new CborError('indefinite CBOR is not supported');
  const argument = readArgument(bytes, cursor, info);
  switch (major) {
    case 0:
      return { kind: 'uint', value: argument };
    case 1:
      return { kind: 'nint', value: -1 - argument };
    case 2:
      return { kind: 'bstr', value: readSlice(bytes, cursor, argument) };
    case 3:
      return { kind: 'tstr', value: textDecoder.decode(readSlice(bytes, cursor, argument)) };
    case 4: {
      const items: CborValue[] = [];
      for (let i = 0; i < argument; i += 1) items.push(readValue(bytes, cursor, depth + 1));
      return { kind: 'array', value: items };
    }
    case 5: {
      const entries: CborMapEntry[] = [];
      for (let i = 0; i < argument; i += 1) {
        const key = readValue(bytes, cursor, depth + 1);
        if (key.kind !== 'tstr') throw new CborError('CBOR map keys must be text');
        entries.push({ key: key.value, value: readValue(bytes, cursor, depth + 1) });
      }
      return { kind: 'map', value: entries };
    }
    default:
      throw new CborError(`unsupported CBOR major type ${major}`);
  }
}

function readArgument(bytes: Uint8Array, cursor: { offset: number }, info: number): number {
  if (info < 24) return info;
  if (info === 24) return readByte(bytes, cursor);
  if (info === 25) return (readByte(bytes, cursor) << 8) | readByte(bytes, cursor);
  if (info === 26) {
    const value =
      (readByte(bytes, cursor) << 24) |
      (readByte(bytes, cursor) << 16) |
      (readByte(bytes, cursor) << 8) |
      readByte(bytes, cursor);
    return value >>> 0;
  }
  if (info === 27) {
    const high =
      ((readByte(bytes, cursor) << 24) |
        (readByte(bytes, cursor) << 16) |
        (readByte(bytes, cursor) << 8) |
        readByte(bytes, cursor)) >>>
      0;
    const low =
      ((readByte(bytes, cursor) << 24) |
        (readByte(bytes, cursor) << 16) |
        (readByte(bytes, cursor) << 8) |
        readByte(bytes, cursor)) >>>
      0;
    const value = high * 0x1_0000_0000 + low;
    if (!Number.isSafeInteger(value))
      throw new CborError('CBOR integer exceeds safe integer range');
    return value;
  }
  throw new CborError('reserved CBOR additional information');
}

function readByte(bytes: Uint8Array, cursor: { offset: number }): number {
  if (cursor.offset >= bytes.byteLength) throw new CborError('unexpected end of CBOR');
  return bytes[cursor.offset++];
}

function readSlice(bytes: Uint8Array, cursor: { offset: number }, length: number): Uint8Array {
  if (length < 0 || cursor.offset + length > bytes.byteLength) {
    throw new CborError('CBOR slice overruns input');
  }
  const slice = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return slice;
}

function appendBytes(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i]);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
