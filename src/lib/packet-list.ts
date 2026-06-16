import type { CSSProperties } from 'vue';
import type { DataFrame, DisplayMode, HighlightRule, PacketViewMode } from '../types';
import { formatAscii, formatHex, formatTimestamp, formatUtf8 } from './format';
import { findFrameHighlight, type HighlightSearchAccessors } from './highlights';

export const PACKET_COPY_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxFrames: 5000,
} as const;

export type PacketContextCopyKey = 'hex' | 'ascii' | 'utf8' | 'plain' | 'row';
export type PacketBatchCopyKey = 'filtered-hex' | 'filtered-text' | 'all-hex' | 'all-text';

export interface PacketVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface PacketRowData {
  key: string;
  start: number;
  size: number;
  style: CSSProperties & {
    position: 'absolute';
    top: string;
    left: string;
    width: string;
    height: string;
    transform: string;
  };
  frame: DataFrame;
  formatted: string;
  timestamp: string;
  showTimestamp: boolean;
  columns: string;
  displayLabel: string;
  useHtml: boolean;
  highlightClass: string | null;
  highlightLabel: string | null;
}

export interface PacketRowBuildOptions extends HighlightSearchAccessors {
  virtualItems: readonly PacketVirtualItem[];
  frames: readonly DataFrame[];
  showTimestamp: boolean;
  columns: string;
  displayLabel: string;
  useHtml: boolean;
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
  return displayMode !== 'HEX' && ansiColorEnabled;
}

export function buildPacketRows({
  virtualItems,
  frames,
  showTimestamp,
  columns,
  displayLabel,
  useHtml,
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
      start: item.start,
      size: item.size,
      style: {
        position: 'absolute',
        top: '0px',
        left: '0px',
        width: '100%',
        height: `${item.size}px`,
        transform: `translateY(${item.start}px)`,
      },
      frame,
      formatted: formatFrame(frame),
      timestamp: formatTimestamp(frame.timestamp),
      showTimestamp,
      columns,
      displayLabel,
      useHtml,
      highlightClass: highlight ? `highlight-${highlight.color}` : null,
      highlightLabel: highlight?.name ?? null,
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
  const totalBytes = frames.reduce((sum, frame) => sum + frame.data.length, 0);
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
