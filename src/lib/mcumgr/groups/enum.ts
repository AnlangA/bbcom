import { Cbor, cborArray, cborText, cborUint, decodeCborMap } from '../cbor';
import { encodeMapPayload, SMP_GROUP } from '../smp';

export const ENUM_CMD = Object.freeze({
  count: 0,
  list: 1,
  single: 2,
  details: 3,
} as const);

export function encodeEnumSingle(index: number): Uint8Array {
  return encodeMapPayload({ index: Cbor.uint(index) });
}

export function encodeEnumDetails(groups?: readonly number[]): Uint8Array {
  return encodeMapPayload({
    groups: groups ? Cbor.array(groups.map((group) => Cbor.uint(group))) : undefined,
  });
}

export function decodeEnumCount(payload: Uint8Array): number {
  return cborUint(decodeCborMap(payload), 'count') ?? 0;
}

export function decodeEnumList(payload: Uint8Array): number[] {
  const map = decodeCborMap(payload);
  const groups = cborArray(map, 'groups') ?? cborArray(map, 'list') ?? [];
  return groups.filter((item) => item.kind === 'uint').map((item) => item.value);
}

export function decodeEnumSingle(payload: Uint8Array): { group: number; name?: string } {
  const map = decodeCborMap(payload);
  return {
    group: cborUint(map, 'group') ?? 0,
    name: cborText(map, 'name'),
  };
}

export const ENUM_GROUP = SMP_GROUP.enum;
