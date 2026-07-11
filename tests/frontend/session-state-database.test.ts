import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  MAX_PERSISTED_BYTES_PER_SESSION,
  MAX_PERSISTED_FRAMES_PER_SESSION,
  SESSION_STORAGE_VERSION,
  createSessionRecord,
  serializeSessionSnapshots,
} from '../../src/lib/session-persistence.ts';
import {
  SESSION_STATE_DATABASE_NAME,
  SESSION_STATE_DATABASE_VERSION,
  joinSessionStateRecords,
  splitSessionStateRecords,
} from '../../src/lib/session-state-database.ts';
import type { DataFrame, PortConfig } from '../../src/types/index.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  dtr: false,
  rts: false,
};

function frame(id: string, size = 1): DataFrame {
  return {
    id,
    direction: 'RX',
    timestamp: Number(id.replace(/\D/g, '')) || 0,
    data: new Uint8Array(size),
  };
}

test('IndexedDB v2 stores metadata for every session but frame tails for MRU eight only', () => {
  const sessions = Array.from({ length: 12 }, (_, index) =>
    createSessionRecord(`s${index}`, `COM${index}`, config, {
      frames: [frame(`f${index}`)],
    }),
  );
  const mru = ['s11', 's10', 's9', 's8', 's7', 's6', 's5', 's4'];
  const file = serializeSessionSnapshots(sessions, 's11', { mruSessionIds: mru });
  const records = splitSessionStateRecords(file, 123);

  assert.equal(SESSION_STATE_DATABASE_NAME, 'bbcom-session-state');
  assert.equal(SESSION_STATE_DATABASE_VERSION, 2);
  assert.equal(records.sessions.length, 12);
  assert.deepEqual(records.manifest.mruSessionIds, mru);
  assert.deepEqual(
    records.frames.map((record) => record.sessionId),
    mru.slice().reverse(),
  );
  assert.ok(records.frames.every((record) => record.frames[0].data instanceof Uint8Array));
  assert.ok(records.sessions.every((record) => !('frames' in record.metadata)));

  const restored = joinSessionStateRecords(records);
  assert.equal(restored.sessions.length, 12);
  assert.equal(restored.sessions.find((session) => session.id === 's11')?.frames.length, 1);
  assert.equal(restored.sessions.find((session) => session.id === 's0')?.frames.length, 0);
});

test('each retained frame tail is bounded by 2000 entries and 1 MiB', () => {
  const session = createSessionRecord('bounded', 'COM1', config, {
    frames: Array.from({ length: MAX_PERSISTED_FRAMES_PER_SESSION + 20 }, (_, index) =>
      frame(`f${index}`, 512),
    ),
  });
  const file = serializeSessionSnapshots([session], 'bounded');
  const tail = file.sessions[0].frames;

  assert.ok(tail.length <= MAX_PERSISTED_FRAMES_PER_SESSION);
  const bytes = tail.reduce((sum, persisted) => sum + persisted.data.byteLength, 0);
  assert.ok(bytes <= MAX_PERSISTED_BYTES_PER_SESSION);
  assert.equal(file.version, SESSION_STORAGE_VERSION);
});
