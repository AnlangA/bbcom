import { encodeUtf8, parseHex } from '@/lib/format';
import { logger } from '@/lib/logger';
import type { SerialWriteAdmission } from '@/lib/serial-write-scheduler';
import { MAX_INPUT_SIZE } from '@/types';
import type { IpcError } from '../../../generated/ipc-contracts';
import type { SerialSendResult, SerialWriteOptions } from '@/types';
import {
  SerialTransactionLeaseError,
  type SerialTransactionOutputLines,
} from './serial-transaction-lease';
import type { ConnectionAttempt } from './serial-shutdown-evidence';
import type { SerialConnectionRuntimeRefs } from './serial-connection-runtime';
import type { SerialConnectionSink, TimerPort } from './serial-connection-types';

/** Result of validating + encoding a send payload before it enters the queue. */
export type SendPayloadResult =
  | { ok: true; payload: Uint8Array }
  | {
      ok: false;
      reason: 'empty' | 'bad-hex' | 'too-large';
      requestedBytes: number;
    };

export function buildSendPayload(data: string, isHex: boolean): SendPayloadResult {
  let payload: Uint8Array;
  if (isHex) {
    try {
      payload = parseHex(data);
    } catch {
      return { ok: false, reason: 'bad-hex', requestedBytes: 0 };
    }
    if (payload.length === 0) return { ok: false, reason: 'empty', requestedBytes: 0 };
  } else {
    if (data.length === 0) return { ok: false, reason: 'empty', requestedBytes: 0 };
    payload = encodeUtf8(data);
  }
  if (payload.length > MAX_INPUT_SIZE) {
    return { ok: false, reason: 'too-large', requestedBytes: payload.length };
  }
  return { ok: true, payload };
}

type SendFailureReason = 'empty' | 'bad-hex' | 'too-large' | 'not-connected' | 'busy';

const SERIAL_SEND_OPERATION = 'serial_send';

