/** Fixed hex/raw dump geometry used by both inspector data views. */
export const PARSER_DUMP_BYTES_PER_ROW = 16;
export const PARSER_DUMP_ROW_HEIGHT = 22;
export const PARSER_DUMP_ROW_OVERSCAN = 16;
export const PARSER_DUMP_COL_OVERSCAN = 8;
export const PARSER_DUMP_HEX_CELL_CH = 2.5;
export const PARSER_DUMP_GROUP_GAP_CH = 1;
export const PARSER_DUMP_DEFAULT_CH_PX = 7;
export const PARSER_DUMP_COLUMN_COUNT = PARSER_DUMP_BYTES_PER_ROW + 2;
export const PARSER_DUMP_ASCII_COL = PARSER_DUMP_BYTES_PER_ROW + 1;
export const PARSER_DUMP_MAX_DOM_ROWS = 48;
export const PARSER_DUMP_MAX_DOM_COLS = 20;
export const PARSER_VIRTUAL_INITIAL_RECT = { width: 720, height: 480 };

/** Record-list column geometry. Widths stay fixed so both axes can virtualize. */
export const PARSER_LIST_ROW_HEIGHT = 44;
export const PARSER_LIST_COLUMN_GAP = 7;
export const PARSER_LIST_ROW_PAD = 7;
export const PARSER_LIST_COL_OVERSCAN = 2;
export const PARSER_LIST_ROW_OVERSCAN = 12;
export const PARSER_LIST_HEX_PREVIEW_BYTES = 22;
export const PARSER_LIST_MAX_FALLBACK_ROWS = 48;

export type ParserDumpColumnKind = 'offset' | 'hex' | 'ascii';
export type ParserListKind = 'legacy' | 'smp';
export type ParserListColumnKey =
  | 'idx'
  | 'direction'
  | 'time'
  | 'transaction'
  | 'route'
  | 'seq'
  | 'status'
  | 'rtt'
  | 'framing'
  | 'hex'
  | 'len'
  | 'copy';

export interface ParserListColumn {
  key: ParserListColumnKey;
  width: number;
}

export function parserDumpRowCount(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 1) return 0;
  return Math.ceil(byteLength / PARSER_DUMP_BYTES_PER_ROW);
}

export function parserDumpRowStart(index: number): number {
  return Math.max(0, index) * PARSER_DUMP_BYTES_PER_ROW;
}

export function parserDumpOffsetChars(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 1) return 4;
  return Math.max(4, byteLength.toString(16).length);
}

export function parserDumpColumnKind(index: number): ParserDumpColumnKind {
  if (index <= 0) return 'offset';
  if (index >= PARSER_DUMP_ASCII_COL) return 'ascii';
  return 'hex';
}

export function parserDumpHexByteIndex(columnIndex: number): number {
  return columnIndex - 1;
}

export function parserDumpColumnIndexForByte(byteOffset: number): number {
  const index = Number.isInteger(byteOffset) ? byteOffset : 0;
  return (Math.max(0, index) % PARSER_DUMP_BYTES_PER_ROW) + 1;
}

export function parserDumpColumnSizeCh(index: number, offsetChars: number): number {
  const kind = parserDumpColumnKind(index);
  if (kind === 'offset') return Math.max(4, offsetChars) + PARSER_DUMP_GROUP_GAP_CH;
  if (kind === 'ascii') return PARSER_DUMP_BYTES_PER_ROW + PARSER_DUMP_GROUP_GAP_CH;
  return PARSER_DUMP_HEX_CELL_CH;
}

export function parserDumpColumnSizePx(index: number, chPx: number, offsetChars: number): number {
  return parserDumpColumnSizeCh(index, offsetChars) * Math.max(1, chPx);
}

export function parserDumpTotalWidthPx(chPx: number, offsetChars: number): number {
  let width = 0;
  for (let index = 0; index < PARSER_DUMP_COLUMN_COUNT; index += 1) {
    width += parserDumpColumnSizePx(index, chPx, offsetChars);
  }
  return width;
}

