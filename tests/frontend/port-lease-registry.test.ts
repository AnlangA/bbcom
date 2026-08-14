import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { HeldPortLeaseState } from '../../src/features/serial/application/port-lease-registry.ts';
import {
  InvalidPortLeaseTransitionError,
  PortLeaseIdCollisionError,
  PortLeaseInUseError,
  PortLeaseOwnershipError,
  PortLeaseRegistry,
  PortLeaseRegistryShutdownError,
  canonicalizePort,
} from '../../src/features/serial/application/port-lease-registry.ts';

function sequenceIds(): () => string {
  let sequence = 0;
  return () => `lease-${++sequence}`;
}

test('canonicalization has explicit strict Windows, Unix, and fallback policies', () => {
  assert.equal(canonicalizePort('com1', 'windows'), 'COM1');
  assert.equal(canonicalizePort('\\\\.\\com1', 'windows'), 'COM1');
  assert.equal(canonicalizePort('COM2048', 'windows'), 'COM2048');
  assert.throws(() => canonicalizePort('COM01', 'windows'));
  assert.throws(() => canonicalizePort('LPT1', 'windows'));
  assert.throws(() => canonicalizePort(' COM1', 'windows'));
  assert.throws(() => canonicalizePort('COM1\0', 'windows'));

  assert.equal(
    canonicalizePort('/dev//serial/./by-id/device-1', 'unix'),
    '/dev/serial/by-id/device-1',
  );
  assert.throws(() => canonicalizePort('/dev/serial/../ttyUSB0', 'unix'));
  assert.throws(() => canonicalizePort('dev/ttyUSB0', 'unix'));
  assert.throws(() => canonicalizePort('/tmp/ttyUSB0', 'unix'));
  assert.throws(() => canonicalizePort('/dev/', 'unix'));

  assert.equal(canonicalizePort('/host/device', 'other'), '/host/device');
  assert.equal(canonicalizePort('C:\\host\\device', 'other'), 'C:\\host\\device');
  assert.throws(() => canonicalizePort('relative-device', 'other'));
});

test('synchronous contenders have one winner, aliases are idempotent, and conflict is navigable', () => {
  let factoryCalls = 0;
  const registry = new PortLeaseRegistry({
    platform: 'windows',
    leaseIdFactory: () => {
      factoryCalls += 1;
      return `lease-${factoryCalls}`;
    },
  });
  const first = registry.acquire('com1', 'session-1', 'Primary session');
  const reentry = registry.acquire('\\\\.\\COM1', 'session-1', 'Renamed session');

  assert.equal(first.leaseId, 'lease-1');
  assert.equal(first.state, 'opening');
  assert.strictEqual(first.leaseId, reentry.leaseId);
  assert.equal(factoryCalls, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.owner), true);

  let conflict: PortLeaseInUseError | undefined;
  try {
    registry.acquire('COM1', 'session-2', 'Competing session');
  } catch (error) {
    if (error instanceof PortLeaseInUseError) conflict = error;
    else throw error;
  }
  assert.ok(conflict);
  assert.deepEqual(conflict.conflict, {
    ownerSessionId: 'session-1',
    ownerSessionName: 'Primary session',
    canonicalPort: 'COM1',
  });
  assert.deepEqual(Object.keys(conflict.conflict).sort(), [
    'canonicalPort',
    'ownerSessionId',
    'ownerSessionName',
  ]);
  assert.equal(Object.isFrozen(conflict.conflict), true);
  assert.equal(registry.size, 1);

  const race = new PortLeaseRegistry({ platform: 'windows', leaseIdFactory: sequenceIds() });
  const outcomes = ['session-a', 'session-b'].map((sessionId) => {
    try {
      return race.acquire('COM9', sessionId, sessionId);
    } catch (error) {
      return error;
    }
  });
  assert.equal(outcomes.filter((outcome) => outcome instanceof PortLeaseInUseError).length, 1);
  assert.equal(outcomes.filter((outcome) => !(outcome instanceof Error)).length, 1);
  assert.equal(race.snapshot().length, 1);
});

