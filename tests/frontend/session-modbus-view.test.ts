import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildModbusWaveformChannelLabels,
  findAvailableModbusWaveformChannel,
  formatSessionModbusStatus,
  snapshotModbusStatus,
} from '../../src/lib/session-modbus-view.ts';

const messages: Record<string, string> = {
  'modbus.status.idle': 'Idle',
  'modbus.status.polling': 'Polling {count}',
  'modbus.status.writing': 'Writing {count}',
  'modbus.status.timeout': 'Timeout',
  'modbus.status.exception': 'Exception {code}',
  'modbus.status.crcError': 'CRC',
  'modbus.status.replaying': 'Replaying {remaining}',
  'modbus.status.backoff': '{scope} backoff {delay}/{count}',
  'modbus.status.scopeRead': 'Read',
  'modbus.status.scopeWrite': 'Write',
  'modbus.status.error': 'Error {message}',
};

function tr(key: string, params?: Record<string, string | number>): string {
  let text = messages[key] ?? key;
  if (!params) return text;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

test('snapshotModbusStatus keeps optional status fields including batch key', () => {
  assert.deepEqual(
    snapshotModbusStatus({
      kind: 'backoff',
      scope: 'read',
      key: '1:3:0:2',
      delayMs: 2000,
      consecutiveFailures: 3,
    }),
    {
      kind: 'backoff',
      code: undefined,
      count: undefined,
      remaining: undefined,
      message: undefined,
      scope: 'read',
      key: '1:3:0:2',
      delayMs: 2000,
      consecutiveFailures: 3,
    },
  );
});

test('formatSessionModbusStatus formats every user-visible status branch', () => {
  assert.equal(formatSessionModbusStatus({ kind: 'idle' }, tr), 'Idle');
  assert.equal(formatSessionModbusStatus({ kind: 'polling', count: 4 }, tr), 'Polling 4');
  assert.equal(formatSessionModbusStatus({ kind: 'writing', count: 2 }, tr), 'Writing 2');
  assert.equal(formatSessionModbusStatus({ kind: 'timeout' }, tr), 'Timeout');
  assert.equal(formatSessionModbusStatus({ kind: 'exception', code: 3 }, tr), 'Exception 3');
  assert.equal(formatSessionModbusStatus({ kind: 'crc-error' }, tr), 'CRC');
  assert.equal(formatSessionModbusStatus({ kind: 'replaying', remaining: 9 }, tr), 'Replaying 9');
  assert.equal(
    formatSessionModbusStatus({ kind: 'error', message: 'bad frame' }, tr),
    'Error bad frame',
  );
  assert.equal(
    formatSessionModbusStatus(
      { kind: 'backoff', scope: 'write', delayMs: 800, consecutiveFailures: 5 },
      tr,
    ),
    'Write backoff 800/5',
  );
  assert.equal(
    formatSessionModbusStatus({ kind: 'backoff', scope: 'read', delayMs: 400 }, tr),
    'Read backoff 400/0',
  );
});

test('formatSessionModbusStatus falls back to safe zero/empty values', () => {
  assert.equal(formatSessionModbusStatus({ kind: 'polling' }, tr), 'Polling 0');
  assert.equal(formatSessionModbusStatus({ kind: 'exception' }, tr), 'Exception 0');
  assert.equal(formatSessionModbusStatus({ kind: 'replaying' }, tr), 'Replaying 0');
  assert.equal(formatSessionModbusStatus({ kind: 'error' }, tr), 'Error ');
  assert.equal(formatSessionModbusStatus({ kind: 'unknown' }, tr), 'Idle');
});

test('buildModbusWaveformChannelLabels maps assigned channels to latest register name', () => {
  assert.deepEqual(
    buildModbusWaveformChannelLabels([
      { name: 'Temperature', waveformChannel: 0 },
      { name: 'Pressure', waveformChannel: 2 },
      { name: 'Ignored', waveformChannel: null },
      { name: 'Override', waveformChannel: 2 },
    ]),
    {
      0: 'Temperature',
      2: 'Override',
    },
  );
});

test('findAvailableModbusWaveformChannel returns the first free channel', () => {
  assert.equal(
    findAvailableModbusWaveformChannel([
      { waveformChannel: 0 },
      { waveformChannel: 2 },
      { waveformChannel: null },
    ]),
    1,
  );
  assert.equal(
    findAvailableModbusWaveformChannel([
      { waveformChannel: -1 },
      { waveformChannel: 9 },
      { waveformChannel: null },
    ]),
    0,
  );
});

test('findAvailableModbusWaveformChannel returns null when all channels are used', () => {
  assert.equal(
    findAvailableModbusWaveformChannel(
      Array.from({ length: 8 }, (_, waveformChannel) => ({ waveformChannel })),
    ),
    null,
  );
  assert.equal(
    findAvailableModbusWaveformChannel([{ waveformChannel: 0 }, { waveformChannel: 1 }], 2),
    null,
  );
});
