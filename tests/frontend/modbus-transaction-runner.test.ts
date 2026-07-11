import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { MAX_MODBUS_TRANSACTION_RX_BYTES, ModbusTransactionRunner } from '../../src/lib/modbus';
import { frameRequest, readRequest } from '../../src/lib/modbus';
import type { ModbusTransactionStatus } from '../../src/lib/modbus';
import type { SerialSendResult } from '../../src/types/serial.ts';

function sendResult(ok: boolean, bytes = 8): SerialSendResult {
  return ok
    ? {
        status: 'complete',
        ok: true,
        requestedBytes: bytes,
        confirmedBytes: bytes,
        bytesWritten: bytes,
        reason: null,
      }
    : {
        status: 'partial-unknown',
        ok: false,
        requestedBytes: bytes,
        confirmedBytes: 0,
        bytesWritten: 0,
        reason: 'write-error',
        code: 'SERIAL_PARTIAL_WRITE',
        error: 'send failed',
      };
}

function rtuReadRegs(slave: number, fc: number, regs: number[]): Uint8Array {
  const pdu = new Uint8Array(2 + regs.length * 2);
  pdu[0] = fc;
  pdu[1] = regs.length * 2;
  regs.forEach((value, i) => {
    pdu[2 + i * 2] = (value >>> 8) & 0xff;
    pdu[2 + i * 2 + 1] = value & 0xff;
  });
  return frameRequest('rtu', slave, pdu);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = Symbol('timeout');
  const result = await Promise.race([promise, delay(ms).then(() => timeout)]);
  assert.notEqual(result, timeout, `promise did not resolve within ${ms}ms`);
  return result as T;
}

test('resolves a transaction from split RTU response bytes', async () => {
  const sent: Uint8Array[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes(payload, options) {
      sent.push(payload);
      options?.onWriteStarted?.();
      return Promise.resolve(sendResult(true, payload.length));
    },
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
  });

  const pending = runner.transact('read', () => readRequest('rtu', 1, 0x03, 10, 1), undefined);
  const response = rtuReadRegs(1, 0x03, [42]);
  runner.receive(response.subarray(0, 3));
  assert.equal(runner.hasPending(), true);
  runner.receive(response.subarray(3));

  const parsed = await resolvesWithin(pending, 40);
  assert.equal(sent.length, 1);
  assert.equal(parsed?.kind, 'read-regs');
  if (parsed?.kind === 'read-regs') assert.deepEqual(parsed.regs, [42]);
  assert.equal(runner.hasPending(), false);
});

test('send failure resolves null and emits an error status', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: () => Promise.resolve(sendResult(false)),
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
    onStatus: (status) => statuses.push(status),
  });

  const response = await resolvesWithin(
    runner.transact('send-false', () => readRequest('rtu', 1, 0x03, 10, 1), undefined),
    40,
  );

  assert.equal(response, null);
  assert.deepEqual(statuses, [{ kind: 'error', message: 'send failed' }]);
  assert.equal(runner.hasPending(), false);
});

test('cancel resolves the active transaction immediately', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: (_payload, options) => {
      options?.onWriteStarted?.();
      return Promise.resolve(sendResult(true));
    },
    getTransport: () => 'rtu',
    getTimeoutMs: () => 1000,
    onStatus: (status) => statuses.push(status),
  });

  const pending = runner.transact('cancel-me', () => readRequest('rtu', 1, 0x03, 10, 1), undefined);
  await delay(10);

  assert.equal(runner.cancel({ kind: 'error', message: 'connection closed' }), true);
  assert.equal(await resolvesWithin(pending, 40), null);
  assert.deepEqual(statuses, [{ kind: 'error', message: 'connection closed' }]);
  assert.equal(runner.hasPending(), false);
});

test('rejects a second transaction while one is already pending', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: (_payload, options) => {
      options?.onWriteStarted?.();
      return Promise.resolve(sendResult(true));
    },
    getTransport: () => 'rtu',
    getTimeoutMs: () => 1000,
    onStatus: (status) => statuses.push(status),
  });

  const first = runner.transact('first', () => readRequest('rtu', 1, 0x03, 10, 1), undefined);
  const second = runner.transact('second', () => readRequest('rtu', 1, 0x03, 11, 1), undefined);

  assert.equal(await resolvesWithin(second, 40), null);
  assert.deepEqual(statuses, [{ kind: 'error', message: 'transaction already pending' }]);
  assert.equal(runner.hasPending(), true);

  runner.receive(rtuReadRegs(1, 0x03, [55]));
  const parsed = await resolvesWithin(first, 40);
  assert.equal(parsed?.kind, 'read-regs');
  if (parsed?.kind === 'read-regs') assert.deepEqual(parsed.regs, [55]);
});

