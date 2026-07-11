import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildWaveformCsv,
  channelColor,
  channelRanges,
  channelStats,
  closestPointOnWaveformPath,
  createBuffer,
  DEFAULT_WAVEFORM_SAMPLE_POINT_MIN_DISTANCE_PX,
  ensureWaveformChannels,
  formatWaveformNumber,
  ingestWaveformTextFrames,
  normalizeWaveformTimeViewport,
  normalizeWaveformViewport,
  panWaveformTimeViewportByMs,
  panWaveformViewport,
  panWaveformViewportBySamples,
  parseSampleLine,
  planWaveformFrameIngest,
  pushSample,
  pushRegisterWaveformSample,
  scaleWaveformTimeViewport,
  scaleWaveformViewport,
  syncWaveformTimeViewportAfterSampleChange,
  syncWaveformViewportAfterSampleChange,
  thinWaveformSamplePoints,
  visibleChannelRange,
  visibleChannelRangeInWindow,
  waveformSampleIndexWindow,
  waveformTimeRange,
  waveformFrameCursorAtEnd,
  zoomWaveformViewport,
  type WaveformChannelState,
} from '../../src/lib/waveform.ts';

function frame(
  direction: 'RX' | 'TX',
  text: string,
  timestamp?: number,
): { direction: 'RX' | 'TX'; data: Uint8Array; timestamp?: number } {
  return { direction, data: new TextEncoder().encode(text), timestamp };
}

test('parseSampleLine parses a trailing CSV of numbers', () => {
  assert.deepEqual(parseSampleLine('hello\n12.5,-3,40\n'), [12.5, -3, 40]);
});

test('parseSampleLine handles space and semicolon separators', () => {
  assert.deepEqual(parseSampleLine('1 2 3'), [1, 2, 3]);
  assert.deepEqual(parseSampleLine('1;2;3'), [1, 2, 3]);
});

test('parseSampleLine skips non-numeric lines and uses the last data line', () => {
  assert.deepEqual(parseSampleLine('booting...\nready\n10,20\n'), [10, 20]);
  assert.deepEqual(parseSampleLine('only text here'), []);
});

test('parseSampleLine handles scientific notation', () => {
  assert.deepEqual(parseSampleLine('1e3,2.5e-1'), [1000, 0.25]);
});

test('parseSampleLine returns [] for empty/whitespace', () => {
  assert.deepEqual(parseSampleLine(''), []);
  assert.deepEqual(parseSampleLine('   \n  '), []);
});

test('createBuffer starts empty with the given capacity', () => {
  const b = createBuffer(100);
  assert.equal(b.samples.length, 0);
  assert.equal(b.timestamps.length, 0);
  assert.equal(b.originTimestamp, null);
  assert.equal(b.capacity, 100);
  assert.equal(b.totalDroppedSamples, 0);
});

test('pushSample trims to capacity from the front', () => {
  const b = createBuffer(3);
  pushSample(b, [1], 100);
  pushSample(b, [2], 125);
  pushSample(b, [3], 150);
  pushSample(b, [4], 175);
  assert.equal(b.samples.length, 3);
  assert.equal(b.samples[0][0], 2, 'oldest dropped');
  assert.equal(b.samples[2][0], 4, 'newest kept');
  assert.deepEqual(b.timestamps, [125, 150, 175]);
  assert.equal(b.originTimestamp, 100, 'time origin stays at the first sample');
  assert.equal(b.totalDroppedSamples, 1);
});

test('pushSample normalizes duplicate timestamps to a monotonic timeline', () => {
  const b = createBuffer(10);
  pushSample(b, [1], 100);
  pushSample(b, [2], 100);
  pushSample(b, [3], 99);

  assert.deepEqual(b.timestamps, [100, 101, 102]);
});

