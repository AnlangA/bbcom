import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SERIAL_WRITE_CHUNK_BYTES,
  SERIAL_WRITE_MAX_OPERATIONS,
  SERIAL_WRITE_MAX_QUEUED_BYTES,
  SerialWriteScheduler,
} from '../../src/lib/serial-write-scheduler.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('writes one logical payload in ordered chunks of at most 4096 bytes', async () => {
  const payload = Uint8Array.from({ length: 10_000 }, (_, index) => index & 0xff);
  const written: number[] = [];
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    written.push(...chunk);
    assert.ok(chunk.length <= SERIAL_WRITE_CHUNK_BYTES);
    return chunk.length;
  });

  const result = await scheduler.enqueue(payload);

  assert.deepEqual(result, {
    status: 'complete',
    ok: true,
    requestedBytes: payload.length,
    confirmedBytes: payload.length,
    bytesWritten: payload.length,
    reason: null,
  });
  assert.deepEqual(written, Array.from(payload));
  assert.deepEqual(scheduler.stats, {
    outstandingOperations: 0,
    outstandingBytes: 0,
    queuedOperations: 0,
    active: false,
    accepting: true,
  });
});

test('writes a full 1 MiB payload as exactly 256 driver chunks', async () => {
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    assert.equal(chunk.length, SERIAL_WRITE_CHUNK_BYTES);
    return chunk.length;
  });

  const result = await scheduler.enqueue(new Uint8Array(1024 * 1024));

  assert.equal(result.ok, true);
  assert.equal(result.bytesWritten, 1024 * 1024);
  assert.equal(calls, 256);
});

test('continues a positive short write from the unwritten suffix', async () => {
  const calls: number[] = [];
  const accepted: number[] = [];
  const returns = [1000, 3096, 904];
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls.push(chunk.length);
    const count = returns.shift() ?? chunk.length;
    accepted.push(...chunk.subarray(0, count));
    return count;
  });
  const payload = Uint8Array.from({ length: 5000 }, (_, index) => index & 0xff);

  const result = await scheduler.enqueue(payload);

  assert.equal(result.ok, true);
  assert.equal(result.bytesWritten, 5000);
  assert.deepEqual(calls, [4096, 3096, 904]);
  assert.deepEqual(accepted, Array.from(payload));
});

test('stops on the first driver error without retrying and reports the written prefix', async () => {
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    if (calls === 3) throw new Error('device write failed');
    return chunk.length;
  });

  const result = await scheduler.enqueue(new Uint8Array(10_000));

  assert.equal(calls, 3);
  assert.deepEqual(result, {
    status: 'partial-unknown',
    ok: false,
    requestedBytes: 10_000,
    confirmedBytes: 8192,
    bytesWritten: 8192,
    reason: 'write-error',
    code: 'SERIAL_PARTIAL_WRITE',
    error: 'device write failed',
  });
});

test('zero or invalid driver progress fails without another call', async () => {
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async () => {
    calls += 1;
    return 0;
  });

  const result = await scheduler.enqueue(new Uint8Array(8));

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-stalled');
  assert.equal(result.bytesWritten, 0);
});

test('validates limits and rejects an empty logical send without reaching the driver', async () => {
  const write = async (_chunk: Uint8Array) => 1;
  assert.throws(() => new SerialWriteScheduler(write, { maxOperations: 0 }), RangeError);
  assert.throws(() => new SerialWriteScheduler(write, { maxQueuedBytes: 0 }), RangeError);
  assert.throws(() => new SerialWriteScheduler(write, { chunkBytes: 0 }), RangeError);
  assert.throws(() => new SerialWriteScheduler(write, { chunkBytes: 1.5 }), RangeError);

  let calls = 0;
  const scheduler = new SerialWriteScheduler(async () => {
    calls += 1;
    return 1;
  });
  assert.deepEqual(await scheduler.enqueue(new Uint8Array()), {
    status: 'rejected',
    ok: false,
    requestedBytes: 0,
    confirmedBytes: 0,
    bytesWritten: 0,
    reason: 'empty',
    code: 'INVALID_INPUT',
  });
  assert.equal(calls, 0);
  assert.deepEqual(await scheduler.shutdown(0), { timedOut: false });
});

