import { Cbor, cborMap, cborText, cborUint, decodeCborMap, mapFromEntries } from '../cbor';
import { encodeMapPayload, SMP_GROUP, SMP_OP } from '../smp';

export const OS_CMD = Object.freeze({
  echo: 0,
  consoleEcho: 1,
  tasks: 2,
  memoryPools: 3,
  datetime: 4,
  reset: 5,
  parameters: 6,
  applicationInfo: 7,
  bootloaderInfo: 8,
} as const);

export function encodeOsEcho(text: string): Uint8Array {
  return encodeMapPayload({ d: Cbor.text(text) });
}

export function decodeOsEcho(payload: Uint8Array): string {
  return cborText(decodeCborMap(payload), 'r') ?? '';
}

export function encodeOsConsoleEcho(echo: boolean): Uint8Array {
  return encodeMapPayload({ echo: Cbor.bool(echo) });
}

export function encodeOsDatetimeSet(datetime: string): Uint8Array {
  return encodeMapPayload({ datetime: Cbor.text(datetime) });
}

export function decodeOsDatetime(payload: Uint8Array): string {
  return cborText(decodeCborMap(payload), 'datetime') ?? '';
}

export function encodeOsReset(input: { force?: boolean; bootMode?: number } = {}): Uint8Array {
  return encodeMapPayload({
    force: input.force ? Cbor.int(1) : undefined,
    boot_mode: input.bootMode === undefined ? undefined : Cbor.uint(input.bootMode),
  });
}

export function encodeOsApplicationInfo(format?: string): Uint8Array {
  return encodeMapPayload({ format: format === undefined ? undefined : Cbor.text(format) });
}

export function decodeOsApplicationInfo(payload: Uint8Array): string {
  return cborText(decodeCborMap(payload), 'output') ?? '';
}

export function encodeOsBootloaderInfo(query?: string): Uint8Array {
  return encodeMapPayload({ query: query === undefined ? undefined : Cbor.text(query) });
}

export function decodeOsParameters(payload: Uint8Array): { bufSize: number; bufCount: number } {
  const map = decodeCborMap(payload);
  return {
    bufSize: cborUint(map, 'buf_size') ?? 0,
    bufCount: cborUint(map, 'buf_count') ?? 0,
  };
}

export function decodeOsTasks(payload: Uint8Array): Record<string, Record<string, number>> {
  const tasks = cborMap(decodeCborMap(payload), 'tasks');
  const result: Record<string, Record<string, number>> = {};
  if (!tasks) return result;
  for (const [name, value] of tasks) {
    if (value.kind !== 'map') continue;
    const fields: Record<string, number> = {};
    for (const entry of value.value) {
      if (entry.value.kind === 'uint' || entry.value.kind === 'nint') {
        fields[entry.key] = entry.value.value;
      }
    }
    result[name] = fields;
  }
  return result;
}

export function decodeOsMemoryPools(payload: Uint8Array): Record<string, Record<string, number>> {
  const map = decodeCborMap(payload);
  const result: Record<string, Record<string, number>> = {};
  for (const [name, value] of map) {
    if (value.kind !== 'map') continue;
    const fields: Record<string, number> = {};
    for (const [key, item] of mapFromEntries(value.value)) {
      if (item.kind === 'uint' || item.kind === 'nint') fields[key] = item.value;
    }
    result[name] = fields;
  }
  return result;
}

export function decodeNamedMap(payload: Uint8Array): Map<string, unknown> {
  const map = decodeCborMap(payload);
  const result = new Map<string, unknown>();
  for (const [key, value] of map) {
    if (value.kind === 'tstr') result.set(key, value.value);
    else if (value.kind === 'uint' || value.kind === 'nint') result.set(key, value.value);
    else if (value.kind === 'bool') result.set(key, value.value);
    else if (value.kind === 'bstr') result.set(key, value.value);
  }
  return result;
}

export const OS_GROUP = SMP_GROUP.os;
export const OS_READ = SMP_OP.read;
export const OS_WRITE = SMP_OP.write;
