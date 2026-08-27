import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  configForKind,
  DEFAULT_DELIMITER_CONFIG,
  defaultParserConfig,
  delimiterConfig,
  delimiterConfigFromHex,
  filterParsedFrames,
  filterProtocolRecords,
  fixedConfig,
  formatDelimiterHex,
  frameAsciiText,
  lengthConfig,
  nonNegativeInteger,
  parseStrictDelimiterHex,
  parsedFrameStats,
  positiveInteger,
  renderedParsedFrameWindow,
  truncateHexPreview,
} from '@/lib/parser-panel.ts';
import type { ParserConfig } from '@/lib/protocol-parser.ts';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test('defaultParserConfig returns safe defaults without sharing mutable delimiter arrays', () => {
  const a = defaultParserConfig('delimiter');
  const b = defaultParserConfig('delimiter');

  assert.deepEqual(a, DEFAULT_DELIMITER_CONFIG);
  assert.deepEqual(b, DEFAULT_DELIMITER_CONFIG);
  assert.notEqual(
    (a as Extract<ParserConfig, { kind: 'delimiter' }>).delimiter,
    (b as Extract<ParserConfig, { kind: 'delimiter' }>).delimiter,
  );
  assert.deepEqual(defaultParserConfig('fixed'), { kind: 'fixed', frameSize: 8 });
  assert.deepEqual(defaultParserConfig('length'), {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 1,
    bigEndian: true,
    lengthAdjust: 1,
  });
  assert.deepEqual(defaultParserConfig('mcumgr-smp'), {
    kind: 'mcumgr-smp',
    transport: 'serial-console',
    maxPacketBytes: 1024 * 1024,
    reassemblyTimeoutMs: 3000,
  });
});

test('config accessors preserve matching configs and fall back by kind', () => {
  const fixed: ParserConfig = { kind: 'fixed', frameSize: 12 };
  const length: ParserConfig = {
    kind: 'length',
    lengthOffset: 2,
    lengthSize: 2,
    bigEndian: false,
    lengthAdjust: 4,
  };

  assert.equal(configForKind(fixed, 'fixed'), fixed);
  assert.deepEqual(configForKind(fixed, 'length'), defaultParserConfig('length'));
  assert.equal(fixedConfig(fixed).frameSize, 12);
  assert.equal(lengthConfig(length).lengthOffset, 2);
  assert.deepEqual(delimiterConfig(length), defaultParserConfig('delimiter'));
});

test('delimiter helpers format and parse editor input', () => {
  const cfg: ParserConfig = { kind: 'delimiter', delimiter: [0x0d, 0x0a], includeDelimiter: true };

  assert.equal(formatDelimiterHex(cfg.delimiter), '0D 0A');
  assert.deepEqual(delimiterConfigFromHex(cfg, 'aa bb').delimiter, [0xaa, 0xbb]);
  assert.equal(delimiterConfigFromHex(cfg, 'aa bb').includeDelimiter, true);
  assert.deepEqual(parseStrictDelimiterHex('06 09'), { ok: true, bytes: [0x06, 0x09] });
  assert.deepEqual(parseStrictDelimiterHex('0609'), { ok: true, bytes: [0x06, 0x09] });
  assert.deepEqual(parseStrictDelimiterHex('06 0'), { ok: false, reason: 'syntax' });
  assert.deepEqual(parseStrictDelimiterHex('06-09'), { ok: false, reason: 'syntax' });
  assert.deepEqual(parseStrictDelimiterHex('  '), { ok: false, reason: 'empty' });
});

test('integer helpers clamp parser numeric fields like the component controls', () => {
  assert.equal(positiveInteger(null), 1);
  assert.equal(positiveInteger(0), 1);
  assert.equal(positiveInteger(9.8), 9);
  assert.equal(nonNegativeInteger(null), 0);
  assert.equal(nonNegativeInteger(-5), 0);
  assert.equal(nonNegativeInteger(3.9), 3);
});

test('filterParsedFrames trims empty searches and matches decoded text', () => {
  const frames = [{ data: bytes('OK ready') }, { data: bytes('ERR fault') }];

  assert.equal(filterParsedFrames(frames, '   '), frames);
  assert.deepEqual(filterParsedFrames(frames, 'ready'), [frames[0]]);
  assert.deepEqual(filterParsedFrames(frames, 'missing'), []);
});

