import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSendPayload } from '../../src/composables/useSerialConnection.ts';
import { encodeUtf8 } from '../../src/lib/format.ts';

// buildSendPayload is the pure input gate every TX passes before entering the
// serialized write chain. It must reject empty/malformed/oversized
// payloads and otherwise return the exact bytes to write.

test('buildSendPayload: text mode encodes UTF-8 and accepts non-empty input', () => {
  const r = buildSendPayload('AT\r\n', false);
  assert.equal(r.ok, true);
  assert.deepEqual(
    Array.from((r as { payload: Uint8Array }).payload),
    Array.from(encodeUtf8('AT\r\n')),
  );
});

test('buildSendPayload: hex mode parses hex into bytes', () => {
  const r = buildSendPayload('AA BB CC', true);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from((r as { payload: Uint8Array }).payload), [0xaa, 0xbb, 0xcc]);
});

test('buildSendPayload: rejects empty text and empty/whitespace-only hex', () => {
  assert.deepEqual(buildSendPayload('', false), { ok: false, reason: 'empty' });
  // whitespace-only hex parses to zero bytes → 'empty'
  assert.deepEqual(buildSendPayload('   ', true), { ok: false, reason: 'empty' });
});

test('buildSendPayload: rejects malformed hex (odd digits) as bad-hex', () => {
  // parseHex throws on an odd number of hex digits.
  assert.deepEqual(buildSendPayload('ABC', true), { ok: false, reason: 'bad-hex' });
});

test('buildSendPayload: rejects payloads exceeding MAX_INPUT_SIZE (1 MiB)', () => {
  // Build a text payload just over 1 MiB.
  const big = 'A'.repeat(1024 * 1024 + 1);
  const r = buildSendPayload(big, false);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'too-large');
});

test('buildSendPayload: accepts a payload exactly at the MAX_INPUT_SIZE boundary', () => {
  // Exactly 1 MiB of ASCII bytes is allowed (the check is strict >).
  const exact = 'A'.repeat(1024 * 1024);
  const r = buildSendPayload(exact, false);
  assert.equal(r.ok, true);
  assert.equal((r as { payload: Uint8Array }).payload.length, 1024 * 1024);
});

test('buildSendPayload: hex mode handles compact (no-space) hex', () => {
  const r = buildSendPayload('DEADBEEF', true);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from((r as { payload: Uint8Array }).payload), [0xde, 0xad, 0xbe, 0xef]);
});
