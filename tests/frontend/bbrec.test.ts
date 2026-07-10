import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BBREC_MAGIC,
  bytesToHex,
  encodeBbrec,
  hexToBytes,
  parseBbrec,
  replayBbrec,
  type ByteRecord,
} from '../../src/lib/bbrec.ts';
import { ProtocolParser } from '../../src/lib/protocol-parser.ts';
import { toProtocolEngine } from '../../src/lib/protocol-engine.ts';

function rec(dir: 'rx' | 'tx', t: number, hex: string): ByteRecord {
  return { dir, t, hex };
}

test('bytesToHex / hexToBytes round-trip arbitrary bytes', () => {
  for (const [label, bytes] of [
    ['empty', new Uint8Array([])],
    ['single', new Uint8Array([0x00])],
    ['all-byte-values', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))],
    ['ascii', new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])],
  ] as const) {
    const hex = bytesToHex(bytes);
    const back = hexToBytes(hex);
    assert.deepEqual(Array.from(back), Array.from(bytes), `${label} round-trips`);
  }
});

test('encodeBbrec + parseBbrec round-trip records exactly', () => {
  const records: ByteRecord[] = [
    rec('rx', 0, '48656C6C6F'),
    rec('tx', 12, '4154'),
    rec('rx', 50, '0D0A'),
  ];
  const text = encodeBbrec(records);
  assert.ok(text.startsWith(BBREC_MAGIC), 'magic header first');
  const back = parseBbrec(text);
  assert.deepEqual(back, records, 'records survive the round-trip');
});

test('parseBbrec rejects a non-.bbrec file (missing magic)', () => {
  assert.throws(
    () => parseBbrec('just some\nplain text\n'),
    /Not a \.bbrec file/,
    'wrong magic throws',
  );
});

test('parseBbrec skips blank lines and the magic header', () => {
  const text = `${BBREC_MAGIC}\n\n  \n${JSON.stringify(rec('rx', 0, 'AA'))}\n`;
  const back = parseBbrec(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].hex, 'AA');
});

test('parseBbrec rejects a malformed record line', () => {
  const text = `${BBREC_MAGIC}\n{"foo":"bar"}\n`;
  assert.throws(() => parseBbrec(text), /not a valid ByteRecord/);
});

test('toProtocolEngine adapts ProtocolParser to the ProtocolEngine interface', () => {
  const parser = new ProtocolParser({ kind: 'fixed', frameSize: 3 });
  const engine = toProtocolEngine(parser);
  assert.equal(engine.name, 'fixed:3');
  assert.equal(engine.pending, 0);
  const frames = engine.feed(new Uint8Array([1, 2, 3, 4, 5, 6]));
  assert.equal(frames.length, 2, 'two 3-byte frames from 6 bytes');
  assert.deepEqual(Array.from(frames[0].data), [1, 2, 3]);
  engine.reset();
  assert.equal(engine.pending, 0, 'reset clears partial state');
});

test('toProtocolEngine: delimiter config name includes the hex pattern', () => {
  const parser = new ProtocolParser({
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  });
  const engine = toProtocolEngine(parser);
  assert.equal(engine.name, 'delimiter:0D0A');
});

test('toProtocolEngine: length config name includes the field size', () => {
  const parser = new ProtocolParser({
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    bigEndian: true,
    lengthAdjust: 0,
  });
  const engine = toProtocolEngine(parser);
  assert.equal(engine.name, 'length:2B');
});

test('toProtocolEngine: plain object without kind returns unknown', () => {
  const engine = toProtocolEngine({
    feed: () => [],
    reset: () => {},
    pending: 0,
    config: { foo: 1 },
  });
  assert.equal(engine.name, 'unknown');
});

test('replayBbrec: RX records are fed to the engine and produce frames', () => {
  // Capture: two RX chunks that together form two 3-byte fixed frames. TX chunk
  // must be skipped.
  const records: ByteRecord[] = [
    rec('rx', 0, '010203'), // frame 1
    rec('tx', 5, 'FFFF'), // TX — skipped
    rec('rx', 10, '040506'), // frame 2
  ];
  const parser = new ProtocolParser({ kind: 'fixed', frameSize: 3 });
  const result = replayBbrec(records, parser);
  assert.equal(result.records, 2, 'two RX records replayed');
  assert.equal(result.bytesFed, 6);
  assert.equal(result.frames.length, 2, 'two frames emitted');
  assert.deepEqual(Array.from(result.frames[0].data), [1, 2, 3]);
  assert.deepEqual(Array.from(result.frames[1].data), [4, 5, 6]);
});

test('replayBbrec: full record/replay round-trip preserves byte fidelity', () => {
  // Simulate a capture of a delimiter-framed stream.
  const original = new Uint8Array([...Array.from('hi\r\nbye\r\n', (c) => c.charCodeAt(0))]);
  // Record: split the stream into two chunks (as the serial plugin would).
  const records: ByteRecord[] = [
    rec('rx', 0, bytesToHex(original.slice(0, 4))),
    rec('rx', 3, bytesToHex(original.slice(4))),
  ];
  // Encode → parse → replay through a CRLF delimiter engine.
  const text = encodeBbrec(records);
  const parsed = parseBbrec(text);
  const parser = new ProtocolParser({
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: true,
  });
  const result = replayBbrec(parsed, parser);
  // Reassemble the emitted frames and compare to the original stream.
  const reassembled = new Uint8Array(result.bytesFed);
  let off = 0;
  for (const f of result.frames) {
    reassembled.set(f.data, off);
    off += f.data.length;
  }
  assert.equal(result.frames.length, 2, 'two CRLF frames');
  assert.deepEqual(Array.from(reassembled), Array.from(original), 'byte fidelity preserved');
});

test('replayBbrec with null engine just collects byte totals', () => {
  const records: ByteRecord[] = [rec('rx', 0, '0102'), rec('tx', 1, '03'), rec('rx', 2, '040506')];
  const result = replayBbrec(records, null);
  assert.equal(result.records, 2);
  assert.equal(result.bytesFed, 5);
  assert.equal(result.frames.length, 0, 'no engine → no frames');
});
