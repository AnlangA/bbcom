import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { encodeUtf8, formatAscii, formatBytes, formatHex, formatTimestamp, formatUtf8, isValidHex, parseHex } from '../../src/lib/format.ts';
import { usePacketFormatter } from '../../src/composables/usePacketFormatter.ts';
import type { DataFrame } from '../../src/types/index.ts';

function frame(text: string): DataFrame {
  return {
    id: crypto.randomUUID(),
    direction: 'RX',
    timestamp: '12:00:00.000',
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

test('formats text, timestamps, and byte counts', () => {
  assert.equal(formatUtf8(encodeUtf8('串口')), '串口');
  assert.equal(formatAscii(new Uint8Array([65, 66, 67])), 'ABC');
  assert.equal(formatTimestamp(1710000000123).endsWith('.123'), true);
  assert.equal(formatBytes(1024), '1.0 KB');
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
