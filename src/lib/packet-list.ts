import type { CSSProperties } from 'vue';
import type { DataFrame, DisplayMode, HighlightRule, PacketViewMode } from '../types';
import {
  formatAscii,
  formatHex,
  formatTimestamp,
  formatUtf8,
  HEXASCII_BYTES_PER_LINE,
} from './format';
import { findFrameHighlight, type HighlightSearchAccessors } from './highlights';
import { splitLogDisplayLines } from './log-line-breaks';

export const PACKET_COPY_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxFrames: 5000,
} as const;

export const PACKET_ROW_HEIGHT = 28;
export const PACKET_ROW_LINE_HEIGHT = 22;

export type PacketContextCopyKey = 'hex' | 'ascii' | 'utf8' | 'plain' | 'row';
export type PacketBatchCopyKey = 'filtered-hex' | 'filtered-text' | 'all-hex' | 'all-text';

export interface PacketVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface PacketRowData {
  key: string;
  index: number;
  style: CSSProperties & {
    position: 'absolute';
    top: string;
    left: string;
    width: string;
    transform: string;
  };
  frame: DataFrame;
  /** Changes whenever immutable frame content changes, including MERGED rows
   * whose stable first-frame id is intentionally reused as data grows. */
  contentVersion: number;
  formatted: string;
  timestamp: string;
  highlightClass: string | null;
  highlightLabel: string | null;
  /** Alternating-row tint derived from the virtual index, stable per frame. */
  striped: boolean;
}

export interface PacketRowBuildOptions extends HighlightSearchAccessors {
  virtualItems: readonly PacketVirtualItem[];
  frames: readonly DataFrame[];
  highlights?: readonly HighlightRule[];
  formatFrame: (frame: DataFrame) => string;
}

export function packetColumns(showTimestamp: boolean): string {
  return showTimestamp ? '50px 160px 1fr 50px' : '50px 1fr 50px';
}

export function packetDisplayLabel(
  packetViewMode: PacketViewMode,
  displayMode: DisplayMode,
): string {
  return packetViewMode === 'MERGED' ? `${displayMode}*` : displayMode;
}

export function packetUsesHtml(displayMode: DisplayMode, ansiColorEnabled: boolean): boolean {
  // HEX and the HEXASCII dump are plain text; only decodable text modes carry
  // ANSI escape sequences worth rendering as HTML.
  return displayMode !== 'HEX' && displayMode !== 'HEXASCII' && ansiColorEnabled;
}

/** Count CR, LF, and CRLF line endings without decoding or allocating. */
export function packetLineBreakCount(data: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < data.byteLength; index += 1) {
    const byte = data[index];
    if (byte === 0x0d) {
      count += 1;
      if (data[index + 1] === 0x0a) index += 1;
    } else if (byte === 0x0a) {
      count += 1;
    }
  }
  return count;
}

/**
 * Exact virtual row height when explicit line endings and recognized log
 * record prefixes are preserved. A terminal CR/LF sequence is the current
 * line's delimiter, not a request for an additional empty display line.
 * HEXASCII is always a multi-line dump (16 bytes per line) regardless of the
 * preserve-line-breaks toggle.
 */
export function packetRowHeight(
  frame: DataFrame | undefined,
  displayMode: DisplayMode,
  preserveLineBreaks: boolean,
): number {
  if (!frame) {
    return PACKET_ROW_HEIGHT;
  }
  if (displayMode === 'HEXASCII') {
    const lineCount = Math.max(1, Math.ceil(frame.data.byteLength / HEXASCII_BYTES_PER_LINE));
    return PACKET_ROW_HEIGHT + (lineCount - 1) * PACKET_ROW_LINE_HEIGHT;
  }
  if (!preserveLineBreaks || displayMode === 'HEX') {
    return PACKET_ROW_HEIGHT;
  }
  const lines = splitLogDisplayLines(formatUtf8(frame.data));
  const lineCount = lines.length - (lines.length > 1 && lines.at(-1) === '' ? 1 : 0);
  return PACKET_ROW_HEIGHT + (lineCount - 1) * PACKET_ROW_LINE_HEIGHT;
}

