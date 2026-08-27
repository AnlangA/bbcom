import {
  byteAscii,
  DEFAULT_SMP_PARSER_CONFIG,
  frameMatchesText,
  parseDelimiterHex,
  type ParserConfig,
  type ParserKind,
} from './protocol-parser';

export type DelimiterParserConfig = Extract<ParserConfig, { kind: 'delimiter' }>;
export type FixedParserConfig = Extract<ParserConfig, { kind: 'fixed' }>;
export type LengthParserConfig = Extract<ParserConfig, { kind: 'length' }>;
export type SmpParserConfig = Extract<ParserConfig, { kind: 'mcumgr-smp' }>;

export type ProtocolRecordStatus = 'ok' | 'warning' | 'error' | 'pending';
export type ProtocolRecordDirectionFilter = 'all' | 'TX' | 'RX';
export type ProtocolRecordStatusFilter = 'all' | ProtocolRecordStatus;
export type ProtocolRecordTransactionFilter = 'all' | 'request' | 'response' | 'unmatched';

/** Structural UI contract shared by legacy frames and richer SMP records. */
export interface SearchableProtocolRecord {
  data: Uint8Array;
  offset: number;
  kind?: string;
  parserKind?: 'delimiter' | 'fixed' | 'length';
  id?: string;
  direction?: 'TX' | 'RX';
  timestamp?: number;
  captureSeq?: number;
  status?: ProtocolRecordStatus;
  summary?: string;
  header?: {
    op?: number | string;
    opName?: string;
    opNameZh?: string;
    requestResponse?: string;
    group?: number;
    groupName?: string;
    groupNameZh?: string;
    command?: number;
    commandName?: string;
    commandNameZh?: string;
    sequence?: number;
  };
  cbor?: unknown;
  requestId?: string;
  responseId?: string;
  diagnostics?: readonly unknown[];
}

export interface ProtocolRecordFilters {
  searchTerm: string;
  direction: ProtocolRecordDirectionFilter;
  status: ProtocolRecordStatusFilter;
  transaction: ProtocolRecordTransactionFilter;
  group: string;
  command: string;
  sequence: string;
}

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
  switch (kind) {
    case 'delimiter':
      return {
        ...DEFAULT_DELIMITER_CONFIG,
        delimiter: [...DEFAULT_DELIMITER_CONFIG.delimiter],
      };
    case 'fixed':
      return { ...DEFAULT_FIXED_CONFIG };
    case 'length':
      return { ...DEFAULT_LENGTH_CONFIG };
    case 'mcumgr-smp':
      return { ...DEFAULT_SMP_PARSER_CONFIG };
  }
  return assertNever(kind);
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

