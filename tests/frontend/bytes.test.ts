import { test } from 'vitest';
import assert from 'node:assert/strict';
import { concatUint8Arrays } from '../../src/lib/bytes.ts';

test('returns an empty buffer for no chunks', () => {
  const result = concatUint8Arrays([]);
  assert.equal(result.length, 0);
});

test('returns the single chunk directly without copying', () => {
  const chunk = new Uint8Array([1, 2, 3]);
  const result = concatUint8Arrays([chunk]);
  assert.equal(result, chunk);
  assert.deepEqual(Array.from(result), [1, 2, 3]);
});

test('concatenates multiple chunks in order with correct total length', () => {
  const result = concatUint8Arrays([
    new Uint8Array([0xaa, 0xbb]),
    new Uint8Array([0xcc]),
    new Uint8Array([0xdd, 0xee, 0xff]),
  ]);
  assert.equal(result.length, 6);
  assert.deepEqual(Array.from(result), [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
});

test('uses a caller-provided total length for the RX flush fast path', () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
  const result = concatUint8Arrays(chunks, 6);
  assert.equal(result.length, 6);
  assert.deepEqual(Array.from(result), [1, 2, 3, 4, 5, 6]);
});

test('does not rely on an external size accumulator (regression: stale totalQueueSize dropped RX data)', () => {
  // The RX flush path resets its running byte counter to 0 BEFORE concatenating.
  // concatUint8Arrays must compute the size from the chunks themselves — otherwise
  // it would allocate a 0-length buffer and merged.set() would throw RangeError,
  // silently dropping the frame at high baud rates.
  const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])];
  assert.doesNotThrow(() => concatUint8Arrays(chunks));
  assert.deepEqual(Array.from(concatUint8Arrays(chunks)), [1, 2, 3, 4, 5, 6]);
});
