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
  const frames = selectFrames(session.frames, mode, session.logAiFrameLimit);
  const lines = frames.map(formatLogFrame);
  const joined = lines.join('\n');
  const trimmed = trimStartToLimit(joined, charLimit);
  const truncated = frames.length < session.frames.length || trimmed.length < joined.length;

  return {
    text: trimmed,
    truncated,
    frameCount: frames.length,
    charLimit,
  };
}

function selectFrames(frames: DataFrame[], mode: LogAiContextMode, frameLimit: number): DataFrame[] {
  if (mode === 'latest-n-frames') {
    return frames.slice(-frameLimit);
  }
  return frames;
}

function formatLogFrame(frame: DataFrame): string {
  const text = sanitizeText(formatUtf8(frame.data));
  const hex = formatHex(frame.data);
  const payload = isReadable(text) ? `UTF8: ${text}` : `HEX: ${hex}`;
  return `[${formatTimestamp(frame.timestamp)}] ${frame.direction} ${payload}`;
}

function sanitizeText(text: string): string {
  return text.replace(/\0/g, '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function isReadable(text: string): boolean {
  if (!text.trim()) return false;
  const printable = [...text].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).length;
  return printable / text.length > 0.75;
}

function trimStartToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}
