import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { encodeUtf8 } from '../../src/lib/format.ts';
import { usePacketFormatter } from '../../src/features/terminal/application/use-packet-formatter.ts';
import type { DataFrame } from '../../src/types/index.ts';

function frame(id: string, data: Uint8Array): DataFrame {
  return { id, direction: 'RX', timestamp: 0, data };
}

test('formats HEX and returns the cached string on repeat calls', () => {
  const displayMode = ref('HEX');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const f = frame('1', new Uint8Array([0xaa, 0xbb]));
  assert.equal(formatFrame(f), 'AA BB');
  // repeat call hits the cache and returns the identical string
  assert.equal(formatFrame(f), 'AA BB');
});

test('switching display mode invalidates the format cache', () => {
  const displayMode = ref('HEX');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const f = frame('1', encodeUtf8('Hi'));
  assert.equal(formatFrame(f), '48 69'); // HEX
  displayMode.value = 'UTF8';
  assert.equal(formatFrame(f), 'Hi'); // reformatted after invalidation
});

test('HEX mode never emits HTML, regardless of the ANSI flag', () => {
  const displayMode = ref('HEX');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const out = formatFrame(frame('1', new Uint8Array([0x1b, 0x5b])));
  assert.equal(out, '1B 5B');
  assert.doesNotMatch(out, /</);
});

test('ANSI enabled escapes HTML and applies color spans', () => {
  const displayMode = ref('UTF8');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const out = formatFrame(frame('1', encodeUtf8('<b>\x1b[31mred\x1b[0m')));
  assert.match(out, /&lt;b&gt;/); // html escaped
  assert.match(out, /red/);
  assert.match(out, /ansi-red-fg/);
});

test('log line breaks colorize each RX line independently in UTF8 mode', () => {
  const displayMode = ref('UTF8');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const out = formatFrame(frame('1', encodeUtf8('ok\n\x1b[32mgreen\x1b[0m')), {
    preserveLineBreaks: true,
    plainLineBreaks: false,
  });
  assert.match(out, /<br>/);
  assert.match(out, /ansi-green-fg/);
});

test('ANSI disabled returns plain text with no markup', () => {
  const displayMode = ref('UTF8');
  const ansi = ref(false);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const out = formatFrame(frame('1', encodeUtf8('\x1b[31mred\x1b[0m')));
  assert.equal(out.includes('<'), false);
  assert.match(out, /red/);
});

test('formatter/search caches share a 16 MiB byte budget and reject oversized entries', () => {
  const displayMode = ref('UTF8');
  const ansi = ref(false);
  const { formatFrame, getHexSearchData, getTextSearchData, getCacheStats } = usePacketFormatter({
    displayMode,
    ansiColorEnabled: ansi,
  });

  const oversized = frame('oversized', new Uint8Array(40 * 1024).fill(0x61));
  assert.equal(formatFrame(oversized).length, 40 * 1024);
  assert.equal(getCacheStats().entries, 0, '80 KiB UTF-16 output is not cacheable');

  // 350 independent 24 KiB strings exceed 16 MiB if retained in full. Each
  // call also exercises the same shared budget through format + both indexes.
  for (let index = 0; index < 350; index += 1) {
    const source = frame(`f${index}`, new Uint8Array(24 * 1024).fill(0x61 + (index % 2)));
    formatFrame(source);
    getHexSearchData(source);
    getTextSearchData(source);
  }
  const stats = getCacheStats();
  assert.ok(stats.bytes <= stats.maxBytes);
  assert.ok(stats.entries > 0);
  assert.equal(stats.maxEntryBytes, 64 * 1024);
});

test('evictFrames removes every format/search entry for dropped source frames', () => {
  const displayMode = ref('UTF8');
  const ansi = ref(false);
  const { formatFrame, getHexSearchData, getTextSearchData, evictFrames, getCacheStats } =
    usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const source = frame('drop-me', encodeUtf8('old'));

  assert.equal(formatFrame(source), 'old');
  getHexSearchData(source);
  getTextSearchData(source);
  assert.equal(getCacheStats().entries, 3);

  evictFrames([source]);
  assert.equal(getCacheStats().entries, 0);
  source.data = encodeUtf8('new');
  assert.equal(formatFrame(source), 'new');
});

test('HEXASCII renders a 16-bytes-per-line dump with an ASCII gutter', () => {
  const displayMode = ref('HEXASCII');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const out = formatFrame(frame('1', encodeUtf8('Hello, serial world!'))); // 20 bytes
  assert.equal(
    out,
    '48 65 6C 6C 6F 2C 20 73 65 72 69 61 6C 20 77 6F  |Hello, serial wo|\n' +
      '72 6C 64 21  |rld!            |',
  );
  assert.equal(out.split('\n').length, 2);
});

test('HEXASCII never passes through ANSI HTML rendering', () => {
  const displayMode = ref('HEXASCII');
  const ansi = ref(true);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const f = frame('1', new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d])); // ESC[31m
  const expected = '1B 5B 33 31 6D  |.[31m           |';
  assert.equal(formatFrame(f), expected);
  ansi.value = false;
  assert.equal(formatFrame(f), expected, 'the ANSI flag must not alter the dump');
});

test('HEX and HEXASCII entries stay separate in the format cache', () => {
  const displayMode = ref('HEX');
  const ansi = ref(false);
  const { formatFrame } = usePacketFormatter({ displayMode, ansiColorEnabled: ansi });
  const f = frame('1', encodeUtf8('AB'));
  assert.equal(formatFrame(f), '41 42');
  displayMode.value = 'HEXASCII';
  assert.equal(formatFrame(f), '41 42  |AB              |');
  displayMode.value = 'HEX';
  assert.equal(formatFrame(f), '41 42');
});
