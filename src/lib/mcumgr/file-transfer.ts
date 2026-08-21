import { decodeFsFileChunk, decodeFsOffset, encodeFsDownload, encodeFsUpload } from './groups/fs';
import { McumgrError } from './errors';
import { concatBytes } from './serial-console';
import { SMP_GROUP, SMP_OP } from './smp';
import type { McumgrByteSource } from './sha256';
import type { McumgrTransactionRequest } from './transaction';
import { imageChunkSize } from './image-upload';

export interface FileTransferOptions {
  name: string;
  mtu: number;
  firstTimeoutMs: number;
  subsequentTimeoutMs: number;
  transact: (request: McumgrTransactionRequest) => Promise<{ payload: Uint8Array }>;
  onProgress?: (offset: number, total: number) => void;
  signal?: AbortSignal;
}

export async function uploadFile(
  options: FileTransferOptions & { source: McumgrByteSource },
): Promise<void> {
  const total = options.source.size;
  let offset = 0;
  let redirects = 0;
  while (offset < total) {
    throwIfAborted(options.signal);
    const first = offset === 0;
    const size = Math.min(imageChunkSize(options.mtu), total - offset);
    const response = await options.transact({
      version: 2,
      op: SMP_OP.write,
      group: SMP_GROUP.fs,
      command: 0,
      payload: encodeFsUpload({
        name: options.name,
        off: offset,
        data: await options.source.slice(offset, offset + size),
        len: first ? total : undefined,
      }),
      timeoutMs: first ? options.firstTimeoutMs : options.subsequentTimeoutMs,
    });
    const next = decodeFsOffset(response.payload);
    if (next === 0 && offset !== 0) {
      redirects += 1;
      if (redirects > 8)
        throw new McumgrError('protocol-error', 'FS upload redirected too many times');
      offset = 0;
      continue;
    }
    offset = next || offset + size;
    options.onProgress?.(Math.min(offset, total), total);
  }
}

export async function downloadFile(options: FileTransferOptions): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    throwIfAborted(options.signal);
    const response = await options.transact({
      version: 2,
      op: SMP_OP.read,
      group: SMP_GROUP.fs,
      command: 0,
      payload: encodeFsDownload(options.name, offset),
      timeoutMs: offset === 0 ? options.firstTimeoutMs : options.subsequentTimeoutMs,
    });
    const chunk = decodeFsFileChunk(response.payload);
    if (chunk.len !== undefined) total = chunk.len;
    chunks.push(chunk.data);
    offset = chunk.off + chunk.data.length;
    options.onProgress?.(offset, total || offset);
    if (chunk.data.length === 0 || (total > 0 && offset >= total)) break;
  }
  return concatBytes(chunks);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new McumgrError('cancelled', 'transfer cancelled');
}
