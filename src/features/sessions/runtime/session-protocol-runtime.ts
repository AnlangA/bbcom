import { McumgrSmpParser } from '@/lib/mcumgr-smp-parser';
import type { ByteFrameRecord, DisplayProtocolRecord } from '@/lib/protocol-record';
import { parserConfigKey, ProtocolParser, type ParserConfig } from '@/lib/protocol-parser';
import type { DataFrame } from '@/types';

export interface SessionProtocolRuntimeSnapshot {
  /** Parsed protocol records accumulated by the resident session runtime. */
  frames: readonly DisplayProtocolRecord[];
  /** Parsed records evicted from the retained inspection window. */
  droppedFrames: number;
  /** Parsed payload bytes evicted from the retained inspection window. */
  droppedBytes: number;
  /** Bytes per second over the most recently completed half-second window. */
  throughputBps: number;
  /** Changes only when the parser stream is reset, never for normal input. */
  resetVersion: number;
}

export interface SessionProtocolRuntimeLimits {
  maxFrames?: number;
  maxBytes?: number;
}

export interface SessionProtocolReplayScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

export interface SessionProtocolExpiryScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

export interface SessionProtocolRuntimeOptions extends SessionProtocolRuntimeLimits {
  replayScheduler?: SessionProtocolReplayScheduler;
  replayTimeSliceMs?: number;
  replayFramesPerSlice?: number;
  maxLiveReplayBacklogBytes?: number;
  expiryScheduler?: SessionProtocolExpiryScheduler;
}

export interface SessionProtocolConfigureOptions {
  /** Rebuild records from the supplied retained capture. Defaults to true. */
  replayHistory?: boolean;
  /** Re-apply even when the normalized configuration key is unchanged. */
  force?: boolean;
}

type ProtocolCaptureFrame = Pick<DataFrame, 'direction' | 'data'> &
  Partial<Pick<DataFrame, 'id' | 'timestamp' | 'captureSeq' | 'origin'>>;

interface ReplayJob {
  readonly generation: number;
  readonly history: readonly ProtocolCaptureFrame[];
  historyIndex: number;
  live: ProtocolCaptureFrame[];
  liveIndex: number;
  liveBytes: number;
}

export const DEFAULT_SESSION_PROTOCOL_MAX_FRAMES = 5_000;
export const DEFAULT_SESSION_PROTOCOL_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SESSION_PROTOCOL_MAX_LIVE_REPLAY_BACKLOG_BYTES = 2 * 1024 * 1024;

const DEFAULT_REPLAY_TIME_SLICE_MS = 8;
const DEFAULT_REPLAY_FRAMES_PER_SLICE = 128;

/**
 * Resident protocol data plane for one serial session.
 *
 * Legacy byte framers stay attached to native RX so capture/UI publication
 * cannot delay stream reassembly. SMP instead consumes the shared session
 * TX/RX timeline used by every other module: native serial, MCUmgr wire
 * replay, paused capture, and presentation all publish onto that one stream.
 * Frame `origin` is display attribution, not a consumption filter.
 */
export class SessionProtocolRuntime {
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly replayScheduler: SessionProtocolReplayScheduler;
  private readonly replayTimeSliceMs: number;
  private readonly replayFramesPerSlice: number;
  private readonly maxLiveReplayBacklogBytes: number;
  private readonly expiryScheduler: SessionProtocolExpiryScheduler;
  private readonly changeListeners = new Set<() => void>();

  private byteParser: ProtocolParser | null = null;
  private smpParser: McumgrSmpParser | null = null;
  private configKey: string | null = null;
  private replayHistoryEnabled = true;
  private replayGeneration = 0;
  private replayJob: ReplayJob | null = null;
  private replayHandle: unknown | null = null;
  private expiryHandle: unknown | null = null;
  private expiryGeneration = 0;
  private smpClockTimestamp = 0;
  private nextByteRecordNumber = 1;

  private captureInitialized = false;
  private captureHighWatermark: number | null = null;
  private captureHighWatermarkId: string | null = null;

  private parsedFrames: DisplayProtocolRecord[] = [];
  /** Oldest live entry; the dead prefix is compacted in batches. */
  private parsedFrameHead = 0;
  private retainedBytes = 0;
  private droppedFrames = 0;
  private droppedBytes = 0;
  private windowStartedAt: number | null = null;
  private windowBytes = 0;
  private throughputBps = 0;
  private resetVersion = 0;

