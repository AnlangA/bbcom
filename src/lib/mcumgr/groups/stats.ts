import { Cbor, cborArray, cborMap, cborText, decodeCborMap, mapFromEntries } from '../cbor';
import { encodeMapPayload, SMP_GROUP } from '../smp';

export const STATS_CMD = Object.freeze({
  group: 0,
  list: 1,
} as const);

export function encodeStatsGroup(name: string): Uint8Array {
  return encodeMapPayload({ name: Cbor.text(name) });
}

export function decodeStatsList(payload: Uint8Array): string[] {
  return (cborArray(decodeCborMap(payload), 'stat_list') ?? [])
    .filter((item) => item.kind === 'tstr')
    .map((item) => item.value);
}

export function decodeStatsGroup(payload: Uint8Array): {
  name: string;
  fields: Record<string, number>;
} {
  const map = decodeCborMap(payload);
  const fields = cborMap(map, 'fields');
  const result: Record<string, number> = {};
  if (fields) {
    for (const [key, value] of fields) {
      if (value.kind === 'uint' || value.kind === 'nint') result[key] = value.value;
    }
  }
  return { name: cborText(map, 'name') ?? '', fields: result };
}

export function decodeStatsFieldMap(
  entries: ReturnType<typeof mapFromEntries>,
): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (value.kind === 'uint' || value.kind === 'nint') fields[key] = value.value;
  }
  return fields;
}

export const STATS_GROUP = SMP_GROUP.stats;
