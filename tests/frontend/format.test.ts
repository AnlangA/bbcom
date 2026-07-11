import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import {
  appendLineEnding,
  computeSendByteCount,
  encodeUtf8,
  formatAscii,
  formatBytes,
  formatDuration,
  formatHex,
  formatLogLine,
  formatRate,
  formatTimestamp,
  formatUtf8,
  formatFrameData,
  hexByteCount,
  isValidHex,
  normalizeHex,
  parseHex,
  stripAnsiEscapes,
  toContinuousHex,
  truncate,
} from '../../src/lib/format.ts';
import { usePacketFormatter } from '../../src/composables/usePacketFormatter.ts';
import type { DataFrame } from '../../src/types/index.ts';

function frame(text: string): DataFrame {
  return {
    id: crypto.randomUUID(),
    direction: 'RX',
    timestamp: 0,
    data: encodeUtf8(text),
  };
}

test('formats and parses hex values', () => {
  assert.equal(formatHex(new Uint8Array([0, 10, 255])), '00 0A FF');
  assert.deepEqual(Array.from(parseHex('00 0a ff')), [0, 10, 255]);
  assert.deepEqual(Array.from(parseHex('00,0A,FF')), [0, 10, 255]);
  assert.equal(isValidHex('AA BB CC'), true);
  assert.equal(isValidHex('AA B'), false);
});

test('parseHex rejects odd-length input and handles mixed-case + separators', () => {
  assert.deepEqual(Array.from(parseHex('aabbcc')), [0xaa, 0xbb, 0xcc]);
  assert.deepEqual(Array.from(parseHex('FfEeDd')), [0xff, 0xee, 0xdd]);
  assert.deepEqual(Array.from(parseHex('')), []);
  assert.throws(() => parseHex('AAB'), /odd number of digits/i);
  assert.throws(() => parseHex('AA BB C'), /odd number of digits/i);
});

test('hexByteCount counts byte pairs ignoring separators and non-hex chars', () => {
  assert.equal(hexByteCount('AA BB CC'), 3);
  assert.equal(hexByteCount('aabbcc'), 3);
  assert.equal(hexByteCount(''), 0);
  assert.equal(hexByteCount('xyz'), 0); // no hex chars
  assert.equal(hexByteCount('AA,BB'), 2); // comma separated
});

test('normalizeHex uppercases and groups bytes, preserving a trailing nibble', () => {
  assert.equal(normalizeHex('aabbcc'), 'AA BB CC');
  assert.equal(normalizeHex('aa bb cc'), 'AA BB CC');
  assert.equal(normalizeHex('AA,BB'), 'AA BB');
  assert.equal(normalizeHex('aab'), 'AA B');
  assert.equal(normalizeHex(''), '');
});

test('toContinuousHex produces lowercase space-less hex for search indexing', () => {
  assert.equal(toContinuousHex(new Uint8Array([0xaa, 0xbb, 0x0c, 0xff])), 'aabb0cff');
  assert.equal(toContinuousHex(new Uint8Array()), '');
  // must equal the legacy format-then-strip path it replaces
  assert.equal(
    toContinuousHex(new Uint8Array([0, 10, 255])),
    formatHex(new Uint8Array([0, 10, 255]))
      .replace(/\s/g, '')
      .toLowerCase(),
  );
});

test('formats text, timestamps, and byte counts', () => {
  assert.equal(formatUtf8(encodeUtf8('串口')), '串口');
  assert.equal(formatAscii(new Uint8Array([65, 66, 67])), 'ABC');
  assert.equal(formatTimestamp(1710000000123).endsWith('.123'), true);
  assert.equal(formatBytes(1024), '1.0 KB');
});

test('formatBytes spans B, KB, and MB ranges', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1048575), '1024.0 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('formatRate spans B/s, KB/s, and MB/s ranges', () => {
  assert.equal(formatRate(500), '500 B/s');
  assert.equal(formatRate(2048), '2.0 KB/s');
  assert.equal(formatRate(2 * 1024 * 1024), '2.0 MB/s');
});

