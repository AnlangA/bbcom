import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  TriggerEngine,
  containsSubarray,
  parseHexPattern,
  type Trigger,
} from '@/lib/trigger-engine.ts';

function textTrigger(
  id: string,
  pattern: string,
  response: string,
  opts: Partial<Trigger> = {},
): Trigger {
  return {
    id,
    name: id,
    enabled: true,
    matchMode: 'text',
    pattern,
    response,
    responseIsHex: false,
    cooldownMs: 0,
    ...opts,
  };
}

function hexTrigger(
  id: string,
  pattern: string,
  response: string,
  opts: Partial<Trigger> = {},
): Trigger {
  return {
    id,
    name: id,
    enabled: true,
    matchMode: 'hex',
    pattern,
    response,
    responseIsHex: true,
    cooldownMs: 0,
    ...opts,
  };
}

function bytes(s: string): Uint8Array {
  return new Uint8Array(s.split('').map((c) => c.charCodeAt(0)));
}

test('parseHexPattern parses spaced and unspaced hex', () => {
  assert.deepEqual(parseHexPattern('AA BB'), [0xaa, 0xbb]);
  assert.deepEqual(parseHexPattern('aabb'), [0xaa, 0xbb]);
  assert.deepEqual(parseHexPattern('xyz'), []);
  assert.deepEqual(parseHexPattern('A'), [], 'odd length yields nothing');
  assert.deepEqual(parseHexPattern('AA- BB'), [], 'punctuation is not silently discarded');
  assert.deepEqual(parseHexPattern('AA ZZ BB'), [], 'invalid pairs do not become another pattern');
});

test('containsSubarray detects contiguous subsequences', () => {
  assert.equal(containsSubarray([1, 2, 3, 4], [2, 3]), true);
  assert.equal(containsSubarray([1, 2, 3, 4], [2, 4]), false);
  assert.equal(containsSubarray([1, 2, 3], []), false);
  assert.equal(containsSubarray([1], [1, 2]), false);
});

test('text trigger fires when the pattern appears in RX', () => {
  const eng = new TriggerEngine([textTrigger('t1', 'login:', 'root\r\n')]);
  const fires = eng.feed(bytes('please login: now'));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].triggerId, 't1');
  assert.equal(fires[0].response, 'root\r\n');
  assert.equal(fires[0].responseIsHex, false);
});

test('text trigger matches across chunked reads', () => {
  const eng = new TriggerEngine([textTrigger('t1', 'READY', 'GO')]);
  assert.equal(eng.feed(bytes('REA')).length, 0, 'partial match does not fire');
  const fires = eng.feed(bytes('DY'));
  assert.equal(fires.length, 1);
});

test('text trigger uses a private streaming UTF-8 decoder', () => {
  const first = new TriggerEngine([textTrigger('first', '€', 'A')]);
  const second = new TriggerEngine([textTrigger('second', '€', 'B')]);
  const euro = new TextEncoder().encode('€');

  assert.equal(first.feed(euro.subarray(0, 2)).length, 0);
  // A separate engine must not consume or corrupt the incomplete sequence.
  assert.equal(second.feed(euro).length, 1);
  assert.equal(first.feed(euro.subarray(2)).length, 1);
});

test('hex trigger matches a byte sequence', () => {
  const eng = new TriggerEngine([hexTrigger('h1', 'AA BB', 'CC')]);
  const fires = eng.feed(new Uint8Array([0x01, 0xaa, 0xbb, 0x02]));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].responseIsHex, true);
});

test('hex trigger matches across chunked reads', () => {
  const eng = new TriggerEngine([hexTrigger('h1', 'AA BB', 'CC')]);
  assert.equal(eng.feed(new Uint8Array([0xaa])).length, 0);
  const fires = eng.feed(new Uint8Array([0xbb]));
  assert.equal(fires.length, 1);
});

test('disabled triggers never fire', () => {
  const t = textTrigger('t1', 'x', 'y', { enabled: false });
  const eng = new TriggerEngine([t]);
  assert.equal(eng.feed(bytes('x')).length, 0);
});

test('cooldown prevents a second firing within the window', () => {
  const t = textTrigger('t1', 'x', 'y', { cooldownMs: 1000 });
  const eng = new TriggerEngine([t]);
  assert.equal(eng.feed(bytes('x')).length, 1, 'first fire');
  assert.equal(eng.feed(bytes('x')).length, 0, 'second within cooldown suppressed');
});

test('a trigger fires at most once per feed call even if pattern repeats', () => {
  const eng = new TriggerEngine([textTrigger('t1', 'a', 'b')]);
  const fires = eng.feed(bytes('aaaa'));
  assert.equal(fires.length, 1);
});

test('multiple distinct triggers can fire in one feed', () => {
  const eng = new TriggerEngine([textTrigger('t1', 'foo', 'A'), textTrigger('t2', 'bar', 'B')]);
  const fires = eng.feed(bytes('foo and bar'));
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map((f) => f.triggerId).sort(), ['t1', 't2']);
});

test('setTriggers replaces the set and resets buffers', () => {
  const eng = new TriggerEngine([textTrigger('t1', 'x', 'y')]);
  eng.feed(bytes('x')); // primes/cooldowns t1
  eng.setTriggers([textTrigger('t2', 'z', 'w')]);
  // t1 is gone; t2 should fire on 'z', and a stale 'x' shouldn't match t1.
  const fires = eng.feed(bytes('z'));
  assert.equal(fires.length, 1);
  assert.equal(fires[0].triggerId, 't2');
});

test('empty pattern never fires', () => {
  const eng = new TriggerEngine([textTrigger('t1', '', 'y')]);
  assert.equal(eng.feed(bytes('anything')).length, 0);
});

test('rolling buffer stays bounded for a long non-matching stream', () => {
  const eng = new TriggerEngine([textTrigger('t1', 'NOPE', 'y')]);
  // Feed a large stream that never matches; the engine must not grow unbounded.
  const chunk = bytes('A'.repeat(1000));
  for (let i = 0; i < 50; i += 1) eng.feed(chunk);
  // If it fired or blew up, this assertion would catch it; the real guard is
  // that the process completes without OOM and fires nothing.
  const fires = eng.feed(bytes('still no match'));
  assert.equal(fires.length, 0);
});
