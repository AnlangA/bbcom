/**
 * Dependency-free base64 codec for the IPC byte channel.
 *
 * `btoa`/`atob` operate on binary strings and choke on large inputs when fed
 * through a single `String.fromCharCode(...)`, so both directions work in
 * chunks sized to keep every intermediate value well inside engine limits:
 * encoding chunks are a multiple of three bytes (no interior padding) and
 * decoding chunks are a multiple of four characters (padding stays in the final
 * chunk only).
 */

/** 12,288 bytes per encode chunk (4,096 ternary groups, 16,384 base64 chars). */
const ENCODE_CHUNK_BYTES = 0x3000;
/** 4,096 bytes per `String.fromCharCode` spread, well below argument limits. */
const BINARY_SLICE_BYTES = 0x1000;
/** 32,768 base64 characters per decode chunk (24,576 decoded bytes). */
const DECODE_CHUNK_CHARS = 0x8000;

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Encode bytes into canonical padded standard-alphabet base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += ENCODE_CHUNK_BYTES) {
    const end = Math.min(offset + ENCODE_CHUNK_BYTES, bytes.length);
    let binary = '';
    for (let index = offset; index < end; index += BINARY_SLICE_BYTES) {
      const slice = bytes.subarray(index, Math.min(index + BINARY_SLICE_BYTES, end));
      binary += String.fromCharCode(...slice);
    }
    output += btoa(binary);
  }
  return output;
}

/** Decode canonical padded standard-alphabet base64 into bytes. */
export function base64ToBytes(value: string): Uint8Array {
  if (!CANONICAL_BASE64.test(value)) {
    throw new TypeError('value is not canonical base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let write = 0;
  for (let offset = 0; offset < value.length; offset += DECODE_CHUNK_CHARS) {
    const binary = atob(value.slice(offset, Math.min(offset + DECODE_CHUNK_CHARS, value.length)));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[write++] = binary.charCodeAt(index);
    }
  }
  return bytes;
}