test('channelRanges autoscales with padding and handles flat lines', () => {
  const b = createBuffer(10);
  pushSample(b, [0, 10]);
  pushSample(b, [10, 10]);
  pushSample(b, [20, 10]);
  const ranges = channelRanges(b, 2);
  // channel 0 spans 0..20, padded ~8% -> roughly [-1.6, 21.6]
  assert.ok(ranges[0][0] < 0 && ranges[0][1] > 20, `ch0 padded: ${ranges[0]}`);
  // channel 1 is flat at 10 -> gets a band around it
  assert.ok(ranges[1][0] < 10 && ranges[1][1] > 10, `ch1 flat band: ${ranges[1]}`);
});

test('channelRanges returns [0,1] for a channel with no data', () => {
  const b = createBuffer(10);
  pushSample(b, [5]); // only channel 0
  const ranges = channelRanges(b, 2);
  assert.deepEqual(ranges[1], [0, 1]);
});

test('visibleChannelRange uses visible channels for a shared dynamic scale', () => {
  const b = createBuffer(10);
  pushSample(b, [10, 100]);
  pushSample(b, [20, 200]);

  const firstOnly = visibleChannelRange(b, 2, [true, false]);
  assert.ok(firstOnly[0] < 10 && firstOnly[1] > 20, `first channel padded: ${firstOnly}`);
  assert.ok(firstOnly[1] < 100, `hidden channel excluded: ${firstOnly}`);

  const both = visibleChannelRange(b, 2, [true, true]);
  assert.ok(both[0] < 10 && both[1] > 200, `visible channels combined: ${both}`);
});

test('visibleChannelRange falls back to all channels when every channel is hidden', () => {
  const b = createBuffer(10);
  pushSample(b, [10, 100]);
  pushSample(b, [20, 200]);

  assert.deepEqual(visibleChannelRange(b, 2, [false, false]), visibleChannelRange(b, 2));
});

test('visibleChannelRangeInWindow only autoscales the requested sample window', () => {
  const b = createBuffer(10);
  pushSample(b, [0, 100]);
  pushSample(b, [10, 200]);
  pushSample(b, [20, 300]);

  const range = visibleChannelRangeInWindow(b, 2, [true, false], 1, 3);
  assert.ok(range[0] < 10 && range[1] > 20, `window padded: ${range}`);
  assert.ok(range[1] < 100, `hidden and out-of-window samples excluded: ${range}`);
});

test('waveformSampleIndexWindow includes neighbors for clipped line segments', () => {
  assert.deepEqual(waveformSampleIndexWindow([], 10, 20), {
    sampleStartIndex: 0,
    sampleEndIndex: 0,
    scanStartIndex: 0,
    scanEndIndex: 0,
  });

  assert.deepEqual(waveformSampleIndexWindow([0, 10, 20, 30, 40], 15, 25), {
    sampleStartIndex: 2,
    sampleEndIndex: 3,
    scanStartIndex: 1,
    scanEndIndex: 4,
  });

  assert.deepEqual(waveformSampleIndexWindow([0, 10, 20, 30, 40], 11, 19), {
    sampleStartIndex: 2,
    sampleEndIndex: 2,
    scanStartIndex: 1,
    scanEndIndex: 3,
  });
});

test('closestPointOnWaveformPath interpolates along a rendered segment', () => {
  const point = closestPointOnWaveformPath({ x: 40, y: 10 }, [
    { x: 0, y: 0, value: 0, timestamp: 1000 },
    { x: 100, y: 0, value: 10, timestamp: 1100 },
  ]);

  assert.ok(point);
  assert.equal(point.x, 40);
  assert.equal(point.y, 0);
  assert.equal(point.value, 4);
  assert.equal(point.timestamp, 1040);
  assert.equal(point.distanceSq, 100);
});

test('closestPointOnWaveformPath handles a single point path', () => {
  const point = closestPointOnWaveformPath({ x: 12, y: 7 }, [
    { x: 10, y: 5, value: 2, timestamp: 20 },
  ]);

  assert.deepEqual(point, {
    x: 10,
    y: 5,
    value: 2,
    timestamp: 20,
    distanceSq: 8,
  });
});

