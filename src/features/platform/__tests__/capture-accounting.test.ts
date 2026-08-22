import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CaptureAccountingStore,
  type CaptureSessionTotals,
} from '@/features/platform/application/capture-accounting.ts';

function totalsOf(store: CaptureAccountingStore, sessionId: string): CaptureSessionTotals | null {
  return store.sessionTotals(sessionId);
}

test('registerSession: registers rows and adds exact workspace aggregates', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 4, frameCount: 10, captureBytes: 100 });
  store.registerSession('s2', { nextSequence: 0, frameCount: 2, captureBytes: 50 });
  assert.equal(store.hasSession('s1'), true);
  assert.equal(store.sessionCount, 2);
  assert.deepEqual(totalsOf(store, 's1'), {
    sessionId: 's1',
    nextSequence: 4,
    frameCount: 10,
    captureBytes: 100,
  });
  assert.deepEqual(store.workspaceTotals(), { frameCount: 12, captureBytes: 150 });
  assert.equal(store.nextFrameSequence('s1'), 4);
  assert.equal(store.nextFrameSequence('missing'), undefined);
});

test('recordFrames: increments rows and aggregates; bytes-only variant works', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 0, frameCount: 1, captureBytes: 10 });
  store.recordFrames('s1', 3, 30);
  assert.deepEqual(totalsOf(store, 's1')!.frameCount, 4);
  assert.deepEqual(totalsOf(store, 's1')!.captureBytes, 40);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 4, captureBytes: 40 });
  store.recordBytes('s1', 5);
  assert.deepEqual(totalsOf(store, 's1')!.captureBytes, 45);
  assert.deepEqual(totalsOf(store, 's1')!.frameCount, 4);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 4, captureBytes: 45 });
});

test('recordFrames: negative deltas write rows exactly and clamp aggregates at zero', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 2, frameCount: 5, captureBytes: 50 });
  store.recordFrames('s1', -4, -45);
  assert.deepEqual(totalsOf(store, 's1'), {
    sessionId: 's1',
    nextSequence: 2,
    frameCount: 1,
    captureBytes: 5,
  });
  assert.deepEqual(store.workspaceTotals(), { frameCount: 1, captureBytes: 5 });
  // A removal larger than the aggregate clamps at zero instead of going negative.
  store.recordFrames('s1', -10, -100);
  assert.deepEqual(totalsOf(store, 's1')!.frameCount, -9);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 0, captureBytes: 0 });
});

test('resetSession: zeroes the row (incl. sequence) and returns the previous totals', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 7, frameCount: 3, captureBytes: 33 });
  const previous = store.resetSession('s1');
  assert.deepEqual(previous, {
    sessionId: 's1',
    nextSequence: 7,
    frameCount: 3,
    captureBytes: 33,
  });
  assert.deepEqual(totalsOf(store, 's1'), {
    sessionId: 's1',
    nextSequence: 0,
    frameCount: 0,
    captureBytes: 0,
  });
  // Still registered after reset.
  assert.equal(store.hasSession('s1'), true);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 0, captureBytes: 0 });
  assert.equal(store.resetSession('missing'), null);
});

test('removeSession: deletes the row, clamps aggregates, and returns the removed totals', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 1, frameCount: 6, captureBytes: 60 });
  store.registerSession('s2', { nextSequence: 0, frameCount: 2, captureBytes: 20 });
  const removed = store.removeSession('s1');
  assert.deepEqual(removed, {
    sessionId: 's1',
    nextSequence: 1,
    frameCount: 6,
    captureBytes: 60,
  });
  assert.equal(store.hasSession('s1'), false);
  assert.equal(store.sessionCount, 1);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 2, captureBytes: 20 });
  assert.equal(store.removeSession('s1'), null);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 2, captureBytes: 20 });
});

test('replaceWorkspace: rebuilds every row and recomputes aggregates as exact sums', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('old', { nextSequence: 9, frameCount: 100, captureBytes: 900 });
  store.replaceWorkspace([
    { sessionId: 'a', nextSequence: 3, frameCount: 4, captureBytes: 40 },
    { sessionId: 'b', nextSequence: 0, frameCount: 0, captureBytes: 0 },
    { sessionId: 'c', nextSequence: 12, frameCount: 1, captureBytes: 7 },
  ]);
  assert.equal(store.hasSession('old'), false);
  assert.equal(store.sessionCount, 3);
  assert.equal(store.nextFrameSequence('a'), 3);
  assert.equal(store.nextFrameSequence('c'), 12);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 5, captureBytes: 47 });
  // Clearing with an empty list is the replaceSessions reset path.
  store.replaceWorkspace([]);
  assert.equal(store.sessionCount, 0);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 0, captureBytes: 0 });
});

test('setSessionBytes / setNextFrameSequence: absolute writes adjust aggregates by delta', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 0, frameCount: 0, captureBytes: 100 });
  store.setSessionBytes('s1', 60);
  assert.deepEqual(totalsOf(store, 's1')!.captureBytes, 60);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 0, captureBytes: 60 });
  store.setNextFrameSequence('s1', 8);
  assert.equal(store.nextFrameSequence('s1'), 8);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 0, captureBytes: 60 });
  // Authoritative aggregate re-baseline after an external global trim.
  store.setWorkspaceBytes(55);
  assert.deepEqual(store.workspaceTotals(), { frameCount: 0, captureBytes: 55 });
});

test('returned totals snapshots are frozen and do not alias internal rows', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 0, frameCount: 1, captureBytes: 10 });
  const snapshot = totalsOf(store, 's1')!;
  store.recordFrames('s1', 1, 5);
  assert.deepEqual(snapshot, { sessionId: 's1', nextSequence: 0, frameCount: 1, captureBytes: 10 });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(store.workspaceTotals()), true);
});

test('allocateNextFrameSequence reserves monotonic values; resetFrameSequence clears counter', () => {
  const store = new CaptureAccountingStore();
  store.registerSession('s1', { nextSequence: 2, frameCount: 0, captureBytes: 0 });
  assert.equal(store.allocateNextFrameSequence('s1'), 2);
  assert.equal(store.allocateNextFrameSequence('s1'), 3);
  assert.equal(store.nextFrameSequence('s1'), 4);
  store.resetFrameSequence('s1');
  assert.equal(store.nextFrameSequence('s1'), 0);
  assert.equal(store.allocateNextFrameSequence('s1'), 0);
});
