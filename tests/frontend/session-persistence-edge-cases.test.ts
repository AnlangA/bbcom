import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import {
  MAX_PERSISTED_BYTES_PER_SESSION,
  cloneParserConfig,
  cloneParserState,
  countFrameTotals,
  createSessionRecord,
  hydrateSession,
  normalizePersistedMruSessionIds,
  normalizePortConfig,
  serializeSessionSnapshots,
} from '../../src/lib/session-persistence.ts';
import {
  appendFrameToSession,
  flushPausedFramesToLive,
  trimSessionsToGlobalByteLimit,
} from '../../src/lib/session-store-helpers.ts';
import {
  isLocalStorageAvailable,
  loadJson,
  loadString,
  removeString,
  saveJson,
  saveString,
} from '../../src/lib/storage.ts';
import type { PortConfig } from '../../src/types/index.ts';
import { frame } from './helpers/frames.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;

afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
});

test('persistence normalizers retain valid alternatives and reject malformed frame inputs', () => {
  assert.deepEqual(cloneParserConfig({ kind: 'unexpected' } as never), {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  });
  assert.deepEqual(
    cloneParserConfig({
      kind: 'length',
      lengthSize: 4,
      lengthOffset: 12,
      bigEndian: false,
      lengthAdjust: 4,
    }),
    {
      kind: 'length',
      lengthSize: 4,
      lengthOffset: 12,
      bigEndian: false,
      lengthAdjust: 4,
    },
  );
  assert.deepEqual(cloneParserState({ config: { kind: 'fixed', frameSize: 9 }, presetId: '' }), {
    config: { kind: 'fixed', frameSize: 9 },
    presetId: '',
  });
  assert.deepEqual(normalizePortConfig(null), config);
  assert.deepEqual(
    normalizePortConfig({
      baudRate: 12.8,
      dataBits: 5,
      stopBits: 2,
      parity: 'odd',
      flowControl: 'software',
      rxFrameGapMs: 2.8,
      dtr: true,
      rts: true,
    }),
    {
      ...config,
      baudRate: 12,
      dataBits: 5,
      stopBits: 2,
      parity: 'odd',
      flowControl: 'software',
      rxFrameGapMs: 2,
      dtr: true,
      rts: true,
    },
  );
  assert.deepEqual(
    normalizePortConfig({
      baudRate: Number.NaN,
      dataBits: 99,
      parity: 'broken',
      flowControl: 'broken',
    }),
    config,
  );

  const generated: string[] = [];
  const restored = hydrateSession(
    {
      portName: 'COM-edge',
      frames: [
        null,
        { direction: 'other', data: new Uint8Array([1]) },
        { direction: 'RX' },
        { direction: 'RX', dataHex: 'not-hex' },
        { direction: 'RX', dataHex: '41', timestamp: Number.NaN },
        { direction: 'TX', data: new Uint8Array([2]), requestedBytes: 0, txStatus: 'bad' },
        { direction: 'TX', data: new Uint8Array([3]), requestedBytes: 4, txStatus: 'complete' },
      ],
      sendHistory: null,
      quickCommands: null,
      macros: null,
      triggers: null,
      highlights: null,
    },
    { createId: () => `id-${generated.push('x')}`, now: () => 17 },
  );
  assert.ok(restored);
  assert.deepEqual(
    restored.frames.map((item) => item.data[0]),
    [0x41, 2, 3],
  );
  assert.equal(restored.frames[0].timestamp, 17);
  assert.equal(restored.frames[1].requestedBytes, undefined);
  assert.equal(restored.frames[2].requestedBytes, 4);
  assert.equal(restored.frames[2].txStatus, 'complete');
  assert.equal(generated.length, 4, 'session plus frames without persisted IDs receive IDs');

  const huge = new Uint8Array(MAX_PERSISTED_BYTES_PER_SESSION + 1);
  assert.equal(
    hydrateSession({ portName: 'COM-too-large', frames: [{ direction: 'RX', data: huge }] })?.frames
      .length,
    0,
  );
});