test('filterProtocolRecords combines direction, status, transaction, header, HEX, and CBOR search', () => {
  const request = {
    kind: 'smp',
    id: 'request',
    offset: 0,
    data: new Uint8Array([0x06, 0x09]),
    direction: 'TX' as const,
    status: 'ok' as const,
    summary: 'image state',
    header: {
      op: 0,
      opName: 'read request',
      group: 1,
      groupName: 'Image',
      command: 0,
      commandName: 'State',
      sequence: 7,
    },
    cbor: new Map([['confirm', true]]),
  };
  const orphan = {
    kind: 'smp',
    id: 'response',
    offset: 10,
    data: new Uint8Array([0xaa]),
    direction: 'RX' as const,
    status: 'warning' as const,
    header: {
      op: 1,
      opName: 'read response',
      group: 0,
      groupName: 'OS',
      command: 0,
      commandName: 'Echo',
      sequence: 8,
    },
  };
  const records = [request, orphan];
  const base = {
    searchTerm: '',
    direction: 'all' as const,
    status: 'all' as const,
    transaction: 'all' as const,
    group: '',
    command: '',
    sequence: '',
  };

  assert.deepEqual(filterProtocolRecords(records, { ...base, direction: 'TX' }), [request]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, status: 'warning' }), [orphan]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, transaction: 'unmatched' }), [orphan]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, group: 'image', command: 'state' }), [
    request,
  ]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, sequence: '7' }), [request]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, searchTerm: '06 09' }), [request]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, searchTerm: 'confirm' }), [request]);
});

test('legacy record search only uses payload text and HEX while SMP keeps metadata search', () => {
  const legacy = {
    kind: 'bytes',
    id: 'legacy',
    offset: 0,
    data: bytes('payload alpha'),
    direction: 'RX' as const,
    status: 'ok' as const,
    summary: 'RX · 13 B',
  };
  const smp = {
    kind: 'smp',
    id: 'smp',
    offset: 13,
    data: bytes('wire body'),
    direction: 'TX' as const,
    status: 'warning' as const,
    summary: 'image state',
    header: {
      op: 0,
      opName: 'read request',
      group: 1,
      groupName: 'Image',
      command: 0,
      commandName: 'State',
      sequence: 7,
    },
  };
  const records = [legacy, smp];
  const base = {
    searchTerm: '',
    direction: 'all' as const,
    status: 'all' as const,
    transaction: 'all' as const,
    group: '',
    command: '',
    sequence: '',
  };

  assert.deepEqual(filterProtocolRecords([legacy], { ...base, searchTerm: 'rx' }), []);
  assert.deepEqual(filterProtocolRecords([legacy], { ...base, searchTerm: 'ok' }), []);
  assert.deepEqual(filterProtocolRecords(records, { ...base, searchTerm: 'alpha' }), [legacy]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, searchTerm: '70 61 79' }), [legacy]);
  assert.deepEqual(filterProtocolRecords(records, { ...base, searchTerm: 'image' }), [smp]);
});

test('renderedParsedFrameWindow returns the tail window and start index', () => {
  const frames = Array.from({ length: 5 }, (_, i) => ({ id: i }));

  assert.deepEqual(renderedParsedFrameWindow(frames, 10), { startIndex: 0, frames });
  assert.deepEqual(renderedParsedFrameWindow(frames, 3), {
    startIndex: 2,
    frames: frames.slice(2),
  });
});

test('parsedFrameStats totals bytes and tracks the largest parsed frame', () => {
  const frames = [{ data: new Uint8Array([1, 2]) }, { data: new Uint8Array([3, 4, 5]) }];

  assert.deepEqual(parsedFrameStats([]), { totalBytes: 0, largestFrame: 0 });
  assert.deepEqual(parsedFrameStats(frames), { totalBytes: 5, largestFrame: 3 });
});

test('preview and ascii helpers mirror parser panel rendering behavior', () => {
  assert.equal(truncateHexPreview('AABBCC', 4), 'AABB\u2026');
  assert.equal(truncateHexPreview('AABB', 4), 'AABB');
  assert.equal(frameAsciiText({ data: new Uint8Array([0x41, 0x00, 0x42]) }), 'A.B');
});
