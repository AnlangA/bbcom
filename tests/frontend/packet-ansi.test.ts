import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPacketAnsiUp, renderPacketAnsiHtml } from '../../src/lib/packet-ansi.ts';

test('renderPacketAnsiHtml colorizes each logical line separately', () => {
  const ansiUp = createPacketAnsiUp();
  const input = 'I: one\nI: \x1b[31mtwo\x1b[0m';
  const out = renderPacketAnsiHtml(input, ansiUp, {
    colorEnabled: true,
    preserveLineBreaks: true,
    plainLineBreaks: false,
  });
  assert.match(out, /<br>/);
  assert.match(out, /ansi-red-fg/);
  assert.match(out, /two/);
  assert.doesNotMatch(out, /<span[^>]*><br>/);
});

test('renderPacketAnsiHtml leaves plain text untouched when color is disabled', () => {
  const ansiUp = createPacketAnsiUp();
  const input = '\x1b[31mred\x1b[0m';
  const out = renderPacketAnsiHtml(input, ansiUp, {
    colorEnabled: false,
    preserveLineBreaks: false,
    plainLineBreaks: false,
  });
  assert.equal(out, input);
});

test('renderPacketAnsiHtml splits Zephyr-style glued records before coloring', () => {
  const ansiUp = createPacketAnsiUp();
  const input = 'I: alphaI: beta';
  const out = renderPacketAnsiHtml(input, ansiUp, {
    colorEnabled: true,
    preserveLineBreaks: true,
    plainLineBreaks: false,
  });
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  assert.match(out, /<br>/);
});
