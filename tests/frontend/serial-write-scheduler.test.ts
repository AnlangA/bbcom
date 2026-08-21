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

const PARTIAL_WRITE_ERROR = {
  code: 'SERIAL_PARTIAL_WRITE',
  messageKey: 'error.serial_partial_write',
  retryable: false,
  operation: 'serial_send',
} as const;

const CANCELLED_ERROR = {
  code: 'CANCELLED',
  messageKey: 'error.cancelled',
  retryable: false,
  operation: 'serial_send',
} as const;

const SECURITY_DENIED_ERROR = {
  code: 'SECURITY_DENIED',
  messageKey: 'error.security_denied',
  retryable: false,
  operation: 'serial_send',
} as const;

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
    outcome: 'complete',
    requestedBytes: payload.length,
    sentBytes: payload.length,
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

  assert.equal(result.outcome, 'complete');
  assert.equal(result.sentBytes, 1024 * 1024);
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

  assert.equal(result.outcome, 'complete');
  assert.equal(result.sentBytes, 5000);
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
    outcome: 'partial',
    requestedBytes: 10_000,
    sentBytes: 8192,
    error: PARTIAL_WRITE_ERROR,
  });
  assert.doesNotMatch(JSON.stringify(result), /device write failed/);
});

test('zero or invalid driver progress fails without another call', async () => {
  for (const invalidProgress of [0, -1, Number.NaN, 1.5, 9]) {
    let calls = 0;
    const scheduler = new SerialWriteScheduler(async () => {
      calls += 1;
      return invalidProgress;
    });

    const result = await scheduler.enqueue(new Uint8Array(8));

    assert.equal(calls, 1);
    assert.deepEqual(result, {
      outcome: 'failed',
      requestedBytes: 8,
      sentBytes: 0,
      error: PARTIAL_WRITE_ERROR,
    });
  }
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
    outcome: 'failed',
    requestedBytes: 0,
    sentBytes: 0,
    error: {
      code: 'INVALID_INPUT',
      messageKey: 'error.invalid_input',
      retryable: false,
      operation: 'serial_send',
      field: 'payload',
    },
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
  assert.equal((await first).outcome, 'complete');
  assert.equal((await second).outcome, 'complete');
  assert.deepEqual(received, [[1], [2, 3, 4]]);
});

test('waitForIdle proves both the queued FIFO and active physical call are drained', async () => {
  const physical = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => physical.promise);
  const write = scheduler.enqueue(Uint8Array.of(1));
  let drained = false;
  const idle = scheduler.waitForIdle().then(() => {
    drained = true;
  });

  await Promise.resolve();
  assert.equal(drained, false);
  physical.resolve(1);
  assert.equal((await write).outcome, 'complete');
  await idle;
  assert.equal(drained, true);
  await scheduler.waitForIdle();
});

test('waitForIdle cancellation detaches only that waiter and never cancels the write', async () => {
  const physical = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => physical.promise);
  const write = scheduler.enqueue(Uint8Array.of(1));
  const cancellation = new AbortController();
  const cancelled = scheduler.waitForIdle(cancellation.signal);
  const surviving = scheduler.waitForIdle();
  cancellation.abort();

  await assert.rejects(cancelled, /drain cancelled/u);
  physical.resolve(1);
  assert.equal((await write).outcome, 'complete');
  await surviving;

  const alreadyCancelled = new AbortController();
  const secondPhysical = deferred<number>();
  const secondScheduler = new SerialWriteScheduler(() => secondPhysical.promise);
  const secondWrite = secondScheduler.enqueue(Uint8Array.of(2));
  alreadyCancelled.abort();
  await assert.rejects(secondScheduler.waitForIdle(alreadyCancelled.signal), /drain cancelled/u);
  secondPhysical.resolve(1);
  await secondWrite;
});

test('admission gate rejects missing or forged provenance and revalidates every physical chunk', async () => {
  let ownerId = 'session-1';
  const chunks: number[][] = [];
  const scheduler = new SerialWriteScheduler(
    async (chunk) => {
      chunks.push(Array.from(chunk));
      ownerId = 'revoked';
      return chunk.length;
    },
    { chunkBytes: 2 },
    {
      authorize(admission) {
        return admission.source === 'host' && admission.ownerId === ownerId;
      },
    },
  );

  await expectDenied(scheduler.enqueue(Uint8Array.of(1)));
  await expectDenied(
    scheduler.enqueue(Uint8Array.of(1), {}, { source: 'host', ownerId: 'other-session' }),
  );

  ownerId = 'session-1';
  assert.deepEqual(
    await scheduler.enqueue(Uint8Array.of(1, 2, 3), {}, { source: 'host', ownerId: 'session-1' }),
    {
      outcome: 'partial',
      requestedBytes: 3,
      sentBytes: 2,
      error: SECURITY_DENIED_ERROR,
    },
  );
  assert.deepEqual(chunks, [[1, 2]]);
});

async function expectDenied(result: Promise<unknown>): Promise<void> {
  assert.deepEqual(await result, {
    outcome: 'failed',
    requestedBytes: 1,
    sentBytes: 0,
    error: SECURITY_DENIED_ERROR,
  });
}

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
    outcome: 'failed',
    requestedBytes: 1,
    sentBytes: 0,
    error: PARTIAL_WRITE_ERROR,
  });
  assert.doesNotMatch(JSON.stringify(result), /start hook failed/);
});

