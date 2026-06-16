import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PERSISTED_FRAMES_PER_SESSION,
  SESSION_STORAGE_VERSION,
  createSessionRecord,
  hydrateSession,
  normalizeParserState,
  serializeSessionSnapshots,
} from '../../src/lib/session-persistence.ts';
import type { DataFrame, PortConfig } from '../../src/types/index.ts';

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  dtr: false,
  rts: false,
};

function frame(id: string, timestamp: number, direction: 'TX' | 'RX', data: number[]): DataFrame {
  return {
    id,
    timestamp,
    direction,
    data: new Uint8Array(data),
  };
}

test('createSessionRecord centralizes session defaults', () => {
  const session = createSessionRecord('s1', 'COM1', cfg);
  assert.equal(session.id, 's1');
  assert.equal(session.portName, 'COM1');
  assert.equal(session.isConnected, false);
  assert.deepEqual(session.frames, []);
  assert.equal(session.modbusConfig.transport, 'rtu');
  assert.equal(session.modbusConfig.enabled, false);
  assert.equal(session.parserState.presetId, 'at-crlf');
  assert.equal(session.terminalAiModel, 'glm-4.5-air');
});

test('hydrateSession restores frames, totals, tools, and decorates frames', () => {
  const decoratedIds: string[] = [];
  let idSeq = 0;
  const session = hydrateSession(
    {
      id: 'saved',
      portName: 'COM9',
      portConfig: { ...cfg, baudRate: 115200 },
      frames: [
        { direction: 'RX', dataHex: '41 42' },
        { id: 'bad', direction: 'TX', dataHex: 'not hex' },
        { id: 'tx', direction: 'TX', timestamp: 99, dataHex: '43' },
      ],
      sendHistory: [
        { data: 'AT', isHex: false },
        { data: 1, isHex: false },
      ],
      quickCommands: [{ name: '  ', data: 'AT', isHex: false }],
      macros: [{ name: '', steps: [{ data: 'BOOT', isHex: false, delayMs: 1.8 }] }],
      triggers: [{ name: '', pattern: 'ok', response: 'AT', cooldownMs: 100_000 }],
      highlights: [{ name: '', pattern: 'ERR', direction: 'RX', color: 'red' }],
      parserState: { config: { kind: 'fixed', frameSize: 0 }, presetId: 3 },
      modbusRegisters: [{ id: 'r1', functionCode: 0x03, value: 7 }],
      modbusConfig: { transport: 'pdu', enabled: true, pollIntervalMs: 10, timeoutMs: 9999 },
      waveformSourceMode: 'register',
      terminalAiModel: 'glm-5.1',
      logAiModel: 'bad-model',
      logAiContextMode: 'latest-n-frames',
      logAiFrameLimit: 9999,
    },
    {
      createId: () => `generated-${++idSeq}`,
      now: () => 1234,
      decorateFrame: (f) => {
        decoratedIds.push(f.id);
        return f;
      },
    },
  );

  assert.ok(session);
  assert.equal(session.id, 'saved');
  assert.equal(session.frames.length, 2);
  assert.deepEqual(decoratedIds, ['generated-1', 'tx']);
  assert.equal(session.frames[0].timestamp, 1234);
  assert.deepEqual(Array.from(session.frames[0].data), [0x41, 0x42]);
  assert.equal(session.rxBytes, 2);
  assert.equal(session.txBytes, 1);
  assert.equal(session.quickCommands[0].name, 'Command');
  assert.equal(session.macros[0].name, 'Macro');
  assert.equal(session.macros[0].steps[0].delayMs, 1);
  assert.equal(session.triggers[0].name, 'Trigger');
  assert.equal(session.triggers[0].cooldownMs, 60_000);
  assert.equal(session.highlights[0].name, 'Highlight');
  assert.deepEqual(session.parserState, {
    config: { kind: 'fixed', frameSize: 1 },
    presetId: null,
  });
  assert.equal(session.modbusRegisters[0].value, 7);
  assert.equal(session.modbusConfig.pollIntervalMs, 100);
  assert.equal(session.modbusConfig.timeoutMs, 5_000);
  assert.equal(session.waveformSourceMode, 'register');
  assert.equal(session.terminalAiModel, 'glm-5.1');
  assert.equal(session.logAiModel, 'glm-4.5-air');
  assert.equal(session.logAiFrameLimit, 2_000);
});

test('hydrateSession rejects invalid persisted sessions', () => {
  assert.equal(hydrateSession(null), null);
  assert.equal(hydrateSession({ portName: '' }), null);
  assert.equal(hydrateSession({ id: 'x' }), null);
});

test('serializeSessionSnapshots bounds frame tails and strips Modbus runtime values', () => {
  const session = createSessionRecord('s1', 'COM1', cfg, {
    frames: Array.from({ length: MAX_PERSISTED_FRAMES_PER_SESSION + 5 }, (_, i) =>
      frame(`f${i}`, i, 'RX', [i % 256]),
    ),
    pausedFrames: [frame('paused', 9999, 'TX', [0xaa])],
    sendHistory: Array.from({ length: 25 }, (_, i) => ({ data: `AT${i}`, isHex: false })),
    modbusRegisters: [
      {
        id: 'r1',
        name: 'Runtime',
        slaveAddress: 1,
        functionCode: 0x03,
        address: 1,
        quantity: 1,
        type: 'uint16',
        waveformChannel: 0,
        value: 99,
        values: [99],
        valueTs: 123,
        periodicRead: true,
        periodicWrite: false,
      },
    ],
  });

  const snapshot = serializeSessionSnapshots([session], 's1');
  assert.equal(snapshot.version, SESSION_STORAGE_VERSION);
  assert.equal(snapshot.activeSessionId, 's1');
  assert.equal(snapshot.sessions[0].frames.length, MAX_PERSISTED_FRAMES_PER_SESSION);
  assert.equal(snapshot.sessions[0].frames[0].id, 'f6');
  assert.equal(snapshot.sessions[0].frames.at(-1)?.id, 'paused');
  assert.equal(snapshot.sessions[0].sendHistory.length, 20);
  assert.equal(snapshot.sessions[0].modbusRegisters[0].value, null);
  assert.equal(snapshot.sessions[0].modbusRegisters[0].values, null);
  assert.equal(snapshot.sessions[0].modbusRegisters[0].valueTs, null);
});

test('normalizeParserState clamps malformed parser configs', () => {
  assert.deepEqual(normalizeParserState({ config: { kind: 'length', lengthSize: 9 } }), {
    config: {
      kind: 'length',
      lengthOffset: 0,
      lengthSize: 1,
      bigEndian: true,
      lengthAdjust: 0,
    },
    presetId: null,
  });
});
