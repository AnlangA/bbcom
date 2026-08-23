import type { IpcError } from '@/generated/ipc-contracts';
import type { SerialSendResult, SerialWriteOptions } from '@/types/serial';

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

export type SerialWriteAdmission = Readonly<{ source: 'host'; ownerId: string }>;

export interface SerialWriteAdmissionGate {
  authorize(admission: SerialWriteAdmission): boolean;
}

interface WriteOperation {
  payload: Uint8Array;
  options: SerialWriteOptions;
  admission: SerialWriteAdmission | null;
  sentBytes: number;
  settled: boolean;
  promise: Promise<SerialSendResult>;
  resolve: (result: SerialSendResult) => void;
}

interface IdleWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  detachAbort: () => void;
}

type WriteChunk = (chunk: Uint8Array) => Promise<number>;

const SERIAL_SEND_OPERATION = 'serial_send';

function serialError(
  code: IpcError['code'],
  messageKey: string,
  retryable: boolean,
  details: Partial<Pick<IpcError, 'field' | 'limit' | 'actual'>> = {},
): IpcError {
  return {
    code,
    messageKey,
    retryable,
    operation: SERIAL_SEND_OPERATION,
    ...details,
  };
}

function failed(requestedBytes: number, error: IpcError): SerialSendResult {
  return {
    outcome: 'failed',
    requestedBytes,
    sentBytes: 0,
    error,
  };
}

function writeFailure(requestedBytes: number, sentBytes: number): SerialSendResult {
  return {
    outcome: sentBytes > 0 ? 'partial' : 'failed',
    requestedBytes,
    sentBytes,
    error: serialError('SERIAL_PARTIAL_WRITE', 'error.serial_partial_write', false),
  };
}

function cancelled(requestedBytes: number, sentBytes = 0): SerialSendResult {
  return {
    outcome: 'cancelled',
    requestedBytes,
    sentBytes,
    error: serialError('CANCELLED', 'error.cancelled', false),
  };
}

