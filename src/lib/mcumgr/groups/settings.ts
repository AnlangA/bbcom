import { Cbor, cborBytes, cborUint, decodeCborMap } from '../cbor';
import { encodeMapPayload, SMP_GROUP } from '../smp';

export const SETTINGS_CMD = Object.freeze({
  readWrite: 0,
  delete: 1,
  commit: 2,
  loadSave: 3,
} as const);

export function encodeSettingsRead(name: string, maxSize?: number): Uint8Array {
  return encodeMapPayload({
    name: Cbor.text(name),
    max_size: maxSize === undefined ? undefined : Cbor.uint(maxSize),
  });
}

export function decodeSettingsRead(payload: Uint8Array): { val: Uint8Array; maxSize?: number } {
  const map = decodeCborMap(payload);
  return {
    val: cborBytes(map, 'val') ?? new Uint8Array(0),
    maxSize: cborUint(map, 'max_size'),
  };
}

export function encodeSettingsWrite(name: string, val: Uint8Array): Uint8Array {
  return encodeMapPayload({ name: Cbor.text(name), val: Cbor.bytes(val) });
}

export function encodeSettingsDelete(name: string): Uint8Array {
  return encodeMapPayload({ name: Cbor.text(name) });
}

export function encodeSettingsSave(name?: string): Uint8Array {
  return encodeMapPayload({ name: name === undefined ? undefined : Cbor.text(name) });
}

export const SETTINGS_GROUP = SMP_GROUP.settings;
