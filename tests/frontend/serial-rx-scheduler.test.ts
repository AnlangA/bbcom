import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SERIAL_RX_DRAIN_INTERVAL_MS,
  SERIAL_UI_HIDDEN_INTERVAL_MS,
  SERIAL_UI_VISIBLE_INTERVAL_MS,
  SerialRxDrainScheduler,
  SerialUiPublishScheduler,
  type SerialTimerScheduler,
} from '../../src/lib/serial-rx-scheduler.ts';

function fakeScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const microtasks: Array<() => void> = [];
  const scheduler: SerialTimerScheduler = {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(handle) {
      (handle as (typeof timers)[number]).cancelled = true;
    },
    microtask(callback) {
      microtasks.push(callback);
    },
  };
  return {
    scheduler,
    timers,
    microtasks,
    runMicrotasks() {
      while (microtasks.length > 0) microtasks.shift()?.();
    },
    runTimer(index: number) {
      const timer = timers[index];
      if (timer && !timer.cancelled) timer.callback();
    },
  };
}

test('small RX bursts restart the configurable inactivity timer', () => {
  const fake = fakeScheduler();
  const pending = { bytes: 1024, chunks: 1 };
  let drains = 0;
  const drain = new SerialRxDrainScheduler(
    () => pending,
    () => {
      drains += 1;
      pending.bytes = 0;
      pending.chunks = 0;
    },
    fake.scheduler,
  );

  drain.notify();
  assert.equal(fake.timers.length, 1);
  assert.equal(fake.timers[0].delay, SERIAL_RX_DRAIN_INTERVAL_MS);
  drain.notify();
  assert.equal(fake.timers.length, 2);
  assert.equal(fake.timers[0].cancelled, true);
  assert.equal(drains, 0);
  fake.runTimer(1);
  assert.equal(drains, 1);
});

test('RX inactivity gap accepts a per-session duration', () => {
  const fake = fakeScheduler();
  const pending = { bytes: 1, chunks: 1 };
  const drain = new SerialRxDrainScheduler(
    () => pending,
    () => Object.assign(pending, { bytes: 0, chunks: 0 }),
    fake.scheduler,
    2,
  );

  drain.notify();
  assert.equal(fake.timers[0].delay, 2);
});

test('64 KiB or 64 chunks cancels the timer and drains on one microtask', () => {
  for (const threshold of [
    { bytes: 64 * 1024, chunks: 1 },
    { bytes: 64, chunks: 64 },
  ]) {
    const fake = fakeScheduler();
    const pending = { bytes: 1, chunks: 1 };
    let drains = 0;
    const drain = new SerialRxDrainScheduler(
      () => pending,
      () => {
        drains += 1;
        pending.bytes = 0;
        pending.chunks = 0;
      },
      fake.scheduler,
    );
    drain.notify();
    Object.assign(pending, threshold);
    drain.notify();
    drain.notify();
    assert.equal(fake.timers[0].cancelled, true);
    assert.equal(fake.microtasks.length, 1);
    fake.runMicrotasks();
    assert.equal(drains, 1);
  }
});

test('cancel invalidates an already queued RX microtask', () => {
  const fake = fakeScheduler();
  const pending = { bytes: 64 * 1024, chunks: 1 };
  let drains = 0;
  const drain = new SerialRxDrainScheduler(
    () => pending,
    () => {
      drains += 1;
    },
    fake.scheduler,
  );
  drain.notify();
  drain.cancel();
  fake.runMicrotasks();
  assert.equal(drains, 0);
});

test('UI publisher uses 17ms visible and 250ms hidden cadence', () => {
  const fake = fakeScheduler();
  let visible = true;
  let publishes = 0;
  const publisher = new SerialUiPublishScheduler(
    () => {
      publishes += 1;
    },
    () => visible,
    fake.scheduler,
  );

  publisher.markDirty();
  publisher.markDirty();
  assert.equal(fake.timers.length, 1);
  assert.equal(fake.timers[0].delay, SERIAL_UI_VISIBLE_INTERVAL_MS);

  visible = false;
  publisher.visibilityChanged();
  assert.equal(fake.timers[0].cancelled, true);
  assert.equal(fake.timers[1].delay, SERIAL_UI_HIDDEN_INTERVAL_MS);
  fake.runTimer(1);
  assert.equal(publishes, 1);

  publisher.markDirty();
  assert.equal(fake.timers[2].delay, SERIAL_UI_HIDDEN_INTERVAL_MS);
  publisher.flushNow();
  assert.equal(fake.timers[2].cancelled, true);
  assert.equal(publishes, 2);
});

test('stale callbacks and clean publishers are harmless', () => {
  const fake = fakeScheduler();
  let pending = { bytes: 1, chunks: 1 };
  let drains = 0;
  const drain = new SerialRxDrainScheduler(
    () => pending,
    () => {
      drains += 1;
      pending = { bytes: 0, chunks: 0 };
    },
    fake.scheduler,
  );
  drain.notify();
  const staleDrain = fake.timers[0].callback;
  drain.cancel();
  staleDrain();
  assert.equal(drains, 0);
  drain.flushNow();
  assert.equal(drains, 1);

  let publishes = 0;
  const publisher = new SerialUiPublishScheduler(
    () => {
      publishes += 1;
    },
    () => true,
    fake.scheduler,
  );
  publisher.visibilityChanged();
  publisher.flushNow();
  publisher.markDirty();
  const stalePublish = fake.timers.at(-1)!.callback;
  publisher.cancel();
  stalePublish();
  assert.equal(publishes, 0);
});