test('persistence serialization obeys byte caps and MRU choices', () => {
  const oversized = frame(
    'oversized',
    'RX',
    new Array(MAX_PERSISTED_BYTES_PER_SESSION + 1).fill(1),
  );
  const retained = frame('retained', 'TX', [1, 2], 3);
  const first = createSessionRecord('one', 'COM1', config, { frames: [oversized, retained] });
  const second = createSessionRecord('two', 'COM2', config, {
    frames: [frame('two-frame', 'RX', [3])],
  });

  assert.deepEqual(
    normalizePersistedMruSessionIds([first, second], 'two', ['one', 'missing', 'one']),
    ['two', 'one'],
  );
  assert.deepEqual(countFrameTotals([retained, second.frames[0]]), {
    txBytes: 2,
    rxBytes: 1,
    txFrames: 1,
    rxFrames: 1,
  });

  const metadataOnly = serializeSessionSnapshots([first, second], 'one', {
    mruSessionIds: ['two'],
    includeFrames: false,
  });
  assert.deepEqual(
    metadataOnly.sessions.map((session) => session.frames),
    [[], []],
  );

  const snapshot = serializeSessionSnapshots([first, second], 'one', { mruSessionIds: ['one'] });
  assert.deepEqual(
    snapshot.sessions[0].frames.map((item) => item.id),
    ['retained'],
  );
});

test('hydration handles every persisted tail boundary and valid persisted configuration variants', () => {
  assert.deepEqual(
    cloneParserConfig({
      kind: 'delimiter',
      delimiter: undefined,
      includeDelimiter: false,
    } as never),
    {
      kind: 'delimiter',
      delimiter: [0x0d, 0x0a],
      includeDelimiter: false,
    },
  );

  const normalized = hydrateSession({
    portName: 'COM-variants',
    frames: null,
    parserState: {},
    macros: [{ id: 'macro', name: 'Macro', steps: [{ data: 'A', isHex: true, delayMs: 'bad' }] }],
    triggers: [
      {
        id: 'trigger',
        name: 'Trigger',
        enabled: true,
        matchMode: 'hex',
        pattern: 'AA',
        response: 'BB',
        responseIsHex: true,
        cooldownMs: 'bad',
      },
    ],
    highlights: [
      { id: 'h1', name: 'One', pattern: 'A', matchMode: 'hex', direction: 'TX', color: 'blue' },
      { id: 'h2', name: 'Two', pattern: 'B', matchMode: 'text', direction: 'RX', color: 'green' },
      {
        id: 'h3',
        name: 'Three',
        pattern: 'C',
        matchMode: 'text',
        direction: 'ALL',
        color: 'violet',
      },
    ],
  });
  assert.ok(normalized);
  assert.equal(normalized.macros[0].steps[0].delayMs, 0);
  assert.equal(normalized.triggers[0].matchMode, 'hex');
  assert.equal(normalized.triggers[0].cooldownMs, 500);
  assert.deepEqual(
    normalized.highlights.map((highlight) => highlight.color),
    ['blue', 'green', 'violet'],
  );

  const overlongHex = hydrateSession({
    portName: 'COM-long-hex',
    frames: [{ direction: 'RX', dataHex: '00'.repeat(MAX_PERSISTED_BYTES_PER_SESSION * 2) }],
  });
  assert.equal(overlongHex?.frames.length, 0);

  const frameCountLimited = hydrateSession({
    portName: 'COM-frame-count',
    frames: Array.from({ length: 2_001 }, (_, index) => ({
      id: `f-${index}`,
      direction: 'RX',
      timestamp: index,
      data: new Uint8Array([index]),
    })),
  });
  assert.equal(frameCountLimited?.frames.length, 2_000);

  const bytesLimited = hydrateSession({
    portName: 'COM-byte-count',
    frames: [
      { id: 'first', direction: 'RX', data: new Uint8Array(600_000) },
      { id: 'second', direction: 'RX', data: new Uint8Array(600_000) },
    ],
  });
  assert.deepEqual(
    bytesLimited?.frames.map((item) => item.id),
    ['second'],
  );

  const partial = createSessionRecord('partial-local', 'COM-local', config, {
    frames: [
      {
        id: 'partial',
        direction: 'TX',
        timestamp: 1,
        data: new Uint8Array([1]),
        txStatus: 'partial-unknown',
        requestedBytes: 4,
      },
    ],
  });
  const persisted = serializeSessionSnapshots([partial], 'partial-local');
  assert.deepEqual(persisted.sessions[0].frames[0], {
    id: 'partial',
    direction: 'TX',
    timestamp: 1,
    data: new Uint8Array([1]),
    txStatus: 'partial-unknown',
    requestedBytes: 4,
  });
});

