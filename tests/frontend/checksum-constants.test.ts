import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKSUM_BYTE_LENGTH,
  checksumAlgoOptionsWithNone,
  checksumOptions,
} from '../../src/lib/checksum-constants.ts';

test('checksum byte lengths match the width each algorithm appends', () => {
  assert.equal(CHECKSUM_BYTE_LENGTH.CHECKSUM, 1);
  assert.equal(CHECKSUM_BYTE_LENGTH.CRC8, 1);
  assert.equal(CHECKSUM_BYTE_LENGTH.CRC16, 2);
  assert.equal(CHECKSUM_BYTE_LENGTH.CRC32, 4);
});

test('checksum option sets stay consistent', () => {
  // The "with none" list must be the base list plus a leading 'none' option.
  assert.equal(checksumAlgoOptionsWithNone[0].value, 'none');
  assert.equal(
    checksumAlgoOptionsWithNone.length,
    checksumOptions.length + 1,
  );
  // Every algorithm in the options has a known byte length.
  for (const opt of checksumOptions) {
    assert.ok(CHECKSUM_BYTE_LENGTH[opt.value] > 0);
  }
});