test('thinWaveformSamplePoints keeps sparse real sample markers', () => {
  const points = [
    { x: 0, y: 0, value: 0, timestamp: 0 },
    { x: DEFAULT_WAVEFORM_SAMPLE_POINT_MIN_DISTANCE_PX, y: 0, value: 1, timestamp: 1 },
    { x: DEFAULT_WAVEFORM_SAMPLE_POINT_MIN_DISTANCE_PX * 2, y: 0, value: 2, timestamp: 2 },
  ];

  assert.deepEqual(thinWaveformSamplePoints(points), points);
});

test('thinWaveformSamplePoints removes overlapping markers without inventing samples', () => {
  const points = [0, 1, 2, 3, 4, 12].map((x) => ({
    x,
    y: 0,
    value: x,
    timestamp: x,
  }));

  const thinned = thinWaveformSamplePoints(points, 4);

  assert.deepEqual(
    thinned.map((point) => point.timestamp),
    [0, 4, 12],
  );
  assert.ok(thinned.every((point) => points.includes(point)));
});

test('thinWaveformSamplePoints keeps the newest marker visible in a dense tail', () => {
  const points = [0, 4, 5, 6, 7].map((x) => ({
    x,
    y: 0,
    value: x,
    timestamp: x,
  }));

  assert.deepEqual(
    thinWaveformSamplePoints(points, 4).map((point) => point.timestamp),
    [0, 7],
  );
});

test('planWaveformFrameIngest starts at zero for a fresh frame window', () => {
  const frames = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(planWaveformFrameIngest(frames, { consumed: 0, lastFrameId: null }), {
    startIndex: 0,
    reset: false,
    nextCursor: { consumed: 2, lastFrameId: 'b' },
  });
});