test('formatLogLine combines timestamp, direction, and data into a single line', () => {
  const line = formatLogLine(1710000000123, 'TX', '41 42');
  assert.match(line, /^\[/);
  assert.match(line, /\] TX \| 41 42$/);
  assert.ok(line.includes(formatTimestamp(1710000000123)));
});

test('formatDuration renders elapsed milliseconds as HH:MM:SS', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(1000), '00:00:01');
  assert.equal(formatDuration(60_000), '00:01:00');
  assert.equal(formatDuration(3_600_000), '01:00:00');
  // 1h 1m 1.5s — sub-second remainder is floored
  assert.equal(formatDuration(3_661_500), '01:01:01');
});

test('appendLineEnding adds the configured terminator', () => {
  assert.equal(appendLineEnding('AT', 'none'), 'AT');
  assert.equal(appendLineEnding('AT', 'CR'), 'AT\r');
  assert.equal(appendLineEnding('AT', 'LF'), 'AT\n');
  assert.equal(appendLineEnding('AT', 'CRLF'), 'AT\r\n');
});

test('computeSendByteCount counts HEX payload bytes incl. appended checksum', () => {
  assert.equal(computeSendByteCount('AA BB', true, 'none', 'none'), 2);
  assert.equal(computeSendByteCount('AA BB', true, 'CHECKSUM', 'none'), 3); // 2 + 1
  assert.equal(computeSendByteCount('AA BB', true, 'CRC16', 'none'), 4); // 2 + 2
  assert.equal(computeSendByteCount('AA BB', true, 'CRC16_MODBUS', 'none'), 4); // 2 + 2
  assert.equal(computeSendByteCount('AA BB', true, 'CRC32', 'none'), 6); // 2 + 4
  // empty input is zero
  assert.equal(computeSendByteCount('   ', true, 'none', 'none'), 0);
});

test('computeSendByteCount counts UTF-8 bytes incl. line ending for text mode', () => {
  assert.equal(computeSendByteCount('AB', false, 'none', 'none'), 2);
  assert.equal(computeSendByteCount('AB', false, 'none', 'CRLF'), 4); // 'AB\r\n'
  // multibyte: '串' is 3 UTF-8 bytes
  assert.equal(computeSendByteCount('串', false, 'none', 'none'), 3);
  // checksum option is ignored for text mode
  assert.equal(computeSendByteCount('AB', false, 'CRC32', 'none'), 2);
});

test('truncate keeps short strings intact and ellipsizes long ones', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc...');
  assert.equal(truncate('abc', 3), 'abc');
});

test('isValidHex treats whitespace, commas, and odd lengths correctly', () => {
  assert.equal(isValidHex(''), false);
  assert.equal(isValidHex('AABB'), true);
  assert.equal(isValidHex('aa-bb'), true);
  assert.equal(isValidHex('AAB'), false);
});

test('ansi formatter escapes unsafe html before v-html rendering', () => {
  const { formatFrame } = usePacketFormatter({
    displayMode: ref('UTF8'),
    ansiColorEnabled: ref(true),
  });

  const html = formatFrame(frame('<img src=x onerror=alert(1)>\x1b[31mred\x1b[0m'));

  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /&gt;/);
  assert.match(html, /red/);
});

test('packet formatter caches formatted output and hex search data', () => {
  const displayMode = ref('HEX' as const);
  const { formatFrame, getHexSearchData, clearCaches } = usePacketFormatter({
    displayMode,
    ansiColorEnabled: ref(false),
  });
  const f = frame('hello');

  const first = formatFrame(f);
  const second = formatFrame(f);
  assert.equal(first, '68 65 6C 6C 6F');
  assert.equal(first, second);

  assert.equal(getHexSearchData(f), '68656c6c6f');

  // changing display mode invalidates the format cache but not the search cache
  displayMode.value = 'ASCII';
  assert.equal(formatFrame(f), 'hello');
  assert.equal(getHexSearchData(f), '68656c6c6f');

  clearCaches();
  assert.equal(getHexSearchData(f), '68656c6c6f');
});

