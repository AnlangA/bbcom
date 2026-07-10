import type { DataFrame } from '../types';
import { ProtocolParser, type ParserConfig } from './protocol-parser';

export interface DisplayParsedFrame {
  data: Uint8Array;
  offset: number;
}

export interface ParserFrameCollectorResult {
  frames: DisplayParsedFrame[];
  throughputBps: number;
  reset: boolean;
}

export function parserConfigKey(config: ParserConfig): string {
  if (config.kind === 'fixed') return `fixed:${config.frameSize}`;
  if (config.kind === 'length') {
    return `length:${config.lengthOffset}:${config.lengthSize}:${config.bigEndian ? 1 : 0}:${config.lengthAdjust}`;
  }
  return `delimiter:${config.includeDelimiter ? 1 : 0}:${config.delimiter.join(',')}`;
}

/**
 * Incrementally turns RX session frames into parsed protocol frames. The class
 * is intentionally free of Vue state so the parser panel can keep UI concerns
 * separate from offset accounting, reset detection, and throughput tracking.
 */
export class ParserFrameCollector {
  private parser: ProtocolParser | null;
  private parsedFrames: DisplayParsedFrame[] = [];
  private consumedFrameCount = 0;
  private lastConfigKey = '';
  private windowStart = 0;
  private windowBytes = 0;
  private throughput = 0;

  constructor(initialConfig: ParserConfig) {
    this.parser = isEmptyDelimiter(initialConfig) ? null : new ProtocolParser(initialConfig);
  }

  sync(
    frames: readonly Pick<DataFrame, 'direction' | 'data'>[],
    config: ParserConfig,
    now = Date.now(),
  ): ParserFrameCollectorResult {
    const key = parserConfigKey(config);
    const configChanged = key !== this.lastConfigKey;
    const framesWereReset = frames.length < this.consumedFrameCount;
    this.lastConfigKey = key;

    if (isEmptyDelimiter(config)) {
      this.reset(null);
      return this.snapshot(true);
    }

    let reset = false;
    if (configChanged || framesWereReset) {
      this.reset(config);
      reset = true;
      this.ingest(frames, 0, now);
    } else if (frames.length > this.consumedFrameCount) {
      this.ingest(frames, this.consumedFrameCount, now);
    }

    return this.snapshot(reset);
  }

  private reset(config: ParserConfig | null): void {
    this.parser = config ? new ProtocolParser(config) : null;
    this.parsedFrames = [];
    this.consumedFrameCount = 0;
    this.windowStart = 0;
    this.windowBytes = 0;
    this.throughput = 0;
  }

  private ingest(
    frames: readonly Pick<DataFrame, 'direction' | 'data'>[],
    startIndex: number,
    now: number,
  ): void {
    if (!this.parser) return;
    for (let i = startIndex; i < frames.length; i += 1) {
      const frame = frames[i];
      if (frame.direction !== 'RX') continue;
      const parsed = this.parser.feed(frame.data);
      for (const parsedFrame of parsed) {
        this.parsedFrames.push({
          data: parsedFrame.data,
          offset: parsedFrame.offset,
        });
        this.windowBytes += parsedFrame.data.length;
      }
    }
    this.consumedFrameCount = frames.length;

    if (this.windowBytes > 0) {
      if (this.windowStart === 0) this.windowStart = now;
      const elapsed = (now - this.windowStart) / 1000;
      if (elapsed >= 0.5) {
        this.throughput = Math.round(this.windowBytes / elapsed);
        this.windowStart = now;
        this.windowBytes = 0;
      }
    } else {
      this.throughput = 0;
      this.windowStart = 0;
    }
  }

  private snapshot(reset: boolean): ParserFrameCollectorResult {
    return {
      frames: this.parsedFrames.slice(),
      throughputBps: this.throughput,
      reset,
    };
  }
}

function isEmptyDelimiter(config: ParserConfig): boolean {
  return config.kind === 'delimiter' && config.delimiter.length === 0;
}
