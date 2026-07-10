import { parserConfigKey, type DisplayParsedFrame } from '../../../lib/parser-frame-collector';
import { ProtocolParser, type ParserConfig } from '../../../lib/protocol-parser';
import type { DataFrame } from '../../../types';

export interface SessionProtocolRuntimeSnapshot {
  /** Parsed RX frames accumulated by the resident session runtime. */
  frames: readonly DisplayParsedFrame[];
  /** Bytes per second over the most recently completed half-second window. */
  throughputBps: number;
  /** Changes only when the parser stream is reset, never for normal RX. */
  resetVersion: number;
}

/**
 * Resident, raw-byte protocol data plane for one serial session.
 *
 * This intentionally accepts native serial chunks rather than `DataFrame`s.
 * Frames are a UI/capture representation that may be published late (or not
 * at all while a document is hidden); protocol reassembly must instead happen
 * at the raw RX boundary owned by the long-lived SessionRuntime.
 */
export class SessionProtocolRuntime {
  private parser: ProtocolParser | null = null;
  private configKey: string | null = null;
  private parsedFrames: DisplayParsedFrame[] = [];
  private windowStartedAt: number | null = null;
  private windowBytes = 0;
  private throughputBps = 0;
  private resetVersion = 0;

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
      frames: this.parsedFrames.slice(),
      throughputBps: this.throughputBps,
      resetVersion: this.resetVersion,
    };
  }

  private resetState(): void {
    this.parsedFrames = [];
    this.windowStartedAt = null;
    this.windowBytes = 0;
    this.throughputBps = 0;
    this.resetVersion += 1;
  }

  private appendParsed(parsed: ReturnType<ProtocolParser['feed']>): void {
    for (const frame of parsed) {
      this.parsedFrames.push({ data: frame.data, offset: frame.offset });
    }
  }
}

function isEmptyDelimiter(config: ParserConfig): boolean {
  return config.kind === 'delimiter' && config.delimiter.length === 0;
}
