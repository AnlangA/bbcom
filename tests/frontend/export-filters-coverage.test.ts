import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  EXPORT_FRAME_REFERENCE_LIMIT,
  createExportFrameSnapshot,
  createExportPreview,
  filterFramesByTimeRange,
  isValidCustomTimeRange,
  iterateExportFrames,
  matchesExportFilter,
  resolveExportFilter,
  type ExportFilterSelection,
} from '../../src/lib/export-filters.ts';
import { frame } from './helpers/frames.ts';

const all: ExportFilterSelection = {
  direction: 'all',
  timePreset: 'all',
  customStartMs: null,
  customEndMs: null,
};

test('export filters: custom ranges require both finite endpoints in ascending order', () => {
  assert.equal(isValidCustomTimeRange(null, 1), false);
  assert.equal(isValidCustomTimeRange(0, null), false);
  assert.equal(isValidCustomTimeRange(Number.NaN, 1), false);
  assert.equal(isValidCustomTimeRange(0, Number.POSITIVE_INFINITY), false);
  assert.equal(isValidCustomTimeRange(2, 1), false);
  assert.equal(isValidCustomTimeRange(1, 2), true);
});

test('export filters: resolve all, custom, and anchored relative windows without wall-clock input', () => {
  const frames = [frame('old', 'RX', 1_000, [1]), frame('new', 'TX', 301_000, [2, 3])];

  assert.deepEqual(resolveExportFilter(frames, all), {
    startMs: null,
    endMs: null,
    direction: null,
  });
  assert.deepEqual(
    resolveExportFilter(frames, {
      direction: 'RX',
      timePreset: 'custom',
      customStartMs: 1_000,
      customEndMs: 2_000,
    }),
    { startMs: 1_000, endMs: 2_000, direction: 'RX' },
  );
  assert.deepEqual(
    resolveExportFilter(frames, { ...all, direction: 'TX', timePreset: 'last-1m' }),
    { startMs: 241_000, endMs: null, direction: 'TX' },
  );
  assert.deepEqual(resolveExportFilter(frames, { ...all, timePreset: 'last-5m' }), {
    startMs: 1_000,
    endMs: null,
    direction: null,
  });
  assert.deepEqual(resolveExportFilter([], { ...all, timePreset: 'last-1m' }), {
    startMs: null,
    endMs: null,
    direction: null,
  });
  assert.throws(
    () =>
      resolveExportFilter(frames, {
        ...all,
        timePreset: 'custom',
        customStartMs: 5,
        customEndMs: 5,
      }),
    /start < end/,
  );
});

test('export filters: preview and frozen snapshots stream only matching prefix frames', () => {
  const frames = [
    frame('one', 'RX', 10, [1]),
    frame('two', 'TX', 20, [2, 3]),
    frame('three', 'TX', 30, [4, 5, 6]),
  ];
  const selection = { ...all, direction: 'TX' as const };
  const selectedFrame = frames[1];
  const selectedPayload = selectedFrame.data;
  const snapshot = createExportFrameSnapshot(frames, selection);
  frames.push(frame('late', 'TX', 40, [7]));
  frames.shift();
  frames.splice(0, 1);

  assert.notEqual(snapshot.frames, frames, 'the selected reference array is frozen');
  assert.equal(snapshot.frames[0], selectedFrame, 'DataFrame references are not copied');
  assert.equal(snapshot.frames[0].data, selectedPayload, 'Uint8Array payloads are not copied');
  assert.deepEqual(
    [...iterateExportFrames(snapshot)].map((item) => item.id),
    ['two', 'three'],
  );
  assert.deepEqual(snapshot.preview, {
    frameCount: 2,
    rawBytes: 5,
    maxFrameBytes: 3,
  });
  assert.deepEqual(
    [...iterateExportFrames(snapshot)].reduce(
      (totals, item) => ({ frames: totals.frames + 1, bytes: totals.bytes + item.data.byteLength }),
      { frames: 0, bytes: 0 },
    ),
    { frames: snapshot.preview.frameCount, bytes: snapshot.preview.rawBytes },
  );
  assert.deepEqual(createExportPreview(frames, selection), {
    frameCount: 2,
    rawBytes: 4,
    maxFrameBytes: 3,
  });
  assert.deepEqual(createExportPreview([], all), { frameCount: 0, rawBytes: 0, maxFrameBytes: 0 });
});

test('export filters: confirmed reference selection rejects more than 100k matches', () => {
  const repeated = frame('same', 'RX', 1, [1]);
  const atLimit = Array.from({ length: EXPORT_FRAME_REFERENCE_LIMIT }, () => repeated);
  const snapshot = createExportFrameSnapshot(atLimit, all);
  assert.equal(snapshot.frames.length, EXPORT_FRAME_REFERENCE_LIMIT);
  assert.throws(
    () => createExportFrameSnapshot([...atLimit, repeated], all),
    /more than 100000 frame references/,
  );
});

test('export filters: half-open bounds and direction conditions reject independently', () => {
  const item = frame('item', 'RX', 10, [1]);
  assert.equal(matchesExportFilter(item, { startMs: 11, endMs: null, direction: null }), false);
  assert.equal(matchesExportFilter(item, { startMs: null, endMs: 10, direction: null }), false);
  assert.equal(matchesExportFilter(item, { startMs: null, endMs: null, direction: 'TX' }), false);
  assert.equal(matchesExportFilter(item, { startMs: 10, endMs: 11, direction: 'RX' }), true);

  const frames = [item, frame('next', 'TX', 11, [2])];
  assert.deepEqual(
    filterFramesByTimeRange(frames, { startMs: 10, endMs: 11, direction: null }).map(
      (entry) => entry.id,
    ),
    ['item'],
  );
});
