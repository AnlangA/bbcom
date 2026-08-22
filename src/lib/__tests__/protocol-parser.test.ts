import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES,
  ProtocolParser,
  byteAscii,
  byteHex,
  frameMatchesText,
  hexDump,
  indexOfSubarray,
  indexOfSubarrayBytes,
  parseDelimiterHex,
  type ParserConfig,
} from '@/lib/protocol-parser.ts';

function bytes(s: string): Uint8Array {
  return new Uint8Array(s.split('').map((c) => c.charCodeAt(0)));
}

function frameSnapshot(frames: ReturnType<ProtocolParser['feed']>) {
  return frames.map((frame) => ({ offset: frame.offset, data: Array.from(frame.data) }));
}

function feedRandomChunks(
  parser: ProtocolParser,
  input: Uint8Array,
  seed: number,
): ReturnType<ProtocolParser['feed']> {
  const frames: ReturnType<ProtocolParser['feed']> = [];
  let state = seed >>> 0;
  let offset = 0;
  while (offset < input.length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const chunkSize = 1 + ((state >>> 0) % 37);
    const end = Math.min(input.length, offset + chunkSize);
    frames.push(...parser.feed(input.subarray(offset, end)));
    offset = end;
  }
  return frames;
}

test('indexOfSubarray finds a subsequence and -1 when absent', () => {
  assert.equal(indexOfSubarray([1, 2, 3, 4], [2, 3]), 1);
  assert.equal(indexOfSubarray([1, 2, 3, 4], [3, 2]), -1);
  assert.equal(indexOfSubarray([1, 2, 3], []), 0);
  assert.equal(indexOfSubarray([1], [1, 2]), -1);
});

test('typed subarray search skips a partial candidate before returning a later match', () => {
  assert.equal(
    indexOfSubarrayBytes(Uint8Array.from([0x01, 0x09, 0x03, 0x01, 0x02, 0x03]), [1, 2, 3]),
    3,
  );
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

test('typed buffer never parses spare capacity as fixed-frame data', () => {
  const p = new ProtocolParser({ kind: 'fixed', frameSize: 150 });
  assert.deepEqual(p.feed(new Uint8Array(100).fill(0x41)), []);
  assert.deepEqual(p.feed(new Uint8Array(10).fill(0x42)), []);
  assert.equal(p.pending, 110);

  const out = p.feed(new Uint8Array(40).fill(0x43));
  assert.equal(out.length, 1);
  assert.deepEqual(Array.from(out[0].data), [
    ...new Array(100).fill(0x41),
    ...new Array(10).fill(0x42),
    ...new Array(40).fill(0x43),
  ]);
});

test('a zero-byte delimiter matches only a real input byte', () => {
  const p = new ProtocolParser({ kind: 'delimiter', delimiter: [0x00], includeDelimiter: false });
  assert.deepEqual(p.feed(new Uint8Array(100).fill(0x41)), []);
  assert.deepEqual(p.feed(new Uint8Array(10).fill(0x42)), []);
  assert.equal(p.pending, 110);

  const out = p.feed(new Uint8Array([0x00]));
  assert.equal(out.length, 1);
  assert.equal(out[0].data.length, 110);
  assert.equal(out[0].offset, 0);
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

test('typed buffer never completes a length frame from spare capacity', () => {
  const p = new ProtocolParser({
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 4,
    bigEndian: true,
    lengthAdjust: 4,
  });
  const frame = new Uint8Array(134);
  frame.set([0x00, 0x00, 0x00, 0x82]);
  for (let i = 4; i < frame.length; i += 1) frame[i] = i & 0xff;

  assert.deepEqual(p.feed(frame.subarray(0, 100)), []);
  assert.deepEqual(p.feed(frame.subarray(100, 110)), []);
  const out = p.feed(frame.subarray(110));
  assert.deepEqual(frameSnapshot(out), [{ offset: 0, data: Array.from(frame) }]);
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

test('length frame must include its own complete header', () => {
  const p = new ProtocolParser({
    kind: 'length',
    lengthOffset: 1,
    lengthSize: 1,
    bigEndian: true,
    lengthAdjust: 0,
  });
  assert.deepEqual(p.feed(new Uint8Array([0xaa, 0x01])), []);
  assert.equal(p.pending, 1);
  assert.deepEqual(p.stats, { discardedBytes: 1, overflowEvents: 0, resyncEvents: 1 });
});

test('frame offsets remain absolute after exhausted buffers and compaction', () => {
  const fixed = new ProtocolParser({ kind: 'fixed', frameSize: 1 });
  const first = fixed.feed(new Uint8Array(64 * 1024));
  assert.equal(first.at(-1)?.offset, 64 * 1024 - 1);
  assert.equal(fixed.feed(new Uint8Array([1]))[0].offset, 64 * 1024);

  const delimiter = new ProtocolParser({
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  });
  assert.equal(delimiter.feed(bytes('hello\n'))[0].offset, 0);
  assert.equal(delimiter.feed(bytes('ok\n'))[0].offset, 6);
});

test('constructor enforces every parser configuration boundary', () => {
  assert.doesNotThrow(() => new ProtocolParser({ kind: 'fixed', frameSize: 1 }));
  assert.doesNotThrow(() => new ProtocolParser({ kind: 'fixed', frameSize: 65_535 }));
  assert.throws(() => new ProtocolParser({ kind: 'fixed', frameSize: 0 }), RangeError);
  assert.throws(() => new ProtocolParser({ kind: 'fixed', frameSize: 65_536 }), RangeError);
  assert.throws(() => new ProtocolParser({ kind: 'fixed', frameSize: 1.5 }), RangeError);

  assert.doesNotThrow(
    () => new ProtocolParser({ kind: 'delimiter', delimiter: [0], includeDelimiter: false }),
  );
  assert.doesNotThrow(
    () =>
      new ProtocolParser({
        kind: 'delimiter',
        delimiter: new Array(256).fill(0xff),
        includeDelimiter: true,
      }),
  );
  assert.throws(
    () => new ProtocolParser({ kind: 'delimiter', delimiter: [], includeDelimiter: false }),
    RangeError,
  );
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'delimiter',
        delimiter: new Array(257).fill(0xff),
        includeDelimiter: false,
      }),
    RangeError,
  );
  assert.throws(
    () => new ProtocolParser({ kind: 'delimiter', delimiter: [256], includeDelimiter: false }),
    RangeError,
  );

  for (const lengthSize of [1, 2, 4] as const) {
    assert.doesNotThrow(
      () =>
        new ProtocolParser({
          kind: 'length',
          lengthOffset: 0,
          lengthSize,
          bigEndian: true,
          lengthAdjust: lengthSize,
        }),
    );
  }
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'length',
        lengthOffset: 0,
        lengthSize: 3,
        bigEndian: true,
        lengthAdjust: 3,
      } as unknown as ParserConfig),
    RangeError,
  );
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'length',
        lengthOffset: 1024 * 1024,
        lengthSize: 1,
        bigEndian: true,
        lengthAdjust: 1,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'length',
        lengthOffset: 0,
        lengthSize: 1,
        bigEndian: true,
        lengthAdjust: -1,
      }),
    RangeError,
  );
});

