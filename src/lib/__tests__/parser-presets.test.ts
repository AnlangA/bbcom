import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PARSER_PRESETS, findPreset } from '@/lib/parser-presets.ts';
import { ProtocolParser } from '@/lib/protocol-parser.ts';

test('PARSER_PRESETS is non-empty and each preset has a unique id', () => {
  assert.ok(PARSER_PRESETS.length >= 4);
  const ids = PARSER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'all ids unique');
  for (const preset of PARSER_PRESETS) {
    assert.ok(preset.name.length > 0, `${preset.id}: English name`);
    assert.ok(preset.nameZh?.length, `${preset.id}: Chinese name`);
    assert.ok(preset.description.length > 0, `${preset.id}: English description`);
    assert.ok(preset.descriptionZh?.length, `${preset.id}: Chinese description`);
  }
});

test('findPreset returns the matching preset', () => {
  const p = findPreset('nmea0183');
  assert.ok(p);
  assert.equal(p?.name, 'NMEA 0183');
});

test('findPreset returns null for an unknown id', () => {
  assert.equal(findPreset('nope'), null);
});

test('the CRLF preset splits NMEA-style sentences correctly', () => {
  const preset = findPreset('nmea0183')!;
  const parser = new ProtocolParser(preset.config);
  const text = '$GPGGA,123*AA\r\n$GPRMC,456*BB\r\n';
  const frames = parser.feed(new Uint8Array(text.split('').map((c) => c.charCodeAt(0))));
  assert.equal(frames.length, 2);
});

test('the LF preset splits Unix text lines', () => {
  const preset = findPreset('text-lf')!;
  const parser = new ProtocolParser(preset.config);
  const text = 'line one\nline two\n';
  const frames = parser.feed(new Uint8Array(text.split('').map((c) => c.charCodeAt(0))));
  assert.equal(frames.length, 2);
});

test('the length-prefix-1B preset reads a 1-byte length correctly', () => {
  const preset = findPreset('len-prefix-1b')!;
  const parser = new ProtocolParser(preset.config);
  // [len=3][A][B][C] => one 4-byte frame
  const bytes = new Uint8Array([3, 0x41, 0x42, 0x43]);
  const frames = parser.feed(bytes);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.length, 4);
});

test('the fixed-8 preset emits exactly 8-byte frames', () => {
  const preset = findPreset('modbus-fixed-8')!;
  const parser = new ProtocolParser(preset.config);
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const frames = parser.feed(bytes);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data.length, 8);
});

test('every preset config is a valid ParserConfig shape (smoke)', () => {
  for (const p of PARSER_PRESETS) {
    const cfg = p.config;
    if (cfg.kind === 'delimiter') {
      assert.ok(cfg.delimiter.length > 0, `${p.id}: delimiter non-empty`);
    } else if (cfg.kind === 'fixed') {
      assert.ok(cfg.frameSize > 0, `${p.id}: frameSize > 0`);
    } else {
      assert.ok(
        cfg.lengthSize === 1 || cfg.lengthSize === 2 || cfg.lengthSize === 4,
        `${p.id}: valid lengthSize`,
      );
    }
  }
});

test('the 2B-BE length-prefix preset reads a big-endian length + payload', () => {
  const preset = findPreset('len-prefix-2b-be')!;
  const parser = new ProtocolParser(preset.config);
  // [0x00,0x03][A][B][C] => lengthValue=3, lengthAdjust=2 covers the 2-byte
  // header, so total frame size = 5 and one 5-byte frame is emitted.
  const bytes = new Uint8Array([0x00, 0x03, 0x41, 0x42, 0x43]);
  const frames = parser.feed(bytes);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.length, 5);
  // A short frame (only the header) is buffered, not emitted.
  assert.equal(parser.feed(new Uint8Array([0x00, 0x02])).length, 0);
});

test('the 2B-LE length-prefix preset reads a little-endian length', () => {
  const preset = findPreset('len-prefix-2b-le')!;
  const parser = new ProtocolParser(preset.config);
  // [0x03,0x00][A][B][C] => LE length 3 + adjust 2 = total 5; one frame.
  const bytes = new Uint8Array([0x03, 0x00, 0x41, 0x42, 0x43]);
  const frames = parser.feed(bytes);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.length, 5);
});

test('the NUL-delimited preset splits on the 0x00 terminator', () => {
  const preset = findPreset('nul-delimited')!;
  const parser = new ProtocolParser(preset.config);
  const bytes = new Uint8Array([0x41, 0x42, 0x00, 0x43, 0x00]);
  const frames = parser.feed(bytes);
  assert.equal(frames.length, 2);
  // includeDelimiter:false → terminator not in the frame payload.
  assert.equal(frames[0].data.length, 2);
});

test('the SCPI-LF preset splits measurement lines on LF', () => {
  const preset = findPreset('scpi-lf')!;
  const parser = new ProtocolParser(preset.config);
  const text = '+1.234E+00\n-9.870E-01\n';
  const bytes = new Uint8Array(text.split('').map((c) => c.charCodeAt(0)));
  const frames = parser.feed(bytes);
  assert.equal(frames.length, 2);
});
