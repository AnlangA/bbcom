import { parseFrame, scanResponse, type ModbusTransport } from './modbus-transport';
import type { ModbusResponse } from './modbus-core';
import type { IpcError } from '@/generated/ipc-contracts';
import type { SerialSendResult, SerialWriteOptions } from '@/types/serial';

/**
 * Modbus RTU ADUs are capped at 256 bytes (and Modbus PDUs at 253 bytes).
 * Retaining at most one incomplete ADU prevents a noisy serial stream from
 * growing a per-request RX buffer until the request times out.
 */
export const MAX_MODBUS_TRANSACTION_RX_BYTES = 256;
const MODBUS_RX_PROCESS_CHUNK_BYTES = 4 * 1024;

export type ModbusTransactionStatus =
  | { kind: 'timeout' }
  | {
      kind: 'error';
      message: string;
      messageKey?: string;
      ipcCode?: IpcError['code'];
    };

interface PendingTransaction<TContext> {
  context: TContext;
  resolve: (response: ModbusResponse | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  /** Expected PDU length for the response (PDU transport needs this). */
  expectedLen?: number;
}

export interface ModbusTransactionRunnerOptions {
  sendBytes: (payload: Uint8Array, options?: SerialWriteOptions) => Promise<SerialSendResult>;
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
    if (!this.pending || !this.pending.started) {
      // Unsolicited bytes (e.g. late echo, noise). Drop to avoid framing drift.
      this.rxBuffer = new Uint8Array(0);
      return;
    }

    let offset = 0;
    while (offset < bytes.length && this.pending?.started) {
      const end = Math.min(bytes.length, offset + MODBUS_RX_PROCESS_CHUNK_BYTES);
      this.rxBuffer = appendRxChunk(this.rxBuffer, bytes.subarray(offset, end));
      offset = end;

      const { frames, remainder } = scanResponse(
        this.options.getTransport(),
        this.rxBuffer,
        this.pending.expectedLen,
      );
      this.rxBuffer = retainIncompleteAdu(remainder);
      if (frames.length === 0) continue;

      const response = parseFrame(this.options.getTransport(), frames[0]);
      const current = this.pending;
      if (current.timer) clearTimeout(current.timer);
      this.pending = null;
      // A response resolves exactly one half-duplex request. Extra bytes from
      // the same native callback are unsolicited for the next request and must
      // not retain a large backing allocation.
      this.rxBuffer = new Uint8Array(0);
      current.resolve(response);
    }
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
            : serialSendFailureStatus();
        if (!this.cancelForContext(context, status)) resolve(null);
      };

      this.pending = { context, resolve, timer: null, started: false, expectedLen };
      this.rxBuffer = new Uint8Array(0);

      let wire: Uint8Array;
      try {
        wire = buildWire();
      } catch (error) {
        failSend(error);
        return;
      }

      let sent: Promise<SerialSendResult>;
      try {
        sent = this.options.sendBytes(wire, {
          onWriteStarted: () => this.startTimeout(context),
        });
      } catch (error) {
        failSend(error);
        return;
      }

      void sent.then((result) => {
        if (result.outcome !== 'complete' || result.sentBytes !== result.requestedBytes) {
          const status = serialSendFailureStatus(result.error);
          if (!this.cancelForContext(context, status)) resolve(null);
          return;
        }
        // Defensive fallback for a custom transport that ignores the hook.
        this.startTimeout(context);
      }, failSend);
    });
  }

  cancel(status?: ModbusTransactionStatus): boolean {
    if (!this.pending) {
      this.rxBuffer = new Uint8Array(0);
      return false;
    }
    const current = this.pending;
    if (current.timer) clearTimeout(current.timer);
    this.pending = null;
    this.rxBuffer = new Uint8Array(0);
    if (status) this.options.onStatus?.(status);
    current.resolve(null);
    return true;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Number of retained incomplete-response bytes (always protocol-bounded). */
  get pendingRxBytes(): number {
    return this.rxBuffer.length;
  }

  private startTimeout(context: TContext): void {
    if (!this.pending || this.pending.context !== context || this.pending.timer !== null) {
      return;
    }
    this.pending.started = true;
    this.rxBuffer = new Uint8Array(0);
    this.pending.timer = setTimeout(() => {
      this.cancelForContext(context, { kind: 'timeout' });
    }, this.options.getTimeoutMs());
  }

  private cancelForContext(context: TContext, status?: ModbusTransactionStatus): boolean {
    if (!this.pending || this.pending.context !== context) return false;
    return this.cancel(status);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serialSendFailureStatus(error?: IpcError): ModbusTransactionStatus {
  const messageKey = error?.messageKey ?? 'error.serial_send_failed';
  return {
    kind: 'error',
    message: messageKey,
    messageKey,
    ...(error ? { ipcCode: error.code } : {}),
  };
}

function appendRxChunk(existing: Uint8Array, incoming: Uint8Array): Uint8Array {
  const combined = new Uint8Array(existing.length + incoming.length);
  combined.set(existing, 0);
  combined.set(incoming, existing.length);
  return combined;
}

function retainIncompleteAdu(remainder: Uint8Array): Uint8Array {
  // A complete 256-byte ADU would have been emitted by `scanResponse`; retain
  // at most the 255-byte prefix that could still become a complete future ADU.
  const start = Math.max(0, remainder.length - (MAX_MODBUS_TRANSACTION_RX_BYTES - 1));
  return remainder.slice(start);
}
