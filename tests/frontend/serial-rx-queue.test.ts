import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SerialRxQueue } from '../../src/lib/serial-rx-queue.ts';

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function flatten(chunks: Uint8Array[]): number[] {
  return chunks.flatMap((chunk) => Array.from(chunk));
}

test('queues chunks and drains them with the accumulated byte length', () => {
  const queue = new SerialRxQueue({ maxBytes: 10, maxChunks: 4 });

  assert.deepEqual(queue.enqueue(bytes([1, 2])), {
    droppedBytes: 0,
    droppedSinceDrain: 0,
    totalDroppedBytes: 0,
    overflowStarted: false,
    pendingBytes: 2,
    pendingChunks: 1,
  });
  queue.enqueue(bytes([3]));

  const drained = queue.drain();
  assert.equal(drained.byteLength, 3);
  assert.equal(drained.droppedSinceDrain, 0);
  assert.deepEqual(flatten(drained.chunks), [1, 2, 3]);
  assert.equal(queue.pendingBytes, 0);
  assert.equal(queue.pendingChunks, 0);
});

test('drops oldest chunks when byte capacity is exceeded', () => {
  const queue = new SerialRxQueue({ maxBytes: 6, maxChunks: 10 });
  queue.enqueue(bytes([1, 2, 3]));

  const result = queue.enqueue(bytes([4, 5, 6, 7]));
  assert.deepEqual(result, {
    droppedBytes: 3,
    droppedSinceDrain: 3,
    totalDroppedBytes: 3,
    overflowStarted: true,
    pendingBytes: 4,
    pendingChunks: 1,
  });

  const drained = queue.drain();
  assert.equal(drained.droppedSinceDrain, 3);
  assert.deepEqual(flatten(drained.chunks), [4, 5, 6, 7]);
});

test('drops oldest chunks when chunk capacity is exceeded', () => {
  const queue = new SerialRxQueue({ maxBytes: 100, maxChunks: 2 });
  queue.enqueue(bytes([1]));
  queue.enqueue(bytes([2]));

  const result = queue.enqueue(bytes([3]));
  assert.equal(result.droppedBytes, 1);
  assert.equal(result.pendingChunks, 2);
  assert.deepEqual(flatten(queue.drain().chunks), [2, 3]);
});

test('retains the tail of an oversized incoming chunk', () => {
  const queue = new SerialRxQueue({ maxBytes: 4, maxChunks: 10 });
  queue.enqueue(bytes([1, 2]));

  const result = queue.enqueue(bytes([3, 4, 5, 6, 7, 8]));
  assert.equal(result.droppedBytes, 4);
  assert.equal(result.droppedSinceDrain, 4);
  assert.equal(result.totalDroppedBytes, 4);
  assert.equal(result.overflowStarted, true);
  assert.equal(result.pendingBytes, 4);
  assert.deepEqual(flatten(queue.drain().chunks), [5, 6, 7, 8]);
});

test('reports overflow start once per reset while keeping total dropped bytes', () => {
  const queue = new SerialRxQueue({ maxBytes: 3, maxChunks: 10 });
  queue.enqueue(bytes([1, 2, 3]));
  assert.equal(queue.enqueue(bytes([4])).overflowStarted, true);
  queue.drain();

  queue.enqueue(bytes([5, 6, 7]));
  const secondDrop = queue.enqueue(bytes([8]));
  assert.equal(secondDrop.overflowStarted, false);
  assert.equal(secondDrop.totalDroppedBytes, 6);

  queue.reset();
  queue.enqueue(bytes([9, 10, 11]));
  const afterReset = queue.enqueue(bytes([12]));
  assert.equal(afterReset.overflowStarted, true);
  assert.equal(afterReset.totalDroppedBytes, 3);
});

test('clearPending keeps cumulative overflow state but clears the pending frame', () => {
  const queue = new SerialRxQueue({ maxBytes: 3, maxChunks: 10 });
  queue.enqueue(bytes([1, 2, 3]));
  queue.enqueue(bytes([4]));

  queue.clearPending();
  assert.equal(queue.pendingBytes, 0);
  assert.equal(queue.droppedSinceDrain, 0);
  assert.equal(queue.totalDroppedBytes, 3);

  queue.enqueue(bytes([5, 6, 7]));
  const nextDrop = queue.enqueue(bytes([8]));
  assert.equal(nextDrop.overflowStarted, false);
  assert.equal(nextDrop.totalDroppedBytes, 6);
});

test('rejects invalid queue limits', () => {
  assert.throws(() => new SerialRxQueue({ maxBytes: 0, maxChunks: 1 }), RangeError);
  assert.throws(() => new SerialRxQueue({ maxBytes: 1, maxChunks: Number.NaN }), RangeError);
});

test('drain copies only the live suffix when an old prefix has not yet compacted', () => {
  const queue = new SerialRxQueue({ maxBytes: 3, maxChunks: 10 });
  queue.enqueue(bytes([1]));
  queue.enqueue(bytes([2]));
  queue.enqueue(bytes([3]));
  queue.enqueue(bytes([4]));

  const drained = queue.drain();
  assert.deepEqual(flatten(drained.chunks), [2, 3, 4]);
});
