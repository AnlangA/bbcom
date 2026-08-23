import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveExportFormat } from '@/lib/constants.ts';

// The text export must follow the selected display mode so the saved file
// matches what the user sees (the reported bug: logs always saved as hex
// regardless of the selected encoding). HEX and HEX+ASCII display → hex dump;
// any text display mode (ASCII/UTF-8/ANSI) → decoded text.

test('txt export follows HEX display mode → hex text wire format', () => {
  assert.equal(resolveExportFormat('txt', 'HEX'), 'txt-hex');
});

test('txt export follows HEXASCII display mode → hex text wire format', () => {
  // Mirrors the auto-log mapping (useAutoLog.ts: HEXASCII → hex).
  assert.equal(resolveExportFormat('txt', 'HEXASCII'), 'txt-hex');
});

test('txt export follows text display modes → decoded-text wire format', () => {
  assert.equal(resolveExportFormat('txt', 'ASCII'), 'txt-ascii');
  assert.equal(resolveExportFormat('txt', 'UTF8'), 'txt-ascii');
  assert.equal(resolveExportFormat('txt', 'ANSI'), 'txt-ascii');
});

test('structured/binary choices pass through regardless of display mode', () => {
  for (const displayMode of ['HEX', 'HEXASCII', 'ASCII', 'UTF8', 'ANSI'] as const) {
    assert.equal(resolveExportFormat('csv', displayMode), 'csv');
    assert.equal(resolveExportFormat('jsonl', displayMode), 'jsonl');
    assert.equal(resolveExportFormat('bin', displayMode), 'bin');
  }
});
