import type { DataFrame, LogAiContextMode, SerialSession } from '../types';
import { formatHex, formatTimestamp, formatUtf8 } from './format';

const LATEST_CHAR_LIMIT = 10_000;
const FULL_CHAR_LIMIT = 50_000;

export interface LogAiContextResult {
  text: string;
  truncated: boolean;
  frameCount: number;
  charLimit: number;
}

export function buildLogAiContext(session: SerialSession): LogAiContextResult {
  const mode = session.logAiContextMode;
  const charLimit = mode === 'full-capped' ? FULL_CHAR_LIMIT : LATEST_CHAR_LIMIT;
  const frameStart = selectedFrameStart(session.frames.length, mode, session.logAiFrameLimit);
  const frameCount = session.frames.length - frameStart;
  const linesFromEnd: string[] = [];
  let joinedLength = 0;
  let frameIndex = session.frames.length - 1;

  // The context always keeps the newest characters. Walk backwards so older
  // frames are never decoded/formatted once the character budget is covered.
  // Lines are reversed once at the end to restore chronological output order.
  for (; frameIndex >= frameStart; frameIndex -= 1) {
    const line = formatLogFrame(session.frames[frameIndex]);
    joinedLength += line.length + (linesFromEnd.length > 0 ? 1 : 0);
    linesFromEnd.push(line);
    if (joinedLength >= charLimit) {
      frameIndex -= 1;
      break;
    }
  }

  const joined = linesFromEnd.reverse().join('\n');
  const trimmed = trimStartToLimit(joined, charLimit);
  const selectionTruncated = frameStart > 0;
  const budgetTruncated = frameIndex >= frameStart || trimmed.length < joined.length;

  return {
    text: trimmed,
    truncated: selectionTruncated || budgetTruncated,
    frameCount,
    charLimit,
  };
}

function selectedFrameStart(
  frameCount: number,
  mode: LogAiContextMode,
  frameLimit: number,
): number {
  if (mode !== 'latest-n-frames') return 0;
  if (frameLimit <= 0) return frameCount;
  // Match Array#slice coercion used by the previous implementation for the
  // defensive NaN/Infinity/fractional cases, while avoiding a tail allocation.
  if (!Number.isFinite(frameLimit)) return 0;
  const normalizedLimit = Math.trunc(frameLimit);
  if (normalizedLimit === 0) return 0;
  return Math.max(0, frameCount - normalizedLimit);
}

function formatLogFrame(frame: DataFrame): string {
  const text = sanitizeText(formatUtf8(frame.data));
  // HEX formatting is substantially more expensive for binary payloads. Only
  // produce it when the UTF-8 readability check says it will actually be used.
  const payload = isReadable(text) ? `UTF8: ${text}` : `HEX: ${formatHex(frame.data)}`;
  return `[${formatTimestamp(frame.timestamp)}] ${frame.direction} ${payload}`;
}

function sanitizeText(text: string): string {
  return text.replace(/\0/g, '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function isReadable(text: string): boolean {
  if (text.length === 0 || !text.trim()) return false;
  let printable = 0;
  let total = 0;
  // Iterate by code point (for..of) without materializing an array.
  for (const ch of text) {
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printable += 1;
    }
  }
  return total > 0 && printable / total > 0.75;
}

function trimStartToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}
