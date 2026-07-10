import type {
  SerialSendFailureReason,
  SerialSendResult,
  SerialWriteOptions,
} from '../types/serial';

export const SERIAL_WRITE_MAX_OPERATIONS = 256;
export const SERIAL_WRITE_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
export const SERIAL_WRITE_CHUNK_BYTES = 4096;
export const SERIAL_WRITE_CLOSE_GRACE_MS = 2000;

export interface SerialWriteSchedulerLimits {
  maxOperations: number;
  maxQueuedBytes: number;
  chunkBytes: number;
}

export const DEFAULT_SERIAL_WRITE_LIMITS: Readonly<SerialWriteSchedulerLimits> = {
  maxOperations: SERIAL_WRITE_MAX_OPERATIONS,
  maxQueuedBytes: SERIAL_WRITE_MAX_QUEUED_BYTES,
  chunkBytes: SERIAL_WRITE_CHUNK_BYTES,
};

export interface SerialWriteSchedulerStats {
  outstandingOperations: number;
  outstandingBytes: number;
  queuedOperations: number;
  active: boolean;
  accepting: boolean;
}

export interface SerialWriteShutdownResult {
  timedOut: boolean;
}

interface WriteOperation {
  payload: Uint8Array;
  options: SerialWriteOptions;
  bytesWritten: number;
  settled: boolean;
  promise: Promise<SerialSendResult>;
  resolve: (result: SerialSendResult) => void;
}

type WriteChunk = (chunk: Uint8Array) => Promise<number>;