test('copies a queued payload so caller mutation cannot alter the later driver write', async () => {
  const firstWrite = deferred<number>();
  const received: number[][] = [];
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    received.push(Array.from(chunk));
    return calls === 1 ? firstWrite.promise : chunk.length;
  });
  const first = scheduler.enqueue(Uint8Array.of(1));
  const queuedPayload = Uint8Array.of(2, 3, 4);
  const second = scheduler.enqueue(queuedPayload);
  queuedPayload.fill(0xff);

  firstWrite.resolve(1);
  assert.equal((await first).status, 'complete');
  assert.equal((await second).status, 'complete');
  assert.deepEqual(received, [[1], [2, 3, 4]]);
});

test('reports a callback failure without attempting a device write', async () => {
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    return chunk.length;
  });

  const result = await scheduler.enqueue(Uint8Array.of(1), {
    onWriteStarted: () => {
      throw new Error('start hook failed');
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, {
    status: 'partial-unknown',
    ok: false,
    requestedBytes: 1,
    confirmedBytes: 0,
    bytesWritten: 0,
    reason: 'write-error',
    code: 'SERIAL_PARTIAL_WRITE',
    error: 'start hook failed',
  });
});

test('shutdown reports no timeout when the active write settles inside the grace period', async () => {
  const activeWrite = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => activeWrite.promise);
  const pending = scheduler.enqueue(Uint8Array.of(1));
  const shutdown = scheduler.shutdown(50);

  activeWrite.resolve(1);
  assert.deepEqual(await shutdown, { timedOut: false });
  assert.equal((await pending).status, 'complete');
  assert.deepEqual(scheduler.stats, {
    outstandingOperations: 0,
    outstandingBytes: 0,
    queuedOperations: 0,
    active: false,
    accepting: false,
  });
});

test('enforces the 256-operation bound including the active operation', async () => {
  const active = deferred<number>();
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    if (calls === 1) return active.promise;
    return chunk.length;
  });

  const accepted = Array.from({ length: SERIAL_WRITE_MAX_OPERATIONS }, () =>
    scheduler.enqueue(new Uint8Array([1])),
  );
  const rejected = await scheduler.enqueue(new Uint8Array([2]));

  assert.equal(scheduler.stats.outstandingOperations, SERIAL_WRITE_MAX_OPERATIONS);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'queue-full');
  active.resolve(1);
  const results = await Promise.all(accepted);
  assert.equal(
    results.every((result) => result.ok),
    true,
  );
});

test('allows exactly 4 MiB outstanding and rejects one additional byte', async () => {
  const active = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => active.promise);
  const accepted = scheduler.enqueue(new Uint8Array(SERIAL_WRITE_MAX_QUEUED_BYTES));

  assert.equal(scheduler.stats.outstandingBytes, SERIAL_WRITE_MAX_QUEUED_BYTES);
  const rejected = await scheduler.enqueue(new Uint8Array([1]));
  assert.equal(rejected.reason, 'queue-full');

  const shutdown = await scheduler.shutdown(0);
  assert.equal(shutdown.timedOut, true);
  assert.equal((await accepted).reason, 'disconnecting');
  active.resolve(SERIAL_WRITE_CHUNK_BYTES);
});

test('shutdown rejects queued operations immediately and force-settles one active write', async () => {
  const active = deferred<number>();
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async () => {
    calls += 1;
    return active.promise;
  });
  const first = scheduler.enqueue(new Uint8Array(16));
  const second = scheduler.enqueue(new Uint8Array(16));
  const third = scheduler.enqueue(new Uint8Array(16));

  const closing = scheduler.shutdown(5);
  assert.equal((await second).reason, 'disconnecting');
  assert.equal((await third).reason, 'disconnecting');
  assert.deepEqual(await closing, { timedOut: true });
  assert.equal((await first).reason, 'disconnecting');
  assert.equal(calls, 1, 'shutdown never starts another queued write');
  assert.equal(scheduler.stats.outstandingOperations, 0);
  assert.equal(scheduler.stats.outstandingBytes, 0);
  const afterClose = await scheduler.enqueue(new Uint8Array([1]));
  assert.equal(afterClose.reason, 'disconnecting');
  active.resolve(16);
});

test('onWriteStarted runs only after the operation reaches the writer', async () => {
  const active = deferred<number>();
  const starts: string[] = [];
  let calls = 0;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    if (calls === 1) return active.promise;
    return chunk.length;
  });
  const first = scheduler.enqueue(new Uint8Array([1]), {
    onWriteStarted: () => starts.push('first'),
  });
  const second = scheduler.enqueue(new Uint8Array([2]), {
    onWriteStarted: () => starts.push('second'),
  });

  assert.deepEqual(starts, ['first']);
  active.resolve(1);
  await first;
  await second;
  assert.deepEqual(starts, ['first', 'second']);
});
