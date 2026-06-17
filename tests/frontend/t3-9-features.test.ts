import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHexAscii } from '../../src/lib/format.ts';
import { chunkPayload, sendChunked, WRITE_CHUNK_SIZE } from '../../src/lib/write-chunking.ts';
import { filterFramesByTimeRange, type TimeRangeFilter } from '../../src/lib/export-filters.ts';
import type { DataFrame } from '../../src/types.ts';

// ---- F-h: HEX+ASCII dual display mode ----

test('formatHexAscii: renders hex pairs + ASCII side by side, 16 per line', () => {
  // "Hi" = 0x48 0x69, both printable.
  const result = formatHexAscii(new Uint8Array([0x48, 0x69]));
  const lines = result.split('\n');
  assert.equal(lines.length, 1, 'one line for 2 bytes');
  assert.ok(lines[0].includes('48 69'), 'hex pairs present');
  assert.ok(lines[0].includes('Hi'), 'ASCII column present');
});

test('formatHexAscii: non-printable bytes become dots', () => {
  const result = formatHexAscii(new Uint8Array([0x00, 0x41, 0x7f]));
  assert.ok(result.includes('.A.'), '0x00 and 0x7f are dots, 0x41 is A');
});

test('formatHexAscii: wraps at bytesPerLine boundary', () => {
  const data = new Uint8Array(20); // 20 zero bytes
  const result = formatHexAscii(data, 16);
  const lines = result.split('\n');
  assert.equal(lines.length, 2, '20 bytes at 16/line = 2 lines');
});

test('formatHexAscii: empty input produces empty string', () => {
  assert.equal(formatHexAscii(new Uint8Array(0)), '');
});

// ---- F8: Production-safe write chunking ----

test('chunkPayload: splits a payload into chunkSize pieces', () => {
  const payload = new Uint8Array(10000);
  const chunks = chunkPayload(payload, 4096);
  assert.equal(chunks.length, 3, '10000 / 4096 = 3 chunks');
  assert.equal(chunks[0].length, 4096);
  assert.equal(chunks[1].length, 4096);
  assert.equal(chunks[2].length, 1808);
  // Total bytes preserved.
  assert.equal(
    chunks.reduce((s, c) => s + c.length, 0),
    10000,
  );
});

test('chunkPayload: a payload smaller than chunkSize is one chunk', () => {
  const chunks = chunkPayload(new Uint8Array(100), 4096);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 100);
});

test('chunkPayload: default chunk size is WRITE_CHUNK_SIZE', () => {
  const chunks = chunkPayload(new Uint8Array(WRITE_CHUNK_SIZE + 1));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, WRITE_CHUNK_SIZE);
});

test('sendChunked: writes all chunks, resolves ok', async () => {
  const written: Uint8Array[] = [];
  const result = await sendChunked(
    new Uint8Array(5000),
    async (chunk) => {
      written.push(chunk);
      return true;
    },
    { chunkSize: 2000 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.chunksWritten, 3);
  assert.equal(result.bytesWritten, 5000);
  assert.equal(result.retriesUsed, 0);
  assert.equal(written.length, 3);
});

test('sendChunked: retries a failing chunk then succeeds', async () => {
  let calls = 0;
  const result = await sendChunked(
    new Uint8Array(100),
    async () => {
      calls += 1;
      return calls >= 3; // fail twice, succeed on 3rd
    },
    { chunkSize: 100, maxRetries: 3, backoffMs: 1, delay: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.retriesUsed, 2, 'two retries consumed');
  assert.equal(calls, 3);
});

test('sendChunked: gives up after maxRetries and reports the error', async () => {
  const result = await sendChunked(new Uint8Array(100), async () => false, {
    chunkSize: 100,
    maxRetries: 2,
    backoffMs: 1,
    delay: async () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('failed after'));
  assert.equal(result.chunksWritten, 0);
});

test('sendChunked: a throw is treated as a failure and retried', async () => {
  let calls = 0;
  const result = await sendChunked(
    new Uint8Array(50),
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('driver error');
      return true;
    },
    { chunkSize: 50, maxRetries: 2, backoffMs: 1, delay: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.retriesUsed, 1);
});

// ---- F-e: Export time-range filtering ----

function frame(dir: 'TX' | 'RX', timestamp: number, id: string): DataFrame {
  return { id, direction: dir, timestamp, data: new Uint8Array([1]) };
}

test('filterFramesByTimeRange: keeps frames within [start, end)', () => {
  const frames = [frame('RX', 0, 'a'), frame('RX', 100, 'b'), frame('RX', 200, 'c')];
  const filter: TimeRangeFilter = { startMs: 50, endMs: 200, direction: null };
  const result = filterFramesByTimeRange(frames, filter);
  assert.deepEqual(
    result.map((f) => f.id),
    ['b'],
    'only the frame in [50,200)',
  );
});

test('filterFramesByTimeRange: open-ended ranges (null start/end)', () => {
  const frames = [frame('RX', 0, 'a'), frame('RX', 100, 'b')];
  assert.equal(
    filterFramesByTimeRange(frames, { startMs: null, endMs: null, direction: null }).length,
    2,
  );
  assert.equal(
    filterFramesByTimeRange(frames, { startMs: 50, endMs: null, direction: null }).length,
    1,
  );
  assert.equal(
    filterFramesByTimeRange(frames, { startMs: null, endMs: 50, direction: null }).length,
    1,
  );
});

test('filterFramesByTimeRange: direction filter', () => {
  const frames = [frame('TX', 0, 'a'), frame('RX', 0, 'b'), frame('TX', 0, 'c')];
  const result = filterFramesByTimeRange(frames, { startMs: null, endMs: null, direction: 'RX' });
  assert.deepEqual(
    result.map((f) => f.id),
    ['b'],
  );
});

test('filterFramesByTimeRange: does not mutate the input', () => {
  const frames = [frame('RX', 0, 'a'), frame('RX', 100, 'b')];
  const original = [...frames];
  filterFramesByTimeRange(frames, { startMs: 50, endMs: null, direction: null });
  assert.deepEqual(frames, original, 'input unchanged');
});
