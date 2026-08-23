import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  appendFrameToSession,
  appendIdentifiedItem,
  frameBuffersByteLength,
  flushPausedFramesToLive,
  normalizeLogAiFrameLimit,
  patchIdentifiedItem,
  removeIdentifiedItem,
  resetSessionFrames,
  trimFrameBuffer,
  trimSessionsToGlobalByteLimit,
  upsertSendHistory,
} from '@/lib/session-store-helpers.ts';
import { createSessionRecord } from '@/lib/session-persistence.ts';
import type { PortConfig } from '@/types/index.ts';
import { frame } from '@/test/helpers/frames.ts';

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

test('trimFrameBuffer trims only after max plus threshold is exceeded', () => {
  const frames = [1, 2, 3, 4, 5];
  assert.equal(trimFrameBuffer(frames, 3, 2), false);
  assert.deepEqual(frames, [1, 2, 3, 4, 5]);

  frames.push(6);
  assert.equal(trimFrameBuffer(frames, 3, 2), true);
  assert.deepEqual(frames, [4, 5, 6]);
});

test('appendFrameToSession routes frames by pause state and updates counters', () => {
  const session = createSessionRecord('s1', 'COM1', cfg);
  appendFrameToSession(session, frame('rx1', 'RX', [1, 2]), 10);
  session.capturePaused = true;
  appendFrameToSession(session, frame('tx1', 'TX', [3]), 10);

  assert.deepEqual(
    session.frames.map((item) => item.id),
    ['rx1'],
  );
  assert.deepEqual(
    session.pausedFrames.map((item) => item.id),
    ['tx1'],
  );
  assert.equal(session.rxBytes, 2);
  assert.equal(session.txBytes, 1);
  assert.equal(session.rxFrames, 1);
  assert.equal(session.txFrames, 1);
});

test('appendFrameToSession enforces a hard combined live/paused byte limit', () => {
  const session = createSessionRecord('s1', 'COM1', cfg);
  const first = appendFrameToSession(session, frame('a', 'RX', [1, 2, 3]), 10, {
    maxBytes: 4,
    currentBytes: 0,
  });
  assert.deepEqual(first, { retainedBytes: 3, droppedBytes: 0, droppedFrames: 0 });

  session.capturePaused = true;
  const second = appendFrameToSession(session, frame('b', 'RX', [4, 5, 6]), 10, {
    maxBytes: 4,
    currentBytes: first.retainedBytes,
  });
  assert.deepEqual(second, { retainedBytes: 3, droppedBytes: 3, droppedFrames: 1 });
  assert.deepEqual(session.frames, []);
  assert.deepEqual(
    session.pausedFrames.map((item) => item.id),
    ['b'],
  );
  assert.equal(frameBuffersByteLength(session), 3);
});

test('paused count eviction removes the persisted sequence prefix', () => {
  const session = createSessionRecord('s1', 'COM1', cfg, {
    frames: [{ ...frame('live-oldest', 'RX', [1]), timestamp: 100 }],
    pausedFrames: [{ ...frame('paused-older', 'RX', [2]), timestamp: 1 }],
    capturePaused: true,
  });
  const result = appendFrameToSession(
    session,
    { ...frame('paused-newest', 'RX', [3]), timestamp: 0 },
    1,
    { trimThreshold: 0, currentBytes: 2, maxBytes: 10 },
  );

  assert.deepEqual(result, { retainedBytes: 2, droppedBytes: 1, droppedFrames: 1 });
  assert.deepEqual(session.frames, []);
  assert.deepEqual(
    session.pausedFrames.map((item) => item.id),
    ['paused-older', 'paused-newest'],
  );
});

test('flushPausedFramesToLive preserves order and trims the live tail', () => {
  const session = createSessionRecord('s1', 'COM1', cfg, {
    frames: [frame('a', 'RX', [1]), frame('b', 'RX', [2])],
    pausedFrames: [frame('c', 'RX', [3]), frame('d', 'RX', [4])],
  });

  flushPausedFramesToLive(session, 2, 1);

  assert.deepEqual(
    session.frames.map((item) => item.id),
    ['c', 'd'],
  );
  assert.equal(session.pausedFrames.length, 0);
});

