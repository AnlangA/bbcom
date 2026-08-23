import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  AsyncSendLoop,
  type LoopScheduler,
} from '@/features/serial/application/async-send-loop.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test('does not schedule the next tick until the active send settles', async () => {
  const active = deferred();
  const scheduled: Array<() => void> = [];
  const delays: number[] = [];
  const scheduler: LoopScheduler = {
    schedule(callback, delayMs) {
      scheduled.push(callback);
      delays.push(delayMs);
      return callback;
    },
    cancel() {},
  };
  let sends = 0;
  const loop = new AsyncSendLoop(
    async () => {
      sends += 1;
      await active.promise;
    },
    () => 50,
    undefined,
    scheduler,
  );

  assert.equal(loop.start(), true);
  assert.equal(loop.start(), false, 'a second start cannot enqueue another send');
  assert.equal(sends, 1);
  assert.equal(scheduled.length, 0);

  active.resolve();
  await flushMicrotasks();
  assert.equal(scheduled.length, 1);
  assert.deepEqual(delays, [50]);
});

test('stop invalidates an in-flight generation and cancels scheduled work', async () => {
  const active = deferred();
  const scheduled: Array<() => void> = [];
  const cancelled: unknown[] = [];
  const scheduler: LoopScheduler = {
    schedule(callback) {
      scheduled.push(callback);
      return callback;
    },
    cancel(handle) {
      cancelled.push(handle);
    },
  };
  let sends = 0;
  const loop = new AsyncSendLoop(
    async () => {
      sends += 1;
      await active.promise;
    },
    () => 1,
    undefined,
    scheduler,
  );

  loop.start();
  loop.stop();
  active.resolve();
  await flushMicrotasks();
  assert.equal(scheduled.length, 0, 'settled stale send must not schedule a tick');
  assert.equal(sends, 1);

  const immediate = new AsyncSendLoop(
    async () => undefined,
    () => 1,
    undefined,
    scheduler,
  );
  immediate.start();
  await flushMicrotasks();
  assert.equal(scheduled.length, 1);
  immediate.stop();
  assert.equal(cancelled.length, 1);
});

test('default scheduler clamps invalid intervals and contains task failures', async () => {
  vi.useFakeTimers();
  try {
    const loop = new AsyncSendLoop(
      async () => {
        throw new Error('driver rejected write');
      },
      () => -10,
    );

    assert.equal(loop.isRunning, false);
    assert.equal(loop.isScheduled, false);
    assert.equal(loop.start(), true);
    await vi.runAllTicks();
    assert.equal(loop.isRunning, true);
    assert.equal(loop.isScheduled, true);
    loop.stop();
    assert.equal(loop.isRunning, false);
    assert.equal(loop.isScheduled, false);
  } finally {
    vi.useRealTimers();
  }
});
