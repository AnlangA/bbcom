import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LRUCache } from '../../src/lib/lru-cache.ts';

test('evicts the oldest entry when capacity is exceeded', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined); // evicted (oldest)
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

test('get promotes an entry to most-recently-used', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a'); // a is now MRU
  c.set('c', 3); // should evict b, not a
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
});

test('set on an existing key updates the value and recency without growing size', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10); // update + touch
  assert.equal(c.get('a'), 10);
  assert.equal(c.size, 2);
  c.set('c', 3); // evicts b (a was just touched)
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 10);
});

test('has reports membership without affecting recency', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.has('a'), true);
  c.set('c', 3); // has() did not touch a → a is still oldest → evicted
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
});

test('clear empties the cache', () => {
  const c = new LRUCache<string, number>(3);
  c.set('a', 1);
  c.set('b', 2);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.has('a'), false);
});

test('rejects a non-positive capacity', () => {
  assert.throws(() => new LRUCache<string, number>(0));
  assert.throws(() => new LRUCache<string, number>(-1));
});
