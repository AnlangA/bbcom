import type {
  SerialShellConfig,
  SerialShellLine,
  SerialShellSnapshot,
} from '../../types/serial-shell';
import { cloneSerialShellConfig, DEFAULT_SERIAL_SHELL_CONFIG } from './config';
import { SerialShellDecoder } from './encoding';
import { SerialShellRxMapper } from './newline';

export const SERIAL_SHELL_MAX_LINES = 8_000;
export const SERIAL_SHELL_MAX_BYTES = 1 * 1024 * 1024;

export interface SerialShellEngineLimits {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

class CurrentLine {
  text = '';
  cursor = 0;

  write(char: string): void {
    const chars = Array.from(this.text);
    if (this.cursor < chars.length) chars[this.cursor] = char;
    else chars.push(char);
    this.cursor += 1;
    this.text = chars.join('');
  }

  append(text: string): void {
    this.text += text;
    this.cursor = Array.from(this.text).length;
  }

  cr(): void {
    this.cursor = 0;
  }

  backspace(): void {
    if (this.cursor <= 0) return;
    const chars = Array.from(this.text);
    chars.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    this.text = chars.join('');
  }

  clear(): void {
    this.text = '';
    this.cursor = 0;
  }

  snapshot(id: number, timestamp: number): SerialShellLine {
    return { id, text: this.text, timestamp };
  }
}

/**
 * Dumb-terminal display engine: CR overwrite, backspace, CRLF, SGR passthrough,
 * and CSI 2J clear. Encoding and newline mapping happen before this layer.
 */
export class SerialShellEngine {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private config: SerialShellConfig;
  private readonly decoder: SerialShellDecoder;
  private readonly rxMapper: SerialShellRxMapper;
  private escape = '';
  private lines: SerialShellLine[] = [];
  private lineHead = 0;
  private retainedBytes = 0;
  private droppedLines = 0;
  private droppedBytes = 0;
  private resetVersion = 0;
  private nextId = 1;
  private readonly current = new CurrentLine();
  private currentStartedAt = 0;
  private currentId = 1;

  constructor(config?: Partial<SerialShellConfig>, limits: SerialShellEngineLimits = {}) {
    this.maxLines = positiveLimit('maxLines', limits.maxLines, SERIAL_SHELL_MAX_LINES);
    this.maxBytes = positiveLimit('maxBytes', limits.maxBytes, SERIAL_SHELL_MAX_BYTES);
    this.config = cloneSerialShellConfig({
      ...DEFAULT_SERIAL_SHELL_CONFIG,
      ...config,
    });
    this.decoder = new SerialShellDecoder(this.config.encoding);
    this.rxMapper = new SerialShellRxMapper(this.config.rxNewline);
    this.currentId = this.nextId;
    this.nextId += 1;
  }

  configure(config: SerialShellConfig): void {
    const next = cloneSerialShellConfig(config);
    if (next.encoding !== this.config.encoding) {
      this.decoder.setEncoding(next.encoding);
    }
    if (next.rxNewline !== this.config.rxNewline) {
      this.rxMapper.setMode(next.rxNewline);
    }
    this.config = next;
  }

  feedRx(bytes: Uint8Array, now = Date.now()): boolean {
    if (bytes.length === 0) return false;
    const decoded = this.decoder.push(bytes);
    if (decoded.length === 0) return false;
    return this.consumeMapped(this.rxMapper.push(decoded), now);
  }

  feedEcho(text: string, now = Date.now()): boolean {
    if (text.length === 0) return false;
    return this.consumeMapped(text, now);
  }

  clear(): void {
    this.decoder.reset();
    this.rxMapper.reset();
    this.escape = '';
    this.lines = [];
    this.lineHead = 0;
    this.retainedBytes = 0;
    this.droppedLines = 0;
    this.droppedBytes = 0;
    this.current.clear();
    this.currentStartedAt = 0;
    this.resetVersion += 1;
    this.currentId = this.nextId;
    this.nextId += 1;
  }

