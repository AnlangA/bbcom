import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  boundParserVirtualItems,
  PARSER_DUMP_ASCII_COL,
  PARSER_DUMP_BYTES_PER_ROW,
  PARSER_DUMP_COLUMN_COUNT,
  PARSER_DUMP_MAX_DOM_COLS,
  PARSER_DUMP_MAX_DOM_ROWS,
  PARSER_DUMP_ROW_HEIGHT,
  PARSER_LIST_COLUMN_GAP,
  PARSER_LIST_HEX_PREVIEW_BYTES,
  PARSER_LIST_ROW_HEIGHT,
  parserDumpColumnIndexForByte,
  parserDumpColumnKind,
  parserDumpColumnSizePx,
  parserDumpHexByteIndex,
  parserDumpOffsetChars,
  parserDumpRowCount,
  parserDumpRowStart,
  parserDumpTotalWidthPx,
  parserFallbackVirtualItems,
  parserListColumns,
  parserListContentWidth,
  parserListTotalHeight,
  parserVirtualWheelDelta,
  applyParserVirtualWheel,
  normalizeParserWheelDelta,
} from '@/lib/parser-virtual-list.ts';

test('parser dump helpers count fixed-width hex rows', () => {
  assert.equal(parserDumpRowCount(0), 0);
  assert.equal(parserDumpRowCount(-1), 0);
  assert.equal(parserDumpRowCount(1), 1);
  assert.equal(parserDumpRowCount(16), 1);
  assert.equal(parserDumpRowCount(17), 2);
  assert.equal(parserDumpRowStart(0), 0);
  assert.equal(parserDumpRowStart(2), 32);
  assert.equal(PARSER_DUMP_ROW_HEIGHT, 22);
});

test('parser dump columns cover offset, sixteen hex cells, and ascii', () => {
  assert.equal(PARSER_DUMP_COLUMN_COUNT, PARSER_DUMP_BYTES_PER_ROW + 2);
  assert.equal(parserDumpColumnKind(0), 'offset');
  assert.equal(parserDumpColumnKind(1), 'hex');
  assert.equal(parserDumpColumnKind(16), 'hex');
  assert.equal(parserDumpColumnKind(PARSER_DUMP_ASCII_COL), 'ascii');
  assert.equal(parserDumpHexByteIndex(1), 0);
  assert.equal(parserDumpHexByteIndex(16), 15);
  assert.equal(parserDumpColumnIndexForByte(0), 1);
  assert.equal(parserDumpColumnIndexForByte(17), 2);
});

test('parser dump geometry scales with offset digits and ch size', () => {
  assert.equal(parserDumpOffsetChars(0), 4);
  assert.equal(parserDumpOffsetChars(0xffff), 4);
  assert.equal(parserDumpOffsetChars(0x10000), 5);
  const narrow = parserDumpTotalWidthPx(7, 4);
  const wide = parserDumpTotalWidthPx(7, 6);
  const largerCh = parserDumpTotalWidthPx(8, 4);
  assert.ok(wide > narrow);
  assert.ok(largerCh > narrow);
  assert.equal(parserDumpColumnSizePx(1, 7, 4), 2.5 * 7);
});

test('parser dump virtual windows stay within the DOM budget', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ index }));
  const cols = Array.from({ length: 30 }, (_, index) => ({ index }));
  assert.equal(boundParserVirtualItems(rows, PARSER_DUMP_MAX_DOM_ROWS).length, 48);
  assert.equal(boundParserVirtualItems(cols, PARSER_DUMP_MAX_DOM_COLS).length, 20);
  assert.equal(boundParserVirtualItems(rows.slice(0, 12), PARSER_DUMP_MAX_DOM_ROWS).length, 12);
});

test('parser fallback virtual items keep a visible window when the virtualizer is empty', () => {
  assert.deepEqual(
    parserFallbackVirtualItems(0, () => 22, 48),
    [],
  );
  const items = parserFallbackVirtualItems(80, () => 22, 4);
  assert.deepEqual(items, [
    { index: 0, start: 0, size: 22 },
    { index: 1, start: 22, size: 22 },
    { index: 2, start: 44, size: 22 },
    { index: 3, start: 66, size: 22 },
  ]);
});

test('parser list columns differ between legacy hex and SMP records', () => {
  const legacy = parserListColumns('legacy');
  const smp = parserListColumns('smp');
  assert.deepEqual(
    legacy.map((column) => column.key),
    ['idx', 'direction', 'time', 'framing', 'hex', 'len', 'copy'],
  );
  assert.deepEqual(
    smp.map((column) => column.key),
    ['idx', 'direction', 'time', 'transaction', 'route', 'seq', 'status', 'rtt', 'len', 'copy'],
  );
  assert.equal(PARSER_LIST_HEX_PREVIEW_BYTES, 22);
  assert.equal(PARSER_LIST_ROW_HEIGHT, 44);
  assert.equal(parserListTotalHeight(35), 35 * PARSER_LIST_ROW_HEIGHT);
  assert.ok(parserListContentWidth('legacy') > parserListColumns('legacy')[4].width);
  assert.equal(
    parserListContentWidth('smp'),
    smp.reduce((sum, column) => sum + column.width, 0) +
      (smp.length - 1) * PARSER_LIST_COLUMN_GAP +
      14,
  );
});

test('parser virtual wheel uses the mouse wheel for both axes', () => {
  assert.equal(normalizeParserWheelDelta(2, 1, 22), 44);
  assert.equal(normalizeParserWheelDelta(1, 2, 22), 352);
  assert.deepEqual(
    parserVirtualWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: false }, 22),
    { x: 0, y: 40 },
  );
  assert.deepEqual(
    parserVirtualWheelDelta({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true }, 22),
    { x: 40, y: 0 },
  );
  assert.deepEqual(
    parserVirtualWheelDelta({ deltaX: 12, deltaY: 40, deltaMode: 0, shiftKey: false }, 22),
    { x: 0, y: 40 },
  );
  assert.deepEqual(
    parserVirtualWheelDelta({ deltaX: 12, deltaY: 4, deltaMode: 0, shiftKey: false }, 22),
    { x: 12, y: 0 },
  );

  const element = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 200,
    scrollWidth: 300,
    clientHeight: 100,
    clientWidth: 100,
  };
  assert.deepEqual(applyParserVirtualWheel(element, { x: 50, y: 80 }), { x: 50, y: 80 });
  assert.equal(element.scrollTop, 80);
  assert.equal(element.scrollLeft, 50);
  assert.deepEqual(applyParserVirtualWheel(element, { x: 999, y: 999 }), { x: 150, y: 20 });
  assert.equal(element.scrollTop, 100);
  assert.equal(element.scrollLeft, 200);
});