function sendError(
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

export function failedSend(reason: SendFailureReason, requestedBytes: number): SerialSendResult {
  let error: IpcError;
  switch (reason) {
    case 'too-large':
      error = sendError('LIMIT_EXCEEDED', 'error.limit_exceeded', false, {
        field: 'payload',
        limit: MAX_INPUT_SIZE,
        actual: requestedBytes,
      });
      break;
    case 'not-connected':
      error = sendError('SERIAL_DISCONNECTED', 'error.serial_disconnected', true);
      break;
    case 'busy':
      error = sendError('BUSY', 'error.busy', true);
      break;
    case 'empty':
    case 'bad-hex':
      error = sendError('INVALID_INPUT', 'error.invalid_input', false, { field: 'payload' });
      break;
  }

  return {
    outcome: 'failed',
    requestedBytes,
    sentBytes: 0,
    error,
  };
}

export interface TxPipelineDeps extends SerialConnectionRuntimeRefs {
  sessionId: string;
  sink: SerialConnectionSink;
  timerPort: TimerPort;
}

export interface TxPipeline {
  trackOutputLines(generation: number, applied: Partial<SerialTransactionOutputLines>): void;
  currentTransactionConnection(context: {
    readonly generation: number;
    readonly signal: AbortSignal;
  }): ConnectionAttempt;
  currentGenerationConnection(generation: number): ConnectionAttempt;
  send(data: string, isHex: boolean, writeOptions?: SerialWriteOptions): Promise<SerialSendResult>;
  sendBytes(payload: Uint8Array, writeOptions?: SerialWriteOptions): Promise<SerialSendResult>;
  enqueuePayload(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
    admission?: SerialWriteAdmission,
  ): Promise<SerialSendResult>;
  sendBreak(durationMs?: number): Promise<boolean>;
}

export function createTxPipeline({ state, serialTransactions, sessionId, sink, timerPort }: TxPipelineDeps): TxPipeline {
  function currentTransactionConnection(context: {
    readonly generation: number;
    readonly signal: AbortSignal;
  }): ConnectionAttempt {
    const connection = state.activeConnection;
    if (
      context.signal.aborted ||
      !state.isConnected.value ||
      !connection?.scheduler ||
      connection.generation !== context.generation ||
      connection.generation !== state.connectionGeneration
    ) {
      throw new SerialTransactionLeaseError(context.signal.aborted ? 'cancelled' : 'stale-handle');
    }
    return connection;
  }

  function currentGenerationConnection(generation: number): ConnectionAttempt {
    const connection = state.activeConnection;
    if (
      !state.isConnected.value ||
      !connection?.scheduler ||
      connection.generation !== generation ||
      connection.generation !== state.connectionGeneration
    ) {
      throw new SerialTransactionLeaseError('stale-handle');
    }
    return connection;
  }

  function trackOutputLines(
    generation: number,
    applied: Partial<SerialTransactionOutputLines>,
  ): void {
    if (state.trackedOutputLinesGeneration !== generation) {
      throw new SerialTransactionLeaseError('stale-handle');
    }
    state.trackedOutputLines = Object.freeze({ ...state.trackedOutputLines, ...applied });
  }

  async function enqueuePayload(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
    admission?: SerialWriteAdmission,
  ): Promise<SerialSendResult> {
    const connection = state.activeConnection;
    if (state.isClosing.value || !connection?.scheduler || !state.isConnected.value) {
      return failedSend('not-connected', payload.length);
    }
    const result = await connection.scheduler.enqueue(payload, writeOptions, admission ?? null);
    if (result.sentBytes > 0) {
      const txFrame = sink.addFrame(sessionId, {
        direction: 'TX',
        data: payload.slice(0, result.sentBytes),
        origin: 'serial-tx',
        txStatus: result.outcome === 'complete' ? 'complete' : 'partial-unknown',
        requestedBytes: result.requestedBytes,
      });
      if (txFrame) sink.appendAutoLogFrame(sessionId, txFrame);
    }
    if (result.error?.code === 'SERIAL_PARTIAL_WRITE') {
      logger.warn(
        'serial write did not complete on',
        connection.target.portName,
        result.error.code,
        result.error.messageKey,
      );
    }
    return result;
  }

  async function enqueueManualPayload(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
  ): Promise<SerialSendResult> {
    try {
      return await serialTransactions.runManualWrite(() =>
        enqueuePayload(payload, writeOptions, { source: 'host', ownerId: sessionId }),
      );
    } catch (gateError) {
      if (gateError instanceof SerialTransactionLeaseError) {
        return failedSend(gateError.code === 'busy' ? 'busy' : 'not-connected', payload.length);
      }
      throw gateError;
    }
  }

  async function send(
    data: string,
    isHex: boolean,
    writeOptions?: SerialWriteOptions,
  ): Promise<SerialSendResult> {
    const built = buildSendPayload(data, isHex);
    if (!built.ok) return failedSend(built.reason, built.requestedBytes);
    return enqueueManualPayload(built.payload, writeOptions);
  }

  async function sendBytes(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
  ): Promise<SerialSendResult> {
    if (payload.length === 0) return failedSend('empty', 0);
    if (payload.length > MAX_INPUT_SIZE) return failedSend('too-large', payload.length);
    return enqueueManualPayload(payload, writeOptions);
  }

  async function performSendBreak(durationMs: number): Promise<boolean> {
    const connection = state.activeConnection;
    if (state.isClosing.value || state.breakInFlight || !connection) return false;
    state.breakInFlight = true;
    try {
      await connection.port.setBreak();
      if (connection === state.activeConnection) {
        trackOutputLines(connection.generation, { breakActive: true });
      }
      await timerPort.delay(durationMs);
      await connection.port.clearBreak();
      if (connection === state.activeConnection) {
        trackOutputLines(connection.generation, { breakActive: false });
      }
      return connection === state.activeConnection;
    } catch (breakError) {
      logger.warn('serial setBreak/clearBreak failed on', connection.target.portName, breakError);
      return false;
    } finally {
      state.breakInFlight = false;
    }
  }

  async function sendBreak(durationMs = 250): Promise<boolean> {
    try {
      return await serialTransactions.runManualWrite(() => performSendBreak(durationMs));
    } catch (gateError) {
      if (gateError instanceof SerialTransactionLeaseError) return false;
      throw gateError;
    }
  }

  return {
    trackOutputLines,
    currentTransactionConnection,
    currentGenerationConnection,
    send,
    sendBytes,
    enqueuePayload,
    sendBreak,
  };
}
