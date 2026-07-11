import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ModbusPeriodicOutcomeTracker, isTrackablePeriodicFailure } from '../../src/lib/modbus';
import type { ModbusResponse } from '../../src/lib/modbus';

const successResponse: ModbusResponse = {
  kind: 'write-ack',
  slave: 1,
  fc: 0x06,
  addr: 5,
  count: 1,
};

test('periodic outcome tracker reports backoff after scoped consecutive failures', () => {
  const tracker = new ModbusPeriodicOutcomeTracker({
    read: { failureThreshold: 2, maxDelayMs: 500 },
    write: { failureThreshold: 2, maxDelayMs: 500 },
  });
  const key = '1:3:5:1';

  assert.equal(
    tracker.record(
      'read',
      key,
      { response: null, failure: { kind: 'timeout' } },
      { baseDelayMs: 100, trackFailure: true, now: 1_000 },
    ),
    null,
  );
  assert.equal(tracker.isCoolingDown('read', key, 1_100), false);

  assert.deepEqual(
    tracker.record(
      'read',
      key,
      { response: null, failure: { kind: 'timeout' } },
      { baseDelayMs: 100, trackFailure: true, now: 1_000 },
    ),
    { kind: 'backoff', scope: 'read', key, delayMs: 200, consecutiveFailures: 2 },
  );
  assert.equal(tracker.isCoolingDown('read', key, 1_199), true);
  assert.equal(tracker.isCoolingDown('read', key, 1_200), false);
  assert.equal(tracker.isCoolingDown('write', key, 1_199), false);
});

test('periodic outcome tracker ignores failures while tracking is disabled', () => {
  const tracker = new ModbusPeriodicOutcomeTracker({ read: { failureThreshold: 2 } });
  const key = '1:3:5:1';

  assert.equal(
    tracker.record(
      'read',
      key,
      { response: null, failure: { kind: 'timeout' } },
      { baseDelayMs: 100, trackFailure: false },
    ),
    null,
  );
  assert.equal(tracker.getConsecutiveFailures('read', key), 0);

  assert.equal(
    tracker.record(
      'read',
      key,
      { response: null, failure: { kind: 'timeout' } },
      { baseDelayMs: 100, trackFailure: true },
    ),
    null,
  );
  assert.equal(tracker.getConsecutiveFailures('read', key), 1);
});

test('periodic outcome tracker ignores null failures and resets on success', () => {
  const tracker = new ModbusPeriodicOutcomeTracker({ write: { failureThreshold: 2 } });
  const key = '1:register:6:5:1';

  tracker.record(
    'write',
    key,
    { response: null, failure: { kind: 'error', message: 'port closed' } },
    { baseDelayMs: 100, trackFailure: true },
  );
  tracker.record(
    'write',
    key,
    { response: null, failure: null },
    { baseDelayMs: 100, trackFailure: true },
  );
  assert.equal(tracker.getConsecutiveFailures('write', key), 1);

  tracker.record(
    'write',
    key,
    { response: successResponse, failure: null },
    { baseDelayMs: 100, trackFailure: true },
  );
  assert.equal(tracker.getConsecutiveFailures('write', key), 0);
});

test('periodic outcome tracker reset clears read and write counters together', () => {
  const tracker = new ModbusPeriodicOutcomeTracker({ read: { failureThreshold: 2 } });

  tracker.record(
    'read',
    '1:3:5:1',
    { response: null, failure: { kind: 'timeout' } },
    { baseDelayMs: 100, trackFailure: true },
  );
  tracker.record(
    'write',
    '1:register:6:5:1',
    { response: null, failure: { kind: 'error', message: 'send returned false' } },
    { baseDelayMs: 100, trackFailure: true },
  );

  tracker.reset();

  assert.equal(tracker.getConsecutiveFailures('read', '1:3:5:1'), 0);
  assert.equal(tracker.getConsecutiveFailures('write', '1:register:6:5:1'), 0);
});

test('periodic outcome tracker keeps independent counters per batch key', () => {
  const tracker = new ModbusPeriodicOutcomeTracker({ read: { failureThreshold: 2 } });

  tracker.record(
    'read',
    'offline',
    { response: null, failure: { kind: 'timeout' } },
    { baseDelayMs: 100, trackFailure: true, now: 0 },
  );
  const status = tracker.record(
    'read',
    'offline',
    { response: null, failure: { kind: 'timeout' } },
    { baseDelayMs: 100, trackFailure: true, now: 0 },
  );

  assert.equal(status?.key, 'offline');
  assert.equal(tracker.isCoolingDown('read', 'offline', 100), true);
  assert.equal(tracker.isCoolingDown('read', 'healthy', 100), false);
  assert.equal(tracker.getConsecutiveFailures('read', 'healthy'), 0);
});

test('isTrackablePeriodicFailure accepts timeout and error transaction statuses only', () => {
  assert.equal(isTrackablePeriodicFailure({ kind: 'timeout' }), true);
  assert.equal(isTrackablePeriodicFailure({ kind: 'error', message: 'send returned false' }), true);
  assert.equal(isTrackablePeriodicFailure(null), false);
});
