import {
  EMPTY_CAPTURE_DISPLAY_CURSOR,
  planCaptureDisplayIngest,
  type CaptureDisplayCursor,
} from '@/lib/capture-stream';
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
 * Resident protocol display plane for one serial session.
 *
 * Live presentation is a projection of the session capture buffer. `feed()`
 * remains available for engine tests and explicit history rebuilds; the
 * session runtime drives `ingestCapturedFrames()` so parser, terminal, and
 * other views share one TX/RX source. Triggers and Modbus stay on raw bytes.
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
  private captureCursor: CaptureDisplayCursor = EMPTY_CAPTURE_DISPLAY_CURSOR;

  constructor(limits: SessionProtocolRuntimeLimits = {}) {
    this.maxFrames = positiveLimit(
      'maxFrames',
      limits.maxFrames,
      DEFAULT_SESSION_PROTOCOL_MAX_FRAMES,
    );
    this.maxBytes = positiveLimit('maxBytes', limits.maxBytes, DEFAULT_SESSION_PROTOCOL_MAX_BYTES);
  }

  /**
   * Replace the parser configuration and optionally rebuild from an explicit
   * capture history. The session runtime instead calls `ingestCapturedFrames()`
   * after configure so live display stays aligned with the capture buffer.
   */
  configure(
    config: ParserConfig,
    capturedHistory?: Iterable<Pick<DataFrame, 'direction' | 'data'>>,
  ): boolean {
    const nextKey = parserConfigKey(config);
    if (nextKey === this.configKey) return false;

    this.configKey = nextKey;
    this.parser = isEmptyDelimiter(config) ? null : new ProtocolParser(config);
    this.captureCursor = EMPTY_CAPTURE_DISPLAY_CURSOR;
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
    const throughputChanged = this.noteBytes(bytes.length, now);
    return throughputChanged || parsed.length > 0;
  }

  /**
   * Project live capture frames into the parser display. TX rows are ignored;
   * a reset rebuilds from the current window after clear/trim/replace.
   */
  ingestCapturedFrames(
    frames: readonly Pick<DataFrame, 'id' | 'direction' | 'data'>[],
    now = Date.now(),
  ): boolean {
    const plan = planCaptureDisplayIngest(frames, this.captureCursor);
    this.captureCursor = plan.nextCursor;
    let changed = false;
    if (plan.reset) {
      this.parser?.reset();
      this.resetState();
      changed = true;
    }
    if (!this.parser) return changed;

    let ingestedBytes = 0;
    for (let index = plan.startIndex; index < frames.length; index += 1) {
      const frame = frames[index];
      if (!frame || frame.direction !== 'RX' || frame.data.length === 0) continue;
      const parsed = this.parser.feed(frame.data);
      this.appendParsed(parsed);
      ingestedBytes += frame.data.length;
      if (parsed.length > 0) changed = true;
    }
    if (ingestedBytes > 0 && this.noteBytes(ingestedBytes, now)) changed = true;
    return changed;
  }

  /** Reset the current display stream after terminal data is explicitly cleared. */
  clear(): void {
    this.parser?.reset();
    this.captureCursor = EMPTY_CAPTURE_DISPLAY_CURSOR;
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

  private noteBytes(byteLength: number, now: number): boolean {
    this.windowBytes += byteLength;
    if (this.windowStartedAt === null) this.windowStartedAt = now;
    const elapsedSeconds = (now - this.windowStartedAt) / 1000;
    if (elapsedSeconds >= 0.5) {
      this.throughputBps = Math.round(this.windowBytes / elapsedSeconds);
      this.windowStartedAt = now;
      this.windowBytes = 0;
      return true;
    }
    return false;
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
