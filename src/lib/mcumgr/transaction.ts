import type { McumgrSmpVersion } from '../../types/mcumgr';
import { McumgrError } from './errors';
import {
  decodeSmpPacket,
  encodeSmpRequest,
  nextSequence,
  packetMatchesRequest,
  parseSmpError,
  SMP_OP,
  type SmpHeader,
  type SmpOp,
  type SmpPacket,
} from './smp';
import type { McumgrTransportCodec } from './transport';

export interface McumgrWriteResult {
  outcome: 'complete' | 'partial' | 'failed';
  requestedBytes: number;
  sentBytes: number;
}

export interface McumgrTransactionRequest {
  version: McumgrSmpVersion;
  op: typeof SMP_OP.read | typeof SMP_OP.write;
  group: number;
  command: number;
  payload?: Uint8Array;
  timeoutMs?: number;
  retries?: number;
}

export interface McumgrTransactionRunnerOptions {
  write: (payload: Uint8Array) => Promise<McumgrWriteResult>;
  getTransport: () => McumgrTransportCodec;
  getTimeoutMs: () => number;
  getRetries: () => number;
}

interface Pending {
  request: SmpHeader;
  resolve: (packet: SmpPacket) => void;
  reject: (error: McumgrError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class McumgrTransactionRunner {
  private sequence = 0;
  private pending: Pending | null = null;
  private readonly options: McumgrTransactionRunnerOptions;

  constructor(options: McumgrTransactionRunnerOptions) {
    this.options = options;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  receive(bytes: Uint8Array): void {
    if (!this.pending) return;
    let packets: Uint8Array[];
    try {
      packets = this.options.getTransport().push(bytes);
    } catch (error) {
      this.fail(
        new McumgrError(
          'protocol-error',
          error instanceof Error ? error.message : 'transport decode failed',
        ),
      );
      return;
    }
    for (const raw of packets) {
      const pending = this.pending;
      if (!pending) return;
      let packet: SmpPacket;
      try {
        packet = decodeSmpPacket(raw);
      } catch {
        continue;
      }
      if (packet.header.sequence !== pending.request.sequence) continue;
      if (!packetMatchesRequest(pending.request, packet.header)) {
        this.fail(new McumgrError('protocol-error', 'SMP response header does not match request'));
        return;
      }
      const device = parseSmpError(packet.payload);
      if (device) {
        this.fail(new McumgrError('device-error', device.rsn ?? `mcumgr rc ${device.rc}`, device));
        return;
      }
      this.clearTimer();
      this.pending = null;
      pending.resolve(packet);
      return;
    }
  }

  async transact(request: McumgrTransactionRequest): Promise<SmpPacket> {
    if (this.pending)
      throw new McumgrError('protocol-error', 'an SMP transaction is already pending');
    const readOnly = request.op === SMP_OP.read;
    const attempts = readOnly ? 1 + (request.retries ?? this.options.getRetries()) : 1;
    let lastError: McumgrError | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.attempt(request);
      } catch (error) {
        const classified =
          error instanceof McumgrError
            ? error
            : new McumgrError(
                'io-error',
                error instanceof Error ? error.message : 'SMP I/O failed',
              );
        lastError = classified;
        if (!readOnly || classified.kind !== 'timeout') throw classified;
      }
    }
    throw lastError ?? new McumgrError('timeout', 'SMP request timed out');
  }

  cancel(message = 'SMP transaction cancelled'): void {
    this.fail(new McumgrError('cancelled', message));
  }

  reset(): void {
    this.cancel();
    this.options.getTransport().reset();
  }

  private attempt(request: McumgrTransactionRequest): Promise<SmpPacket> {
    const sequence = this.sequence;
    this.sequence = nextSequence(this.sequence);
    const packet = encodeSmpRequest({
      version: request.version,
      op: request.op,
      group: request.group,
      command: request.command,
      sequence,
      payload: request.payload,
    });
    const header = decodeSmpPacket(packet).header;
    const wire = this.options.getTransport().encode(packet);
    const timeoutMs = request.timeoutMs ?? this.options.getTimeoutMs();

    return new Promise<SmpPacket>((resolve, reject) => {
      this.pending = {
        request: header,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(new McumgrError('timeout', 'SMP request timed out'));
        }, timeoutMs),
      };
      void this.writeAndWatch(wire, request.op);
    });
  }

  private async writeAndWatch(wire: Uint8Array, op: SmpOp): Promise<void> {
    try {
      const result = await this.options.write(wire);
      if (result.outcome === 'complete' && result.sentBytes === result.requestedBytes) return;
      if (result.sentBytes === 0) {
        this.fail(new McumgrError('io-error', 'serial write failed before any bytes were sent'));
        return;
      }
      if (result.outcome === 'partial' || result.sentBytes < result.requestedBytes) {
        this.fail(
          new McumgrError(
            'partial-write',
            `serial write stopped after ${result.sentBytes} of ${result.requestedBytes} bytes`,
          ),
        );
        return;
      }
      this.fail(
        new McumgrError('unknown-outcome', 'serial write finished without a confirmed outcome'),
      );
    } catch (error) {
      if (error instanceof McumgrError) {
        this.fail(error);
        return;
      }
      this.fail(
        new McumgrError(
          op === SMP_OP.write ? 'unknown-outcome' : 'io-error',
          error instanceof Error ? error.message : 'serial write failed',
        ),
      );
    }
  }

  private fail(error: McumgrError): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearTimer();
    this.pending = null;
    pending.reject(error);
  }

  private clearTimer(): void {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
  }
}