test('buffer helpers cover empty, frame-count, and global-empty eviction paths', () => {
  const session = createSessionRecord('helper', 'COM-helper', config, {
    frames: [frame('old', 'RX', [1], 1)],
    pausedFrames: [frame('new', 'TX', [2], 2)],
  });
  const countTrim = appendFrameToSession(session, frame('incoming', 'RX', [3], 3), 1, {
    trimThreshold: 0,
    currentBytes: 2,
    maxBytes: 10,
  });
  assert.deepEqual(countTrim, { retainedBytes: 2, droppedBytes: 1, droppedFrames: 1 });
  assert.deepEqual(
    session.frames.map((item) => item.id),
    ['incoming'],
  );
  assert.deepEqual(
    session.pausedFrames.map((item) => item.id),
    ['new'],
  );

  const emptyPaused = createSessionRecord('empty', 'COM-empty', config);
  assert.deepEqual(flushPausedFramesToLive(emptyPaused, 5), {
    retainedBytes: 0,
    droppedBytes: 0,
    droppedFrames: 0,
  });

  const overLimit = createSessionRecord('over', 'COM-over', config, {
    frames: [frame('a', 'RX', [1, 2], 2), frame('b', 'RX', [3, 4], 3)],
    pausedFrames: [frame('held', 'RX', [5], 4)],
  });
  const flushed = flushPausedFramesToLive(overLimit, 10, { currentBytes: 5, maxBytes: 1 });
  assert.equal(flushed.retainedBytes, 1);
  assert.equal(flushed.droppedFrames, 2);
  assert.deepEqual(
    overLimit.frames.map((item) => item.id),
    ['held'],
  );

  assert.deepEqual(trimSessionsToGlobalByteLimit([], 5, 1), {
    retainedBytes: 0,
    droppedBytesBySession: new Map(),
    droppedFramesBySession: new Map(),
  });
});

test('storage helpers handle unavailable, normal, and throwing browser storage', () => {
  (globalThis as { localStorage?: Storage }).localStorage = undefined;
  assert.equal(isLocalStorageAvailable(), false);
  assert.equal(loadString('missing'), '');
  assert.deepEqual(loadJson('missing', { value: 1 }), { value: 1 });
  assert.equal(saveString('missing', 'x'), false);
  assert.equal(saveJson('missing', { value: 1 }), false);
  assert.equal(removeString('missing'), false);

  const values = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
  assert.equal(isLocalStorageAvailable(), true);
  assert.deepEqual(loadJson('absent-json', { fallback: true }), { fallback: true });
  assert.equal(saveString('text', 'value'), true);
  assert.equal(loadString('text'), 'value');
  assert.equal(saveString('text', ''), true);
  assert.equal(loadString('text'), '');
  assert.equal(saveJson('json', { value: 2 }), true);
  assert.deepEqual(loadJson('json', { fallback: true }), { fallback: true, value: 2 });
  assert.equal(removeString('json'), true);

  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
  assert.equal(loadString('x'), '');
  assert.deepEqual(loadJson('x', { fallback: true }), { fallback: true });
  assert.equal(saveString('x', 'value'), false);
  assert.equal(saveJson('x', { value: true }), false);
  assert.equal(removeString('x'), false);
});
