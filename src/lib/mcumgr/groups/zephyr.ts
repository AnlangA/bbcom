import { emptyCborMap } from '../cbor';
import { SMP_GROUP } from '../smp';

export const ZEPHYR_CMD = Object.freeze({
  eraseStorage: 0,
} as const);

export function encodeZephyrEraseStorage(): Uint8Array {
  return emptyCborMap();
}

export const ZEPHYR_GROUP = SMP_GROUP.zephyr;
