import {
  byteAscii,
  frameMatchesText,
  parseDelimiterHex,
  type ParserConfig,
  type ParserKind,
} from './protocol-parser';

export type DelimiterParserConfig = Extract<ParserConfig, { kind: 'delimiter' }>;
export type FixedParserConfig = Extract<ParserConfig, { kind: 'fixed' }>;
export type LengthParserConfig = Extract<ParserConfig, { kind: 'length' }>;

export const MAX_RENDERED_PARSED_FRAMES = 500;

export const DEFAULT_DELIMITER_CONFIG: DelimiterParserConfig = {
  kind: 'delimiter',
  delimiter: [0x0d, 0x0a],
  includeDelimiter: false,
};

export const DEFAULT_FIXED_CONFIG: FixedParserConfig = { kind: 'fixed', frameSize: 8 };

export const DEFAULT_LENGTH_CONFIG: LengthParserConfig = {
  kind: 'length',
  lengthOffset: 0,
  lengthSize: 1,
  bigEndian: true,
  lengthAdjust: 1,
};

export function defaultParserConfig(kind: ParserKind): ParserConfig {
  if (kind === 'fixed') return { ...DEFAULT_FIXED_CONFIG };
  if (kind === 'length') return { ...DEFAULT_LENGTH_CONFIG };
  return {
    ...DEFAULT_DELIMITER_CONFIG,
    delimiter: [...DEFAULT_DELIMITER_CONFIG.delimiter],
  };
}

export function configForKind(config: ParserConfig, kind: ParserKind): ParserConfig {
  return config.kind === kind ? config : defaultParserConfig(kind);
}

export function delimiterConfig(config: ParserConfig): DelimiterParserConfig {
  return config.kind === 'delimiter'
    ? config
    : (defaultParserConfig('delimiter') as DelimiterParserConfig);
}

export function fixedConfig(config: ParserConfig): FixedParserConfig {
  return config.kind === 'fixed' ? config : (defaultParserConfig('fixed') as FixedParserConfig);
}

export function lengthConfig(config: ParserConfig): LengthParserConfig {
  return config.kind === 'length' ? config : (defaultParserConfig('length') as LengthParserConfig);
}

export function formatDelimiterHex(delimiter: readonly number[]): string {
  return delimiter.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function delimiterConfigFromHex(config: ParserConfig, value: string): DelimiterParserConfig {
  return {
    ...delimiterConfig(config),
    delimiter: parseDelimiterHex(value),
  };
}

export function positiveInteger(value: number | null, fallback = 1): number {
  return Math.max(1, Math.floor(value || fallback));
}

export function nonNegativeInteger(value: number | null, fallback = 0): number {
  return Math.max(0, Math.floor(value || fallback));
}

export function filterParsedFrames<T extends { data: Uint8Array }>(
  frames: readonly T[],
  searchTerm: string,
): readonly T[] {
  const term = searchTerm.trim();
  if (term.length === 0) return frames;
  return frames.filter((frame) => frameMatchesText(frame.data, term));
}

export function renderedParsedFrameWindow<T>(
  frames: readonly T[],
  maxRendered = MAX_RENDERED_PARSED_FRAMES,
): { startIndex: number; frames: readonly T[] } {
  const startIndex = Math.max(0, frames.length - maxRendered);
  return {
    startIndex,
    frames: frames.length <= maxRendered ? frames : frames.slice(startIndex),
  };
}

export function parsedFrameStats(frames: readonly { data: Uint8Array }[]): {
  totalBytes: number;
  largestFrame: number;
} {
  return frames.reduce(
    (stats, frame) => ({
      totalBytes: stats.totalBytes + frame.data.length,
      largestFrame: Math.max(stats.largestFrame, frame.data.length),
    }),
    { totalBytes: 0, largestFrame: 0 },
  );
}

export function truncateHexPreview(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\u2026`;
}

export function frameAsciiText(frame: { data: Uint8Array }): string {
  return Array.from(frame.data, byteAscii).join('');
}
