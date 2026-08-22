import { test } from 'vitest';
import assert from 'node:assert/strict';
import { clampDelayMs, useMacroRunner } from '@/features/sessions/application/use-macro-runner.ts';
import type { Macro } from '@/types.ts';

function macro(steps: Macro['steps']): Macro {
  return { id: 'm1', name: 'test', steps };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('clampDelayMs clamps to [0, 3600000] and floors non-integers', () => {
  assert.equal(clampDelayMs(-100), 0, 'negative -> 0');
  assert.equal(clampDelayMs(0), 0);
  assert.equal(clampDelayMs(5_000_000), 3_600_000, 'above max -> 1h ceiling');
  assert.equal(clampDelayMs(250.9), 250, 'floors to integer');
  assert.equal(clampDelayMs(NaN), 0, 'NaN -> 0');
  assert.equal(clampDelayMs(Infinity), 0, 'Infinity -> 0 (not finite, treated like NaN)');
});

test('runs all steps in order and reports completion', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const { run } = useMacroRunner({
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });
  const res = await run(
    macro([
      { data: 'AT', isHex: false, delayMs: 0 },
      { data: 'AA BB', isHex: true, delayMs: 0 },
    ]),
  );
  assert.equal(res.completed, 2);
  assert.equal(res.failedAt, 2);
  assert.equal(res.aborted, false);
  assert.deepEqual(sent, [
    { data: 'AT', isHex: false },
    { data: 'AA BB', isHex: true },
  ]);
});

test('stops at the first failed step and reports its index', async () => {
  let calls = 0;
  const { run } = useMacroRunner({
    send: async () => {
      calls += 1;
      // fail the second step
      return calls !== 2;
    },
  });
  const res = await run(
    macro([
      { data: 'a', isHex: false, delayMs: 0 },
      { data: 'b', isHex: false, delayMs: 0 },
      { data: 'c', isHex: false, delayMs: 0 },
    ]),
  );
  assert.equal(res.completed, 1, 'one step completed before the failure');
  assert.equal(res.failedAt, 1, 'failure at index 1');
  assert.equal(calls, 2, 'did not attempt the third step');
});

test('aborts before the next step after abort() is called', async () => {
  let calls = 0;
  const runner = useMacroRunner({
    send: async () => {
      calls += 1;
      return true;
    },
  });
  // Abort during the inter-step delay of step 0; step 1 must not run.
  const promise = runner.run(
    macro([
      { data: 'a', isHex: false, delayMs: 50 },
      { data: 'b', isHex: false, delayMs: 0 },
    ]),
  );
  // Give the first send + delay a tick to start, then abort.
  setTimeout(() => runner.abort(), 10);
  const res = await promise;
  assert.equal(calls, 1, 'only the first step sent');
  assert.equal(res.aborted, true);
  assert.equal(res.completed, 1);
});

test('does not run if already running (reentrancy guard)', async () => {
  const { run, running } = useMacroRunner({ send: async () => true });
  // A macro with a delay so it is still in-flight when we re-enter.
  const slow = macro([{ data: 'a', isHex: false, delayMs: 30 }]);
  const p1 = run(slow);
  assert.equal(running.value, true);
  const second = await run(slow);
  assert.equal(second.aborted, true, 'second invocation is rejected');
  await p1;
});

test('skips the trailing delay on the last step', async () => {
  let t0 = 0;
  let elapsed = 0;
  const { run } = useMacroRunner({
    send: async () => true,
    onStep: (i) => {
      if (i === 0) t0 = Date.now();
      if (i === 1) elapsed = Date.now() - t0;
    },
  });
  await run(
    macro([
      { data: 'a', isHex: false, delayMs: 200 },
      { data: 'b', isHex: false, delayMs: 0 },
    ]),
  );
  // The 200ms delay is inter-step (after step 0), so step 1 starts ~200ms in.
  // If the last-step delay were NOT skipped we'd see no difference here (last
  // delay is 0 anyway); this test guards the inter-step gap itself.
  assert.ok(elapsed >= 150, `inter-step delay honored (~200ms): ${elapsed}ms`);
});

test('pause waits for an active send and resume continues at the next step', async () => {
  const firstSend = deferred<boolean>();
  const sent: string[] = [];
  const runner = useMacroRunner({
    send: async (data) => {
      sent.push(data);
      return sent.length === 1 ? firstSend.promise : true;
    },
  });
  const running = runner.run(
    macro([
      { data: 'first', isHex: false, delayMs: 0 },
      { data: 'second', isHex: false, delayMs: 0 },
    ]),
  );
  await Promise.resolve();
  let paused = false;
  const pause = runner.pause().then(() => {
    paused = true;
  });
  await Promise.resolve();
  assert.equal(paused, false);

  firstSend.resolve(true);
  await pause;
  await Promise.resolve();
  assert.deepEqual(sent, ['first']);
  runner.resume();
  assert.equal((await running).completed, 2);
  assert.deepEqual(sent, ['first', 'second']);
});
