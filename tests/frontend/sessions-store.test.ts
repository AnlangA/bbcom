import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/features/sessions/store/session-store.ts';
import { setMaxBufferFrames } from '../../src/lib/buffer-config.ts';
import { MAX_FRAMES } from '../../src/types/index.ts';
import {
  hydrateSession,
  migratePersistedFile,
  serializeSessionSnapshots,
} from '../../src/lib/session-persistence.ts';
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
  rxFrameGapMs: 5,
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
  assert.equal(s.sessions[0].droppedBytes, 501, 'frame-buffer evictions count as dropped bytes');
  s.updateDroppedBytes(id, 3);
  assert.equal(
    s.sessions[0].droppedBytes,
    504,
    'RX-queue and frame-buffer drops remain independently cumulative',
  );
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

    const persisted = serializeSessionSnapshots([s.sessions[0]], id);
    assert.equal(persisted.sessions.length, 1);
    const session = hydrateSession(persisted.sessions[0]);
    assert.ok(session, 'persisted session hydrates');
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
    const persisted = serializeSessionSnapshots([s.sessions[0]], id);
    assert.equal(persisted.sessions[0].frames.length, 2000);
    assert.deepEqual(Array.from(persisted.sessions[0].frames[0].data), [105]);
  });
});

test('modbus registers + config round-trip through persistence; values are dropped', async () => {
  await withLocalStorageMock(async () => {
    const s = store();
    const id = s.createSession('COM11', cfg);

    // Defaults: RTU transport, polling off.
    assert.equal(s.sessions[0].modbusConfig.transport, 'rtu');
    assert.equal(s.sessions[0].modbusConfig.enabled, false);
    assert.equal(s.sessions[0].waveformSourceMode, 'text');
    assert.deepEqual(s.sessions[0].modbusRegisters, []);

    // Add a register with a runtime value + a PDU transport override.
    s.addModbusRegister(id, {
      name: 'Temperature',
      slaveAddress: 2,
      functionCode: 0x03,
      address: 100,
      type: 'uint16',
      unit: '°C',
      waveformChannel: 1,
      periodicRead: true,
      periodicWrite: false,
    });
    s.setModbusRegisterValues(id, [
      { id: s.sessions[0].modbusRegisters[0].id, value: 42, valueTs: 1234 },
    ]);
    s.setModbusConfig(id, {
      transport: 'pdu',
      enabled: true,
      pollIntervalMs: 250,
      writeIntervalMs: 500,
      timeoutMs: 300,
    });
    s.setWaveformSourceMode(id, 'register');

    const persisted = serializeSessionSnapshots([s.sessions[0]], id);
    const restored = hydrateSession(persisted.sessions[0]);
    assert.ok(restored, 'persisted session hydrates');
    const reg = restored.modbusRegisters[0];
    assert.equal(reg.name, 'Temperature');
    assert.equal(reg.slaveAddress, 2);
    assert.equal(reg.functionCode, 0x03);
    assert.equal(reg.address, 100);
    assert.equal(reg.type, 'uint16');
    assert.equal(reg.unit, '°C');
    assert.equal(reg.waveformChannel, 1);
    // periodic flags persist (they are config, not runtime values).
    assert.equal(reg.periodicRead, true, 'periodicRead survives reload');
    assert.equal(reg.periodicWrite, false, 'periodicWrite survives reload');
    // Runtime values must NOT survive a reload — they are repopulated by polling.
    assert.equal(reg.value, null);
    assert.equal(reg.valueTs, null);

    assert.equal(restored.modbusConfig.transport, 'pdu');
    assert.equal(restored.modbusConfig.enabled, true);
    assert.equal(restored.modbusConfig.pollIntervalMs, 250);
    assert.equal(restored.modbusConfig.writeIntervalMs, 500, 'writeIntervalMs survives reload');
    assert.equal(restored.modbusConfig.timeoutMs, 300);
    assert.equal(restored.waveformSourceMode, 'register');
  });
});

