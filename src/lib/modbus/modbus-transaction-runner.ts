import { parseFrame, scanResponse, type ModbusTransport } from './modbus-transport';
import type { ModbusResponse } from './modbus-core';

export type ModbusTransactionStatus = { kind: 'timeout' } | { kind: 'error'; message: string };

interface PendingTransaction<TContext> {
  context: TContext;
  resolve: (response: ModbusResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Expected PDU length for the response (PDU transport needs this). */
  expectedLen?: number;
}

export interface ModbusTransactionRunnerOptions {
  sendBytes: (payload: Uint8Array) => Promise<boolean>;
  getTransport: () => ModbusTransport;
  getTimeoutMs: () => number;
  onStatus?: (status: ModbusTransactionStatus) => void;
}

/**
 * Owns the Modbus half-duplex transaction invariant: one outstanding request,
 * one RX accumulation buffer, one timeout. UI/composable layers decide what a
 * request means; this runner only sends bytes and resolves parsed responses.
 */
export class ModbusTransactionRunner<TContext = unknown> {
  private rxBuffer: Uint8Array = new Uint8Array(0);
  private pending: PendingTransaction<TContext> | null = null;
  private readonly options: ModbusTransactionRunnerOptions;

  constructor(options: ModbusTransactionRunnerOptions) {
    this.options = options;
  }

  receive(bytes: Uint8Array): void {
    if (!this.pending) {
      // Unsolicited bytes (e.g. late echo, noise). Drop to avoid framing drift.
      this.rxBuffer = new Uint8Array(0);
      return;
    }

    const concat = new Uint8Array(this.rxBuffer.length + bytes.length);
    concat.set(this.rxBuffer, 0);
    concat.set(bytes, this.rxBuffer.length);
    this.rxBuffer = concat;

    const { frames, remainder } = scanResponse(
      this.options.getTransport(),
      this.rxBuffer,
      this.pending.expectedLen,
    );
    this.rxBuffer = remainder;
    if (frames.length === 0) return;

    const response = parseFrame(this.options.getTransport(), frames[0]);
    const current = this.pending;
    clearTimeout(current.timer);
    this.pending = null;
    current.resolve(response);
  }

  transact(
    context: TContext,
    buildWire: () => Uint8Array,
    expectedLen: number | undefined,
  ): Promise<ModbusResponse | null> {
    return new Promise<ModbusResponse | null>((resolve) => {
      if (this.pending) {
        this.options.onStatus?.({ kind: 'error', message: 'transaction already pending' });
        resolve(null);
        return;
      }

      const failSend = (error?: unknown) => {
        const status: ModbusTransactionStatus =
          error !== undefined
            ? { kind: 'error', message: errorMessage(error) }
            : { kind: 'error', message: 'send returned false' };
        if (!this.cancelForContext(context, status)) resolve(null);
      };

      const timer = setTimeout(() => {
        if (!this.cancelForContext(context, { kind: 'timeout' })) resolve(null);
      }, this.options.getTimeoutMs());

      this.pending = { context, resolve, timer, expectedLen };
      this.rxBuffer = new Uint8Array(0);

      let wire: Uint8Array;
      try {
        wire = buildWire();
      } catch (error) {
        failSend(error);
        return;
      }

      let sent: Promise<boolean>;
      try {
        sent = this.options.sendBytes(wire);
      } catch (error) {
        failSend(error);
        return;
      }

      void sent.then((ok) => {
        if (!ok) failSend();
      }, failSend);
    });
  }

  cancel(status?: ModbusTransactionStatus): boolean {
    if (!this.pending) {
      this.rxBuffer = new Uint8Array(0);
      return false;
    }
    const current = this.pending;
    clearTimeout(current.timer);
    this.pending = null;
    this.rxBuffer = new Uint8Array(0);
    if (status) this.options.onStatus?.(status);
    current.resolve(null);
    return true;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  private cancelForContext(context: TContext, status?: ModbusTransactionStatus): boolean {
    if (!this.pending || this.pending.context !== context) return false;
    return this.cancel(status);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
