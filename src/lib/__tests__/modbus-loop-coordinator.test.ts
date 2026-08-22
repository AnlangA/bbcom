import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ModbusLoopCoordinator } from '@/lib/modbus';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), message);
}

test('overdue write runs after a slow read releases the bus', async () => {
  const events: string[] = [];
  let releaseRead: (() => void) | null = null;
  const coordinator = new ModbusLoopCoordinator({
    shouldRunRead: () => true,
    shouldRunWrite: () => true,
    getReadIntervalMs: () => 100,
    getWriteIntervalMs: () => 100,
    runRead: async () => {
      events.push('read:start');
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      events.push('read:end');
    },
    runWrite: async () => {
      events.push('write');
    },
  });

  try {
    coordinator.start();
    await waitFor(() => events.includes('read:start'), 160, 'read did not start');
    await delay(130);
    assert.deepEqual(events, ['read:start']);

    assert.ok(releaseRead);
    releaseRead();
    await waitFor(() => events.includes('write'), 120, 'overdue write did not run');
    assert.deepEqual(events.slice(0, 3), ['read:start', 'read:end', 'write']);
  } finally {
    coordinator.stop();
  }
});

test('pause clears timers and resume arms a fresh loop', async () => {
  let reads = 0;
  const coordinator = new ModbusLoopCoordinator({
    shouldRunRead: () => true,
    shouldRunWrite: () => false,
    getReadIntervalMs: () => 100,
    getWriteIntervalMs: () => 100,
    runRead: async () => {
      reads += 1;
    },
    runWrite: async () => {},
  });

  try {
    coordinator.start();
    await waitFor(() => reads >= 1, 160, 'initial read did not run');

    coordinator.pause();
    const pausedAt = reads;
    await delay(140);
    assert.equal(reads, pausedAt);

    coordinator.resume();
    await waitFor(() => reads > pausedAt, 160, 'read did not resume');
  } finally {
    coordinator.stop();
  }
});

test('runExclusive defers due loops until the manual operation finishes', async () => {
  let writes = 0;
  const coordinator = new ModbusLoopCoordinator({
    shouldRunRead: () => false,
    shouldRunWrite: () => true,
    getReadIntervalMs: () => 100,
    getWriteIntervalMs: () => 100,
    runRead: async () => {},
    runWrite: async () => {
      writes += 1;
    },
  });

  try {
    coordinator.start();
    const manual = coordinator.runExclusive(async () => {
      await delay(160);
    });

    await delay(130);
    assert.equal(writes, 0);

    await manual;
    await waitFor(() => writes >= 1, 120, 'deferred write did not run');
  } finally {
    coordinator.stop();
  }
});

test('stop clears armed timers', async () => {
  let reads = 0;
  const coordinator = new ModbusLoopCoordinator({
    shouldRunRead: () => true,
    shouldRunWrite: () => false,
    getReadIntervalMs: () => 100,
    getWriteIntervalMs: () => 100,
    runRead: async () => {
      reads += 1;
    },
    runWrite: async () => {},
  });

  coordinator.start();
  coordinator.stop();
  await delay(140);
  assert.equal(reads, 0);
});

test('waitForIdle observes an exclusive operation and supports cancellation', async () => {
  let finish!: () => void;
  const coordinator = new ModbusLoopCoordinator({
    shouldRunRead: () => false,
    shouldRunWrite: () => false,
    getReadIntervalMs: () => 100,
    getWriteIntervalMs: () => 100,
    runRead: async () => {},
    runWrite: async () => {},
  });
  const operation = coordinator.runExclusive(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const cancellation = new AbortController();
  const cancelled = coordinator.waitForIdle(cancellation.signal);
  const idle = coordinator.waitForIdle();
  cancellation.abort();
  await assert.rejects(cancelled, /pause cancelled/u);
  finish();
  await operation;
  await idle;
  await coordinator.waitForIdle();
});
