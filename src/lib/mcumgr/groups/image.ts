import {
  Cbor,
  cborArray,
  cborBool,
  cborBytes,
  cborText,
  cborUint,
  decodeCborMap,
  mapFromEntries,
} from '../cbor';
import { encodeMapPayload, SMP_GROUP } from '../smp';

export const IMAGE_CMD = Object.freeze({
  state: 0,
  upload: 1,
  file: 2,
  coreList: 3,
  coreLoad: 4,
  erase: 5,
  slotInfo: 6,
} as const);

export interface McumgrImageSlot {
  image?: number;
  slot: number;
  version: string;
  hash?: Uint8Array;
  bootable?: boolean;
  pending?: boolean;
  confirmed?: boolean;
  active?: boolean;
  permanent?: boolean;
}

export interface McumgrImageState {
  images: McumgrImageSlot[];
  splitStatus?: number;
}

export interface McumgrImageUploadChunk {
  off: number;
  data: Uint8Array;
  len?: number;
  sha?: Uint8Array;
  image?: number;
  upgrade?: boolean;
}

export function encodeImageStateSet(input: { hash?: Uint8Array; confirm: boolean }): Uint8Array {
  return encodeMapPayload({
    hash: input.hash ? Cbor.bytes(input.hash) : undefined,
    confirm: Cbor.bool(input.confirm),
  });
}

export function decodeImageState(payload: Uint8Array): McumgrImageState {
  const map = decodeCborMap(payload);
  const images = (cborArray(map, 'images') ?? [])
    .filter((item) => item.kind === 'map')
    .map((item) => {
      const slot = mapFromEntries(item.value);
      return {
        image: cborUint(slot, 'image'),
        slot: cborUint(slot, 'slot') ?? 0,
        version: cborText(slot, 'version') ?? '',
        hash: cborBytes(slot, 'hash'),
        bootable: cborBool(slot, 'bootable'),
        pending: cborBool(slot, 'pending'),
        confirmed: cborBool(slot, 'confirmed'),
        active: cborBool(slot, 'active'),
        permanent: cborBool(slot, 'permanent'),
      } satisfies McumgrImageSlot;
    });
  return { images, splitStatus: cborUint(map, 'splitStatus') };
}

export function encodeImageUploadChunk(chunk: McumgrImageUploadChunk): Uint8Array {
  return encodeMapPayload({
    off: Cbor.uint(chunk.off),
    data: Cbor.bytes(chunk.data),
    len: chunk.len === undefined ? undefined : Cbor.uint(chunk.len),
    sha: chunk.sha ? Cbor.bytes(chunk.sha) : undefined,
    image: chunk.image === undefined ? undefined : Cbor.uint(chunk.image),
    upgrade: chunk.upgrade === undefined ? undefined : Cbor.bool(chunk.upgrade),
  });
}

export function decodeImageUploadProgress(payload: Uint8Array): { off?: number; match?: boolean } {
  const map = decodeCborMap(payload);
  return { off: cborUint(map, 'off'), match: cborBool(map, 'match') };
}

export function encodeImageErase(slot?: number): Uint8Array {
  return encodeMapPayload({ slot: slot === undefined ? undefined : Cbor.uint(slot) });
}

export const IMAGE_GROUP = SMP_GROUP.image;
