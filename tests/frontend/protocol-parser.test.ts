import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES,
  ProtocolParser,
  byteAscii,
  byteHex,
  frameMatchesText,
  hexDump,
  indexOfSubarray,
  parseDelimiterHex,
  type ParserConfig,
} from '../../src/lib/protocol-parser.ts';

function bytes(s: string): Uint8Array {
  return new Uint8Array(s.split('').map((c) => c.charCodeAt(0)));
}

test('indexOfSubarray finds a subsequence and -1 when absent', () => {
  assert.equal(indexOfSubarray([1, 2, 3, 4], [2, 3]), 1);
  assert.equal(indexOfSubarray([1, 2, 3, 4], [3, 2]), -1);
  assert.equal(indexOfSubarray([1, 2, 3], []), 0);
  assert.equal(indexOfSubarray([1], [1, 2]), -1);
});

test('parseDelimiterHex parses spaced and unspaced hex', () => {
  assert.deepEqual(parseDelimiterHex('0D 0A'), [0x0d, 0x0a]);
  assert.deepEqual(parseDelimiterHex('0d0a'), [0x0d, 0x0a]);
  assert.deepEqual(parseDelimiterHex('AA BB CC'), [0xaa, 0xbb, 0xcc]);
  assert.deepEqual(parseDelimiterHex('xyz'), []);
});

test('delimiter parser splits a stream on CRLF', () => {
  const cfg: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  };
  const p = new ProtocolParser(cfg);
  // First read contains a partial line + a complete one.
  const a = p.feed(bytes('hello\r\nwor'));
  assert.equal(a.length, 1);
  assert.equal(new TextDecoder().decode(a[0].data), 'hello');
  // Second read completes the second line.
  const b = p.feed(bytes('ld\r\n'));
  assert.equal(b.length, 1);
  assert.equal(new TextDecoder().decode(b[0].data), 'world');
});

test('delimiter includeDelimiter keeps the terminator in the frame', () => {
  const cfg: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: true,
  };
  const p = new ProtocolParser(cfg);
  const out = p.feed(bytes('ab\ncd\n'));
  assert.equal(out.length, 2);
  assert.equal(new TextDecoder().decode(out[0].data), 'ab\n');
  assert.equal(new TextDecoder().decode(out[1].data), 'cd\n');
});

test('fixed-size parser emits exactly N bytes per frame', () => {
  const cfg: ParserConfig = { kind: 'fixed', frameSize: 3 };
  const p = new ProtocolParser(cfg);
  const out = p.feed(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  assert.equal(out.length, 2, 'two complete 3-byte frames');
  assert.deepEqual(Array.from(out[0].data), [1, 2, 3]);
  assert.deepEqual(Array.from(out[1].data), [4, 5, 6]);
  assert.equal(p.pending, 1, 'one leftover byte buffered');
});

test('fixed-size parser drains 32 KiB of one-byte frames in linear time', () => {
  const input = new Uint8Array(32 * 1024);
  for (let i = 0; i < input.length; i += 1) input[i] = i & 0xff;
  const p = new ProtocolParser({ kind: 'fixed', frameSize: 1 });

  const started = performance.now();
  const out = p.feed(input);
  const elapsed = performance.now() - started;

  assert.equal(out.length, input.length);
  assert.equal(out[0].data[0], 0);
  assert.equal(out[0].offset, 0);
  assert.equal(out.at(-1)?.data[0], 0xff);
  assert.equal(out.at(-1)?.offset, input.length - 1);
  assert.equal(p.pending, 0);
  // The old implementation copied every remaining suffix and took >1s for
  // this case on the baseline machine. Leave ample CI headroom while guarding
  // against accidentally restoring quadratic extraction.
  assert.ok(elapsed < 500, `32 KiB fixed parse took ${elapsed.toFixed(1)}ms`);
});

test('length-based parser reads a 1-byte length prefix (big-endian)', () => {
  // Frame: [len=4][payload 4 bytes]. lengthAdjust = 1 (the length byte itself).
  const cfg: ParserConfig = {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 1,
    bigEndian: true,
    lengthAdjust: 1,
  };
  const p = new ProtocolParser(cfg);
  // Partial: only the length byte arrives first.
  const a = p.feed(new Uint8Array([4]));
  assert.equal(a.length, 0, 'no complete frame yet');
  const b = p.feed(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
  assert.equal(b.length, 1);
  assert.deepEqual(Array.from(b[0].data), [4, 0xaa, 0xbb, 0xcc, 0xdd]);
});

test('length-based parser reads a 2-byte little-endian length', () => {
  // lengthValue=0x0100 little-endian = [0x00, 0x01]; payload 256 bytes is a lot,
  // so use lengthAdjust so total is small. Use lengthValue=5, LE = [0x05, 0x00],
  // lengthAdjust=2 (offset 0 + size 2) => total frame = 5 + 2 = 7 bytes.
  const cfg: ParserConfig = {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    bigEndian: false,
    lengthAdjust: 2,
  };
  const p = new ProtocolParser(cfg);
  const payload = new Uint8Array([0x05, 0x00, 1, 2, 3, 4, 5]);
  const out = p.feed(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.length, 7);
  assert.deepEqual(Array.from(out[0].data), [0x05, 0x00, 1, 2, 3, 4, 5]);
});

test('length-based parser drains many small frames without copying each remaining suffix', () => {
  const frameCount = 16 * 1024;
  const input = new Uint8Array(frameCount * 2);
  for (let i = 0; i < frameCount; i += 1) {
    input[i * 2] = 1;
    input[i * 2 + 1] = i & 0xff;
  }
  const p = new ProtocolParser({
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 1,
    bigEndian: true,
    lengthAdjust: 1,
  });

  const out = p.feed(input);

  assert.equal(out.length, frameCount);
  assert.deepEqual(Array.from(out[0].data), [1, 0]);
  assert.deepEqual(Array.from(out.at(-1)?.data ?? []), [1, 0xff]);
  assert.equal(out.at(-1)?.offset, input.length - 2);
  assert.equal(p.pending, 0);
});

test('length-based parser resyncs on an implausible length (drops 1 byte)', () => {
  // lengthValue=0 at offset 0 => total = 0 + 1 (adjust) = 1; that's fine.
  // Use a huge lengthValue to trigger the resync path: 0xFF => total=256, fine.
  // To force implausible, use lengthValue that overflows 1MB: need 4-byte field.
  const cfg: ParserConfig = {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 4,
    bigEndian: true,
    lengthAdjust: 4,
  };
  const p = new ProtocolParser(cfg);
  // 0x00100000 = 1048576 > 1MB boundary => implausible, drop 1 byte, resync.
  const bogus = new Uint8Array([0x00, 0x10, 0x00, 0x00]);
  const out = p.feed(bogus);
  assert.equal(out.length, 0, 'no frame emitted for implausible length');
  // After dropping 1 byte, only 3 bytes remain — not enough for a 4-byte header.
  assert.equal(p.pending, 3);
  assert.deepEqual(p.stats, { discardedBytes: 1, overflowEvents: 0, resyncEvents: 1 });
});

test('reset clears the partial buffer', () => {
  const cfg: ParserConfig = { kind: 'fixed', frameSize: 5 };
  const p = new ProtocolParser(cfg);
  p.feed(new Uint8Array([1, 2, 3]));
  assert.equal(p.pending, 3);
  p.reset();
  assert.equal(p.pending, 0);
});

test('delimiter parser retains unmatched bytes while below its safety ceiling', () => {
  const cfg: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x00],
    includeDelimiter: false,
  };
  const p = new ProtocolParser(cfg);
  const out = p.feed(bytes('no terminator here'));
  assert.equal(out.length, 0);
  assert.equal(p.pending, bytes('no terminator here').length);
  assert.deepEqual(p.stats, { discardedBytes: 0, overflowEvents: 0, resyncEvents: 0 });
});