test('parser output is invariant across deterministic random chunk boundaries', () => {
  const fixedInput = Uint8Array.from({ length: 517 }, (_, i) => (i * 29) & 0xff);

  const delimiterParts: number[] = [];
  for (let frame = 0; frame < 30; frame += 1) {
    for (let i = 0; i < frame + 1; i += 1) delimiterParts.push(1 + ((frame * 17 + i) % 254));
    delimiterParts.push(0x00, 0xff, 0x00);
  }
  delimiterParts.push(1, 2, 3);
  const delimiterInput = new Uint8Array(delimiterParts);

  const lengthParts: number[] = [];
  for (let frame = 0; frame < 80; frame += 1) {
    const payloadLength = 1 + (frame % 31);
    lengthParts.push(payloadLength);
    for (let i = 0; i < payloadLength; i += 1) lengthParts.push((frame + i) & 0xff);
  }
  const lengthInput = new Uint8Array(lengthParts);

  const cases: { config: ParserConfig; input: Uint8Array }[] = [
    { config: { kind: 'fixed', frameSize: 17 }, input: fixedInput },
    {
      config: { kind: 'delimiter', delimiter: [0x00, 0xff, 0x00], includeDelimiter: true },
      input: delimiterInput,
    },
    {
      config: {
        kind: 'length',
        lengthOffset: 0,
        lengthSize: 1,
        bigEndian: true,
        lengthAdjust: 1,
      },
      input: lengthInput,
    },
  ];

  for (const [index, { config, input }] of cases.entries()) {
    const oneShot = new ProtocolParser(config);
    const expected = oneShot.feed(input);
    for (let seed = 1; seed <= 20; seed += 1) {
      const chunked = new ProtocolParser(config);
      const actual = feedRandomChunks(chunked, input, seed * 97 + index);
      assert.deepEqual(frameSnapshot(actual), frameSnapshot(expected));
      assert.equal(chunked.pending, oneShot.pending);
      assert.deepEqual(chunked.stats, oneShot.stats);
    }
  }
});

