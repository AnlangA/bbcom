import { Cbor, decodeCbor, encodeCbor, type CborValue } from '../cbor';
import { encodeMapPayload } from '../smp';

const RAW_JSON_MAX_BYTES = 64 * 1024;

export function encodeRawJsonPayload(json: string): Uint8Array {
  if (new TextEncoder().encode(json).length > RAW_JSON_MAX_BYTES) {
    throw new RangeError('raw JSON payload exceeds 64 KiB');
  }
  const parsed = JSON.parse(json) as unknown;
  return encodeCbor(jsonToCbor(parsed, 0));
}

export function encodeRawHexPayload(hex: string): Uint8Array {
  const compact = hex.replace(/\s+/g, '');
  if (compact.length === 0) return encodeMapPayload({});
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) {
    throw new RangeError('raw CBOR hex is invalid');
  }
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  decodeCbor(bytes);
  return bytes;
}

export function formatCborPreview(bytes: Uint8Array): string {
  try {
    return JSON.stringify(cborToJson(decodeCbor(bytes)), null, 2);
  } catch {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
  }
}

function jsonToCbor(value: unknown, depth: number): CborValue {
  if (depth > 32) throw new RangeError('raw JSON is too deeply nested');
  if (value === null) return Cbor.null();
  if (typeof value === 'boolean') return Cbor.bool(value);
  if (typeof value === 'string') return Cbor.text(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new RangeError('raw JSON numbers must be safe integers');
    return Cbor.int(value);
  }
  if (Array.isArray(value)) return Cbor.array(value.map((item) => jsonToCbor(item, depth + 1)));
  if (value && typeof value === 'object') {
    const entries: Record<string, CborValue> = {};
    for (const [key, item] of Object.entries(value)) {
      entries[key] = jsonToCbor(item, depth + 1);
    }
    return Cbor.map(entries);
  }
  throw new RangeError('unsupported raw JSON value');
}

function cborToJson(value: CborValue): unknown {
  switch (value.kind) {
    case 'uint':
    case 'nint':
    case 'tstr':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'bstr':
      return {
        $hex: Array.from(value.value, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    case 'array':
      return value.value.map(cborToJson);
    case 'map':
      return Object.fromEntries(value.value.map((entry) => [entry.key, cborToJson(entry.value)]));
  }
}
