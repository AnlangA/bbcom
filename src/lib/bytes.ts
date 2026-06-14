/**
 * Concatenate a list of Uint8Array chunks into a single buffer.
 *
 * The total length is computed from the chunks themselves (not a pre-tracked
 * running total) so the result stays correct even if the caller has already
 * reset its own size accumulator — which is exactly the flush-then-reset
 * ordering used by the RX batching path.
 */
export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
