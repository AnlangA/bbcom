export interface SerialRxQueueOptions {
  maxBytes: number;
  maxChunks: number;
}

export interface SerialRxQueueEnqueueResult {
  droppedBytes: number;
  droppedSinceDrain: number;
  totalDroppedBytes: number;
  overflowStarted: boolean;
  pendingBytes: number;
  pendingChunks: number;
}

export interface SerialRxQueueDrainResult {
  chunks: Uint8Array[];
  byteLength: number;
  droppedSinceDrain: number;
}

/**
 * Small, deterministic RX buffer used by the serial connection composable.
 * It keeps the newest bytes when the UI cannot flush fast enough and reports
 * exactly how much data was discarded.
 *
 * Implementation note: drops advance a `head` index (O(1)) rather than calling
 * `Array.shift()` (O(n) re-index). This is the difference between an O(n²) and
 * O(n) steady-state overflow loop at high baud, where every enqueue drops one
 * chunk from the front. The live region is `[head, chunks.length)`; it is
 * compacted when the dead prefix exceeds half the array so memory stays bounded
 * without paying the copy on every drop.
 */
export class SerialRxQueue {
  readonly maxBytes: number;
  readonly maxChunks: number;

  private chunks: Uint8Array[] = [];
  /** Index of the oldest live chunk. Chunks in `[0, head)` are dropped/dead. */
  private head = 0;
  private byteLength = 0;
  private droppedSinceDrainBytes = 0;
  private totalDropped = 0;
  private overflowNotified = false;

  constructor(options: SerialRxQueueOptions) {
    this.maxBytes = positiveInteger('maxBytes', options.maxBytes);
    this.maxChunks = positiveInteger('maxChunks', options.maxChunks);
  }

  /** Number of live chunks (excluding the dropped prefix). */
  private get liveCount(): number {
    return this.chunks.length - this.head;
  }

  get pendingBytes(): number {
    return this.byteLength;
  }

  get pendingChunks(): number {
    return this.liveCount;
  }

  get droppedSinceDrain(): number {
    return this.droppedSinceDrainBytes;
  }

  get totalDroppedBytes(): number {
    return this.totalDropped;
  }

  enqueue(bytes: Uint8Array): SerialRxQueueEnqueueResult {
    const droppedBefore = this.totalDropped;
    const wasOverflowNotified = this.overflowNotified;

    while (
      this.liveCount > 0 &&
      (this.byteLength + bytes.length > this.maxBytes || this.liveCount >= this.maxChunks)
    ) {
      const dropped = this.chunks[this.head];
      this.chunks[this.head] = undefined as unknown as Uint8Array; // release reference
      this.head += 1;
      this.byteLength -= dropped.length;
      this.recordDrop(dropped.length);
    }

    if (bytes.length > this.maxBytes) {
      const retained = bytes.slice(bytes.length - this.maxBytes);
      this.recordDrop(bytes.length - retained.length);
      this.pushLive(retained);
      this.byteLength += retained.length;
    } else {
      this.pushLive(bytes);
      this.byteLength += bytes.length;
    }

    return {
      droppedBytes: this.totalDropped - droppedBefore,
      droppedSinceDrain: this.droppedSinceDrainBytes,
      totalDroppedBytes: this.totalDropped,
      overflowStarted: !wasOverflowNotified && this.overflowNotified,
      pendingBytes: this.byteLength,
      pendingChunks: this.liveCount,
    };
  }

  /** Push a chunk, compacting the dead prefix first when it has grown past
   *  half the backing array — bounds memory while keeping drops O(1) amortized. */
  private pushLive(chunk: Uint8Array): void {
    if (this.head > 0 && this.head >= this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    this.chunks.push(chunk);
  }

  drain(): SerialRxQueueDrainResult {
    const chunks = this.head === 0 ? this.chunks : this.chunks.slice(this.head);
    const byteLength = this.byteLength;
    const droppedSinceDrain = this.droppedSinceDrainBytes;
    this.chunks = [];
    this.head = 0;
    this.byteLength = 0;
    this.droppedSinceDrainBytes = 0;
    return { chunks, byteLength, droppedSinceDrain };
  }

  clearPending(): void {
    this.chunks = [];
    this.head = 0;
    this.byteLength = 0;
    this.droppedSinceDrainBytes = 0;
  }

  reset(): void {
    this.clearPending();
    this.totalDropped = 0;
    this.overflowNotified = false;
  }

  private recordDrop(count: number): void {
    if (count <= 0) return;
    this.droppedSinceDrainBytes += count;
    this.totalDropped += count;
    this.overflowNotified = true;
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}
