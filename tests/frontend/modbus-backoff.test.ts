import test from 'node:test';
import assert from 'node:assert/strict';
import { ModbusBackoff } from '../../src/lib/modbus';

test('keeps the base cadence for a single transient failure', () => {
  const backoff = new ModbusBackoff({ failureThreshold: 2, maxDelayMs: 1_000 });

  assert.equal(backoff.delayFor(100), 100);
  assert.equal(backoff.isBackingOff(), false);

  backoff.recordFailure();

  assert.equal(backoff.getConsecutiveFailures(), 1);
  assert.equal(backoff.isBackingOff(), false);
  assert.equal(backoff.delayFor(100), 100);
});

test('ramps delay after consecutive failures and caps at max delay', () => {
  const backoff = new ModbusBackoff({ failureThreshold: 2, multiplier: 2, maxDelayMs: 500 });

  backoff.recordFailure();
  backoff.recordFailure();
  assert.equal(backoff.delayFor(100), 200);

  backoff.recordFailure();
  assert.equal(backoff.delayFor(100), 400);

  backoff.recordFailure();
  assert.equal(backoff.delayFor(100), 500);
});

test('success resets consecutive failures and restores the base cadence', () => {
  const backoff = new ModbusBackoff({ failureThreshold: 2 });

  backoff.recordFailure();
  backoff.recordFailure();
  assert.equal(backoff.isBackingOff(), true);

  backoff.recordSuccess();

  assert.equal(backoff.getConsecutiveFailures(), 0);
  assert.equal(backoff.isBackingOff(), false);
  assert.equal(backoff.delayFor(100), 100);
});
