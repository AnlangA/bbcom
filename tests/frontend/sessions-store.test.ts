import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { MAX_FRAMES, MAX_HISTORY } from '../../src/types/index.ts';

function newFrame(direction: 'TX' | 'RX', bytes: number) {
  return { direction, data: new Uint8Array(bytes) };
}

test('createSession adds an inactive session with zeroed counters and activates it', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();

  assert.equal(store.sessions.length, 0);
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  assert.ok(id);
  assert.equal(store.sessions.length, 1);
  assert.equal(store.activeSessionId, id);
  const session = store.activeSession;
  assert.equal(session?.isConnected, false);
  assert.equal(session?.txBytes, 0);
  assert.equal(session?.rxBytes, 0);
  assert.equal(session?.frames.length, 0);
});

test('addFrame updates direction-specific byte and frame counters', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  store.addFrame(id, newFrame('TX', 5));
  store.addFrame(id, newFrame('TX', 3));
  store.addFrame(id, newFrame('RX', 10));

  const session = store.activeSession;
  assert.equal(session?.frames.length, 3);
  assert.equal(session?.txBytes, 8);
  assert.equal(session?.txFrames, 2);
  assert.equal(session?.rxBytes, 10);
  assert.equal(session?.rxFrames, 1);
});

test('clearFrames empties frames and resets all counters', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  store.addFrame(id, newFrame('TX', 5));
  store.addFrame(id, newFrame('RX', 7));

  store.clearFrames(id);

  const session = store.activeSession;
  assert.equal(session?.frames.length, 0);
  assert.equal(session?.txBytes, 0);
  assert.equal(session?.rxBytes, 0);
  assert.equal(session?.txFrames, 0);
  assert.equal(session?.rxFrames, 0);
});

test('addSendHistory prepends and dedups by data + isHex', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  store.addSendHistory(id, { data: 'AT', isHex: false });
  store.addSendHistory(id, { data: 'ping', isHex: false });
  // Re-adding 'AT' dedups (removes the old entry) and moves it to the front.
  store.addSendHistory(id, { data: 'AT', isHex: false });

  const history = store.activeSession?.sendHistory ?? [];
  assert.equal(history.length, 2);
  assert.equal(history[0].data, 'AT');
  assert.equal(history[1].data, 'ping');
});

test('addSendHistory caps at MAX_HISTORY entries', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  for (let i = 0; i < MAX_HISTORY + 5; i += 1) {
    store.addSendHistory(id, { data: `cmd${i}`, isHex: false });
  }

  const history = store.activeSession?.sendHistory ?? [];
  assert.equal(history.length, MAX_HISTORY);
  // Most-recent-first; the oldest 5 commands dropped.
  assert.equal(history[0].data, `cmd${MAX_HISTORY + 4}`);
});

test('addFrame keeps frames bounded once the threshold is exceeded (OOM guard)', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  // Push well past MAX_FRAMES + the 500-frame trim threshold.
  for (let i = 0; i < MAX_FRAMES + 600; i += 1) {
    store.addFrame(id, newFrame('RX', 1));
  }

  const session = store.activeSession;
  // The trim sawtooths between MAX_FRAMES and MAX_FRAMES + 500 — it must never
  // grow unboundedly toward the number of received frames.
  assert.ok(
    session && session.frames.length <= MAX_FRAMES + 500,
    `frames length ${session?.frames.length} exceeded the bounded range`,
  );
  assert.ok(
    session && session.frames.length >= MAX_FRAMES,
    `frames length ${session?.frames.length} fell below MAX_FRAMES`,
  );
  // Counters still reflect ALL received bytes/frames, not just the retained ones.
  assert.equal(session?.rxFrames, MAX_FRAMES + 600);
  assert.equal(session?.rxBytes, MAX_FRAMES + 600);
});

test('quick commands and log AI messages add/remove/clear', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  const session = store.activeSession;
  assert.ok(session);

  store.addQuickCommand(id, { name: 'reset', data: 'AA', isHex: true });
  store.addQuickCommand(id, { name: 'ping', data: 'AT', isHex: false });
  assert.equal(session!.quickCommands.length, 2);
  assert.ok(session!.quickCommands[0].id, 'quick command gets an id');

  store.removeQuickCommand(id, session!.quickCommands[0].id);
  assert.equal(session!.quickCommands.length, 1);

  store.addLogAiMessage(id, { role: 'user', content: 'q1' });
  store.addLogAiMessage(id, { role: 'assistant', content: 'a1' });
  assert.equal(session!.logAiMessages.length, 2);
  assert.ok(session!.logAiMessages[0].id, 'log message gets an id');
  assert.ok(session!.logAiMessages[0].timestamp, 'log message gets a timestamp');

  store.clearLogAiMessages(id);
  assert.equal(session!.logAiMessages.length, 0);
});

test('removeSession runs the registered cleanup and re-selects the next session', async () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const first = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  const second = store.createSession('COM4', {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  let cleanedUp = false;
  store.registerCleanup(first, async () => {
    cleanedUp = true;
  });

  await store.removeSession(first);

  assert.equal(cleanedUp, true);
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0]?.id, second);
  // active session falls back to the remaining one
  assert.equal(store.activeSessionId, second);
});

test('setConnected stamps startTime on connect and clears it on disconnect', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM3', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  assert.equal(store.activeSession?.startTime, null);
  assert.equal(store.activeSession?.isConnected, false);

  store.setConnected(id, true);
  assert.equal(store.activeSession?.isConnected, true);
  const firstStart = store.activeSession?.startTime;
  assert.notEqual(firstStart, null);

  // disconnecting clears startTime so the duration does not include offline time
  store.setConnected(id, false);
  assert.equal(store.activeSession?.isConnected, false);
  assert.equal(store.activeSession?.startTime, null);

  // reconnecting stamps a fresh startTime
  store.setConnected(id, true);
  assert.notEqual(store.activeSession?.startTime, null);
});