function denied(requestedBytes: number, sentBytes = 0): SerialSendResult {
  return {
    outcome: sentBytes > 0 ? 'partial' : 'failed',
    requestedBytes,
    sentBytes,
    error: serialError('SECURITY_DENIED', 'error.security_denied', false),
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
  private readonly idleWaiters = new Set<IdleWaiter>();
  private draining = false;
  private accepting = true;
  private outstandingOperations = 0;
  private outstandingBytes = 0;

  constructor(
    writeChunk: WriteChunk,
    limits: Partial<SerialWriteSchedulerLimits> = {},
    private readonly admissionGate?: SerialWriteAdmissionGate,
  ) {
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

  enqueue(
    payload: Uint8Array,
    options: SerialWriteOptions = {},
    admission: SerialWriteAdmission | null = null,
  ): Promise<SerialSendResult> {
    if (payload.length === 0) {
      return Promise.resolve(
        failed(0, serialError('INVALID_INPUT', 'error.invalid_input', false, { field: 'payload' })),
      );
    }
    if (!this.accepting) {
      return Promise.resolve(cancelled(payload.length));
    }
    if (!this.authorized(admission)) {
      return Promise.resolve(denied(payload.length));
    }
    if (
      this.outstandingOperations >= this.limits.maxOperations ||
      this.outstandingBytes + payload.length > this.limits.maxQueuedBytes
    ) {
      return Promise.resolve(
        failed(payload.length, serialError('SERIAL_QUEUE_FULL', 'error.serial_queue_full', true)),
      );
    }

    let resolve!: (result: SerialSendResult) => void;
    const promise = new Promise<SerialSendResult>((done) => {
      resolve = done;
    });
    const operation: WriteOperation = {
      // The caller may reuse or mutate its buffer while this operation waits.
      payload: payload.slice(),
      options,
      admission: admission ? Object.freeze({ ...admission }) : null,
      sentBytes: 0,
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
   * Resolve only after the logical FIFO and the current physical driver call
   * are both idle. Cancellation removes the waiter but never interrupts a
   * physical write whose outcome is already uncertain.
   */
  waitForIdle(signal?: AbortSignal): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('serial write drain cancelled'));
    return new Promise<void>((resolve, reject) => {
      const waiter: IdleWaiter = {
        resolve,
        reject,
        detachAbort: () => undefined,
      };
      const onAbort = () => {
        if (!this.idleWaiters.delete(waiter)) return;
        waiter.detachAbort();
        reject(new Error('serial write drain cancelled'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.idleWaiters.add(waiter);
      // Defensive re-check: a custom driver thenable may settle synchronously
      // while this waiter is being installed.
      this.resolveIdleWaiters();
    });
  }

  /**
   * Stop accepting writes, reject every operation that has not started, and
   * allow only the current driver call to settle for `graceMs`.
   */
  async shutdown(graceMs = SERIAL_WRITE_CLOSE_GRACE_MS): Promise<SerialWriteShutdownResult> {
    this.accepting = false;
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      if (queued) this.settle(queued, cancelled(queued.payload.length));
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
      this.settle(active, cancelled(active.payload.length, active.sentBytes));
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
      this.resolveIdleWaiters();
    }
  }

  private async writeOperation(operation: WriteOperation): Promise<SerialSendResult> {
    if (!this.authorized(operation.admission)) {
      return denied(operation.payload.length, operation.sentBytes);
    }
    try {
      operation.options.onWriteStarted?.();
    } catch {
      return writeFailure(operation.payload.length, 0);
    }

    while (operation.sentBytes < operation.payload.length) {
      if (!this.accepting) return cancelled(operation.payload.length, operation.sentBytes);
      // Keep the logical 4 KiB boundary stable across short writes. A short
      // result continues only the suffix of this chunk before advancing.
      const logicalChunkEnd = Math.min(
        operation.sentBytes + this.limits.chunkBytes,
        operation.payload.length,
      );
      while (operation.sentBytes < logicalChunkEnd) {
        if (operation.settled) {
          return cancelled(operation.payload.length, operation.sentBytes);
        }

        if (!this.accepting) return cancelled(operation.payload.length, operation.sentBytes);
        if (!this.authorized(operation.admission)) {
          return denied(operation.payload.length, operation.sentBytes);
        }
        const chunk = operation.payload.subarray(operation.sentBytes, logicalChunkEnd);
        let written: number;
        try {
          written = await this.writeChunk(chunk);
        } catch {
          return this.accepting
            ? writeFailure(operation.payload.length, operation.sentBytes)
            : cancelled(operation.payload.length, operation.sentBytes);
        }

        // A shutdown may have settled the logical operation while the native
        // promise was still pending. Ignore that stale completion entirely.
        if (operation.settled) {
          return cancelled(operation.payload.length, operation.sentBytes);
        }
        if (!Number.isInteger(written) || written <= 0 || written > chunk.length) {
          return this.accepting
            ? writeFailure(operation.payload.length, operation.sentBytes)
            : cancelled(operation.payload.length, operation.sentBytes);
        }
        operation.sentBytes += written;
        this.outstandingBytes -= written;
        if (!this.accepting) return cancelled(operation.payload.length, operation.sentBytes);
      }
    }

    if (operation.sentBytes !== operation.payload.length) {
      return writeFailure(operation.payload.length, operation.sentBytes);
    }
    return {
      outcome: 'complete',
      requestedBytes: operation.payload.length,
      sentBytes: operation.payload.length,
    };
  }

  private settle(operation: WriteOperation, result: SerialSendResult): void {
    if (operation.settled) return;
    operation.settled = true;
    const remaining = operation.payload.length - operation.sentBytes;
    this.outstandingBytes = Math.max(0, this.outstandingBytes - remaining);
    this.outstandingOperations = Math.max(0, this.outstandingOperations - 1);
    operation.resolve(result);
  }

  private authorized(admission: SerialWriteAdmission | null): boolean {
    if (!this.admissionGate) return true;
    if (!admission) return false;
    try {
      return this.admissionGate.authorize(admission);
    } catch {
      return false;
    }
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.activeOperation === null && !this.draining;
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle() || this.idleWaiters.size === 0) return;
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    for (const waiter of waiters) {
      waiter.detachAbort();
      waiter.resolve();
    }
  }
}