test('modbus register edits are normalized after a row is added', async () => {
  await withLocalStorageMock(async () => {
    const s = store();
    const id = s.createSession('COM12', cfg);
    const regId = s.addModbusRegister(id, {
      name: 'Setpoint',
      slaveAddress: 1,
      functionCode: 0x03,
      address: 0,
      type: 'uint16',
      waveformChannel: 0,
      periodicRead: true,
      periodicWrite: false,
    });
    assert.ok(regId);

    s.updateModbusRegister(id, regId, {
      slaveAddress: 999,
      functionCode: 0x10,
      address: 99999,
      quantity: 999,
      type: 'float32-be',
      unit: '',
      waveformChannel: 99,
      periodicRead: true,
      periodicWrite: true,
      value: 1,
      values: [1, 2],
      valueTs: 123,
    });

    const reg = s.sessions[0].modbusRegisters[0];
    assert.equal(reg.slaveAddress, 247);
    assert.equal(reg.functionCode, 0x10);
    assert.equal(reg.address, 65535);
    assert.equal(reg.quantity, 61);
    assert.equal(reg.type, 'float32-be');
    assert.equal(reg.unit, undefined);
    assert.equal(reg.waveformChannel, null);
    assert.equal(reg.periodicRead, false);
    assert.equal(reg.periodicWrite, true);
    assert.equal(reg.value, 1);
    assert.deepEqual(reg.values, [1, 2]);
    assert.equal(reg.valueTs, 123);
  });
});

test('modbus register additions notify consumers holding the session object', () => {
  const s = store();
  const id = s.createSession('COM13', cfg);
  const session = s.sessions[0];
  const registerCount = computed(() => session.modbusRegisters.length);
  const firstName = computed(() => session.modbusRegisters[0]?.name ?? '');

  assert.equal(session.isConnected, false);
  assert.equal(registerCount.value, 0);

  const regId = s.addModbusRegister(id, {
    name: 'Offline temperature',
    slaveAddress: 1,
    functionCode: 0x03,
    address: 10,
    type: 'uint16',
    waveformChannel: null,
    periodicRead: true,
    periodicWrite: false,
  });

  assert.ok(regId);
  assert.equal(registerCount.value, 1);
  assert.equal(firstName.value, 'Offline temperature');

  s.updateModbusRegister(id, regId, { name: 'Edited offline temperature' });
  assert.equal(firstName.value, 'Edited offline temperature');
});

test('modbus config is clamped to valid ranges on hydration', () => {
  const bad = {
    version: 1,
    activeSessionId: 'x',
    sessions: [
      {
        id: 'x',
        portName: 'COM12',
        portConfig: cfg,
        frames: [],
        modbusRegisters: [
          {
            id: 'r1',
            name: 'Bad',
            slaveAddress: 999,
            functionCode: 0x99,
            address: -5,
            type: 'bogus',
            value: 7,
            valueTs: 1,
          },
        ],
        modbusConfig: { transport: 'weird', enabled: 'yes', pollIntervalMs: 5, timeoutMs: 99999 },
        waveformSourceMode: 'unknown',
      },
    ],
  };

  const migrated = migratePersistedFile(bad);
  const session = hydrateSession(migrated.sessions[0]);
  assert.ok(session, 'malformed snapshot still hydrates');
  const reg = session.modbusRegisters[0];
  assert.equal(reg.slaveAddress, 247, 'slave clamped');
  assert.equal(reg.functionCode, 0x03, 'unknown FC defaults to read-holding');
  assert.equal(reg.address, 0, 'negative address clamped to 0');
  assert.equal(reg.type, 'uint16', 'unknown type defaults to uint16');
  // Pre-flag snapshots migrate to safe defaults: read-on, write-off.
  assert.equal(reg.periodicRead, true, 'missing periodicRead defaults to true');
  assert.equal(reg.periodicWrite, false, 'missing periodicWrite defaults to false');
  // The normalize layer preserves a carried value (used by snapshot import);
  // production persistence strips values before writing via
  // persistableModbusRegisters, so reloads start clean. Here we injected a
  // raw value directly, so it survives normalization — verifying that path.
  assert.equal(reg.value, 7, 'carried value preserved by normalize');

  const mc = session.modbusConfig;
  assert.equal(mc.transport, 'rtu');
  assert.equal(mc.enabled, false);
  assert.equal(mc.pollIntervalMs, 100, 'below-min interval clamped');
  assert.equal(mc.writeIntervalMs, 1000, 'missing writeIntervalMs defaults to 1000');
  assert.equal(mc.timeoutMs, 5000, 'above-max timeout clamped');
  assert.equal(session.waveformSourceMode, 'text');
});