  constructor(options: SessionProtocolRuntimeOptions = {}) {
    this.maxFrames = positiveLimit(
      'maxFrames',
      options.maxFrames,
      DEFAULT_SESSION_PROTOCOL_MAX_FRAMES,
    );
    this.maxBytes = positiveLimit('maxBytes', options.maxBytes, DEFAULT_SESSION_PROTOCOL_MAX_BYTES);
    this.replayTimeSliceMs = positiveLimit(
      'replayTimeSliceMs',
      options.replayTimeSliceMs,
      DEFAULT_REPLAY_TIME_SLICE_MS,
    );
    this.replayFramesPerSlice = positiveLimit(
      'replayFramesPerSlice',
      options.replayFramesPerSlice,
      DEFAULT_REPLAY_FRAMES_PER_SLICE,
    );
    this.maxLiveReplayBacklogBytes = positiveLimit(
      'maxLiveReplayBacklogBytes',
      options.maxLiveReplayBacklogBytes,
      DEFAULT_SESSION_PROTOCOL_MAX_LIVE_REPLAY_BACKLOG_BYTES,
    );
    this.replayScheduler = options.replayScheduler ?? defaultReplayScheduler();
    this.expiryScheduler = options.expiryScheduler ?? defaultExpiryScheduler();
  }

  get isSmpMode(): boolean {
    return this.smpParser !== null;
  }

  /** Receive asynchronous replay updates without coupling this class to Vue. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Replace the parser configuration. Legacy history is rebuilt immediately
   * for backwards compatibility; SMP history is replayed in cancellable time
   * slices so a large capture never monopolizes the UI thread.
   */
  configure(
    config: ParserConfig,
    capturedHistory?: Iterable<ProtocolCaptureFrame>,
    options: SessionProtocolConfigureOptions = {},
  ): boolean {
    const nextKey = parserConfigKey(config);
    if (nextKey === this.configKey && !options.force) return false;

    this.cancelReplay();
    this.cancelSmpExpiry();
    this.configKey = nextKey;
    this.replayHistoryEnabled = options.replayHistory ?? true;
    this.byteParser = null;
    this.smpParser = null;
    this.captureInitialized = false;
    this.captureHighWatermark = null;
    this.captureHighWatermarkId = null;
    this.smpClockTimestamp = 0;

    if (config.kind === 'mcumgr-smp') {
      this.smpParser = new McumgrSmpParser(config);
    } else if (!isEmptyDelimiter(config)) {
      this.byteParser = new ProtocolParser(config);
    }

    this.resetState();
    if (!capturedHistory) return true;

    if (this.smpParser) {
      const timeline = orderCaptureTimeline(capturedHistory);
      this.updateCaptureBoundary(timeline);
      if (this.replayHistoryEnabled) this.startReplay(timeline);
      return true;
    }

    if (this.byteParser && this.replayHistoryEnabled) {
      for (const frame of capturedHistory) {
        if (frame.direction !== 'RX') continue;
        this.appendByteFrames(this.byteParser.feed(frame.data), {
          timestamp: frame.timestamp ?? Date.now(),
          captureSeq: frame.captureSeq,
        });
      }
    }
    return true;
  }

  /**
   * Consume one native RX chunk. SMP ignores this path so it cannot double-
   * ingest bytes that already land on the shared TX/RX timeline (including
   * MCUmgr replay, which broadcasts RX before capture publication).
   */
  feed(bytes: Uint8Array, now = Date.now()): boolean {
    if (!this.byteParser || bytes.length === 0) return false;

    const parsed = this.byteParser.feed(bytes);
    this.appendByteFrames(parsed, { timestamp: now });
    return this.recordLiveThroughput(bytes.length, now) || parsed.length > 0;
  }

