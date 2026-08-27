import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SessionProtocolRuntime } from '@/features/sessions/runtime/session-protocol-runtime.ts';
import { parserConfigKey, type ParserConfig } from '@/lib/protocol-parser.ts';
import type { DataFrame } from '@/types/index.ts';

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
  assert.equal(
    parserConfigKey({
      kind: 'length',
      lengthOffset: 0,
      lengthSize: 1,
      bigEndian: true,
      lengthAdjust: 0,
    }),
    'length:0:1:1:0',
  );
  assert.equal(
    parserConfigKey({
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 4096,
      reassemblyTimeoutMs: 3000,
    }),
    'mcumgr-smp:raw-uart:4096:3000',
  );
});

test('resident runtime incrementally parses RX bytes and preserves stream offsets', () => {
  const config: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  };
  const runtime = new SessionProtocolRuntime();
  runtime.configure(config);

  runtime.feed(new Uint8Array(ascii('he')), 1_000);
  assert.equal(runtime.snapshot().frames.length, 0);

  runtime.feed(new Uint8Array(ascii('llo\n')), 1_100);
  runtime.feed(new Uint8Array(ascii('ok\n')), 1_200);
  const records = runtime.snapshot().frames;
  assert.deepEqual(records.map(frameText), ['hello', 'ok']);
  assert.deepEqual(
    records.map((record) => record.offset),
    [0, 6],
  );
});

test('resident runtime replays RX-only history when parser settings change', () => {
  const delimiterConfig: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  };
  const fixedConfig: ParserConfig = { kind: 'fixed', frameSize: 2 };
  const runtime = new SessionProtocolRuntime();
  const history = [rx(ascii('ab\n')), tx(ascii('ignored\n')), rx(ascii('cd\n'))];

  runtime.configure(delimiterConfig, history);
  assert.deepEqual(runtime.snapshot().frames.map(frameText), ['ab', 'cd']);

  runtime.configure(fixedConfig, history);
  assert.deepEqual(runtime.snapshot().frames.map(frameText), ['ab', '\nc', 'd\n']);
  assert.deepEqual(
    runtime.snapshot().frames.map((record) => record.offset),
    [0, 2, 4],
  );
});

test('resident runtime resets offsets when capture is explicitly cleared', () => {
  const config: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  };
  const runtime = new SessionProtocolRuntime();
  runtime.configure(config);
  runtime.feed(new Uint8Array(ascii('old\nmore\n')), 1_000);

  runtime.clear();
  assert.deepEqual(runtime.snapshot().frames, []);

  runtime.feed(new Uint8Array(ascii('new\n')), 1_200);
  const [fresh] = runtime.snapshot().frames;
  assert.equal(frameText(fresh), 'new');
  assert.equal(fresh.offset, 0);
});

test('resident runtime ignores empty delimiter configs until Apply makes them valid', () => {
  const emptyConfig: ParserConfig = {
    kind: 'delimiter',
    delimiter: [],
    includeDelimiter: false,
  };
  const validConfig: ParserConfig = {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  };
  const runtime = new SessionProtocolRuntime();
  const history = [rx(ascii('held\n'))];

  runtime.configure(emptyConfig, history);
  assert.deepEqual(runtime.snapshot().frames, []);

  runtime.configure(validConfig, history);
  assert.equal(frameText(runtime.snapshot().frames[0]), 'held');
});

test('resident runtime reports throughput over its rolling window', () => {
  const runtime = new SessionProtocolRuntime();
  runtime.configure({ kind: 'delimiter', delimiter: [0x0a], includeDelimiter: true });

  runtime.feed(new Uint8Array(ascii('a\n')), 1_000);
  assert.equal(runtime.snapshot().throughputBps, 0);

  runtime.feed(new Uint8Array(ascii('b\n')), 1_700);
  assert.equal(runtime.snapshot().throughputBps, 6);

  runtime.feed(new Uint8Array(ascii('c\n')), 1_800);
  assert.equal(runtime.snapshot().throughputBps, 6);

  runtime.feed(new Uint8Array(ascii('d\n')), 2_300);
  assert.equal(runtime.snapshot().throughputBps, 7);
});