export function buildPacketRows({
  virtualItems,
  frames,
  highlights = [],
  formatFrame,
  getHexSearchData,
  getTextSearchData,
}: PacketRowBuildOptions): PacketRowData[] {
  const out: PacketRowData[] = [];
  const highlightRules = [...highlights];
  for (const item of virtualItems) {
    const frame = frames[item.index];
    if (!frame) continue;
    const highlight = findFrameHighlight(highlightRules, frame, {
      getHexSearchData,
      getTextSearchData,
    });
    out.push({
      key: frame.id,
      index: item.index,
      style: {
        position: 'absolute',
        top: '0px',
        left: '0px',
        width: '100%',
        transform: `translateY(${item.start}px)`,
      },
      frame,
      // Rope-backed MERGED rows expose a stable id and a 64 KiB UI tail. Their
      // monotonic contentVersion, not the capped tail length, drives v-memo.
      contentVersion: frame.contentVersion ?? frame.data.byteLength,
      formatted: formatFrame(frame),
      timestamp: formatTimestamp(frame.timestamp),
      highlightClass: highlight ? `highlight-${highlight.color}` : null,
      highlightLabel: highlight?.name ?? null,
      striped: item.index % 2 === 1,
    });
  }
  return out;
}

export function packetSelectionIndex(
  frames: readonly DataFrame[],
  selectedFrameId: string | null,
  key: string,
): number | null {
  if (frames.length === 0) return null;
  const currentIndex = selectedFrameId
    ? frames.findIndex((frame) => frame.id === selectedFrameId)
    : -1;
  if (key === 'ArrowDown') return Math.min(currentIndex + 1, frames.length - 1);
  if (key === 'ArrowUp') return Math.max(currentIndex - 1, 0);
  return null;
}

export function scrollTopForVirtualIndex(
  index: number,
  virtualItems: readonly PacketVirtualItem[],
  scrollTop: number,
  viewportHeight: number,
): number | null {
  const item = virtualItems.find((candidate) => candidate.index === index);
  if (!item) return null;
  const itemTop = item.start;
  const itemBottom = itemTop + item.size;
  if (itemTop < scrollTop) return itemTop;
  if (itemBottom > scrollTop + viewportHeight) return itemBottom - viewportHeight;
  return null;
}

export function packetContextCopyText(
  key: PacketContextCopyKey,
  frame: DataFrame,
  options: {
    formatFrame: (frame: DataFrame) => string;
    stripAnsi: (text: string) => string;
  },
): string {
  switch (key) {
    case 'hex':
      return formatHex(frame.data);
    case 'ascii':
      return formatAscii(frame.data);
    case 'utf8':
      return formatUtf8(frame.data);
    case 'plain':
      return options.stripAnsi(formatAscii(frame.data));
    case 'row':
      return `[${formatTimestamp(frame.timestamp)}] ${frame.direction} | ${options.formatFrame(frame)}`;
  }
}

export function packetKeyboardCopyText(
  frame: DataFrame,
  formatFrame: (frame: DataFrame) => string,
): string {
  return `[${frame.timestamp}] ${frame.direction} | ${formatFrame(frame)}`;
}

export function framesForPacketCopy(
  key: PacketBatchCopyKey,
  allFrames: readonly DataFrame[],
  filteredFrames: readonly DataFrame[],
): readonly DataFrame[] {
  return key.startsWith('all') ? allFrames : filteredFrames;
}

export function packetCopySizeStatus(
  frames: readonly DataFrame[],
  limits = PACKET_COPY_LIMITS,
): { tooLarge: boolean; totalBytes: number } {
  // Rope rows carry only a 64 KiB UI tail in `data`; omittedBytes completes
  // the logical payload length before a copy can request full materialization.
  const totalBytes = frames.reduce(
    (sum, frame) => sum + frame.data.length + (frame.omittedBytes ?? 0),
    0,
  );
  return {
    tooLarge: frames.length > limits.maxFrames || totalBytes > limits.maxBytes,
    totalBytes,
  };
}

export function packetBatchCopyText(key: PacketBatchCopyKey, frames: readonly DataFrame[]): string {
  const asHex = key.endsWith('hex');
  return frames
    .map((frame) => {
      const data = asHex ? formatHex(frame.data) : formatUtf8(frame.data);
      return `[${formatTimestamp(frame.timestamp)}] ${frame.direction} | ${data}`;
    })
    .join('\n');
}