  /**
   * Synchronize SMP with the latest retained capture timeline. The caller may
   * pass the whole timeline on each capture-version update; only frames beyond
   * the last observed capture sequence are consumed.
   */
  syncCaptureTimeline(frames: Iterable<ProtocolCaptureFrame>, now = Date.now()): boolean {
    if (!this.smpParser) return false;
    const timeline = orderCaptureTimeline(frames);

    if (!this.captureInitialized) {
      this.updateCaptureBoundary(timeline);
      if (this.replayJob) {
        this.queueReplayLive(timeline);
        return this.recordLiveThroughput(totalBytes(timeline), now);
      }
      const before = this.liveFrameCount();
      this.feedSmpFrames(timeline);
      this.armSmpExpiry();
      return (
        this.recordLiveThroughput(totalBytes(timeline), now) || this.liveFrameCount() !== before
      );
    }

    if (this.captureWasReplaced(timeline)) {
      this.restartForCaptureReplacement(timeline);
      return true;
    }

    const previousHighWatermark = this.captureHighWatermark;
    const appended =
      previousHighWatermark === null
        ? timeline
        : timeline.filter(
            (frame) => frame.captureSeq !== undefined && frame.captureSeq > previousHighWatermark,
          );
    if (appended.length === 0) return false;

    if (previousHighWatermark !== null && hasCaptureSequenceGap(appended, previousHighWatermark)) {
      this.restartForCaptureReplacement(timeline);
      return true;
    }

    this.updateCaptureBoundary(timeline);
    const bytes = totalBytes(appended);
    const throughputChanged = this.recordLiveThroughput(bytes, now);

    if (this.replayJob) {
      this.queueReplayLive(appended);
      return throughputChanged;
    }

    const before = this.liveFrameCount();
    this.feedSmpFrames(appended);
    this.armSmpExpiry();
    return throughputChanged || this.liveFrameCount() !== before;
  }

  /** Reset the current stream after terminal data is explicitly cleared. */
  clear(): void {
    this.cancelReplay();
    this.cancelSmpExpiry();
    this.byteParser?.reset();
    this.smpParser?.reset();
    this.captureInitialized = false;
    this.captureHighWatermark = null;
    this.captureHighWatermarkId = null;
    this.smpClockTimestamp = 0;
    this.resetState();
  }

