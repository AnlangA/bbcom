import type { DataFrame } from '../types';
import { MAX_MERGED_VISIBLE_BYTES } from '../types/constants';

/**
 * Merged terminal rows deliberately expose only the newest 64 KiB to the UI.
 * The source chunks remain referenced by the rope and are copied only when an
 * explicit copy/export action asks for the full payload.
 */
export { MAX_MERGED_VISIBLE_BYTES };

type MarkRawFrame = <T extends object>(value: T) => T;

interface RopeRun {
  frame: DataFrame;
  chunks: Uint8Array[];
  totalBytes: number;
  contentVersion: number;
  detached: boolean;
}

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
  private cachedTailRun: RopeRun | null = null;
  private cachedTailVersion = -1;
  private cachedTail = new Uint8Array(0);

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
    this.clearTailCache();
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
      if (this.cachedTailRun === last) this.clearTailCache();
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

  private tailFor(run: RopeRun): Uint8Array {
    if (run.detached || run.totalBytes === 0) return new Uint8Array(0);
    if (this.cachedTailRun === run && this.cachedTailVersion === run.contentVersion) {
      return this.cachedTail;
    }

    const tailLength = Math.min(run.totalBytes, MAX_MERGED_VISIBLE_BYTES);
    const tail = new Uint8Array(tailLength);
    let destinationEnd = tailLength;
    for (let index = run.chunks.length - 1; index >= 0 && destinationEnd > 0; index -= 1) {
      const chunk = run.chunks[index];
      const copyLength = Math.min(destinationEnd, chunk.byteLength);
      destinationEnd -= copyLength;
      tail.set(chunk.subarray(chunk.byteLength - copyLength), destinationEnd);
    }

    // Keep at most one display-tail copy. A terminal can have many historical
    // direction runs, so caching a tail on every descriptor would recreate a
    // large duplicate buffer under sustained capture.
    this.cachedTailRun = run;
    this.cachedTailVersion = run.contentVersion;
    this.cachedTail = tail;
    return tail;
  }

  private clearTailCache(): void {
    this.cachedTailRun = null;
    this.cachedTailVersion = -1;
    this.cachedTail = new Uint8Array(0);
  }
}
