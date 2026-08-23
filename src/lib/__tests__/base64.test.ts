import { test } from 'vitest';
import assert from 'node:assert/strict';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64.ts';

test('encodes known vectors with canonical padding', () => {
  assert.equal(bytesToBase64(new Uint8Array([])), '');
  assert.equal(bytesToBase64(new Uint8Array([0])), 'AA==');
  assert.equal(bytesToBase64(new Uint8Array([0, 1])), 'AAE=');
  assert.equal(bytesToBase64(new Uint8Array([1, 2, 3])), 'AQID');
  assert.equal(bytesToBase64(new Uint8Array([0xff, 0xef, 0xfe, 0xff, 0x80, 0x7f])), '/+/+/4B/');
});

test('decodes known vectors back to the original bytes', () => {
  assert.deepEqual(Array.from(base64ToBytes('')), []);
  assert.deepEqual(Array.from(base64ToBytes('AA==')), [0]);
  assert.deepEqual(Array.from(base64ToBytes('AAE=')), [0, 1]);
  assert.deepEqual(Array.from(base64ToBytes('AQID')), [1, 2, 3]);
});

test('round-trips every length across the chunk boundaries', () => {
  // 0..8 covers all padding remainders; 12,288 is the encode chunk size, so
  // its +/-1 neighbours exercise multi-chunk paths and final partial groups.
  const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0x2fff, 0x3000, 0x3001, 0x6005];
  for (const length of lengths) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (index * 31 + length) % 256;
    }
    const encoded = bytesToBase64(bytes);
    assert.equal(encoded.length % 4, 0, `length ${length} must stay padded`);
    assert.deepEqual(Array.from(base64ToBytes(encoded)), Array.from(bytes));
  }
});

test('round-trips a 512 KiB capture batch payload', () => {
  const bytes = new Uint8Array(512 * 1024);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded.length, 4 * Math.ceil((512 * 1024) / 3));
  assert.deepEqual(Array.from(base64ToBytes(encoded)), Array.from(bytes));
});

test('rejects non-canonical base64 instead of decoding it loosely', () => {
  for (const invalid of [
    'A',
    'A===',
    '====',
    'AAAA=',
    'AA==AAAA',
    'AA =',
    'AA==\n',
    'AQ D',
    'ü===',
  ]) {
    assert.throws(() => base64ToBytes(invalid), TypeError);
  }
});