  snapshot(): SerialShellSnapshot {
    return {
      lines: this.lines.slice(this.lineHead),
      current: this.current.snapshot(this.currentId, this.currentStartedAt),
      droppedLines: this.droppedLines,
      droppedBytes: this.droppedBytes,
      resetVersion: this.resetVersion,
    };
  }

  private consumeMapped(text: string, now: number): boolean {
    if (text.length === 0) return false;
    let changed = false;
    const source = this.escape + text;
    this.escape = '';
    let index = 0;
    while (index < source.length) {
      const char = source[index];
      if (this.escape.length > 0 || char === '\u001b') {
        const consumed = this.consumeEscape(source, index, now);
        if (consumed === 0) {
          this.escape = source.slice(index);
          break;
        }
        index += consumed;
        changed = true;
        continue;
      }
      this.ensureCurrentTimestamp(now);
      if (char === '\n') {
        this.commitCurrent(now);
        changed = true;
        index += 1;
        continue;
      }
      if (char === '\r') {
        this.current.cr();
        changed = true;
        index += 1;
        continue;
      }
      if (char === '\b' || char === '\u007f') {
        this.current.backspace();
        changed = true;
        index += 1;
        continue;
      }
      this.current.write(char);
      changed = true;
      index += 1;
    }
    return changed;
  }

  private consumeEscape(source: string, start: number, now: number): number {
    if (source[start] !== '\u001b') return 0;
    if (start + 1 >= source.length) return 0;
    if (source[start + 1] !== '[') {
      this.ensureCurrentTimestamp(now);
      this.current.append(source.slice(start, start + 2));
      return 2;
    }
    const sequence = source.slice(start);
    const end = findCsiFinal(sequence);
    if (end < 0) return 0;
    const finalChar = sequence[end];
    const params = sequence.slice(2, end);
    if (finalChar === 'J' && (params === '2' || params === '3')) {
      this.clearScreen(now);
    } else if (finalChar === 'm') {
      this.ensureCurrentTimestamp(now);
      this.current.append(sequence.slice(0, end + 1));
    }
    return end + 1;
  }

  private clearScreen(now: number): void {
    this.dropAllLines();
    this.current.clear();
    this.currentStartedAt = now;
    this.currentId = this.nextId;
    this.nextId += 1;
  }

  private commitCurrent(now: number): void {
    const line = this.current.snapshot(this.currentId, this.currentStartedAt || now);
    this.lines.push(line);
    this.retainedBytes += utf8Length(line.text);
    this.current.clear();
    this.currentStartedAt = 0;
    this.currentId = this.nextId;
    this.nextId += 1;
    this.evict();
  }

  private dropAllLines(): void {
    for (let index = this.lineHead; index < this.lines.length; index += 1) {
      const line = this.lines[index];
      this.droppedLines += 1;
      this.droppedBytes += utf8Length(line.text);
    }
    this.lines = [];
    this.lineHead = 0;
    this.retainedBytes = 0;
  }

  private evict(): void {
    while (
      this.lines.length - this.lineHead > this.maxLines ||
      this.retainedBytes > this.maxBytes
    ) {
      const dropped = this.lines[this.lineHead];
      this.lineHead += 1;
      this.droppedLines += 1;
      const size = utf8Length(dropped.text);
      this.retainedBytes -= size;
      this.droppedBytes += size;
    }
    if (this.lineHead > 256 && this.lineHead * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.lineHead);
      this.lineHead = 0;
    }
  }

  private ensureCurrentTimestamp(now: number): void {
    if (this.currentStartedAt === 0) this.currentStartedAt = now;
  }
}

function findCsiFinal(sequence: string): number {
  for (let index = 2; index < sequence.length; index += 1) {
    const code = sequence.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
    if ((code < 0x30 || code > 0x3f) && code !== 0x3b && (code < 0x20 || code > 0x2f)) {
      return index;
    }
  }
  return -1;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`serial shell ${name} must be a positive integer`);
  }
  return value;
}
