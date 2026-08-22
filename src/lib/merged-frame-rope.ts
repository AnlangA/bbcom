import type { DataFrame } from '@/types';
import { MAX_MERGED_VISIBLE_BYTES } from '@/types/constants';

/**
 * Merged terminal rows deliberately expose only the newest 64 KiB to the UI.
 * The source chunks remain referenced by the rope and are copied only when an
 * explicit copy/export action asks for the full payload.
 */
export { MAX_MERGED_VISIBLE_BYTES };

type MarkRawFrame = <T extends object>(value: T) => T;

/**
 * Memo hook that rope-built MERGED frames expose to generic row-measuring
 * code (`packetRowHeight`): it caches the display line count per run and
 * content version. Symbol-keyed so the merged-frame cache stays invisible to
 * the plain `DataFrame` shape consumed elsewhere.
 */
export const MERGED_FRAME_LINE_COUNT: unique symbol = Symbol('bbcom.mergedFrameLineCount');

export type MergedFrameLineCountHook = (compute: () => number) => number;

interface RopeRun {
  frame: DataFrame;
  chunks: Uint8Array[];
  totalBytes: number;
  contentVersion: number;
  detached: boolean;
}

/** One LRU node: a run's materialized display tail at a content version. */
interface RopeTailCacheEntry {
  run: RopeRun;
  contentVersion: number;
  tail: Uint8Array;
}

/** Memoized display line count for one run at a content version. */
interface RopeLineCountEntry {
  contentVersion: number;
  count: number;
}

/** Display tails are 64 KiB buffers, so only a bounded window stays warm. */
const TAIL_CACHE_CAPACITY = 8;

const identityMarkRaw: MarkRawFrame = <T extends object>(value: T): T => value;

/**
 * Incremental direction-run index for the terminal's MERGED view.
 *
 * Appending a frame either adds one descriptor or appends one `Uint8Array`
 * reference to the last descriptor. It never concatenates the run. The
 * `DataFrame` returned to the UI keeps the historical shape, but its `data`
 * getter materializes only the 64 KiB display tail on demand.
 */
export class MergedFrameRopeIndex {
  private readonly runs: RopeRun[] = [];
  private readonly runByFrame = new WeakMap<DataFrame, RopeRun>();
  private readonly displayFrames: DataFrame[] = [];
  private readonly markRawFrame: MarkRawFrame;
  /**
   * Bounded LRU of materialized display tails, most recently used first.
   * Virtual measure passes over the MERGED view revisit many historical runs
   * per streaming pulse, so the original single-entry cache re-copied a fresh
   * 64 KiB tail on every revisit; eight entries keep a visible window warm
   * while capping duplicated tail bytes at 8 x 64 KiB.
   */
  private readonly tailCache: RopeTailCacheEntry[] = [];
  /**
   * Display line counts cost one number per run, so every run—including
   * unmeasured historical rows revisited across pulses—stays memoized. The
   * WeakMap drops entries with their runs after clear()/rebuild.
   */
  private readonly lineCounts = new WeakMap<RopeRun, RopeLineCountEntry>();

  constructor(markRawFrame: MarkRawFrame = identityMarkRaw) {
    this.markRawFrame = markRawFrame;
  }

  get frames(): readonly DataFrame[] {
    return this.displayFrames;
  }

  get frameCount(): number {
    return this.displayFrames.length;
  }

  clear(): void {
    for (const run of this.runs) {
      run.detached = true;
      run.chunks.length = 0;
      run.totalBytes = 0;
      this.runByFrame.delete(run.frame);
    }
    this.runs.length = 0;
    this.displayFrames.length = 0;
    this.tailCache.length = 0;
  }

  rebuild(source: readonly DataFrame[]): void {
    this.clear();
    this.appendRange(source, 0);
  }

  appendRange(source: readonly DataFrame[], start: number): void {
    for (let index = start; index < source.length; index += 1) {
      const sourceFrame = source[index];
      if (!sourceFrame) continue;
      this.append(sourceFrame);
    }
  }

