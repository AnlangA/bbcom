import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelColor,
  channelRanges,
  channelStats,
  createBuffer,
  parseSampleLine,
  pushSample,
} from '../../src/lib/waveform.ts';

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
  assert.equal(b.capacity, 100);
});

test('pushSample trims to capacity from the front', () => {
  const b = createBuffer(3);
  pushSample(b, [1]);
  pushSample(b, [2]);
  pushSample(b, [3]);
  pushSample(b, [4]);
  assert.equal(b.samples.length, 3);
  assert.equal(b.samples[0][0], 2, 'oldest dropped');
  assert.equal(b.samples[2][0], 4, 'newest kept');
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

test('channelColor is stable per index and cycles the palette', () => {
  const a = channelColor(0);
  const a2 = channelColor(0);
  assert.equal(a, a2, 'same index -> same color');
  assert.notEqual(channelColor(0), channelColor(1), 'different indices differ');
  // cycles: index == palette length wraps to 0
  assert.equal(channelColor(0), channelColor(8), 'palette wraps at 8');
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
