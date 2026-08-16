import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  MAX_MERGED_VISIBLE_BYTES,
  MERGED_FRAME_LINE_COUNT,
  MergedFrameRopeIndex,
  type MergedFrameLineCountHook,
} from '../../src/lib/merged-frame-rope.ts';
import type { DataFrame } from '../../src/types/index.ts';

function frame(id: string, direction: DataFrame['direction'], data: Uint8Array): DataFrame {
  return { id, direction, timestamp: Number(id.replace(/\D/g, '')) || 0, data };
}

test('rope appends chunks without replacing a merged UI descriptor', () => {
  const rope = new MergedFrameRopeIndex();
  rope.append(frame('1', 'RX', new Uint8Array([1, 2])));
  const display = rope.frames[0];
  assert.ok(display);
  assert.equal(display.contentVersion, 1);

  rope.append(frame('2', 'RX', new Uint8Array([3, 4])));
  assert.equal(rope.frames.length, 1);
  assert.equal(rope.frames[0], display, 'append keeps the stable row object');
  assert.equal(display.contentVersion, 2);
  assert.deepEqual(Array.from(display.data), [1, 2, 3, 4]);
  assert.equal(rope.chunksFor(display)?.length, 2);
});

test('rope exposes only the tail and materializes full bytes on demand', () => {
  const rope = new MergedFrameRopeIndex();
  const first = new Uint8Array(MAX_MERGED_VISIBLE_BYTES).fill(0x11);
  const second = new Uint8Array(1024).fill(0x22);
  rope.append(frame('1', 'TX', first));
  rope.append(frame('2', 'TX', second));

  const display = rope.frames[0];
  assert.equal(display.data.byteLength, MAX_MERGED_VISIBLE_BYTES);
  assert.equal(display.omittedBytes, 1024);
  assert.equal(display.data[0], 0x11);
  assert.equal(display.data.at(-1), 0x22);

  const full = rope.materialize(display);
  assert.equal(full.data.byteLength, MAX_MERGED_VISIBLE_BYTES + 1024);
  assert.equal(full.data[0], 0x11);
  assert.equal(full.data.at(-1), 0x22);
  assert.equal(full.omittedBytes, undefined);
});

test('rope rebuild releases old source chunks and groups directions independently', () => {
  const rope = new MergedFrameRopeIndex();
  rope.rebuild([
    frame('1', 'RX', new Uint8Array([1])),
    frame('2', 'RX', new Uint8Array([2])),
    frame('3', 'TX', new Uint8Array([3])),
  ]);
  const stale = rope.frames[0];
  rope.rebuild([frame('4', 'TX', new Uint8Array([4]))]);

  assert.equal(rope.frames.length, 1);
  assert.equal(rope.frames[0].id, 'merged-4');
  assert.equal(stale.data.byteLength, 0, 'detached descriptors do not retain dropped chunks');
});

test('tail cache keeps the eight most recent runs warm and evicts on overflow', () => {
  const rope = new MergedFrameRopeIndex();
  const directions = ['RX', 'TX'] as const;
  for (let index = 0; index < 8; index += 1) {
    rope.append(frame(String(index), directions[index % 2], new Uint8Array([index])));
  }
  const tails = rope.frames.map((item) => item.data);

  // Revisits within capacity return the identical buffer: measure passes no
  // longer re-materialize a fresh 64 KiB tail per historical row.
  assert.equal(rope.frames[0].data, tails[0]);
  assert.equal(rope.frames[7].data, tails[7]);

  // A ninth run evicts the least recently used tail (run 1 after the two
  // refreshes above); revisiting that run materializes a fresh copy.
  rope.append(frame('8', 'RX', new Uint8Array([8])));
  assert.equal(rope.frames[8].data.byteLength, 1);
  assert.notEqual(rope.frames[1].data, tails[1]);
  assert.deepEqual(Array.from(rope.frames[1].data), [1]);
});

test('appending to a run drops its cached tail so growth is never stale', () => {
  const rope = new MergedFrameRopeIndex();
  rope.append(frame('1', 'RX', new Uint8Array([1, 2])));
  const display = rope.frames[0];
  const before = display.data;
  assert.deepEqual(Array.from(before), [1, 2]);

  rope.append(frame('2', 'RX', new Uint8Array([3, 4])));
  const after = display.data;
  assert.notEqual(after, before, 'the stale tail buffer is not reused');
  assert.deepEqual(Array.from(after), [1, 2, 3, 4]);
});

test('display line counts memoize per run and invalidate when the live tail grows', () => {
  const rope = new MergedFrameRopeIndex();
  rope.append(frame('1', 'RX', new Uint8Array([1])));
  const display = rope.frames[0];

  let calls = 0;
  const compute = () => {
    calls += 1;
    return 4;
  };
  assert.equal(rope.runDisplayLineCount(display, compute), 4);
  assert.equal(rope.runDisplayLineCount(display, compute), 4);
  assert.equal(calls, 1, 'the second estimate pass hits the per-run cache');

  // The symbol hook exposed on the frame shares the same memo.
  const hook = (display as { [MERGED_FRAME_LINE_COUNT]?: MergedFrameLineCountHook })[
    MERGED_FRAME_LINE_COUNT
  ];
  assert.ok(hook);
  assert.equal(hook(compute), 4);
  assert.equal(calls, 1, 'frame hook and index method share one memo');

  // The live tail run is the only mutable run: its content version bumps on
  // append, so exactly one recompute serves the next measure pass.
  rope.append(frame('2', 'RX', new Uint8Array([2])));
  assert.equal(rope.runDisplayLineCount(display, compute), 4);
  assert.equal(calls, 2);

  // Frames the rope does not own always compute directly.
  assert.equal(rope.runDisplayLineCount(frame('plain', 'TX', new Uint8Array([9])), compute), 4);
  assert.equal(calls, 3);
});

test('100k-frame direction run keeps 1000 incremental appends below 1 ms p95', () => {
  const rope = new MergedFrameRopeIndex();
  rope.rebuild(
    Array.from({ length: 100_000 }, (_, index) =>
      frame(`seed-${index}`, 'RX', new Uint8Array([index & 0xff])),
    ),
  );

  const samples: number[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const started = performance.now();
    rope.append(frame(`append-${index}`, 'RX', new Uint8Array([index & 0xff])));
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.ok(p95 < 1, `rope append p95 ${p95.toFixed(3)} ms exceeds 1 ms`);
  assert.equal(rope.frameCount, 1);
  assert.equal(rope.frames[0].contentVersion, 101_000);
});
