/**
 * Production-safe write chunking (F8 / T3.9).
 *
 * serialplugin issue #29: release-build writes may silently truncate large
 * payloads (works in dev). This module splits a large TX payload into chunks
 * below a safe per-write ceiling, and provides a retry-with-backoff sender that
 * writes each chunk through the caller's `writeChunk` (which must route through
 * the COW-1 serialized write chain — never bypasses `send`/`sendBytes`).
 *
 * The chunk ceiling is conservative (4 KiB) because the truncation threshold is
 * not precisely known and varies by driver/OS. Chunks are written sequentially;
 * a failed chunk is retried up to `maxRetries` times with exponential backoff.
 *
 * Pure split logic (no DOM/Vue deps) so it is fully unit-testable.
 */

/** Conservative per-write byte ceiling for production safety (F8). */
export const WRITE_CHUNK_SIZE = 4096;

/** Default retry count per chunk. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default initial backoff delay (ms), doubled per retry. */
export const DEFAULT_BACKOFF_MS = 100;

/** Split `payload` into chunks of at most `chunkSize` bytes. Pure. */
export function chunkPayload(
  payload: Uint8Array,
  chunkSize: number = WRITE_CHUNK_SIZE,
): Uint8Array[] {
  if (chunkSize < 1) chunkSize = WRITE_CHUNK_SIZE;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.subarray(offset, Math.min(offset + chunkSize, payload.length)));
  }
  // A zero-length payload still needs one (empty) chunk so the caller's write
  // is exercised — but buildSendPayload already rejects empty payloads, so this
  // is just defensive.
  if (chunks.length === 0 && payload.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
}

export interface ChunkedSendResult {
  /** Total bytes written across all chunks. */
  bytesWritten: number;
  /** Number of chunks successfully written. */
  chunksWritten: number;
  /** Total retries consumed across all chunks. */
  retriesUsed: number;
  /** True if all chunks were written successfully. */
  ok: boolean;
  /** Error message if a chunk failed all retries. */
  error: string | null;
}

/**
 * Write `payload` in chunks through `writeChunk`, retrying each failed chunk up
 * to `maxRetries` times with exponential backoff. The chunks are written
 * sequentially (the caller's `writeChunk` must serialize through COW-1).
 *
 * `writeChunk` resolves `true` on success; `false` or a throw triggers a retry.
 */
export async function sendChunked(
  payload: Uint8Array,
  writeChunk: (chunk: Uint8Array) => Promise<boolean>,
  options: {
    chunkSize?: number;
    maxRetries?: number;
    backoffMs?: number;
    delay?: (ms: number) => Promise<void>;
  } = {},
): Promise<ChunkedSendResult> {
  const chunkSize = options.chunkSize ?? WRITE_CHUNK_SIZE;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const chunks = chunkPayload(payload, chunkSize);
  let bytesWritten = 0;
  let retriesUsed = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let attempt = 0;
    let succeeded = false;
    while (attempt <= maxRetries && !succeeded) {
      try {
        succeeded = await writeChunk(chunk);
      } catch {
        succeeded = false;
      }
      if (!succeeded && attempt < maxRetries) {
        retriesUsed += 1;
        await delay(baseBackoff * 2 ** attempt);
      }
      attempt += 1;
    }
    if (!succeeded) {
      return {
        bytesWritten,
        chunksWritten: i,
        retriesUsed,
        ok: false,
        error: `chunk ${i + 1}/${chunks.length} failed after ${attempt} attempts`,
      };
    }
    bytesWritten += chunk.length;
  }

  return { bytesWritten, chunksWritten: chunks.length, retriesUsed, ok: true, error: null };
}
