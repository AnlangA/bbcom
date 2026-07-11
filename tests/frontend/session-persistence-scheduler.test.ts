import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  SESSION_CONFIG_DEBOUNCE_MS,
  SESSION_FINAL_FLUSH_TIMEOUT_MS,
  SESSION_FRAME_CHECKPOINT_MS,
  SessionPersistenceScheduler,
  type SessionPersistenceTimerScheduler,
} from '../../src/lib/session-persistence-scheduler.ts';

class FakeTimers implements SessionPersistenceTimerScheduler {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

test('configuration persistence uses a trailing 500 ms debounce', async () => {
  const timers = new FakeTimers();
  const flushes: boolean[] = [];
  const scheduler = new SessionPersistenceScheduler(
    async (includeFrames) => {
      flushes.push(includeFrames);
    },
    { timers },
  );

  scheduler.markConfigDirty();
  timers.advance(400);
  scheduler.markConfigDirty();
  timers.advance(499);
  assert.deepEqual(flushes, []);
  timers.advance(1);
  await Promise.resolve();
  assert.deepEqual(flushes, [false]);
  assert.equal(SESSION_CONFIG_DEBOUNCE_MS, 500);
});

test('frame traffic keeps one non-sliding 10 second checkpoint', async () => {
  const timers = new FakeTimers();
  const flushes: boolean[] = [];
  const scheduler = new SessionPersistenceScheduler(
    async (includeFrames) => {
      flushes.push(includeFrames);
    },
    { timers },
  );

  scheduler.markFramesDirty();
  timers.advance(9_000);
  scheduler.markFramesDirty();
  timers.advance(999);
  assert.deepEqual(flushes, []);
  timers.advance(1);
  await Promise.resolve();
  assert.deepEqual(flushes, [true]);
  assert.equal(SESSION_FRAME_CHECKPOINT_MS, 10_000);
});

test('a frame checkpoint subsumes a pending configuration write', async () => {
  const timers = new FakeTimers();
  const flushes: boolean[] = [];
  const scheduler = new SessionPersistenceScheduler(
    async (includeFrames) => {
      flushes.push(includeFrames);
    },
    { timers },
  );

  scheduler.markFramesDirty();
  timers.advance(9_750);
  scheduler.markConfigDirty();
  timers.advance(250);
  await Promise.resolve();
  assert.deepEqual(flushes, [true]);
  timers.advance(250);
  assert.deepEqual(flushes, [true]);
});

test('an MRU metadata change checkpoints matching frame tails after 500 ms', async () => {
  const timers = new FakeTimers();
  const flushes: boolean[] = [];
  const scheduler = new SessionPersistenceScheduler(
    async (includeFrames) => {
      flushes.push(includeFrames);
    },
    { timers },
  );

  scheduler.markFramesDirty();
  scheduler.markConfigDirty(true);
  timers.advance(SESSION_CONFIG_DEBOUNCE_MS);
  await Promise.resolve();
  assert.deepEqual(flushes, [true]);
  timers.advance(SESSION_FRAME_CHECKPOINT_MS);
  assert.deepEqual(flushes, [true]);
});

test('final persistence stops waiting at the two second deadline', async () => {
  const timers = new FakeTimers();
  let release!: () => void;
  const scheduler = new SessionPersistenceScheduler(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    { timers },
  );

  let outcome: string | null = null;
  const final = scheduler.flushFinal().then((value) => {
    outcome = value;
  });
  timers.advance(SESSION_FINAL_FLUSH_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(outcome, null);
  timers.advance(1);
  await final;
  assert.equal(outcome, 'timeout');
  release();
});
