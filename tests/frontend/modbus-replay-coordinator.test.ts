import test from 'node:test';
import assert from 'node:assert/strict';
import { ModbusReplayCoordinator } from '../../src/lib/modbus';

interface TestReplayItem {
  ts: number;
  id: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), message);
}

test('replays timestamped items in sorted relative order and reports progress', async () => {
  const ran: string[] = [];
  const progress: number[] = [];
  let idleCount = 0;

  const replay = new ModbusReplayCoordinator<TestReplayItem>({
    runItem: async (item) => {
      ran.push(item.id);
    },
    onProgress: (remaining) => progress.push(remaining),
    onIdle: () => {
      idleCount += 1;
    },
  });

  assert.equal(
    replay.start([
      { ts: 40, id: 'third' },
      { ts: 0, id: 'first' },
      { ts: 20, id: 'second' },
    ]),
    true,
  );

  await waitFor(() => idleCount === 1, 140, 'replay should finish');

  assert.deepEqual(ran, ['first', 'second', 'third']);
  assert.deepEqual(progress, [3, 2, 1, 0]);
  assert.equal(replay.isRunning(), false);
  assert.equal(replay.remaining(), 0);
});

test('stop clears queued timers and reports idle once', async () => {
  const ran: string[] = [];
  let idleCount = 0;
  const replay = new ModbusReplayCoordinator<TestReplayItem>({
    runItem: async (item) => {
      ran.push(item.id);
    },
    onIdle: () => {
      idleCount += 1;
    },
  });

  replay.start([
    { ts: 0, id: 'now' },
    { ts: 60, id: 'later' },
  ]);

  await waitFor(() => ran.length === 1, 60, 'first replay item should run');
  assert.equal(replay.stop(), true);
  await delay(90);

  assert.deepEqual(ran, ['now']);
  assert.equal(idleCount, 1);
  assert.equal(replay.isRunning(), false);
});

test('restart ignores an older in-flight item when it eventually resolves', async () => {
  const ran: string[] = [];
  let releaseOld: (() => void) | null = null;
  const replay = new ModbusReplayCoordinator<TestReplayItem>({
    runItem: async (item) => {
      ran.push(item.id);
      if (item.id === 'old') {
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      }
    },
  });

  replay.start([
    { ts: 0, id: 'old' },
    { ts: 10, id: 'old-next' },
  ]);
  await waitFor(() => ran.includes('old'), 60, 'old replay item should start');

  replay.start([{ ts: 0, id: 'new' }]);
  await waitFor(() => ran.includes('new'), 60, 'new replay item should run');

  assert.ok(releaseOld);
  releaseOld();
  await delay(60);

  assert.deepEqual(ran, ['old', 'new']);
  assert.equal(replay.isRunning(), false);
});

test('restart suppresses errors from an older in-flight item', async () => {
  const errors: unknown[] = [];
  let rejectOld: (() => void) | null = null;
  const replay = new ModbusReplayCoordinator<TestReplayItem>({
    runItem: async (item) => {
      if (item.id === 'old') {
        await new Promise<void>((resolve) => {
          rejectOld = resolve;
        });
        throw new Error('old replay failed late');
      }
    },
    onError: (error) => errors.push(error),
  });

  replay.start([{ ts: 0, id: 'old' }]);
  await waitFor(() => rejectOld !== null, 60, 'old replay item should start');

  replay.start([{ ts: 0, id: 'new' }]);
  await waitFor(() => replay.isRunning() === false, 60, 'new replay should finish');

  assert.ok(rejectOld);
  rejectOld();
  await delay(30);

  assert.deepEqual(errors, []);
});

test('empty replay input is a no-op', () => {
  let progressCount = 0;
  let idleCount = 0;
  const replay = new ModbusReplayCoordinator<TestReplayItem>({
    runItem: async () => {},
    onProgress: () => {
      progressCount += 1;
    },
    onIdle: () => {
      idleCount += 1;
    },
  });

  assert.equal(replay.start([]), false);
  assert.equal(replay.isRunning(), false);
  assert.equal(progressCount, 0);
  assert.equal(idleCount, 0);
});
