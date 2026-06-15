import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { setMaxBufferFrames } from '../../src/lib/buffer-config.ts';
import { MAX_FRAMES } from '../../src/types/index.ts';
import type { PortConfig } from '../../src/types/index.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  dtr: false,
  rts: false,
};

function store() {
  setActivePinia(createPinia());
  return useSessionStore();
}

async function withLocalStorageMock<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  try {
    return await fn();
  } finally {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
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

test('session snapshots restore recent capture and per-session tools', async () => {
  await withLocalStorageMock(async () => {
    const s = store();
    const id = s.createSession('COM9', cfg);
    s.addFrame(id, { direction: 'RX', data: new Uint8Array([0x41, 0x42]) });
    s.addFrame(id, { direction: 'TX', data: new Uint8Array([0x43]) });
    s.setSendDraft(id, 'AT');
    s.addQuickCommand(id, { name: 'Ping', data: 'AT', isHex: false });
    s.addMacro(id, {
      name: 'Boot',
      steps: [{ data: 'AT', isHex: false, delayMs: 250 }],
    });
    s.addTrigger(id, {
      name: 'Login',
      enabled: true,
      matchMode: 'text',
      pattern: 'login:',
      response: 'root',
      responseIsHex: false,
      cooldownMs: 500,
    });
    s.addHighlight(id, {
      name: 'Errors',
      enabled: true,
      matchMode: 'text',
      pattern: 'ERROR',
      direction: 'RX',
      color: 'red',
    });
    s.setParserState(id, { kind: 'fixed', frameSize: 12 }, 'modbus-fixed-8');
    s.flushPersistedSessions();

    const restored = store();
    assert.equal(restored.sessions.length, 1);
    const session = restored.sessions[0];
    assert.equal(session.portName, 'COM9');
    assert.equal(session.isConnected, false, 'restored sessions never reopen ports automatically');
    assert.equal(session.frames.length, 2);
    assert.deepEqual(Array.from(session.frames[0].data), [0x41, 0x42]);
    assert.equal(session.rxBytes, 2);
    assert.equal(session.txBytes, 1);
    assert.equal(session.sendDraft, 'AT');
    assert.equal(session.quickCommands[0].name, 'Ping');
    assert.equal(session.macros[0].steps[0].delayMs, 250);
    assert.equal(session.triggers[0].pattern, 'login:');
    assert.deepEqual(session.highlights[0], {
      id: session.highlights[0].id,
      name: 'Errors',
      enabled: true,
      matchMode: 'text',
      pattern: 'ERROR',
      direction: 'RX',
      color: 'red',
    });
    assert.deepEqual(session.parserState, {
      config: { kind: 'fixed', frameSize: 12 },
      presetId: 'modbus-fixed-8',
    });
  });
});

test('session snapshots are bounded to the recent frame tail', async () => {
  await withLocalStorageMock(async () => {
    const s = store();
    const id = s.createSession('COM10', cfg);
    for (let i = 0; i < 2105; i += 1) {
      s.addFrame(id, { direction: 'RX', data: new Uint8Array([i % 256]) });
    }
    s.flushPersistedSessions();

    const restored = store();
    assert.equal(restored.sessions[0].frames.length, 2000);
    assert.deepEqual(Array.from(restored.sessions[0].frames[0].data), [105]);
  });
});