  append(sourceFrame: DataFrame): void {
    const last = this.runs[this.runs.length - 1];
    if (last && !last.detached && last.frame.direction === sourceFrame.direction) {
      last.chunks.push(sourceFrame.data);
      last.totalBytes += sourceFrame.data.byteLength;
      last.contentVersion += 1;
      // The live tail run is the only mutable run: drop its cached tail
      // eagerly so the stale 64 KiB copy is freed at growth, not at reuse.
      // The common high-baud append path has never materialized a display
      // tail. Avoid an LRU scan/function call on every source frame in that
      // case; invalidation is needed only after a consumer has read `data`.
      if (this.tailCache.length > 0) this.dropTailCacheEntry(last);
      return;
    }

    const run: RopeRun = {
      frame: undefined as unknown as DataFrame,
      chunks: [sourceFrame.data],
      totalBytes: sourceFrame.data.byteLength,
      contentVersion: 1,
      detached: false,
    };
    const tailForRun = () => this.tailFor(run);
    const display = {
      id: `merged-${sourceFrame.id}`,
      direction: sourceFrame.direction,
      timestamp: sourceFrame.timestamp,
      get data(): Uint8Array {
        return tailForRun();
      },
      get contentVersion(): number {
        return run.contentVersion;
      },
      get omittedBytes(): number {
        return Math.max(0, run.totalBytes - MAX_MERGED_VISIBLE_BYTES);
      },
      [MERGED_FRAME_LINE_COUNT]: (compute: () => number): number => this.lineCountFor(run, compute),
    } as DataFrame;
    const frame = this.markRawFrame(display);
    run.frame = frame;
    this.runs.push(run);
    this.displayFrames.push(frame);
    this.runByFrame.set(frame, run);
  }

  isMergedFrame(frame: DataFrame): boolean {
    return this.runByFrame.has(frame);
  }

  /** Full byte materialization is intentionally limited to copy/export paths. */
  materialize(frame: DataFrame): DataFrame {
    const run = this.runByFrame.get(frame);
    if (!run || run.detached) return frame;

    const data = new Uint8Array(run.totalBytes);
    let offset = 0;
    for (const chunk of run.chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      id: frame.id,
      direction: frame.direction,
      timestamp: frame.timestamp,
      data,
      contentVersion: run.contentVersion,
    };
  }

  /** Source chunks for bounded streaming search; never concatenate them. */
  chunksFor(frame: DataFrame): readonly Uint8Array[] | null {
    const run = this.runByFrame.get(frame);
    return run && !run.detached ? run.chunks : null;
  }

  /**
   * Memoized display line count for a merged row. `compute` runs at most once
   * per (run, content version); appending to the live tail run bumps that
   * run's version, so a growing row invalidates its own memo while immutable
   * historical runs stay cached forever. Frames not owned by this rope simply
   * compute every call.
   */
  runDisplayLineCount(frame: DataFrame, compute: () => number): number {
    const run = this.runByFrame.get(frame);
    return run ? this.lineCountFor(run, compute) : compute();
  }

  private lineCountFor(run: RopeRun, compute: () => number): number {
    const cached = this.lineCounts.get(run);
    if (cached && cached.contentVersion === run.contentVersion) {
      return cached.count;
    }
    const count = compute();
    this.lineCounts.set(run, { contentVersion: run.contentVersion, count });
    return count;
  }

  private tailFor(run: RopeRun): Uint8Array {
    if (run.detached || run.totalBytes === 0) return new Uint8Array(0);
    const cached = this.freshTailEntry(run);
    if (cached) return cached.tail;

    const tailLength = Math.min(run.totalBytes, MAX_MERGED_VISIBLE_BYTES);
    const tail = new Uint8Array(tailLength);
    let destinationEnd = tailLength;
    for (let index = run.chunks.length - 1; index >= 0 && destinationEnd > 0; index -= 1) {
      const chunk = run.chunks[index];
      const copyLength = Math.min(destinationEnd, chunk.byteLength);
      destinationEnd -= copyLength;
      tail.set(chunk.subarray(chunk.byteLength - copyLength), destinationEnd);
    }

    this.rememberTail(run, tail);
    return tail;
  }

  /** The run's cached tail at its current content version, LRU-refreshed. */
  private freshTailEntry(run: RopeRun): RopeTailCacheEntry | null {
    for (let index = 0; index < this.tailCache.length; index += 1) {
      const entry = this.tailCache[index];
      if (entry.run !== run) continue;
      this.tailCache.splice(index, 1);
      if (entry.contentVersion !== run.contentVersion) return null;
      this.tailCache.unshift(entry);
      return entry;
    }
    return null;
  }

  private rememberTail(run: RopeRun, tail: Uint8Array): void {
    this.tailCache.unshift({ run, contentVersion: run.contentVersion, tail });
    if (this.tailCache.length > TAIL_CACHE_CAPACITY) {
      this.tailCache.length = TAIL_CACHE_CAPACITY;
    }
  }

  private dropTailCacheEntry(run: RopeRun): void {
    const index = this.tailCache.findIndex((entry) => entry.run === run);
    if (index >= 0) this.tailCache.splice(index, 1);
  }
}
