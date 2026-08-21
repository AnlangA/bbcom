import { decodeImageUploadProgress, encodeImageUploadChunk } from './groups/image';
import { McumgrError } from './errors';
import { sha256Source, type McumgrByteSource } from './sha256';
import { SMP_GROUP, SMP_OP } from './smp';
import type { McumgrTransactionRequest } from './transaction';

const HEADER_OVERHEAD = 160;
const MAX_CHUNK = 16 * 1024;
const MAX_REDIRECTS = 8;

export interface ImageUploadOptions {
  source: McumgrByteSource;
  mtu: number;
  image?: number;
  upgrade?: boolean;
  firstTimeoutMs: number;
  subsequentTimeoutMs: number;
  transact: (request: McumgrTransactionRequest) => Promise<{ payload: Uint8Array }>;
  onProgress?: (offset: number, total: number) => void;
  signal?: AbortSignal;
}

export function imageChunkSize(mtu: number): number {
  return Math.max(16, Math.min(MAX_CHUNK, mtu - HEADER_OVERHEAD));
}

export async function uploadImage(options: ImageUploadOptions): Promise<{ match?: boolean }> {
  const total = options.source.size;
  const sha = await sha256Source(options.source);
  let offset = 0;
  let redirects = 0;
  let match: boolean | undefined;
  while (offset < total) {
    throwIfAborted(options.signal);
    const first = offset === 0;
    let size = Math.min(imageChunkSize(options.mtu), total - offset);
    let payload = encodeImageUploadChunk({
      off: offset,
      data: await options.source.slice(offset, offset + size),
      len: first ? total : undefined,
      sha: first ? sha : undefined,
      image: first ? options.image : undefined,
      upgrade: first ? options.upgrade : undefined,
    });
    while (payload.length + 8 > options.mtu && size > 16) {
      size = Math.max(16, Math.floor((size * 7) / 8));
      payload = encodeImageUploadChunk({
        off: offset,
        data: await options.source.slice(offset, offset + size),
        len: first ? total : undefined,
        sha: first ? sha : undefined,
        image: first ? options.image : undefined,
        upgrade: first ? options.upgrade : undefined,
      });
    }
    const response = await options.transact({
      version: 2,
      op: SMP_OP.write,
      group: SMP_GROUP.image,
      command: 1,
      payload,
      timeoutMs: first ? options.firstTimeoutMs : options.subsequentTimeoutMs,
    });
    const progress = decodeImageUploadProgress(response.payload);
    match = progress.match;
    const next = progress.off ?? offset + size;
    if (next === 0 && offset !== 0) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new McumgrError('protocol-error', 'image upload offset redirected too many times');
      }
      offset = 0;
      continue;
    }
    if (next < offset) {
      throw new McumgrError('protocol-error', 'image upload offset moved backwards');
    }
    offset = next;
    options.onProgress?.(Math.min(offset, total), total);
  }
  return { match };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new McumgrError('cancelled', 'transfer cancelled');
}