test('reset clears the partial buffer', () => {
  const cfg: ParserConfig = { kind: 'fixed', frameSize: 5 };
  const p = new ProtocolParser(cfg);
  p.feed(new Uint8Array([1, 2, 3]));
  assert.equal(p.pending, 3);
  p.reset();
  assert.equal(p.pending, 0);
});

test('empty input is a no-op and non-finite pending limits fall back to the safe default', () => {
  const p = new ProtocolParser(
    { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false },
    { maxPendingBytes: Number.POSITIVE_INFINITY },
  );

  assert.deepEqual(p.feed(new Uint8Array()), []);
  assert.deepEqual(frameSnapshot(p.feed(bytes('safe\n'))), [
    { offset: 0, data: [115, 97, 102, 101] },
  ]);
});

test('delimiter parser reuses a consumed prefix when only the backing tail is too small', () => {
  const p = new ProtocolParser({
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  });
  // The first feed allocates a 256-byte backing array. It consumes a two-byte
  // frame, leaving 148 live bytes and a two-byte consumed prefix. Appending
  // 107 bytes cannot fit in the tail, but does fit after compaction.
  const first = new Uint8Array(150).fill(0x61);
  first[1] = 0x0a;
  assert.deepEqual(frameSnapshot(p.feed(first)), [{ offset: 0, data: [0x61] }]);

  assert.deepEqual(p.feed(new Uint8Array(107).fill(0x62)), []);
  const completed = p.feed(new Uint8Array([0x0a]));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].offset, 2);
  assert.equal(completed[0].data.length, 255);
  assert.equal(completed[0].data[0], 0x61);
  assert.equal(completed[0].data.at(-1), 0x62);
});

test('constructor rejects malformed parser config shapes before parsing input', () => {
  assert.throws(() => new ProtocolParser(null as unknown as ParserConfig), TypeError);
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'delimiter',
        delimiter: '0a',
        includeDelimiter: false,
      } as unknown as ParserConfig),
    TypeError,
  );
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'delimiter',
        delimiter: [0x0a],
        includeDelimiter: 'yes',
      } as unknown as ParserConfig),
    TypeError,
  );
  assert.throws(
    () =>
      new ProtocolParser({
        kind: 'length',
        lengthOffset: 0,
        lengthSize: 1,
        bigEndian: 1,
        lengthAdjust: 1,
      } as unknown as ParserConfig),
    TypeError,
  );
  assert.throws(
    () => new ProtocolParser({ kind: 'unknown' } as unknown as ParserConfig),
    RangeError,
  );
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
  assert.equal(p.pending, extra - 1);
  assert.deepEqual(p.stats, {
    discardedBytes: DEFAULT_PROTOCOL_PARSER_MAX_PENDING_BYTES + 1,
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
  assert.equal(p.pending, 2);
  assert.deepEqual(p.stats, { discardedBytes: 4, overflowEvents: 1, resyncEvents: 1 });

  const out = p.feed(new Uint8Array([0x0a]));
  assert.equal(out.length, 1);
  assert.deepEqual(Array.from(out[0].data), [5]);
  assert.equal(out[0].offset, 4);
  assert.equal(p.pending, 0);
});

test('delimiter inclusion never emits a frame above the pending ceiling', () => {
  const p = new ProtocolParser(
    { kind: 'delimiter', delimiter: [0x00], includeDelimiter: true },
    { maxPendingBytes: 4 },
  );
  assert.deepEqual(p.feed(new Uint8Array([1, 2, 3, 4, 0])), []);
  assert.equal(p.pending, 0);
  assert.deepEqual(p.stats, { discardedBytes: 5, overflowEvents: 1, resyncEvents: 1 });
});

test('delimiter overflow behavior is invariant across caller chunking', () => {
  const config: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  };
  const input = new Uint8Array([...new Array(200).fill(0x41), 0x0d, 0x0a, 0x6f, 0x6b, 0x0d, 0x0a]);
  const oneShot = new ProtocolParser(config, { maxPendingBytes: 64 });
  const expected = oneShot.feed(input);

  for (let seed = 1; seed <= 20; seed += 1) {
    const chunked = new ProtocolParser(config, { maxPendingBytes: 64 });
    const actual = feedRandomChunks(chunked, input, seed);
    assert.deepEqual(frameSnapshot(actual), frameSnapshot(expected));
    assert.equal(chunked.pending, oneShot.pending);
    assert.deepEqual(chunked.stats, oneShot.stats);
  }
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
