import { parserConfigKey, type DisplayParsedFrame } from '@/lib/parser-frame-collector';
import { ProtocolParser, type ParserConfig } from '@/lib/protocol-parser';
import type { DataFrame } from '@/types';

export interface SessionProtocolRuntimeSnapshot {
  /** Parsed RX frames accumulated by the resident session runtime. */
  frames: readonly DisplayParsedFrame[];
  /** Parsed frames evicted from the retained inspection window. */
  droppedFrames: number;
  /** Parsed payload bytes evicted from the retained inspection window. */
  droppedBytes: number;
  /** Bytes per second over the most recently completed half-second window. */
  throughputBps: number;
  /** Changes only when the parser stream is reset, never for normal RX. */
  resetVersion: number;
}

export interface SessionProtocolRuntimeLimits {
  maxFrames?: number;
  maxBytes?: number;
}

export const DEFAULT_SESSION_PROTOCOL_MAX_FRAMES = 5_000;
export const DEFAULT_SESSION_PROTOCOL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Resident, raw-byte protocol data plane for one serial session.
 *
 * This intentionally accepts native serial chunks rather than `DataFrame`s.
 * Frames are a UI/capture representation that may be published late (or not
 * at all while a document is hidden); protocol reassembly must instead happen
 * at the raw RX boundary owned by the long-lived SessionRuntime.
 */
export class SessionProtocolRuntime {
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private parser: ProtocolParser | null = null;
  private configKey: string | null = null;
  private parsedFrames: DisplayParsedFrame[] = [];
  /** Oldest live entry; the dead prefix is compacted in batches. */
  private parsedFrameHead = 0;
  private retainedBytes = 0;
  private droppedFrames = 0;
  private droppedBytes = 0;
  private windowStartedAt: number | null = null;
  private windowBytes = 0;
  private throughputBps = 0;
  private resetVersion = 0;

  constructor(limits: SessionProtocolRuntimeLimits = {}) {
    this.maxFrames = positiveLimit(
      'maxFrames',
      limits.maxFrames,
      DEFAULT_SESSION_PROTOCOL_MAX_FRAMES,
    );
    this.maxBytes = positiveLimit('maxBytes', limits.maxBytes, DEFAULT_SESSION_PROTOCOL_MAX_BYTES);
  }

  /**
   * Replace the parser configuration and optionally rebuild the display from
   * retained capture history. The history path exists only to preserve the
   * user's explicit "change settings and inspect captured data" workflow;
   * normal live parsing never waits for frames to be captured or rendered.
   */
  configure(
    config: ParserConfig,
    capturedHistory?: Iterable<Pick<DataFrame, 'direction' | 'data'>>,
  ): boolean {
    const nextKey = parserConfigKey(config);
    if (nextKey === this.configKey) return false;

    this.configKey = nextKey;
    this.parser = isEmptyDelimiter(config) ? null : new ProtocolParser(config);
    this.resetState();
    if (this.parser && capturedHistory) {
      for (const frame of capturedHistory) {
        if (frame.direction !== 'RX') continue;
        this.appendParsed(this.parser.feed(frame.data));
      }
    }
    return true;
  }

  /**
   * Consume one native RX chunk synchronously. Returns true only when the
   * presentation snapshot changed and a throttled UI publication is useful.
   */
  feed(bytes: Uint8Array, now = Date.now()): boolean {
    if (!this.parser || bytes.length === 0) return false;

    const parsed = this.parser.feed(bytes);
    this.appendParsed(parsed);
    this.windowBytes += bytes.length;

    if (this.windowStartedAt === null) this.windowStartedAt = now;
    const elapsedSeconds = (now - this.windowStartedAt) / 1000;
    if (elapsedSeconds >= 0.5) {
      this.throughputBps = Math.round(this.windowBytes / elapsedSeconds);
      this.windowStartedAt = now;
      this.windowBytes = 0;
      return true;
    }
    return parsed.length > 0;
  }

  /** Reset the current raw stream after terminal data is explicitly cleared. */
  clear(): void {
    this.parser?.reset();
    this.resetState();
  }

  snapshot(): SessionProtocolRuntimeSnapshot {
    return {
      // The receiver is allowed to retain the snapshot until the next UI
      // publish. Do not expose the mutable collector array itself.
      frames: this.parsedFrames.slice(this.parsedFrameHead),
      droppedFrames: this.droppedFrames,
      droppedBytes: this.droppedBytes,
      throughputBps: this.throughputBps,
      resetVersion: this.resetVersion,
    };
  }

  private resetState(): void {
    this.parsedFrames = [];
    this.parsedFrameHead = 0;
    this.retainedBytes = 0;
    this.droppedFrames = 0;
    this.droppedBytes = 0;
    this.windowStartedAt = null;
    this.windowBytes = 0;
    this.throughputBps = 0;
    this.resetVersion += 1;
  }

  private appendParsed(parsed: ReturnType<ProtocolParser['feed']>): void {
    for (const frame of parsed) {
      this.pushParsedFrame({ data: frame.data, offset: frame.offset });
    }
  }

  private pushParsedFrame(frame: DisplayParsedFrame): void {
    this.parsedFrames.push(frame);
    this.retainedBytes += frame.data.byteLength;

    while (
      this.parsedFrames.length - this.parsedFrameHead > this.maxFrames ||
      this.retainedBytes > this.maxBytes
    ) {
      const dropped = this.parsedFrames[this.parsedFrameHead];
      // Release the payload immediately; compaction of the sparse prefix is
      // deliberately batched so steady-state overflow remains amortized O(1).
      this.parsedFrames[this.parsedFrameHead] = undefined as unknown as DisplayParsedFrame;
      this.parsedFrameHead += 1;
      this.retainedBytes -= dropped.data.byteLength;
      this.droppedFrames += 1;
      this.droppedBytes += dropped.data.byteLength;
    }

    if (this.parsedFrameHead > 0 && this.parsedFrameHead >= this.parsedFrames.length / 2) {
      this.parsedFrames = this.parsedFrames.slice(this.parsedFrameHead);
      this.parsedFrameHead = 0;
    }
  }
}

function isEmptyDelimiter(config: ParserConfig): boolean {
  return config.kind === 'delimiter' && config.delimiter.length === 0;
}

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(resolved);
}