test('planWaveformFrameIngest uses frame id overlap when length is unchanged', () => {
  const cursor = waveformFrameCursorAtEnd([{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(planWaveformFrameIngest([{ id: 'b' }, { id: 'c' }], cursor), {
    startIndex: 1,
    reset: false,
    nextCursor: { consumed: 2, lastFrameId: 'c' },
  });
});

test('planWaveformFrameIngest resets after an external clear', () => {
  const cursor = waveformFrameCursorAtEnd([{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(planWaveformFrameIngest([], cursor), {
    startIndex: 0,
    reset: true,
    nextCursor: { consumed: 0, lastFrameId: null },
  });
});

test('planWaveformFrameIngest resets when the previous overlap is gone', () => {
  const cursor = waveformFrameCursorAtEnd([{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(planWaveformFrameIngest([{ id: 'x' }, { id: 'y' }], cursor), {
    startIndex: 0,
    reset: true,
    nextCursor: { consumed: 2, lastFrameId: 'y' },
  });
});

test('normalizeWaveformViewport clamps empty, tiny, and out-of-range windows', () => {
  assert.deepEqual(normalizeWaveformViewport({ start: 99, size: 4 }, 0), { start: 0, size: 0 });
  assert.deepEqual(normalizeWaveformViewport({ start: -10, size: 4 }, 20, 8), {
    start: 0,
    size: 8,
  });
  assert.deepEqual(normalizeWaveformViewport({ start: 50, size: 10 }, 20, 8), {
    start: 10,
    size: 10,
  });
});

test('zoomWaveformViewport zooms around center and respects min/max bounds', () => {
  assert.deepEqual(zoomWaveformViewport({ start: 20, size: 40 }, 100, 'in', 8), {
    start: 30,
    size: 20,
  });
  assert.deepEqual(zoomWaveformViewport({ start: 30, size: 8 }, 100, 'in', 8), {
    start: 30,
    size: 8,
  });
  assert.deepEqual(zoomWaveformViewport({ start: 10, size: 80 }, 100, 'out', 8), {
    start: 0,
    size: 100,
  });
});

test('scaleWaveformViewport keeps the requested cursor ratio anchored', () => {
  assert.deepEqual(scaleWaveformViewport({ start: 20, size: 40 }, 100, 0.25, 0.5, 8), {
    start: 25,
    size: 20,
  });
  assert.deepEqual(scaleWaveformViewport({ start: 20, size: 40 }, 100, 0.75, 0.5, 8), {
    start: 35,
    size: 20,
  });
  assert.deepEqual(scaleWaveformViewport({ start: 10, size: 80 }, 100, 0.25, 2, 8), {
    start: 0,
    size: 100,
  });
});

test('scaleWaveformViewport ignores tiny scale deltas below one visible sample', () => {
  assert.deepEqual(scaleWaveformViewport({ start: 20, size: 40 }, 100, 0.7, 0.999, 8), {
    start: 20,
    size: 40,
  });
  assert.deepEqual(scaleWaveformViewport({ start: 20, size: 40 }, 100, 0.7, 1.001, 8), {
    start: 20,
    size: 40,
  });
});

test('panWaveformViewport moves by a bounded fraction of the current window', () => {
  assert.deepEqual(panWaveformViewport({ start: 40, size: 40 }, 120, 'left', 8, 0.25), {
    start: 30,
    size: 40,
  });
  assert.deepEqual(panWaveformViewport({ start: 40, size: 40 }, 120, 'right', 8, 0.25), {
    start: 50,
    size: 40,
  });
  assert.deepEqual(panWaveformViewport({ start: 0, size: 40 }, 120, 'left', 8, 0.25), {
    start: 0,
    size: 40,
  });
  assert.deepEqual(panWaveformViewport({ start: 90, size: 40 }, 120, 'right', 8, 0.25), {
    start: 80,
    size: 40,
  });
});

test('panWaveformViewportBySamples applies direct offsets and clamps boundaries', () => {
  assert.deepEqual(panWaveformViewportBySamples({ start: 10, size: 20 }, 100, 5, 8), {
    start: 15,
    size: 20,
  });
  assert.deepEqual(panWaveformViewportBySamples({ start: 10, size: 20 }, 100, -30, 8), {
    start: 0,
    size: 20,
  });
  assert.deepEqual(panWaveformViewportBySamples({ start: 10, size: 20 }, 100, 999, 8), {
    start: 80,
    size: 20,
  });
});

test('waveformTimeRange normalizes sparse timestamp domains', () => {
  assert.deepEqual(waveformTimeRange([]), null);
  assert.deepEqual(waveformTimeRange([1000]), {
    startMs: 1000,
    endMs: 1001,
    durationMs: 1,
  });
  assert.deepEqual(waveformTimeRange([0, 10, 10_000]), {
    startMs: 0,
    endMs: 10_000,
    durationMs: 10_000,
  });
});

test('normalizeWaveformTimeViewport clamps sparse time windows continuously', () => {
  assert.deepEqual(normalizeWaveformTimeViewport({ startMs: -100, durationMs: 500 }, [0, 10_000]), {
    startMs: 0,
    durationMs: 500,
  });
  assert.deepEqual(normalizeWaveformTimeViewport({ startMs: 9900, durationMs: 500 }, [0, 10_000]), {
    startMs: 9500,
    durationMs: 500,
  });
});

test('scaleWaveformTimeViewport zooms around a time anchor without sample-index jumps', () => {
  assert.deepEqual(
    scaleWaveformTimeViewport({ startMs: 0, durationMs: 10_000 }, [0, 10_000], 0.5, 0.5),
    {
      startMs: 2500,
      durationMs: 5000,
    },
  );
  assert.deepEqual(
    scaleWaveformTimeViewport({ startMs: 1000, durationMs: 4000 }, [0, 10_000], 0.25, 2),
    {
      startMs: 0,
      durationMs: 8000,
    },
  );
});

test('panWaveformTimeViewportByMs moves by continuous milliseconds and clamps bounds', () => {
  assert.deepEqual(
    panWaveformTimeViewportByMs({ startMs: 1000, durationMs: 4000 }, [0, 10_000], 333.5),
    {
      startMs: 1333.5,
      durationMs: 4000,
    },
  );
  assert.deepEqual(
    panWaveformTimeViewportByMs({ startMs: 1000, durationMs: 4000 }, [0, 10_000], -5000),
    {
      startMs: 0,
      durationMs: 4000,
    },
  );
});

test('syncWaveformTimeViewportAfterSampleChange follows newest only from the right edge', () => {
  assert.deepEqual(
    syncWaveformTimeViewportAfterSampleChange(
      { startMs: 0, durationMs: Number.POSITIVE_INFINITY },
      [0],
      [0, 10_000],
    ),
    {
      startMs: 0,
      durationMs: Number.POSITIVE_INFINITY,
    },
  );
  assert.deepEqual(
    syncWaveformTimeViewportAfterSampleChange(
      { startMs: 5000, durationMs: 5000 },
      [0, 10_000],
      [0, 11_000],
    ),
    {
      startMs: 6000,
      durationMs: 5000,
    },
  );
  assert.deepEqual(
    syncWaveformTimeViewportAfterSampleChange(
      { startMs: 1000, durationMs: 5000 },
      [0, 10_000],
      [0, 11_000],
    ),
    {
      startMs: 1000,
      durationMs: 5000,
    },
  );
});

test('syncWaveformViewportAfterSampleChange follows newest only from the right edge', () => {
  assert.deepEqual(syncWaveformViewportAfterSampleChange({ start: 50, size: 50 }, 100, 101, 8), {
    start: 51,
    size: 50,
  });
  assert.deepEqual(syncWaveformViewportAfterSampleChange({ start: 20, size: 50 }, 100, 101, 8), {
    start: 20,
    size: 50,
  });
  assert.deepEqual(syncWaveformViewportAfterSampleChange({ start: 0, size: 600 }, 10, 11, 8), {
    start: 0,
    size: 600,
  });
});

test('channelColor is stable per index and cycles the palette', () => {
  const a = channelColor(0);
  const a2 = channelColor(0);
  assert.equal(a, a2, 'same index -> same color');
  assert.notEqual(channelColor(0), channelColor(1), 'different indices differ');
  // cycles: index == palette length wraps to 0
  assert.equal(channelColor(0), channelColor(8), 'palette wraps at 8');
});

test('ensureWaveformChannels grows channels while preserving existing state', () => {
  const existing: WaveformChannelState[] = [{ color: 'red', latest: 12, visible: false }];
  const next = ensureWaveformChannels(existing, 3);

  assert.deepEqual(next[0], existing[0]);
  assert.equal(next[1].color, channelColor(1));
  assert.equal(next[1].latest, null);
  assert.equal(next[1].visible, true);
  assert.equal(next[2].color, channelColor(2));
});

test('pushRegisterWaveformSample appends sparse register samples and updates latest', () => {
  const b = createBuffer(10);
  let channels: WaveformChannelState[] = [];

  let result = pushRegisterWaveformSample(b, channels, 2, 42, false, 1000);
  channels = result.channels;
  assert.equal(result.pushed, true);
  assert.deepEqual(b.samples, [[0, 0, 42]]);
  assert.deepEqual(b.timestamps, [1000]);
  assert.equal(b.originTimestamp, 1000);
  assert.equal(channels.length, 3);
  assert.equal(channels[2].latest, 42);
  assert.equal(channels[0].latest, null);

  result = pushRegisterWaveformSample(b, channels, 0, 7, false, 1016);
  channels = result.channels;
  assert.deepEqual(b.samples[1], [7, 0, 42]);
  assert.deepEqual(b.timestamps, [1000, 1016]);
  assert.equal(channels[0].latest, 7);
  assert.equal(channels[2].latest, 42);
});

test('pushRegisterWaveformSample ignores paused or invalid samples', () => {
  const b = createBuffer(10);
  const channels: WaveformChannelState[] = [{ color: 'red', latest: 1, visible: true }];

  assert.equal(pushRegisterWaveformSample(b, channels, 0, 2, true).pushed, false);
  assert.equal(pushRegisterWaveformSample(b, channels, -1, 2, false).pushed, false);
  assert.equal(pushRegisterWaveformSample(b, channels, 0, Number.NaN, false).pushed, false);
  assert.equal(b.samples.length, 0);
});

test('ingestWaveformTextFrames parses only the selected direction and refreshes latest', () => {
  const b = createBuffer(10);
  const result = ingestWaveformTextFrames(
    b,
    [frame('TX', '1,2\n', 100), frame('RX', '3,4\n', 110), frame('RX', 'noise\n5,6,7\n', 145)],
    {
      startIndex: 0,
      direction: 'RX',
      paused: false,
      channels: [],
    },
  );

  assert.equal(result.consumed, 3);
  assert.equal(result.pushedSamples, 2);
  assert.deepEqual(b.samples, [
    [3, 4],
    [5, 6, 7],
  ]);
  assert.deepEqual(b.timestamps, [110, 145]);
  assert.equal(b.originTimestamp, 110);
  assert.equal(result.channels.length, 3);
  assert.deepEqual(
    result.channels.map((channel) => channel.latest),
    [5, 6, 7],
  );
});

test('ingestWaveformTextFrames consumes frames while paused without appending samples', () => {
  const b = createBuffer(10);
  pushSample(b, [9, 8]);
  const result = ingestWaveformTextFrames(b, [frame('RX', '1,2,3\n')], {
    startIndex: 0,
    direction: 'RX',
    paused: true,
    channels: [
      { color: channelColor(0), latest: 9, visible: true },
      { color: channelColor(1), latest: 8, visible: false },
    ],
  });

  assert.equal(result.consumed, 1);
  assert.equal(result.pushedSamples, 0);
  assert.deepEqual(b.samples, [[9, 8]]);
  assert.equal(result.channels.length, 3);
  assert.deepEqual(
    result.channels.map((channel) => channel.latest),
    [9, 8, null],
  );
  assert.equal(result.channels[1].visible, false);
});

test('formatWaveformNumber matches compact legend formatting', () => {
  assert.equal(formatWaveformNumber(Number.NaN), '—');
  assert.equal(formatWaveformNumber(1234.5), '1235');
  assert.equal(formatWaveformNumber(12.34), '12.3');
  assert.equal(formatWaveformNumber(1.234), '1.23');
});

test('buildWaveformCsv emits headers and blanks missing or invalid values', () => {
  assert.equal(buildWaveformCsv([[1, 2], [3], [Number.NaN, 5]], 2), 'ch0,ch1\n1,2\n3,\n,5');
});

test('channelStats reports min/max/mean across the buffer', () => {
  const b = createBuffer(10);
  pushSample(b, [0]);
  pushSample(b, [10]);
  pushSample(b, [20]);
  const stats = channelStats(b, 1);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].min, 0);
  assert.equal(stats[0].max, 20);
  assert.equal(stats[0].mean, 10);
});

test('channelStats returns zeros for a channel with no data', () => {
  const b = createBuffer(10);
  pushSample(b, [5]); // only channel 0 has data
  const stats = channelStats(b, 2);
  assert.deepEqual(stats[1], { min: 0, max: 0, mean: 0 });
});

test('channelStats handles multiple channels independently', () => {
  const b = createBuffer(10);
  pushSample(b, [1, 100]);
  pushSample(b, [3, 200]);
  const stats = channelStats(b, 2);
  assert.deepEqual(stats[0], { min: 1, max: 3, mean: 2 });
  assert.deepEqual(stats[1], { min: 100, max: 200, mean: 150 });
});
