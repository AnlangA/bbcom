import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../../src/lib/lru-cache.ts';

test('throws on non-positive capacity', () => {
  assert.throws(() => new LRUCache(0), /positive/i);
  assert.throws(() => new LRUCache(-3), /positive/i);
});

test('get returns undefined for missing keys without recording them', () => {
  const cache = new LRUCache<string, number>(2);
  cache.set('a', 1);
  assert.equal(cache.get('missing'), undefined);
  assert.equal(cache.get('a'), 1);
});

test('evicts least recently used entry when capacity is exceeded', () => {
  const cache = new LRUCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  // 'a' is LRU; inserting 'c' should evict 'a'
  cache.set('c', 3);

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('reading a key promotes it to most recently used', () => {
  const cache = new LRUCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  // Touch 'a' so 'b' becomes LRU
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('updating an existing key keeps capacity and moves it to most recently used', () => {
  const cache = new LRUCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10); // update, not insert — size stays 2

  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 10);
  cache.set('c', 3);
  // 'b' was LRU after the 'a' update
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('c'), 3);
});

test('has reports membership without affecting recency', () => {
  const cache = new LRUCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);

  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('missing'), false);
  // has() must not promote, so 'a' stays LRU and is evicted next
  cache.set('c', 3);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
});

test('clear empties the cache', () => {
  const cache = new LRUCache<string, number>(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.has('b'), false);
});

test('supports capacity of one (every insert evicts the previous)', () => {
  const cache = new LRUCache<string, number>(1);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.size, 1);
});
