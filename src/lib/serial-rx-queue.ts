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
 */
export class SerialRxQueue {
  readonly maxBytes: number;
  readonly maxChunks: number;

  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private droppedSinceDrainBytes = 0;
  private totalDropped = 0;
  private overflowNotified = false;

  constructor(options: SerialRxQueueOptions) {
    this.maxBytes = positiveInteger('maxBytes', options.maxBytes);
    this.maxChunks = positiveInteger('maxChunks', options.maxChunks);
  }

  get pendingBytes(): number {
    return this.byteLength;
  }

  get pendingChunks(): number {
    return this.chunks.length;
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
      this.chunks.length > 0 &&
      (this.byteLength + bytes.length > this.maxBytes || this.chunks.length >= this.maxChunks)
    ) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.byteLength -= dropped.length;
      this.recordDrop(dropped.length);
    }

    if (bytes.length > this.maxBytes) {
      const retained = bytes.slice(bytes.length - this.maxBytes);
      this.recordDrop(bytes.length - retained.length);
      this.chunks.push(retained);
      this.byteLength += retained.length;
    } else {
      this.chunks.push(bytes);
      this.byteLength += bytes.length;
    }

    return {
      droppedBytes: this.totalDropped - droppedBefore,
      droppedSinceDrain: this.droppedSinceDrainBytes,
      totalDroppedBytes: this.totalDropped,
      overflowStarted: !wasOverflowNotified && this.overflowNotified,
      pendingBytes: this.byteLength,
      pendingChunks: this.chunks.length,
    };
  }

  drain(): SerialRxQueueDrainResult {
    const chunks = this.chunks;
    const byteLength = this.byteLength;
    const droppedSinceDrain = this.droppedSinceDrainBytes;
    this.chunks = [];
    this.byteLength = 0;
    this.droppedSinceDrainBytes = 0;
    return { chunks, byteLength, droppedSinceDrain };
  }

  clearPending(): void {
    this.chunks = [];
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