test('release and transition require both identifiers and acquisition fails atomically', () => {
  const registry = new PortLeaseRegistry({
    platform: 'windows',
    leaseIdFactory: () => 'lease-fixed',
  });
  const lease = registry.acquire('COM2', 'session-owner', 'Owner');

  assert.equal(registry.release('lease-other', 'session-owner'), false);
  assert.equal(registry.release(lease.leaseId, 'session-other'), false);
  assert.equal(registry.getByPort('com2')?.leaseId, lease.leaseId);
  assert.throws(
    () => registry.transition(lease.leaseId, 'session-other', 'connected'),
    PortLeaseOwnershipError,
  );
  assert.equal(registry.getByPort('COM2')?.state, 'opening');

  assert.throws(
    () => registry.acquire('COM3', 'session-second', 'Second'),
    PortLeaseIdCollisionError,
  );
  assert.equal(registry.getByPort('COM3'), undefined);
  assert.equal(registry.size, 1);
  assert.throws(() => registry.acquire('COM4', 'session-third', 'x'.repeat(129)));
  assert.equal(registry.getByPort('COM4'), undefined);

  assert.equal(registry.release(lease.leaseId, 'session-owner'), true);
  assert.equal(registry.release(lease.leaseId, 'session-owner'), false);
  assert.equal(registry.size, 0);
});

test('the lease state graph permits only documented active transitions', () => {
  const registry = new PortLeaseRegistry({ platform: 'windows', leaseIdFactory: sequenceIds() });
  const allowedPaths: readonly (readonly HeldPortLeaseState[])[] = [
    ['connected', 'reconnecting', 'connected', 'failed'],
    ['closing'],
    ['connected', 'closing'],
    ['connected', 'reconnecting', 'closing'],
    ['connected', 'reconnecting', 'failed'],
    ['failed'],
  ];

  allowedPaths.forEach((path, index) => {
    const sessionId = `session-${index}`;
    const lease = registry.acquire(`COM${index + 10}`, sessionId, sessionId);
    let current = lease;
    for (const state of path) current = registry.transition(lease.leaseId, sessionId, state);
    assert.equal(current.state, path.at(-1));
    assert.throws(
      () => registry.transition(lease.leaseId, sessionId, 'connected'),
      InvalidPortLeaseTransitionError,
    );
  });

  const invalid = registry.acquire('COM20', 'session-invalid', 'Invalid transitions');
  assert.throws(
    () => registry.transition(invalid.leaseId, 'session-invalid', 'reconnecting'),
    InvalidPortLeaseTransitionError,
  );
  assert.throws(
    () => registry.transition(invalid.leaseId, 'session-invalid', 'idle' as HeldPortLeaseState),
    InvalidPortLeaseTransitionError,
  );
  assert.equal(registry.getByPort('COM20')?.state, 'opening');
});

test('releaseSession, subscriptions, custom strategy, and shutdown provide lifecycle fallbacks', () => {
  const observedSizes: number[] = [];
  const registry = new PortLeaseRegistry({ platform: 'unix', leaseIdFactory: sequenceIds() });
  const detach = registry.subscribe((leases) => observedSizes.push(leases.length));
  registry.acquire('/dev/ttyUSB0', 'session-1', 'One');
  registry.acquire('/dev/ttyUSB1', 'session-1', 'One');
  registry.acquire('/dev/ttyACM0', 'session-2', 'Two');
  assert.deepEqual(observedSizes, [0, 1, 2, 3]);
  assert.equal(Object.isFrozen(registry.snapshot()), true);
  assert.equal(Object.isFrozen(registry.getBySession('session-1')), true);
  assert.equal(registry.getBySession('session-1').length, 2);

  detach();
  assert.equal(registry.releaseSession('session-1'), 2);
  assert.deepEqual(observedSizes, [0, 1, 2, 3]);
  assert.equal(registry.getBySession('session-1').length, 0);
  assert.equal(registry.size, 1);
  assert.equal(registry.shutdown(), 1);
  assert.equal(registry.shutdown(), 0);
  assert.equal(registry.size, 0);
  assert.throws(
    () => registry.acquire('/dev/ttyUSB2', 'session-3', 'Three'),
    PortLeaseRegistryShutdownError,
  );

  const custom = new PortLeaseRegistry({
    canonicalizer: (port) => port.toUpperCase(),
    leaseIdFactory: sequenceIds(),
  });
  const customLease = custom.acquire('usb:device-a', 'session-custom', 'Custom');
  assert.equal(customLease.owner.canonicalPort, 'USB:DEVICE-A');
  assert.equal(custom.getByPort('Usb:Device-A')?.leaseId, customLease.leaseId);
  assert.throws(() => new PortLeaseRegistry({ platform: 'other', canonicalizer: (port) => port }));
});
