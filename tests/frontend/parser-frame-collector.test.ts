import test from 'node:test';
import assert from 'node:assert/strict';
import { ParserFrameCollector, parserConfigKey } from '../../src/lib/parser-frame-collector.ts';
import type { ParserConfig } from '../../src/lib/protocol-parser.ts';
import type { DataFrame } from '../../src/types/index.ts';

function rx(data: number[]): Pick<DataFrame, 'direction' | 'data'> {
  return { direction: 'RX', data: new Uint8Array(data) };
}

function tx(data: number[]): Pick<DataFrame, 'direction' | 'data'> {
  return { direction: 'TX', data: new Uint8Array(data) };
}

function ascii(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function frameText(frame: { data: Uint8Array }): string {
  return new TextDecoder().decode(frame.data);
}

test('parserConfigKey changes for each parser mode option', () => {
  assert.equal(
    parserConfigKey({ kind: 'delimiter', delimiter: [0x0d, 0x0a], includeDelimiter: false }),
    'delimiter:0:13,10',
  );
  assert.equal(
    parserConfigKey({ kind: 'delimiter', delimiter: [0x0a], includeDelimiter: true }),
    'delimiter:1:10',
  );
  assert.equal(parserConfigKey({ kind: 'fixed', frameSize: 8 }), 'fixed:8');
  assert.equal(
    parserConfigKey({
      kind: 'length',
      lengthOffset: 1,
      lengthSize: 2,
      bigEndian: false,
      lengthAdjust: 3,
    }),
    'length:1:2:0:3',
  );
});

test('collector incrementally parses RX frames and preserves stream offsets', () => {
  const cfg: ParserConfig = { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false };
  const collector = new ParserFrameCollector(cfg);
  const frames: Pick<DataFrame, 'direction' | 'data'>[] = [rx(ascii('he'))];

  let result = collector.sync(frames, cfg, 1000);
  assert.equal(result.reset, true);
  assert.equal(result.frames.length, 0);

  frames.push(rx(ascii('llo\n')));
  result = collector.sync(frames, cfg, 1100);
  assert.equal(result.reset, false);
  assert.equal(result.frames.length, 1);
  assert.equal(frameText(result.frames[0]), 'hello');
  // ProtocolParser reports the chunk-local offset where the delimiter completed.
  assert.equal(result.frames[0].offset, 2);

  frames.push(tx(ascii('ignored\n')));
  frames.push(rx(ascii('ok\n')));
  result = collector.sync(frames, cfg, 1200);
  assert.equal(result.frames.length, 2);
  assert.equal(frameText(result.frames[1]), 'ok');
  assert.equal(result.frames[1].offset, 6);
});

test('collector resets parsed frames when config changes', () => {
  const delimiterCfg: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  };
  const fixedCfg: ParserConfig = { kind: 'fixed', frameSize: 2 };
  const collector = new ParserFrameCollector(delimiterCfg);
  const frames = [rx(ascii('ab\ncd\n'))];

  assert.equal(collector.sync(frames, delimiterCfg, 1000).frames.length, 2);
  const result = collector.sync(frames, fixedCfg, 1200);
  assert.equal(result.reset, true);
  assert.deepEqual(
    result.frames.map((frame) => frameText(frame)),
    ['ab', '\nc', 'd\n'],
  );
  assert.deepEqual(
    result.frames.map((frame) => frame.offset),
    [0, 2, 4],
  );
});

test('collector resets offsets when the source frame list shrinks', () => {
  const cfg: ParserConfig = { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false };
  const collector = new ParserFrameCollector(cfg);
  collector.sync([rx(ascii('old\n')), rx(ascii('more\n'))], cfg, 1000);

  const empty = collector.sync([], cfg, 1100);
  assert.equal(empty.reset, true);
  assert.deepEqual(empty.frames, []);

  const fresh = collector.sync([rx(ascii('new\n'))], cfg, 1200);
  assert.equal(fresh.frames.length, 1);
  assert.equal(frameText(fresh.frames[0]), 'new');
  assert.equal(fresh.frames[0].offset, 0);
});

test('collector ignores empty delimiter configs until they become valid again', () => {
  const emptyCfg: ParserConfig = { kind: 'delimiter', delimiter: [], includeDelimiter: false };
  const validCfg: ParserConfig = { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false };
  const collector = new ParserFrameCollector(emptyCfg);
  const frames = [rx(ascii('held\n'))];

  const disabled = collector.sync(frames, emptyCfg, 1000);
  assert.equal(disabled.reset, true);
  assert.deepEqual(disabled.frames, []);

  const enabled = collector.sync(frames, validCfg, 1100);
  assert.equal(enabled.reset, true);
  assert.equal(frameText(enabled.frames[0]), 'held');
});

test('collector reports throughput over its rolling window', () => {
  const cfg: ParserConfig = { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: true };
  const collector = new ParserFrameCollector(cfg);
  const frames: Pick<DataFrame, 'direction' | 'data'>[] = [rx(ascii('a\n'))];

  let result = collector.sync(frames, cfg, 1000);
  assert.equal(result.throughputBps, 0);

  frames.push(rx(ascii('b\n')));
  result = collector.sync(frames, cfg, 1700);
  assert.equal(result.throughputBps, 6);

  frames.push(rx(ascii('c\n')));
  result = collector.sync(frames, cfg, 1800);
  assert.equal(result.throughputBps, 6);

  frames.push(rx(ascii('d\n')));
  result = collector.sync(frames, cfg, 2300);
  assert.equal(result.throughputBps, 7);
});
