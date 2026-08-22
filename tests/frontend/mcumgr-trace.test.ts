import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mcumgrTraceFramesToDataFrames } from '../../src/lib/mcumgr-trace';

test('mcumgrTraceFramesToDataFrames maps direction and payload', () => {
  const frames = mcumgrTraceFramesToDataFrames([
    { direction: 'TX', timestampMs: 1_700_000_000_000, data: [6, 9, 10] },
    { direction: 'RX', timestampMs: 1_700_000_000_010, data: [4, 20, 13] },
  ]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.direction, 'TX');
  assert.equal(frames[1]?.direction, 'RX');
  assert.deepEqual([...frames[0]!.data], [6, 9, 10]);
  assert.equal(frames[0]?.timestamp, 1_700_000_000_000);
});
