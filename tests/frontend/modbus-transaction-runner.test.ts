import test from 'node:test';
import assert from 'node:assert/strict';
import { ModbusTransactionRunner } from '../../src/lib/modbus';
import { frameRequest, readRequest } from '../../src/lib/modbus';
import type { ModbusTransactionStatus } from '../../src/lib/modbus';

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
    sendBytes(payload) {
      sent.push(payload);
      return Promise.resolve(true);
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

test('send false resolves null and emits an error status', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: () => Promise.resolve(false),
    getTransport: () => 'rtu',
    getTimeoutMs: () => 100,
    onStatus: (status) => statuses.push(status),
  });

  const response = await resolvesWithin(
    runner.transact('send-false', () => readRequest('rtu', 1, 0x03, 10, 1), undefined),
    40,
  );

  assert.equal(response, null);
  assert.deepEqual(statuses, [{ kind: 'error', message: 'send returned false' }]);
  assert.equal(runner.hasPending(), false);
});

test('cancel resolves the active transaction immediately', async () => {
  const statuses: ModbusTransactionStatus[] = [];
  const runner = new ModbusTransactionRunner<string>({
    sendBytes: () => Promise.resolve(true),
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
    sendBytes: () => Promise.resolve(true),
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