export function smpConfig(config: ParserConfig): SmpParserConfig {
  return config.kind === 'mcumgr-smp'
    ? config
    : (defaultParserConfig('mcumgr-smp') as SmpParserConfig);
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

export type StrictDelimiterHexResult =
  { ok: true; bytes: number[] } | { ok: false; reason: 'empty' | 'syntax' | 'too-long' };

/**
 * Parse editor input without silently dropping invalid characters or a trailing
 * half-byte. Spaces between byte pairs are optional, but every non-space
 * character must be a hexadecimal nibble and the delimiter is capped at the
 * protocol parser's 256-byte limit.
 */
export function parseStrictDelimiterHex(value: string): StrictDelimiterHexResult {
  const compact = value.replace(/\s/g, '');
  if (compact.length === 0) return { ok: false, reason: 'empty' };
  if (!/^[0-9a-fA-F]+$/.test(compact) || compact.length % 2 !== 0) {
    return { ok: false, reason: 'syntax' };
  }
  if (compact.length > 512) return { ok: false, reason: 'too-long' };

  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
  }
  return { ok: true, bytes };
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

export function protocolRecordDirection(record: SearchableProtocolRecord): 'TX' | 'RX' {
  return record.direction === 'TX' ? 'TX' : 'RX';
}

export function protocolRecordStatus(record: SearchableProtocolRecord): ProtocolRecordStatus {
  return record.status ?? 'ok';
}

export function protocolRecordTransaction(
  record: SearchableProtocolRecord,
): Exclude<ProtocolRecordTransactionFilter, 'all'> | 'none' {
  if (record.kind !== 'smp') return 'none';
  const header = record.header;
  const normalized = `${header?.requestResponse ?? ''} ${header?.opName ?? ''}`.toLowerCase();
  const op = typeof header?.op === 'number' ? header.op : Number.NaN;
  const response = op === 1 || op === 3 || normalized.includes('response');
  const request = op === 0 || op === 2 || normalized.includes('request');
  if (response && !record.requestId) return 'unmatched';
  if (response) return 'response';
  if (request) return 'request';
  return 'none';
}

/**
 * Combined protocol-record filter used by the virtual list. Search covers
 * decoded text, HEX, SMP header labels/values, diagnostics, and a bounded CBOR
 * traversal so malformed or very large values cannot monopolize the UI thread.
 */
export function filterProtocolRecords<T extends SearchableProtocolRecord>(
  records: readonly T[],
  filters: ProtocolRecordFilters,
): readonly T[] {
  const search = filters.searchTerm.trim().toLowerCase();
  const group = filters.group.trim().toLowerCase();
  const command = filters.command.trim().toLowerCase();
  const sequence = filters.sequence.trim();

  return records.filter((record) => {
    if (filters.direction !== 'all' && protocolRecordDirection(record) !== filters.direction) {
      return false;
    }
    if (filters.status !== 'all' && protocolRecordStatus(record) !== filters.status) return false;
    if (
      filters.transaction !== 'all' &&
      protocolRecordTransaction(record) !== filters.transaction
    ) {
      return false;
    }

    const header = record.header;
    if (group) {
      const value =
        `${header?.group ?? ''} ${header?.groupName ?? ''} ${header?.groupNameZh ?? ''}`.toLowerCase();
      if (!value.includes(group)) return false;
    }
    if (command) {
      const value =
        `${header?.command ?? ''} ${header?.commandName ?? ''} ${header?.commandNameZh ?? ''}`.toLowerCase();
      if (!value.includes(command)) return false;
    }
    if (sequence && String(header?.sequence ?? '') !== sequence) return false;
    if (!search) return true;

    return protocolRecordMatchesSearch(record, search);
  });
}

export function protocolRecordSearchText(record: SearchableProtocolRecord): string {
  // This helper is intended for labels/previews. Keep its allocation bounded;
  // the actual search path below still scans every byte in fixed-size chunks.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
    record.data.subarray(0, MAX_SEARCH_CHUNK_BYTES),
  );
  const hex = Array.from(record.data.subarray(0, 256), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join(' ');
  const values = [decoded, hex];
  if (record.kind === 'smp') values.push(protocolRecordMetadataSearchText(record));
  return values
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase();
}

function protocolRecordMatchesSearch(record: SearchableProtocolRecord, search: string): boolean {
  if (record.kind === 'smp' && protocolRecordMetadataSearchText(record).includes(search)) {
    return true;
  }

  const compactHex = search.replace(/\s/g, '');
  if (compactHex.length >= 2 && compactHex.length % 2 === 0 && /^[0-9a-f]+$/.test(compactHex)) {
    const needle = new Uint8Array(compactHex.length / 2);
    for (let index = 0; index < compactHex.length; index += 2) {
      needle[index / 2] = Number.parseInt(compactHex.slice(index, index + 2), 16);
    }
    if (byteSequenceIncludes(record.data, needle)) return true;
  }

  return decodedBytesIncludeText(record.data, search);
}

function protocolRecordMetadataSearchText(record: SearchableProtocolRecord): string {
  const header = record.header;
  return [
    record.summary,
    record.direction,
    record.status,
    header?.op,
    header?.opName,
    header?.opNameZh,
    header?.requestResponse,
    header?.group,
    header?.groupName,
    header?.groupNameZh,
    header?.command,
    header?.commandName,
    header?.commandNameZh,
    header?.sequence,
    boundedValueText(record.diagnostics, 128, 4096),
    boundedValueText(record.cbor, 512, 16_384),
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase();
}

const MAX_SEARCH_CHUNK_BYTES = 64 * 1024;

function decodedBytesIncludeText(data: Uint8Array, search: string): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  // Retain enough decoded text to catch a match spanning two chunks without
  // ever constructing a string proportional to a 1 MiB packet.
  let overlap = '';
  const overlapLength = Math.max(0, search.length - 1);
  for (let offset = 0; offset < data.length; offset += MAX_SEARCH_CHUNK_BYTES) {
    const end = Math.min(data.length, offset + MAX_SEARCH_CHUNK_BYTES);
    const decoded = decoder.decode(data.subarray(offset, end), { stream: end < data.length });
    const candidate = `${overlap}${decoded}`.toLowerCase();
    if (candidate.includes(search)) return true;
    overlap = overlapLength === 0 ? '' : candidate.slice(-overlapLength);
  }
  return false;
}

function byteSequenceIncludes(data: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  if (needle.length > data.length) return false;
  const prefix = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = prefix[matched - 1];
    if (needle[index] === needle[matched]) matched += 1;
    prefix[index] = matched;
  }
  for (let index = 0, matched = 0; index < data.length; index += 1) {
    while (matched > 0 && data[index] !== needle[matched]) matched = prefix[matched - 1];
    if (data[index] === needle[matched]) matched += 1;
    if (matched === needle.length) return true;
  }
  return false;
}

function boundedValueText(value: unknown, maxNodes: number, maxCharacters: number): string {
  if (value === undefined || value === null) return '';
  const parts: string[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  let nodes = 0;
  let characters = 0;

  while (stack.length > 0 && nodes < maxNodes && characters < maxCharacters) {
    const current = stack.pop();
    nodes += 1;
    if (current === undefined || current === null) continue;

    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      if (current instanceof Uint8Array) {
        const preview = Array.from(current.subarray(0, 64), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(' ');
        parts.push(preview);
        characters += preview.length;
        continue;
      }
      if (current instanceof Map) {
        const entries = Array.from(current.entries()).slice(0, 128);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          stack.push(entries[index][1], entries[index][0]);
        }
        continue;
      }
      const entries = Array.isArray(current)
        ? current.slice(0, 128).map((entry, index) => [String(index), entry] as const)
        : Object.entries(current as Record<string, unknown>).slice(0, 128);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        stack.push(entries[index][1], entries[index][0]);
      }
      continue;
    }

    const text = typeof current === 'bigint' ? current.toString(10) : String(current);
    const remaining = Math.max(0, maxCharacters - characters);
    const bounded = text.slice(0, remaining);
    parts.push(bounded);
    characters += bounded.length;
  }

  return parts.join(' ');
}

function assertNever(value: never): never {
  throw new RangeError(`unsupported parser kind: ${String(value)}`);
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
