import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { SESSION_STORAGE_KEY } from '../../src/lib/session-persistence.ts';
import { useSessionStore } from '../../src/stores/sessions.ts';
import type { PortConfig } from '../../src/types/index.ts';

const config: PortConfig = {
  baudRate: 57600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

interface StorageDouble {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;

afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
});

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  const storage: StorageDouble = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  (globalThis as { localStorage: StorageDouble }).localStorage = storage;
  return values;
}

function store() {
  setActivePinia(createPinia());
  return useSessionStore();
}

test('session store public API handles every session-owned configuration and missing-session no-ops', async () => {
  const storage = installStorage();
  const sessions = store();
  await sessions.whenPersistenceReady();

  const missing = 'not-a-session';
  assert.equal(
    sessions.addFrame(missing, { direction: 'RX', data: new Uint8Array([0]) }),
    undefined,
  );
  sessions.publishSessionFrames(missing);
  sessions.setConnected(missing, true);
  sessions.updateDroppedBytes(missing, 10);
  sessions.clearFrames(missing);
  sessions.setCapturePaused(missing, true);
  sessions.addSendHistory(missing, { data: 'x', isHex: false });
  sessions.clearSendHistory(missing);
  sessions.setSendDraft(missing, 'x');
  sessions.addQuickCommand(missing, { name: 'missing', data: 'x', isHex: false });
  sessions.removeQuickCommand(missing, 'x');
  assert.equal(sessions.addMacro(missing, { name: 'missing', steps: [] }), undefined);
  sessions.updateMacro(missing, 'x', { name: 'x' });
  sessions.removeMacro(missing, 'x');
  assert.equal(
    sessions.addTrigger(missing, {
      name: 'missing',
      enabled: true,
      matchMode: 'text',
      pattern: 'x',
      response: 'x',
      responseIsHex: false,
      cooldownMs: 0,
    }),
    undefined,
  );
  sessions.updateTrigger(missing, 'x', { name: 'x' });
  sessions.removeTrigger(missing, 'x');
  assert.equal(
    sessions.addHighlight(missing, {
      name: 'missing',
      enabled: true,
      matchMode: 'text',
      pattern: 'x',
      direction: 'ALL',
      color: 'amber',
    }),
    undefined,
  );
  sessions.updateHighlight(missing, 'x', { name: 'x' });
  sessions.removeHighlight(missing, 'x');
  sessions.setParserState(missing, { kind: 'fixed', frameSize: 2 });
  assert.equal(
    sessions.addModbusRegister(missing, {
      name: 'missing',
      slaveAddress: 1,
      functionCode: 0x03,
      address: 0,
      type: 'uint16',
      waveformChannel: null,
      periodicRead: true,
      periodicWrite: false,
    }),
    undefined,
  );
  sessions.updateModbusRegister(missing, 'x', { name: 'x' });
  sessions.removeModbusRegister(missing, 'x');
  sessions.setModbusRegisters(missing, []);
  sessions.setModbusRegisterValues(missing, []);
  sessions.setModbusConfig(missing, { enabled: true });
  sessions.setWaveformSourceMode(missing, 'register');
  sessions.setAutoLogTarget(missing, '/tmp/missing');
  sessions.setTerminalAiModel(missing, 'glm-4.7');
  sessions.setLogAiModel(missing, 'glm-5.1');
  sessions.setLogAiContextMode(missing, 'full-capped');
  sessions.setLogAiFrameLimit(missing, 20);
  sessions.addLogAiMessage(missing, { role: 'user', content: 'missing' });
  sessions.clearLogAiMessages(missing);

  const first = sessions.createSession('COM-public-1', config);
  const second = sessions.createSession('COM-public-2', config);
  assert.equal(sessions.activeSessionId, second);
  sessions.setActiveSession(first);
  assert.equal(sessions.activeSessionId, first);
  assert.equal(sessions.getSessionFramesVersion(first), 0);

  sessions.addFrame(first, { direction: 'RX', data: new Uint8Array([1]) }, { publish: false });
  assert.equal(sessions.getSessionFramesVersion(first), 0);
  sessions.publishSessionFrames(first);
  assert.equal(sessions.getSessionFramesVersion(first), 1);
  sessions.addFrame(first, { direction: 'TX', data: new Uint8Array([2, 3]) });
  sessions.setConnected(first, true);
  assert.equal(sessions.activeSession?.isConnected, true);
  assert.ok(sessions.activeSession?.startTime);
  sessions.setConnected(first, false);
  assert.equal(sessions.activeSession?.startTime, null);
  sessions.updateDroppedBytes(first, Number.NaN);
  sessions.updateDroppedBytes(first, -5);
  assert.equal(sessions.activeSession?.droppedBytes, 0);

  let cleared = 0;
  const unregister = sessions.onFramesCleared(first, () => {
    cleared += 1;
  });
  const unregisterThrowing = sessions.onFramesCleared(first, () => {
    throw new Error('listener failure must not block clearing');
  });
  sessions.clearFrames(first);
  assert.equal(cleared, 1);
  unregisterThrowing();
  unregister();
  sessions.clearFrames(first);

  sessions.setCapturePaused(first, true);
  sessions.setCapturePaused(first, true);
  sessions.addFrame(first, { direction: 'RX', data: new Uint8Array([4]) });
  sessions.setCapturePaused(first, false);
  sessions.setCapturePaused(first, false);

  sessions.addSendHistory(first, { data: 'AT', isHex: false });
  sessions.clearSendHistory(first);
  sessions.setSendDraft(first, 'AT+RESET');
  sessions.addQuickCommand(first, { name: 'Ping', data: 'AT', isHex: false });
  const commandId = sessions.sessions.find((session) => session.id === first)?.quickCommands[0]?.id;
  assert.ok(commandId);
  sessions.removeQuickCommand(first, commandId);

  const macroId = sessions.addMacro(first, {
    name: 'Boot',
    steps: [{ data: 'AT', isHex: false, delayMs: 1 }],
  });
  assert.ok(macroId);
  sessions.updateMacro(first, 'missing', { name: 'unchanged' });
  sessions.updateMacro(first, macroId, { name: 'Boot 2' });
  sessions.removeMacro(first, macroId);

  const triggerId = sessions.addTrigger(first, {
    name: 'Prompt',
    enabled: true,
    matchMode: 'text',
    pattern: '>',
    response: 'AT',
    responseIsHex: false,
    cooldownMs: 10,
  });
  assert.ok(triggerId);
  sessions.updateTrigger(first, 'missing', { name: 'unchanged' });
  sessions.updateTrigger(first, triggerId, { enabled: false });
  sessions.removeTrigger(first, triggerId);

  const highlightId = sessions.addHighlight(first, {
    name: 'Alert',
    enabled: true,
    matchMode: 'text',
    pattern: 'ERR',
    direction: 'RX',
    color: 'red',
  });
  assert.ok(highlightId);
  sessions.updateHighlight(first, 'missing', { name: 'unchanged' });
  sessions.updateHighlight(first, highlightId, { color: 'green' });
  sessions.removeHighlight(first, highlightId);

  sessions.setParserState(
    first,
    { kind: 'delimiter', delimiter: [10], includeDelimiter: true },
    null,
  );
  const registerId = sessions.addModbusRegister(first, {
    name: 'Register',
    slaveAddress: 1,
    functionCode: 0x03,
    address: 2,
    type: 'uint16',
    waveformChannel: 0,
    periodicRead: true,
    periodicWrite: false,
  });
  assert.ok(registerId);
  sessions.updateModbusRegister(first, 'missing', { name: 'unchanged' });
  sessions.updateModbusRegister(first, registerId, { name: 'Register 2' });
  sessions.setModbusRegisterValues(first, []);
  sessions.setModbusRegisterValues(first, [
    { id: registerId, value: 7, values: [7], valueTs: 10 },
    { id: 'missing', value: 8, valueTs: 10 },
  ]);
  sessions.setModbusRegisters(first, sessions.activeSession?.modbusRegisters ?? []);
  sessions.removeModbusRegister(first, registerId);
  sessions.setModbusConfig(first, { enabled: true, timeoutMs: 200 });
  sessions.setWaveformSourceMode(first, 'register');
  sessions.setAutoLogTarget(first, '/display-only/log.txt');
  sessions.setAutoLogTarget(first, null);
  sessions.setTerminalAiModel(first, 'glm-4.7');
  sessions.setLogAiModel(first, 'glm-5.1');
  sessions.setLogAiContextMode(first, 'latest-n-frames');
  sessions.setLogAiFrameLimit(first, 99999);
  sessions.addLogAiMessage(first, { role: 'user', content: 'question' });
  sessions.clearLogAiMessages(first);

  sessions.reorderSessions(0, 0);
  sessions.reorderSessions(-1, 0);
  sessions.reorderSessions(0, 99);
  sessions.reorderSessions(0, 1);
  assert.equal(sessions.sessions.length, 2);

  let cleaned = 0;
  sessions.registerCleanup(second, async () => {
    cleaned += 1;
  });
  // Removing the active tab promotes the remaining resident tab and refreshes
  // its MRU position before its own cleanup later runs.
  await sessions.removeSession(first);
  assert.equal(sessions.activeSessionId, second);
  await sessions.removeSession(second);
  assert.equal(cleaned, 1);
  await sessions.removeSession(missing);

  await sessions.flushPersistedSessions();
  assert.ok(storage.has(SESSION_STORAGE_KEY));
  assert.equal(await sessions.flushFinalPersistence(), 'completed');
});