test('trimSessionsToGlobalByteLimit drops globally oldest frames', () => {
  const first = createSessionRecord('s1', 'COM1', cfg, {
    frames: [{ ...frame('a', 'RX', [1, 2, 3]), timestamp: 1 }],
  });
  const second = createSessionRecord('s2', 'COM2', cfg, {
    frames: [{ ...frame('b', 'RX', [4, 5, 6]), timestamp: 2 }],
    pausedFrames: [{ ...frame('c', 'RX', [7, 8, 9]), timestamp: 3 }],
  });

  const result = trimSessionsToGlobalByteLimit([first, second], 9, 5);
  assert.equal(result.retainedBytes, 3);
  assert.deepEqual(
    [...result.droppedBytesBySession],
    [
      ['s1', 3],
      ['s2', 3],
    ],
  );
  assert.deepEqual(
    [...result.droppedFramesBySession],
    [
      ['s1', 1],
      ['s2', 1],
    ],
  );
  assert.deepEqual(first.frames, []);
  assert.deepEqual(second.frames, []);
  assert.equal(second.pausedFrames[0].id, 'c');
});

test('resetSessionFrames clears live and paused buffers plus counters', () => {
  const session = createSessionRecord('s1', 'COM1', cfg, {
    frames: [frame('a', 'RX', [1])],
    pausedFrames: [frame('b', 'TX', [2])],
    capturePaused: true,
    rxBytes: 1,
    txBytes: 1,
    rxFrames: 1,
    txFrames: 1,
  });

  resetSessionFrames(session);

  assert.equal(session.frames.length, 0);
  assert.equal(session.pausedFrames.length, 0);
  assert.equal(session.capturePaused, false);
  assert.equal(session.rxBytes, 0);
  assert.equal(session.txBytes, 0);
  assert.equal(session.rxFrames, 0);
  assert.equal(session.txFrames, 0);
});

test('upsertSendHistory moves duplicates to the front and caps length', () => {
  const history = [
    { data: 'A', isHex: false },
    { data: 'B', isHex: true },
    { data: 'C', isHex: false },
  ];

  assert.deepEqual(upsertSendHistory(history, { data: 'B', isHex: true }, 3), [
    { data: 'B', isHex: true },
    { data: 'A', isHex: false },
    { data: 'C', isHex: false },
  ]);
  assert.deepEqual(upsertSendHistory(history, { data: 'D', isHex: false }, 2), [
    { data: 'D', isHex: false },
    { data: 'A', isHex: false },
  ]);
});

test('identified item helpers append, patch, and remove records by id', () => {
  const items: Array<{ id: string; name: string; enabled: boolean }> = [];
  const id = appendIdentifiedItem(items, { name: 'Rule', enabled: false }, () => 'id-1');

  assert.equal(id, 'id-1');
  assert.deepEqual(items, [{ id: 'id-1', name: 'Rule', enabled: false }]);
  assert.equal(patchIdentifiedItem(items, 'missing', { enabled: true }), false);
  assert.equal(patchIdentifiedItem(items, 'id-1', { enabled: true }), true);
  assert.deepEqual(items, [{ id: 'id-1', name: 'Rule', enabled: true }]);
  assert.deepEqual(removeIdentifiedItem(items, 'id-1'), []);
});

test('normalizeLogAiFrameLimit clamps to the supported range', () => {
  assert.equal(normalizeLogAiFrameLimit(5), 20);
  assert.equal(normalizeLogAiFrameLimit(99.9), 99);
  assert.equal(normalizeLogAiFrameLimit(9999), 2000);
  assert.equal(normalizeLogAiFrameLimit(Number.NaN), 200);
});