test('response timeout starts when a queued request reaches the writer', async () => {
  let onWriteStarted: (() => void) | undefined;
  const sent = deferred<SerialSendResult>();
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: (_payload, options) => {
      onWriteStarted = options?.onWriteStarted;
      return sent.promise;
    },
    getTransport: () => 'rtu',
    getTimeoutMs: () => 20,
    onStatus: (status) => statuses.push(status),
  });

  const pending = runner.transact('queued', () => readRequest('rtu', 1, 0x03, 10, 1), undefined);
  await delay(35);
  assert.equal(runner.hasPending(), true, 'queue wait must not consume the response timeout');
  assert.deepEqual(statuses, []);
  runner.receive(rtuReadRegs(1, 0x03, [999]));
  assert.equal(runner.hasPending(), true, 'a late response before the write starts is ignored');

  onWriteStarted?.();
  sent.resolve(sendResult(true));
  assert.equal(await resolvesWithin(pending, 60), null);
  assert.deepEqual(statuses, [{ kind: 'timeout' }]);
});

test('bounds retained Modbus RX bytes under a noisy pending request', async () => {
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: (_payload, options) => {
      options?.onWriteStarted?.();
      return Promise.resolve(sendResult(true));
    },
    getTransport: () => 'rtu',
    getTimeoutMs: () => 1_000,
  });

  const pending = runner.transact('noisy', () => readRequest('rtu', 1, 0x03, 10, 1), undefined);
  const noise = new Uint8Array(64 * 1024);
  for (let index = 0; index < 8; index += 1) {
    runner.receive(noise);
    assert.ok(runner.pendingRxBytes < MAX_MODBUS_TRANSACTION_RX_BYTES);
  }

  assert.equal(runner.cancel(), true);
  assert.equal(await resolvesWithin(pending, 40), null);
});

test('transaction setup failures resolve deterministically and do not leave a pending buffer', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const buildFailure = new ModbusTransactionRunner<string>({
    sendBytes: () => Promise.resolve(sendResult(true)),
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(
    await buildFailure.transact(
      'bad-wire',
      () => {
        throw new Error('cannot build request');
      },
      undefined,
    ),
    null,
  );
  assert.equal(buildFailure.hasPending(), false);
  assert.equal(buildFailure.pendingRxBytes, 0);

  const sendFailure = new ModbusTransactionRunner<string>({
    sendBytes: () => {
      throw new Error('writer unavailable');
    },
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(await sendFailure.transact('bad-send', () => new Uint8Array([1]), undefined), null);
  assert.equal(sendFailure.cancel(), false, 'cancel is idempotent after setup failure');
  assert.deepEqual(
    statuses.map((status) => status.kind),
    ['error', 'error'],
  );
});

test('duplicate write-start hooks do not restart a pending timeout', async () => {
  vi.useFakeTimers();
  try {
    let onWriteStarted: (() => void) | undefined;
    const runner = new ModbusTransactionRunner<string>({
      sendBytes: (_payload, options) => {
        onWriteStarted = options?.onWriteStarted;
        return Promise.resolve(sendResult(true));
      },
      getTransport: () => 'rtu',
      getTimeoutMs: () => 20,
    });
    const pending = runner.transact('once', () => new Uint8Array([1]), undefined);
    onWriteStarted?.();
    await vi.advanceTimersByTimeAsync(10);
    onWriteStarted?.();
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(await pending, null);
    assert.equal(runner.hasPending(), false);
  } finally {
    vi.useRealTimers();
  }
});

test('failed send without driver detail uses the stable fallback and late failure is ignored', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: () =>
      Promise.resolve({
        status: 'rejected',
        ok: false,
        requestedBytes: 1,
        confirmedBytes: 0,
        bytesWritten: 0,
        reason: null,
      }),
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(await runner.transact('fallback', () => new Uint8Array([1]), undefined), null);
  assert.deepEqual(statuses, [{ kind: 'error', message: 'send returned false' }]);

  const send = deferred<SerialSendResult>();
  const late = new ModbusTransactionRunner<string>({
    sendBytes: () => send.promise,
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
  });
  const pending = late.transact('late', () => new Uint8Array([1]), undefined);
  assert.equal(late.cancel(), true);
  send.resolve({
    status: 'partial-unknown',
    ok: false,
    requestedBytes: 1,
    confirmedBytes: 0,
    bytesWritten: 0,
    reason: 'write-error',
  });
  assert.equal(await pending, null);
  await Promise.resolve();
  assert.equal(late.hasPending(), false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
