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
  packetLineBreakCount,
  packetRowHeight,
  packetKeyboardCopyText,
  packetSelectionIndex,
  packetUsesHtml,
  scrollTopForVirtualIndex,
} from '@/lib/packet-list.ts';
import { encodeUtf8, formatHex, formatTimestamp, formatUtf8 } from '@/lib/format.ts';
import { MERGED_FRAME_LINE_COUNT, MergedFrameRopeIndex } from '@/lib/merged-frame-rope.ts';
import type { DataFrame, HighlightRule } from '@/types/index.ts';
import { frame } from '@/test/helpers/frames.ts';

test('derives packet list display labels and columns', () => {
  assert.equal(packetColumns(true), '50px 160px 1fr 50px');
  assert.equal(packetColumns(false), '50px 1fr 50px');
  assert.equal(packetDisplayLabel('FRAME', 'HEX'), 'HEX');
  assert.equal(packetDisplayLabel('MERGED', 'UTF8'), 'UTF8*');
  assert.equal(packetUsesHtml('HEX', true), false);
  assert.equal(packetUsesHtml('HEXASCII', true), false);
  assert.equal(packetUsesHtml('HEXASCII', false), false);
  assert.equal(packetUsesHtml('UTF8', true), true);
  assert.equal(packetUsesHtml('UTF8', false), false);
});

test('sizes text rows from CR/LF log line endings without double-counting CRLF', () => {
  const f = frame('lines', 'RX', encodeUtf8('one\r\ntwo\nthree\rfour'));
  assert.equal(packetLineBreakCount(f.data), 3);
  assert.equal(packetRowHeight(f, 'UTF8', true), 94);
  assert.equal(packetRowHeight(f, 'UTF8', false), 28);
  assert.equal(packetRowHeight(f, 'HEX', true), 28);
  assert.equal(packetRowHeight(frame('trailing', 'RX', encodeUtf8('one\r\n')), 'UTF8', true), 28);
  assert.equal(packetRowHeight(frame('blank', 'RX', encodeUtf8('one\n\n')), 'UTF8', true), 50);
  assert.equal(
    packetRowHeight(frame('zephyr', 'RX', encodeUtf8('I: oneI: two')), 'UTF8', true),
    50,
  );
});

test('sizes HEXASCII dump rows from the fixed 16-bytes-per-line layout', () => {
  // The dump is always multi-line (one display line per 16 bytes, 28px base +
  // 22px per extra line), independent of the preserve-line-breaks toggle.
  assert.equal(packetRowHeight(undefined, 'HEXASCII', true), 28);
  assert.equal(packetRowHeight(frame('empty', 'RX', new Uint8Array(0)), 'HEXASCII', false), 28);
  assert.equal(
    packetRowHeight(frame('full-line', 'RX', new Uint8Array(16)), 'HEXASCII', false),
    28,
  );
  assert.equal(packetRowHeight(frame('two-lines', 'RX', new Uint8Array(17)), 'HEXASCII', true), 50);
  assert.equal(packetRowHeight(frame('two-full', 'RX', new Uint8Array(32)), 'HEXASCII', false), 50);
  assert.equal(
    packetRowHeight(frame('three-lines', 'RX', new Uint8Array(33)), 'HEXASCII', true),
    72,
  );
});

test('packetRowHeight consults the merged frame line-count memo hook only on the text path', () => {
  let computeCalls = 0;
  const hooked = {
    id: 'hooked',
    direction: 'RX',
    timestamp: 1,
    data: encodeUtf8('one\ntwo\nthree'),
    [MERGED_FRAME_LINE_COUNT]: (compute: () => number): number => {
      computeCalls += 1;
      return compute();
    },
  } as DataFrame;

  assert.equal(packetRowHeight(hooked, 'UTF8', true), 28 + 2 * 22);
  assert.equal(packetRowHeight(hooked, 'UTF8', false), 28);
  assert.equal(packetRowHeight(hooked, 'HEX', true), 28);
  assert.equal(
    packetRowHeight(hooked, 'HEXASCII', true),
    28 + (Math.ceil(hooked.data.byteLength / 16) - 1) * 22,
  );
  assert.equal(computeCalls, 1, 'only preserve-line-breaks text sizing goes through the hook');
});

test('merged rope frames keep exact memoized heights and re-measure after growth', () => {
  const rope = new MergedFrameRopeIndex();
  rope.append(frame('m1', 'RX', encodeUtf8('a\nb\nc')));
  const display = rope.frames[0];
  assert.ok(display);

  // Repeated measure passes return the same cached height (memoization is
  // asserted at the rope level via the counting-spy test).
  assert.equal(packetRowHeight(display, 'UTF8', true), 28 + 2 * 22);
  assert.equal(packetRowHeight(display, 'UTF8', true), 28 + 2 * 22);

  // Growth of the live tail run invalidates the memo: the tail now decodes
  // to four display lines ("a", "b", "cd", "e").
  rope.append(frame('m2', 'RX', encodeUtf8('d\ne')));
  assert.equal(packetRowHeight(display, 'UTF8', true), 28 + 3 * 22);
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
    highlights,
    formatFrame: (candidate) => `formatted:${candidate.id}`,
    getHexSearchData: (candidate) => formatHex(candidate.data).replace(/\s/g, '').toLowerCase(),
    getTextSearchData: (candidate) => formatUtf8(candidate.data).toLowerCase(),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'b');
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].formatted, 'formatted:b');
  assert.equal(rows[0].timestamp, formatTimestamp(2000));
  assert.equal(rows[0].style.height, undefined);
  assert.equal(rows[0].style.transform, 'translateY(28px)');
  assert.equal(rows[0].highlightClass, 'highlight-amber');
  assert.equal(rows[0].highlightLabel, 'Match');
  assert.equal(rows[0].striped, true);
});

test('buildPacketRows alternates the zebra tint by virtual index parity', () => {
  const frames = [
    frame('a', 'RX', encodeUtf8('one')),
    frame('b', 'RX', encodeUtf8('two')),
    frame('c', 'RX', encodeUtf8('three')),
  ];

  const rows = buildPacketRows({
    virtualItems: [
      { index: 0, start: 0, size: 28 },
      { index: 1, start: 28, size: 28 },
      { index: 2, start: 56, size: 28 },
    ],
    frames,
    formatFrame: (candidate) => candidate.id,
    getHexSearchData: () => '',
    getTextSearchData: () => '',
  });

  assert.deepEqual(
    rows.map((row) => row.striped),
    [false, true, false],
  );
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

test('packetKeyboardCopyText formats the timestamp like every other copy path', () => {
  const f = frame('x', 'TX', encodeUtf8('AT'), 456);
  assert.equal(
    packetKeyboardCopyText(f, () => 'AT'),
    `[${formatTimestamp(456)}] TX | AT`,
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