test('text search index strips ANSI codes and lowercases for matching', () => {
  const { getTextSearchData } = usePacketFormatter({
    displayMode: ref('UTF8'),
    ansiColorEnabled: ref(true),
  });
  const f = frame('\x1b[31mERROR\x1b[0m reboot now');

  // search index has no escape sequences and is lowercased
  assert.equal(getTextSearchData(f), 'error reboot now');
  assert.equal(stripAnsiEscapes('\x1b[1;32mok\x1b[0m'), 'ok');
  // non-SGR CSI sequences (cursor move, erase, DEC-private) are also stripped
  assert.equal(stripAnsiEscapes('\x1b[2J\x1b[1;1Hcleared\x1b[?25h'), 'cleared');
});

test('formatFrame renders each display mode from the same bytes', () => {
  const f = frame('AB'); // bytes 0x41 0x42

  assert.equal(
    usePacketFormatter({ displayMode: ref('HEX'), ansiColorEnabled: ref(false) }).formatFrame(f),
    '41 42',
  );
  assert.equal(
    usePacketFormatter({ displayMode: ref('ASCII'), ansiColorEnabled: ref(false) }).formatFrame(f),
    'AB',
  );
  assert.equal(
    usePacketFormatter({ displayMode: ref('UTF8'), ansiColorEnabled: ref(false) }).formatFrame(f),
    'AB',
  );
  // ANSI mode without color rendering falls back to plain ASCII text
  assert.equal(
    usePacketFormatter({ displayMode: ref('ANSI'), ansiColorEnabled: ref(false) }).formatFrame(f),
    'AB',
  );
});

test('formatFrame ANSI color output is cached identically across calls', () => {
  const { formatFrame } = usePacketFormatter({
    displayMode: ref('UTF8'),
    ansiColorEnabled: ref(true),
  });
  const f = frame('\x1b[32mok\x1b[0m');

  const first = formatFrame(f);
  const second = formatFrame(f);
  assert.equal(first, second);
  assert.match(first, /ok/);
  // ansi_up wraps colored output in a span
  assert.match(first, /span/i);
});

test('formatFrame must not serve stale output for a stable id with growing data (merged-frame safety)', () => {
  // Merged frames keep id `merged-<firstFrameId>` while their concatenated data
  // grows on every rebuild. Caching by id alone would freeze the displayed
  // content during streaming, so a stable id with changed data must re-render.
  const { formatFrame } = usePacketFormatter({
    displayMode: ref('UTF8'),
    ansiColorEnabled: ref(false),
  });
  const f1: DataFrame = {
    id: 'merged-1',
    direction: 'RX',
    timestamp: 0,
    data: encodeUtf8('hello'),
  };
  const f2: DataFrame = {
    id: 'merged-1',
    direction: 'RX',
    timestamp: 0,
    data: encodeUtf8('hello world'),
  };

  assert.equal(formatFrame(f1), 'hello');
  assert.equal(formatFrame(f2), 'hello world');
});

test('stripAnsiEscapes removes CSI color/control sequences', () => {
  const red = '\x1b[31m';
  const reset = '\x1b[0m';
  assert.equal(stripAnsiEscapes(`${red}hello${reset}`), 'hello');
  // cursor moves / DEC-private sequences are stripped too
  assert.equal(stripAnsiEscapes('a\x1b[2Kb\x1b[?25hc'), 'abc');
});

test('formatFrameData decodes bytes per the selected display mode', () => {
  // 'AB' = 0x41 0x42
  const data = new Uint8Array([0x41, 0x42]);
  assert.equal(formatFrameData(data, 'HEX'), '41 42');
  assert.equal(formatFrameData(data, 'ASCII'), 'AB');
  assert.equal(formatFrameData(data, 'UTF8'), 'AB');
  // ANSI mode strips escape codes from the ASCII-decoded text
  const colored = new Uint8Array([...encodeUtf8('\x1b[32mOK\x1b[0m')]);
  assert.equal(formatFrameData(colored, 'ANSI'), 'OK');
});