test('delimiter parser bounds an unmatched stream and exposes overflow statistics', () => {
  const p = new ProtocolParser({ kind: 'delimiter', delimiter: [0x00], includeDelimiter: false });
  const extra = 257;
  const input = new Uint8Array(DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES + extra);
  input.fill(0x41);

  assert.deepEqual(p.feed(input), []);
  assert.equal(p.pending, DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES);
  assert.deepEqual(p.stats, {
    discardedBytes: extra,
    overflowEvents: 1,
    resyncEvents: 1,
  });

  p.reset();
  assert.equal(p.pending, 0);
  assert.deepEqual(p.stats, { discardedBytes: 0, overflowEvents: 0, resyncEvents: 0 });
});

test('delimiter overflow preserves a split delimiter in the retained suffix', () => {
  const p = new ProtocolParser(
    { kind: 'delimiter', delimiter: [0x0d, 0x0a], includeDelimiter: false },
    { maxPendingBytes: 4 },
  );

  assert.deepEqual(p.feed(new Uint8Array([1, 2, 3, 4, 5, 0x0d])), []);
  assert.equal(p.pending, 4);
  assert.deepEqual(p.stats, { discardedBytes: 2, overflowEvents: 1, resyncEvents: 1 });

  const out = p.feed(new Uint8Array([0x0a]));
  assert.equal(out.length, 1);
  assert.deepEqual(Array.from(out[0].data), [3, 4, 5]);
  assert.equal(p.pending, 0);
});

test('byteHex renders two-char lowercase hex', () => {
  assert.equal(byteHex(0), '00');
  assert.equal(byteHex(255), 'ff');
  assert.equal(byteHex(0xab), 'ab');
});

test('byteAscii renders printable chars and dots for control bytes', () => {
  assert.equal(byteAscii(0x41), 'A');
  assert.equal(byteAscii(0x30), '0');
  assert.equal(byteAscii(0x00), '.');
  assert.equal(byteAscii(0x7f), '.');
  assert.equal(byteAscii(0x1b), '.'); // ESC
});

test('hexDump groups bytes into offset/hex/ascii rows', () => {
  const data = new Uint8Array([0x41, 0x42, 0x00, 0x43]);
  const rows = hexDump(data, 16);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].offset, 0);
  assert.equal(rows[0].hex, '41 42 00 43');
  assert.equal(rows[0].ascii, 'AB.C');
});

test('hexDump wraps across multiple rows at the requested width', () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const rows = hexDump(data, 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.hex),
    ['01 02', '03 04', '05'],
  );
  assert.deepEqual(
    rows.map((r) => r.offset),
    [0, 2, 4],
  );
});

test('frameMatchesText is case-insensitive and ignores surrounding spaces', () => {
  const data = bytes('OK 200');
  assert.ok(frameMatchesText(data, 'ok'));
  assert.ok(frameMatchesText(data, '  OK  '));
  assert.ok(!frameMatchesText(data, 'ERROR'));
  // Empty needle matches everything (no filter).
  assert.ok(frameMatchesText(data, ''));
});