function failure(
  reason: SerialSendFailureReason,
  requestedBytes: number,
  bytesWritten = 0,
  error?: unknown,
): SerialSendResult {
  return {
    status: reason === 'write-error' || reason === 'write-stalled' ? 'partial-unknown' : 'rejected',
    ok: false,
    requestedBytes,
    confirmedBytes: bytesWritten,
    bytesWritten,
    reason,
    code:
      reason === 'queue-full'
        ? 'SERIAL_QUEUE_FULL'
        : reason === 'disconnecting'
          ? 'SERIAL_DISCONNECTED'
          : reason === 'write-error' || reason === 'write-stalled'
            ? 'SERIAL_PARTIAL_WRITE'
            : 'INVALID_INPUT',
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

/**
 * A bounded, single-flight FIFO for all writes belonging to one connection.
 *
 * One logical payload occupies one queue slot. Driver calls are capped at
 * 4096 bytes; a positive short write continues at the unwritten suffix, while
 * exceptions and zero/invalid progress stop immediately and are never retried.
 */
export class SerialWriteScheduler {
  private readonly writeChunk: WriteChunk;
  private readonly limits: SerialWriteSchedulerLimits;
  private readonly queue: WriteOperation[] = [];
  private activeOperation: WriteOperation | null = null;
  private draining = false;
  private accepting = true;
  private outstandingOperations = 0;
  private outstandingBytes = 0;

  constructor(writeChunk: WriteChunk, limits: Partial<SerialWriteSchedulerLimits> = {}) {
    this.writeChunk = writeChunk;
    this.limits = { ...DEFAULT_SERIAL_WRITE_LIMITS, ...limits };
    if (
      !Number.isInteger(this.limits.maxOperations) ||
      this.limits.maxOperations < 1 ||
      !Number.isInteger(this.limits.maxQueuedBytes) ||
      this.limits.maxQueuedBytes < 1 ||
      !Number.isInteger(this.limits.chunkBytes) ||
      this.limits.chunkBytes < 1
    ) {
      throw new RangeError('serial write scheduler limits must be positive integers');
    }
  }

  get stats(): SerialWriteSchedulerStats {
    return {
      outstandingOperations: this.outstandingOperations,
      outstandingBytes: this.outstandingBytes,
      queuedOperations: this.queue.length,
      active: this.activeOperation !== null,
      accepting: this.accepting,
    };
  }

  enqueue(payload: Uint8Array, options: SerialWriteOptions = {}): Promise<SerialSendResult> {
    if (payload.length === 0) return Promise.resolve(failure('empty', 0));
    if (!this.accepting) {
      return Promise.resolve(failure('disconnecting', payload.length));
    }
    if (
      this.outstandingOperations >= this.limits.maxOperations ||
      this.outstandingBytes + payload.length > this.limits.maxQueuedBytes
    ) {
      return Promise.resolve(failure('queue-full', payload.length));
    }

    let resolve!: (result: SerialSendResult) => void;
    const promise = new Promise<SerialSendResult>((done) => {
      resolve = done;
    });
    const operation: WriteOperation = {
      // The caller may reuse or mutate its buffer while this operation waits.
      payload: payload.slice(),
      options,
      bytesWritten: 0,
      settled: false,
      promise,
      resolve,
    };
    this.queue.push(operation);
    this.outstandingOperations += 1;
    this.outstandingBytes += operation.payload.length;
    void this.drain();
    return promise;
  }

  /**
   * Stop accepting writes, reject every operation that has not started, and
   * allow only the current driver call to settle for `graceMs`.
   */
  async shutdown(graceMs = SERIAL_WRITE_CLOSE_GRACE_MS): Promise<SerialWriteShutdownResult> {
    this.accepting = false;
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      if (queued) this.settle(queued, failure('disconnecting', queued.payload.length));
    }

    const active = this.activeOperation;
    if (!active || active.settled) return { timedOut: false };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const completed = active.promise.then(() => false);
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, graceMs));
    });
    const timedOut = await Promise.race([completed, timeout]);
    if (timer) clearTimeout(timer);
    if (timedOut && !active.settled) {
      this.settle(active, failure('disconnecting', active.payload.length, active.bytesWritten));
    }
    return { timedOut };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const operation = this.queue.shift();
        if (!operation || operation.settled) continue;
        this.activeOperation = operation;
        const result = await this.writeOperation(operation);
        if (!operation.settled) this.settle(operation, result);
        if (this.activeOperation === operation) this.activeOperation = null;
      }
    } finally {
      this.draining = false;
    }
  }

  private async writeOperation(operation: WriteOperation): Promise<SerialSendResult> {
    try {
      operation.options.onWriteStarted?.();
    } catch (error) {
      return failure('write-error', operation.payload.length, 0, error);
    }

    while (operation.bytesWritten < operation.payload.length) {
      // Keep the logical 4 KiB boundary stable across short writes. A short
      // result continues only the suffix of this chunk before advancing.
      const logicalChunkEnd = Math.min(
        operation.bytesWritten + this.limits.chunkBytes,
        operation.payload.length,
      );
      while (operation.bytesWritten < logicalChunkEnd) {
        if (operation.settled) {
          return failure('disconnecting', operation.payload.length, operation.bytesWritten);
        }

        const chunk = operation.payload.subarray(operation.bytesWritten, logicalChunkEnd);
        let written: number;
        try {
          written = await this.writeChunk(chunk);
        } catch (error) {
          return failure('write-error', operation.payload.length, operation.bytesWritten, error);
        }

        // A shutdown may have settled the logical operation while the native
        // promise was still pending. Ignore that stale completion entirely.
        if (operation.settled) {
          return failure('disconnecting', operation.payload.length, operation.bytesWritten);
        }
        if (!Number.isInteger(written) || written <= 0 || written > chunk.length) {
          return failure(
            'write-stalled',
            operation.payload.length,
            operation.bytesWritten,
            `driver reported ${written} bytes for a ${chunk.length}-byte write`,
          );
        }
        operation.bytesWritten += written;
        this.outstandingBytes -= written;
      }
    }

    return {
      status: 'complete',
      ok: true,
      requestedBytes: operation.payload.length,
      confirmedBytes: operation.payload.length,
      bytesWritten: operation.payload.length,
      reason: null,
    };
  }

  private settle(operation: WriteOperation, result: SerialSendResult): void {
    if (operation.settled) return;
    operation.settled = true;
    const remaining = operation.payload.length - operation.bytesWritten;
    this.outstandingBytes = Math.max(0, this.outstandingBytes - remaining);
    this.outstandingOperations = Math.max(0, this.outstandingOperations - 1);
    operation.resolve(result);
  }
}
