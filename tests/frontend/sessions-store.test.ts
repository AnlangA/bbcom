import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { setMaxBufferFrames } from '../../src/lib/buffer-config.ts';
import { MAX_FRAMES } from '../../src/types/index.ts';
import type { PortConfig } from '../../src/types/index.ts';

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

function store() {
  setActivePinia(createPinia());
  return useSessionStore();
}

test('addFrame appends to frames and counts bytes/frames', () => {
  const s = store();
  const id = s.createSession('COM1', cfg);
  s.addFrame(id, { direction: 'RX', data: new Uint8Array([1, 2, 3]) });
  s.addFrame(id, { direction: 'TX', data: new Uint8Array([4]) });
  const sess = s.sessions[0];
  assert.equal(sess.frames.length, 2);
  assert.equal(sess.pausedFrames.length, 0);
  assert.equal(sess.capturePaused, false);
  assert.equal(sess.rxBytes, 3);
  assert.equal(sess.txBytes, 1);
  assert.equal(sess.rxFrames, 1);
  assert.equal(sess.txFrames, 1);
});

test('pause routes frames off-screen; counters advance; resume flushes in order', () => {
  const s = store();
  const id = s.createSession('COM1', cfg);
  s.addFrame(id, { direction: 'RX', data: new Uint8Array([0]) });
  s.setCapturePaused(id, true);
  assert.equal(s.sessions[0].capturePaused, true);

  s.addFrame(id, { direction: 'RX', data: new Uint8Array([1]) });
  s.addFrame(id, { direction: 'TX', data: new Uint8Array([2, 3]) });

  // live view frozen at 1 frame; 2 held off-screen; total traffic still counted
  assert.equal(s.sessions[0].frames.length, 1);
  assert.equal(s.sessions[0].pausedFrames.length, 2);
  assert.equal(s.sessions[0].rxBytes, 2);
  assert.equal(s.sessions[0].txBytes, 2);
  assert.equal(s.sessions[0].rxFrames, 2);
  assert.equal(s.sessions[0].txFrames, 1);

  // resume flushes the held frames back, preserving order
  s.setCapturePaused(id, false);
  assert.equal(s.sessions[0].capturePaused, false);
  assert.equal(s.sessions[0].pausedFrames.length, 0);
  assert.equal(s.sessions[0].frames.length, 3);
  assert.deepEqual(
    s.sessions[0].frames.map((f) => Array.from(f.data)),
    [[0], [1], [2, 3]],
  );
});

test('clearFrames also clears the paused buffer and resets the pause flag', () => {
  const s = store();
  const id = s.createSession('COM1', cfg);
  s.setCapturePaused(id, true);
  s.addFrame(id, { direction: 'RX', data: new Uint8Array([9]) });
  s.clearFrames(id);
  assert.equal(s.sessions[0].frames.length, 0);
  assert.equal(s.sessions[0].pausedFrames.length, 0);
  assert.equal(s.sessions[0].capturePaused, false);
  assert.equal(s.sessions[0].rxBytes, 0);
});

test('trim respects configurable maxBufferFrames', () => {
  setMaxBufferFrames(1000);
  const s = store();
  const id = s.createSession('COM1', cfg);
  for (let i = 0; i < 1501; i++) {
    s.addFrame(id, { direction: 'RX', data: new Uint8Array([i % 256]) });
  }
  // trim threshold is 500, so once length exceeds 1000 + 500 it drops to 1000
  assert.equal(s.sessions[0].frames.length, 1000);
  setMaxBufferFrames(MAX_FRAMES);
});