  /** Stop scheduled replay work when its owning session runtime is disposed. */
  dispose(): void {
    this.cancelReplay();
    this.cancelSmpExpiry();
    this.changeListeners.clear();
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

  private restartForCaptureReplacement(timeline: readonly ProtocolCaptureFrame[]): void {
    this.cancelReplay();
    this.cancelSmpExpiry();
    this.smpParser?.reset();
    this.captureInitialized = false;
    this.captureHighWatermark = null;
    this.captureHighWatermarkId = null;
    this.resetState();
    this.updateCaptureBoundary(timeline);
    // A replacement/discontinuity is a new live capture generation rather
    // than the user's original Apply-time history. Rebuild the retained new
    // generation so its first partial transport fragment is not lost.
    this.startReplay(timeline);
  }

  private captureWasReplaced(timeline: readonly ProtocolCaptureFrame[]): boolean {
    if (this.captureHighWatermark === null) return false;
    const highest = highestCaptureSequence(timeline);
    if (highest === null || highest < this.captureHighWatermark) return true;

    const previousTail = timeline.find((frame) => frame.captureSeq === this.captureHighWatermark);
    return Boolean(
      previousTail &&
      this.captureHighWatermarkId &&
      previousTail.id &&
      previousTail.id !== this.captureHighWatermarkId,
    );
  }

  private updateCaptureBoundary(timeline: readonly ProtocolCaptureFrame[]): void {
    this.captureInitialized = true;
    let tail: ProtocolCaptureFrame | undefined;
    for (const frame of timeline) {
      if (frame.captureSeq === undefined) continue;
      if (!tail || frame.captureSeq > (tail.captureSeq ?? -1)) tail = frame;
    }
    if (!tail || tail.captureSeq === undefined) return;
    this.captureHighWatermark = tail.captureSeq;
    this.captureHighWatermarkId = tail.id ?? null;
  }

  private startReplay(timeline: readonly ProtocolCaptureFrame[]): void {
    if (!this.smpParser) return;
    const history = timeline.filter((frame) => frame.data.length > 0);
    if (history.length === 0) return;
    const generation = ++this.replayGeneration;
    this.replayJob = {
      generation,
      history,
      historyIndex: 0,
      live: [],
      liveIndex: 0,
      liveBytes: 0,
    };
    this.scheduleReplay(generation);
  }

  private queueReplayLive(frames: readonly ProtocolCaptureFrame[]): void {
    const job = this.replayJob;
    if (!job || frames.length === 0) return;
    job.live.push(...frames);
    job.liveBytes += totalBytes(frames);
    if (job.liveBytes <= this.maxLiveReplayBacklogBytes) return;

    // Historical work is expendable once it can no longer keep up. Discard
    // partially replayed records and continue after the current capture
    // boundary. The over-limit backlog is intentionally skipped rather than
    // synchronously parsing more than 2 MiB on the UI thread.
    const live = job.live.slice(job.liveIndex);
    this.cancelReplay();
    this.smpParser?.reset();
    this.resetState();
    const boundary = live.at(-1);
    if (this.smpParser && boundary) {
      this.pushParsedFrame(
        this.smpParser.diagnostic({
          direction: boundary.direction,
          timestamp: boundary.timestamp ?? Date.now(),
          captureSeq: boundary.captureSeq,
          code: 'smp.runtime.replay-backlog',
          message:
            'Historical replay was abandoned because the live capture backlog exceeded 2 MiB',
          severity: 'warning',
        }),
      );
    }
    if (boundary) this.updateSmpClock(boundary.timestamp ?? Date.now());
    this.armSmpExpiry();
    this.emitChange();
  }

  private scheduleReplay(generation: number): void {
    if (this.replayHandle !== null) return;
    const scheduledHandle = this.replayScheduler.schedule(() => {
      if (this.replayHandle !== scheduledHandle) return;
      this.replayHandle = null;
      this.runReplaySlice(generation);
    });
    this.replayHandle = scheduledHandle;
  }

  private runReplaySlice(generation: number): void {
    const job = this.replayJob;
    const parser = this.smpParser;
    if (!job || !parser || job.generation !== generation || generation !== this.replayGeneration)
      return;
    const startedAt = this.replayScheduler.now();
    const before = this.liveFrameCount();
    let processed = 0;

    while (
      processed < this.replayFramesPerSlice &&
      (processed === 0 || this.replayScheduler.now() - startedAt < this.replayTimeSliceMs)
    ) {
      let frame: ProtocolCaptureFrame | undefined;
      if (job.historyIndex < job.history.length) {
        frame = job.history[job.historyIndex];
        job.historyIndex += 1;
      } else if (job.liveIndex < job.live.length) {
        frame = job.live[job.liveIndex];
        job.liveIndex += 1;
        job.liveBytes -= frame.data.byteLength;
      } else {
        break;
      }
      this.feedSmpFrame(frame);
      processed += 1;
    }

    if (this.liveFrameCount() !== before) this.emitChange();
    if (job.historyIndex < job.history.length || job.liveIndex < job.live.length) {
      this.scheduleReplay(generation);
      return;
    }

    this.replayJob = null;
    this.armSmpExpiry();
    // A final notification makes pending/empty replay state observable even
    // when the last time slice produced no complete SMP record.
    this.emitChange();
  }

  private cancelReplay(): void {
    this.replayGeneration += 1;
    if (this.replayHandle !== null) {
      this.replayScheduler.cancel(this.replayHandle);
      this.replayHandle = null;
    }
    this.replayJob = null;
  }

  private feedSmpFrames(frames: readonly ProtocolCaptureFrame[]): void {
    for (const frame of frames) this.feedSmpFrame(frame);
  }

  private feedSmpFrame(frame: ProtocolCaptureFrame): void {
    if (!this.smpParser || frame.data.length === 0) return;
    const timestamp = frame.timestamp ?? Date.now();
    this.updateSmpClock(timestamp);
    const records = this.smpParser.feed({
      direction: frame.direction,
      data: frame.data,
      timestamp,
      captureSeq: frame.captureSeq,
    });
    for (const record of records) this.pushParsedFrame(record);
  }

  private armSmpExpiry(): void {
    this.cancelSmpExpiry();
    const expiresAt = this.smpParser?.nextExpiryTimestamp();
    if (expiresAt === null || expiresAt === undefined) return;
    const generation = this.expiryGeneration;
    const delayMs = Math.max(0, expiresAt - this.smpClockTimestamp);
    const scheduledAt = this.expiryScheduler.now();
    const scheduledHandle = this.expiryScheduler.schedule(() => {
      if (this.expiryHandle !== scheduledHandle) return;
      this.expiryHandle = null;
      if (generation !== this.expiryGeneration || !this.smpParser) return;
      const elapsed = Math.max(0, this.expiryScheduler.now() - scheduledAt);
      const effectiveNow = Math.max(expiresAt, this.smpClockTimestamp + elapsed);
      this.updateSmpClock(effectiveNow);
      for (const record of this.smpParser.flushExpired(effectiveNow)) this.pushParsedFrame(record);
      // Request expiry mutates its retained request record rather than
      // creating a duplicate, so publish even when no new record was emitted.
      this.emitChange();
      this.armSmpExpiry();
    }, delayMs);
    this.expiryHandle = scheduledHandle;
  }

  private cancelSmpExpiry(): void {
    this.expiryGeneration += 1;
    if (this.expiryHandle !== null) {
      this.expiryScheduler.cancel(this.expiryHandle);
      this.expiryHandle = null;
    }
  }

  private updateSmpClock(timestamp: number): void {
    if (Number.isFinite(timestamp))
      this.smpClockTimestamp = Math.max(this.smpClockTimestamp, timestamp);
  }

  private appendByteFrames(
    parsed: ReturnType<ProtocolParser['feed']>,
    metadata: { timestamp: number; captureSeq?: number },
  ): void {
    const parserKind = this.byteParser?.config.kind;
    if (!parserKind) return;
    for (const frame of parsed) {
      const record: ByteFrameRecord = {
        kind: 'bytes',
        parserKind,
        id: `bytes-${this.nextByteRecordNumber++}`,
        direction: 'RX',
        timestamp: metadata.timestamp,
        ...(metadata.captureSeq === undefined ? {} : { captureSeq: metadata.captureSeq }),
        data: frame.data,
        length: frame.data.length,
        offset: frame.offset,
        endOffset: frame.offset + frame.data.length,
        status: 'ok',
        diagnostics: [],
        summary: `RX · ${frame.data.length} B`,
      };
      this.pushParsedFrame(record);
    }
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
    this.smpClockTimestamp = 0;
    this.nextByteRecordNumber = 1;
    this.resetVersion += 1;
  }

  private recordLiveThroughput(bytes: number, now: number): boolean {
    if (bytes <= 0) return false;
    this.windowBytes += bytes;
    if (this.windowStartedAt === null) this.windowStartedAt = now;
    const elapsedSeconds = (now - this.windowStartedAt) / 1000;
    if (elapsedSeconds < 0.5) return false;
    this.throughputBps = Math.round(this.windowBytes / elapsedSeconds);
    this.windowStartedAt = now;
    this.windowBytes = 0;
    return true;
  }

  private pushParsedFrame(frame: DisplayProtocolRecord): void {
    this.parsedFrames.push(frame);
    this.retainedBytes += frame.data.byteLength;

    while (
      this.parsedFrames.length - this.parsedFrameHead > this.maxFrames ||
      this.retainedBytes > this.maxBytes
    ) {
      const dropped = this.parsedFrames[this.parsedFrameHead];
      // Release the payload immediately; compaction of the sparse prefix is
      // deliberately batched so steady-state overflow remains amortized O(1).
      this.parsedFrames[this.parsedFrameHead] = undefined as unknown as DisplayProtocolRecord;
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

  private liveFrameCount(): number {
    return this.parsedFrames.length - this.parsedFrameHead;
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }
}

function isEmptyDelimiter(config: ParserConfig): boolean {
  return config.kind === 'delimiter' && config.delimiter.length === 0;
}

function hasCaptureSequenceGap(
  frames: readonly ProtocolCaptureFrame[],
  previousSequence: number,
): boolean {
  let expected = previousSequence + 1;
  for (const frame of frames) {
    if (frame.captureSeq === undefined || frame.captureSeq !== expected) return true;
    expected += 1;
  }
  return false;
}

function orderCaptureTimeline(frames: Iterable<ProtocolCaptureFrame>): ProtocolCaptureFrame[] {
  const ordered = Array.from(frames);
  let needsSort = false;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1].captureSeq;
    const current = ordered[index].captureSeq;
    if ((previous !== undefined && current === undefined) || (previous ?? -1) > (current ?? -1)) {
      needsSort = true;
      break;
    }
  }
  if (!needsSort) return ordered;

  return ordered
    .map((frame, index) => ({ frame, index }))
    .sort((left, right) => {
      const leftSeq = left.frame.captureSeq;
      const rightSeq = right.frame.captureSeq;
      if (leftSeq === undefined && rightSeq === undefined) return left.index - right.index;
      if (leftSeq === undefined) return -1;
      if (rightSeq === undefined) return 1;
      return leftSeq - rightSeq || left.index - right.index;
    })
    .map(({ frame }) => frame);
}

function highestCaptureSequence(frames: readonly ProtocolCaptureFrame[]): number | null {
  let highest: number | null = null;
  for (const frame of frames) {
    if (frame.captureSeq === undefined) continue;
    if (highest === null || frame.captureSeq > highest) highest = frame.captureSeq;
  }
  return highest;
}

function totalBytes(frames: readonly ProtocolCaptureFrame[]): number {
  let total = 0;
  for (const frame of frames) total += frame.data.byteLength;
  return total;
}

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(resolved);
}

function defaultReplayScheduler(): SessionProtocolReplayScheduler {
  return {
    schedule: (callback) => setTimeout(callback, 0),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  };
}

function defaultExpiryScheduler(): SessionProtocolExpiryScheduler {
  return {
    schedule: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle;
    },
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}
