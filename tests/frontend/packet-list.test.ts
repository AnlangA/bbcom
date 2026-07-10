import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildPacketRows,
  framesForPacketCopy,
  packetBatchCopyText,
  packetColumns,
  packetContextCopyText,
  packetCopySizeStatus,
  packetDisplayLabel,
  packetKeyboardCopyText,
  packetSelectionIndex,
  packetUsesHtml,
  scrollTopForVirtualIndex,
} from '../../src/lib/packet-list.ts';
import { encodeUtf8, formatHex, formatTimestamp, formatUtf8 } from '../../src/lib/format.ts';
import type { DataFrame, HighlightRule } from '../../src/types/index.ts';

function frame(
  id: string,
  direction: DataFrame['direction'],
  data: Uint8Array,
  timestamp = 1234,
): DataFrame {
  return { id, direction, data, timestamp };
}

test('derives packet list display labels and columns', () => {
  assert.equal(packetColumns(true), '50px 160px 1fr 50px');
  assert.equal(packetColumns(false), '50px 1fr 50px');
  assert.equal(packetDisplayLabel('FRAME', 'HEX'), 'HEX');
  assert.equal(packetDisplayLabel('MERGED', 'UTF8'), 'UTF8*');
  assert.equal(packetUsesHtml('HEX', true), false);
  assert.equal(packetUsesHtml('UTF8', true), true);
  assert.equal(packetUsesHtml('UTF8', false), false);
});

test('buildPacketRows maps virtual rows with formatted data and highlight metadata', () => {
  const frames = [
    frame('a', 'TX', encodeUtf8('skip'), 1000),
    frame('b', 'RX', encodeUtf8('ok value'), 2000),
  ];
  const highlights: HighlightRule[] = [
    {
      id: 'h1',
      name: 'Match',
      enabled: true,
      matchMode: 'text',
      pattern: 'OK',
      direction: 'RX',
      color: 'amber',
    },
  ];

  const rows = buildPacketRows({
    virtualItems: [{ index: 1, start: 28, size: 28 }],
    frames,
    showTimestamp: true,
    columns: packetColumns(true),
    displayLabel: 'UTF8',
    useHtml: false,
    highlights,
    formatFrame: (candidate) => `formatted:${candidate.id}`,
    getHexSearchData: (candidate) => formatHex(candidate.data).replace(/\s/g, '').toLowerCase(),
    getTextSearchData: (candidate) => formatUtf8(candidate.data).toLowerCase(),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'b');
  assert.equal(rows[0].formatted, 'formatted:b');
  assert.equal(rows[0].timestamp, formatTimestamp(2000));
  assert.equal(rows[0].style.height, '28px');
  assert.equal(rows[0].style.transform, 'translateY(28px)');
  assert.equal(rows[0].highlightClass, 'highlight-amber');
  assert.equal(rows[0].highlightLabel, 'Match');
});

test('packetSelectionIndex follows current keyboard navigation semantics', () => {
  const frames = [
    frame('a', 'RX', new Uint8Array([1])),
    frame('b', 'RX', new Uint8Array([2])),
    frame('c', 'RX', new Uint8Array([3])),
  ];

  assert.equal(packetSelectionIndex(frames, null, 'ArrowDown'), 0);
  assert.equal(packetSelectionIndex(frames, null, 'ArrowUp'), 0);
  assert.equal(packetSelectionIndex(frames, 'b', 'ArrowDown'), 2);
  assert.equal(packetSelectionIndex(frames, 'b', 'ArrowUp'), 0);
  assert.equal(packetSelectionIndex(frames, 'c', 'ArrowDown'), 2);
  assert.equal(packetSelectionIndex(frames, 'a', 'Enter'), null);
  assert.equal(packetSelectionIndex([], null, 'ArrowDown'), null);
});

test('scrollTopForVirtualIndex returns only the scroll adjustment needed', () => {
  const items = [
    { index: 0, start: 0, size: 28 },
    { index: 1, start: 28, size: 28 },
    { index: 2, start: 56, size: 28 },
  ];

  assert.equal(scrollTopForVirtualIndex(0, items, 20, 40), 0);
  assert.equal(scrollTopForVirtualIndex(2, items, 0, 60), 24);
  assert.equal(scrollTopForVirtualIndex(1, items, 20, 60), null);
  assert.equal(scrollTopForVirtualIndex(9, items, 20, 60), null);
});

test('packetContextCopyText formats every context-menu copy mode', () => {
  const f = frame('x', 'RX', encodeUtf8('\x1b[31mA\x1b[0m'), 123);
  const options = {
    formatFrame: () => 'formatted',
    stripAnsi: (text: string) =>
      text.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g'), ''),
  };

  assert.equal(packetContextCopyText('hex', f, options), formatHex(f.data));
  assert.equal(packetContextCopyText('ascii', f, options), formatUtf8(f.data));
  assert.equal(packetContextCopyText('utf8', f, options), formatUtf8(f.data));
  assert.equal(packetContextCopyText('plain', f, options), 'A');
  assert.equal(
    packetContextCopyText('row', f, options),
    `[${formatTimestamp(123)}] RX | formatted`,
  );
});

test('packetKeyboardCopyText keeps the existing raw timestamp shortcut format', () => {
  const f = frame('x', 'TX', encodeUtf8('AT'), 456);
  assert.equal(
    packetKeyboardCopyText(f, () => 'AT'),
    '[456] TX | AT',
  );
});

test('batch copy helpers select frames, enforce limits, and format text', () => {
  const allFrames = [
    frame('a', 'TX', encodeUtf8('AT'), 100),
    frame('b', 'RX', encodeUtf8('OK'), 200),
  ];
  const filteredFrames = [allFrames[1]];

  assert.deepEqual(framesForPacketCopy('all-text', allFrames, filteredFrames), allFrames);
  assert.deepEqual(framesForPacketCopy('filtered-hex', allFrames, filteredFrames), filteredFrames);
  assert.deepEqual(packetCopySizeStatus(allFrames, { maxBytes: 3, maxFrames: 10 }), {
    tooLarge: true,
    totalBytes: 4,
  });
  assert.deepEqual(packetCopySizeStatus(allFrames, { maxBytes: 10, maxFrames: 1 }), {
    tooLarge: true,
    totalBytes: 4,
  });
  assert.deepEqual(packetCopySizeStatus(filteredFrames, { maxBytes: 10, maxFrames: 10 }), {
    tooLarge: false,
    totalBytes: 2,
  });
  assert.deepEqual(
    packetCopySizeStatus([{ ...frame('merged', 'RX', new Uint8Array(64)), omittedBytes: 1024 }], {
      maxBytes: 1000,
      maxFrames: 10,
    }),
    { tooLarge: true, totalBytes: 1088 },
  );
  assert.equal(
    packetBatchCopyText('filtered-text', filteredFrames),
    `[${formatTimestamp(200)}] RX | OK`,
  );
  assert.equal(
    packetBatchCopyText('all-hex', allFrames),
    `[${formatTimestamp(100)}] TX | 41 54\n[${formatTimestamp(200)}] RX | 4F 4B`,
  );
});