export function boundParserVirtualItems<T>(items: readonly T[], max: number): readonly T[] {
  return items.length <= max ? items : items.slice(0, max);
}

export function parserFallbackVirtualItems(
  count: number,
  estimateSize: (index: number) => number,
  max: number,
): Array<{ index: number; start: number; size: number }> {
  const n = Math.min(Math.max(0, count), max);
  const items: Array<{ index: number; start: number; size: number }> = [];
  let start = 0;
  for (let index = 0; index < n; index += 1) {
    const size = estimateSize(index);
    items.push({ index, start, size });
    start += size;
  }
  return items;
}

export function parserListColumns(kind: ParserListKind): readonly ParserListColumn[] {
  const leading: ParserListColumn[] = [
    { key: 'idx', width: 56 },
    { key: 'direction', width: 40 },
    { key: 'time', width: 80 },
  ];
  const trailing: ParserListColumn[] = [
    { key: 'len', width: 56 },
    { key: 'copy', width: 28 },
  ];
  if (kind === 'smp') {
    return [
      ...leading,
      { key: 'transaction', width: 56 },
      { key: 'route', width: 280 },
      { key: 'seq', width: 48 },
      { key: 'status', width: 72 },
      { key: 'rtt', width: 56 },
      ...trailing,
    ];
  }
  return [...leading, { key: 'framing', width: 84 }, { key: 'hex', width: 462 }, ...trailing];
}

export function normalizeParserWheelDelta(
  delta: number,
  deltaMode: number,
  lineSize: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  const line = Math.max(1, lineSize);
  if (deltaMode === 1) return delta * line;
  if (deltaMode === 2) return delta * line * 16;
  return delta;
}

export function parserVirtualWheelDelta(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey'>,
  lineSize: number,
): { x: number; y: number } {
  const x = normalizeParserWheelDelta(event.deltaX, event.deltaMode, lineSize);
  const y = normalizeParserWheelDelta(event.deltaY, event.deltaMode, lineSize);
  if (event.shiftKey) return { x: Math.abs(y) >= Math.abs(x) ? y : x, y: 0 };
  if (Math.abs(y) >= Math.abs(x)) return { x: 0, y };
  return { x, y: 0 };
}

export function applyParserVirtualWheel(
  element: {
    scrollTop: number;
    scrollLeft: number;
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
  },
  delta: { x: number; y: number },
): { x: number; y: number } {
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  const nextTop = Math.min(maxTop, Math.max(0, element.scrollTop + delta.y));
  const nextLeft = Math.min(maxLeft, Math.max(0, element.scrollLeft + delta.x));
  const moved = { x: nextLeft - element.scrollLeft, y: nextTop - element.scrollTop };
  element.scrollTop = nextTop;
  element.scrollLeft = nextLeft;
  return moved;
}

export function bindParserVirtualWheel(element: HTMLElement, lineSize: number): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    const moved = applyParserVirtualWheel(element, parserVirtualWheelDelta(event, lineSize));
    if (moved.x === 0 && moved.y === 0) return;
    event.preventDefault();
    event.stopPropagation();
  };
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => element.removeEventListener('wheel', onWheel);
}

export function parserListContentWidth(kind: ParserListKind): number {
  const columns = parserListColumns(kind);
  const widths = columns.reduce((sum, column) => sum + column.width, 0);
  const gaps = Math.max(0, columns.length - 1) * PARSER_LIST_COLUMN_GAP;
  return widths + gaps + PARSER_LIST_ROW_PAD * 2;
}

/** Scroll track height for fixed-height parser rows — never rely on virtualizer totals. */
export function parserListTotalHeight(count: number): number {
  return Math.max(0, count) * PARSER_LIST_ROW_HEIGHT;
}
