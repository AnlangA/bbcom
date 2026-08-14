import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildSendPayload,
  classifyOpenFailure,
  serialConnectionFailureMessage,
  type SerialConnectionFailure,
} from '../../src/composables/useSerialConnection.ts';
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
  assert.deepEqual(buildSendPayload('', false), {
    ok: false,
    reason: 'empty',
    requestedBytes: 0,
  });
  // whitespace-only hex parses to zero bytes → 'empty'
  assert.deepEqual(buildSendPayload('   ', true), {
    ok: false,
    reason: 'empty',
    requestedBytes: 0,
  });
});

test('buildSendPayload: rejects malformed hex (odd digits) as bad-hex', () => {
  // parseHex throws on an odd number of hex digits.
  const invalid = { ok: false, reason: 'bad-hex', requestedBytes: 0 };
  assert.deepEqual(buildSendPayload('ABC', true), invalid);
  assert.deepEqual(buildSendPayload('AA ZZ BB', true), invalid);
  assert.deepEqual(buildSendPayload('AA-BB', true), invalid);
  assert.deepEqual(buildSendPayload('A A', true), invalid);
});

test('buildSendPayload: rejects payloads exceeding MAX_INPUT_SIZE (1 MiB)', () => {
  // Build a text payload just over 1 MiB.
  const big = 'A'.repeat(1024 * 1024 + 1);
  const r = buildSendPayload(big, false);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'too-large');
  assert.equal((r as { requestedBytes: number }).requestedBytes, 1024 * 1024 + 1);
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

test('classifyOpenFailure normalizes typed and textual backend failures', () => {
  assert.equal(classifyOpenFailure({ code: 'IO_PERMISSION_DENIED' }).category, 'permission-denied');
  assert.equal(classifyOpenFailure({ code: 'SERIAL_DISCONNECTED' }).category, 'device-missing');
  assert.equal(classifyOpenFailure({ code: 'INVALID_INPUT' }).category, 'invalid-port');
  assert.equal(classifyOpenFailure('bad port path').category, 'invalid-port');
  assert.equal(classifyOpenFailure('EACCES opening serial device').category, 'permission-denied');
  assert.equal(classifyOpenFailure('device not found').category, 'device-missing');
  assert.equal(classifyOpenFailure(null).category, 'backend-failure');
});

test('serialConnectionFailureMessage covers every stable UI category and owner fallback', () => {
  const error = {
    code: 'PORT_IN_USE',
    messageKey: 'error.port_in_use',
    retryable: false,
    operation: 'serial_open',
  } as const;
  const withOwnerId = {
    error,
    category: 'port-in-use',
    conflict: {
      ownerSessionId: 'owner-session',
      ownerSessionName: undefined,
      canonicalPort: 'COM1',
    },
  } as unknown as SerialConnectionFailure;
  const withoutConflict = { error, category: 'port-in-use' } as SerialConnectionFailure;

  assert.ok(serialConnectionFailureMessage(withOwnerId).includes('owner-session'));
  assert.equal(typeof serialConnectionFailureMessage(withoutConflict), 'string');
  for (const category of [
    'device-missing',
    'permission-denied',
    'backend-failure',
    'invalid-port',
  ] as const) {
    assert.notEqual(
      serialConnectionFailureMessage({ error, category } as SerialConnectionFailure).length,
      0,
    );
  }
});