test('shutdown reports no timeout when the active write settles inside the grace period', async () => {
  const activeWrite = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => activeWrite.promise);
  const pending = scheduler.enqueue(Uint8Array.of(1));
  const shutdown = scheduler.shutdown(50);

  activeWrite.resolve(1);
  assert.deepEqual(await shutdown, { timedOut: false });
  assert.deepEqual(await pending, {
    outcome: 'cancelled',
    requestedBytes: 1,
    sentBytes: 1,
    error: CANCELLED_ERROR,
  });
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
  assert.equal(rejected.outcome, 'failed');
  assert.equal(rejected.error?.code, 'SERIAL_QUEUE_FULL');
  active.resolve(1);
  const results = await Promise.all(accepted);
  assert.equal(
    results.every((result) => result.outcome === 'complete'),
    true,
  );
});

test('allows exactly 4 MiB outstanding and rejects one additional byte', async () => {
  const active = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => active.promise);
  const accepted = scheduler.enqueue(new Uint8Array(SERIAL_WRITE_MAX_QUEUED_BYTES));

  assert.equal(scheduler.stats.outstandingBytes, SERIAL_WRITE_MAX_QUEUED_BYTES);
  const rejected = await scheduler.enqueue(new Uint8Array([1]));
  assert.equal(rejected.outcome, 'failed');
  assert.equal(rejected.error?.code, 'SERIAL_QUEUE_FULL');

  const shutdown = await scheduler.shutdown(0);
  assert.equal(shutdown.timedOut, true);
  assert.equal((await accepted).outcome, 'cancelled');
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
  assert.deepEqual(await second, {
    outcome: 'cancelled',
    requestedBytes: 16,
    sentBytes: 0,
    error: CANCELLED_ERROR,
  });
  assert.equal((await third).outcome, 'cancelled');
  assert.deepEqual(await closing, { timedOut: true });
  assert.equal((await first).outcome, 'cancelled');
  assert.equal(calls, 1, 'shutdown never starts another queued write');
  assert.equal(scheduler.stats.outstandingOperations, 0);
  assert.equal(scheduler.stats.outstandingBytes, 0);
  const afterClose = await scheduler.enqueue(new Uint8Array([1]));
  assert.equal(afterClose.outcome, 'cancelled');
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

test('shutdown requested by onWriteStarted cancels before the first driver call', async () => {
  let calls = 0;
  let shutdown!: Promise<{ timedOut: boolean }>;
  const scheduler = new SerialWriteScheduler(async (chunk) => {
    calls += 1;
    return chunk.length;
  });

  const pending = scheduler.enqueue(Uint8Array.of(1), {
    onWriteStarted: () => {
      shutdown = scheduler.shutdown(50);
    },
  });

  assert.deepEqual(await pending, {
    outcome: 'cancelled',
    requestedBytes: 1,
    sentBytes: 0,
    error: CANCELLED_ERROR,
  });
  assert.deepEqual(await shutdown, { timedOut: false });
  assert.equal(calls, 0);
});

test('a driver rejection after shutdown is classified as cancellation', async () => {
  const write = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => write.promise);
  const pending = scheduler.enqueue(Uint8Array.of(1));
  const shutdown = scheduler.shutdown(50);

  write.reject(new Error('late driver rejection'));

  assert.equal((await pending).outcome, 'cancelled');
  assert.deepEqual(await shutdown, { timedOut: false });
});

test('invalid driver progress after shutdown is classified as cancellation', async () => {
  const write = deferred<number>();
  const scheduler = new SerialWriteScheduler(() => write.promise);
  const pending = scheduler.enqueue(Uint8Array.of(1));
  const shutdown = scheduler.shutdown(50);

  write.resolve(0);

  assert.equal((await pending).outcome, 'cancelled');
  assert.deepEqual(await shutdown, { timedOut: false });
});

test('defensive settled guards ignore an operation invalidated before its first chunk', async () => {
  type InternalOperation = {
    payload: Uint8Array;
    sentBytes: number;
    settled: boolean;
  };
  type InternalScheduler = {
    activeOperation: InternalOperation | null;
    settle(
      operation: InternalOperation,
      result: typeof CANCELLED_ERROR extends never ? never : unknown,
    ): void;
  };

  let operation: InternalOperation | null = null;
  const scheduler = new SerialWriteScheduler(async (chunk) => chunk.length);
  const pending = scheduler.enqueue(Uint8Array.of(1), {
    onWriteStarted: () => {
      operation = (scheduler as unknown as InternalScheduler).activeOperation;
      assert.ok(operation);
      operation.settled = true;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(operation);

  operation.settled = false;
  const cancelledResult = {
    outcome: 'cancelled',
    requestedBytes: 1,
    sentBytes: 0,
    error: CANCELLED_ERROR,
  } as const;
  const internal = scheduler as unknown as InternalScheduler;
  internal.settle(operation, cancelledResult);
  internal.settle(operation, cancelledResult);

  assert.deepEqual(await pending, cancelledResult);
});
