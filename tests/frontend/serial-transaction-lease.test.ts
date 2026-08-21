import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  SerialTransactionLeaseCoordinator,
  SerialTransactionLeaseError,
  type SerialAutomationPausePort,
  type SerialTransactionIoPort,
  type SerialTransactionLeaseErrorCode,
  type SerialTransactionLeaseTimerPort,
  type SerialTransactionLeaseToken,
  type SerialTransactionWriteContext,
} from '../../src/features/serial/application/serial-transaction-lease.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function hasCode(code: SerialTransactionLeaseErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof SerialTransactionLeaseError && error.code === code;
}

function fakeToken(value: string): SerialTransactionLeaseToken {
  return value as SerialTransactionLeaseToken;
}

function automation(id: string, events: string[], active = true): SerialAutomationPausePort {
  return {
    id,
    async pause(context) {
      events.push(`pause:${id}:${context.generation}`);
      if (!active) return null;
      return {
        async restore(restoreContext) {
          events.push(`restore:${id}:${restoreContext.reason}`);
        },
      };
    },
  };
}

class ManualTimer implements SerialTransactionLeaseTimerPort {
  private sequence = 0;
  private readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];

  schedule(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    this.delays.push(delayMs);
    return id;
  }

  cancel(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    assert.ok(entry);
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

test('acquisition drains existing writes, pauses in order, gates writes, and restores in reverse', async () => {
  const events: string[] = [];
  const firstDrain = deferred<void>();
  const releaseDrain = deferred<void>();
  let drainCalls = 0;
  const contexts: SerialTransactionWriteContext[] = [];
  const payloads: Uint8Array[] = [];
  const io: SerialTransactionIoPort<{ accepted: number }> = {
    snapshot: () => ({ generation: 7, connected: true }),
    async waitForWriteDrain({ generation, signal }) {
      events.push(`drain:${generation}`);
      drainCalls += 1;
      const selected = drainCalls === 1 ? firstDrain : releaseDrain;
      await Promise.race([
        selected.promise,
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      ]);
    },
    async write(payload, context) {
      payloads.push(payload);
      contexts.push(context);
      return { accepted: payload.length };
    },
  };
  const coordinator = new SerialTransactionLeaseCoordinator({
    io,
    tokenFactory: () => 'test-entropy',
  });
  assert.deepEqual(coordinator.connectionSnapshot(), { generation: 7, connected: true });
  coordinator.registerAutomation(automation('macro', events));
  coordinator.registerAutomation(automation('inactive', events, false));
  coordinator.registerAutomation(automation('modbus', events));

  const acquisition = coordinator.acquire('plugin.mcumgr');
  assert.equal(coordinator.snapshot().phase, 'acquiring');
  await assert.rejects(coordinator.acquire('plugin.other'), hasCode('busy'));
  await assert.rejects(
    coordinator.runManualWrite(async () => 'manual'),
    hasCode('busy'),
  );
  assert.deepEqual(events, ['drain:7']);

  firstDrain.resolve();
  const grant = await acquisition;
  assert.equal(grant.generation, 7);
  assert.match(grant.token, /^test-entropy\.[a-z0-9]+$/u);
  assert.deepEqual(events, ['drain:7', 'pause:macro:7', 'pause:inactive:7', 'pause:modbus:7']);
  assert.equal(coordinator.snapshot().manualWriteAllowed, false);
  assert.equal(
    coordinator.authorizesSchedulerWrite({
      source: 'host',
      ownerId: 'session-1',
    }),
    false,
  );

  const source = Uint8Array.of(1, 2, 3);
  assert.deepEqual(await coordinator.write(grant.token, source), { accepted: 3 });
  source.fill(0xff);
  assert.deepEqual(Array.from(payloads[0] ?? []), [1, 2, 3]);
  assert.equal(contexts[0]?.ownerId, 'plugin.mcumgr');
  assert.equal(contexts[0]?.generation, 7);
  assert.equal(contexts[0]?.leaseToken, grant.token);

  const released = coordinator.release(grant.token);
  assert.equal(coordinator.snapshot().phase, 'releasing');
  assert.equal(events.includes('restore:modbus:released'), false);
  releaseDrain.resolve();
  assert.deepEqual(await released, {
    reason: 'released',
    generation: 7,
    restoredAutomations: 2,
    restoreFailures: [],
    restoreSkipped: false,
    drainFailed: false,
  });
  assert.deepEqual(events.slice(-2), ['restore:modbus:released', 'restore:macro:released']);
  assert.equal(await coordinator.runManualWrite(async () => 'manual'), 'manual');
  assert.equal(
    await coordinator.runManualWrite(async () =>
      coordinator.authorizesSchedulerWrite({ source: 'host', ownerId: 'session-1' }),
    ),
    true,
  );
});

test('lease-bound buffer clearing and pending byte counts include the mirrored RX queue', async () => {
  let physicalRx = 5;
  const clearCalls: string[] = [];
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 9, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
      async clearBuffers(selection) {
        clearCalls.push(selection);
        if (selection === 'input' || selection === 'all') physicalRx = 0;
      },
      async pendingBytes() {
        return { rx: physicalRx, tx: 2 };
      },
    },
    tokenFactory: () => 'buffer-lease',
  });
  const grant = await coordinator.acquire('plugin.mcumgr');
  assert.deepEqual(coordinator.offerRx(9, Uint8Array.of(1, 2, 3)), {
    status: 'mirrored',
    bufferedBytes: 3,
  });
  assert.deepEqual(await coordinator.pendingBytes(grant.token), { rx: 8, tx: 2 });

  await coordinator.clearBuffers(grant.token, 'input');
  assert.deepEqual(clearCalls, ['input']);
  assert.deepEqual(await coordinator.pendingBytes(grant.token), { rx: 0, tx: 2 });
});

test('buffer operations fail closed when the runtime adapter does not prove support', async () => {
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 2, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'unsupported-buffer-lease',
  });
  const grant = await coordinator.acquire('plugin.mcumgr');
  await assert.rejects(coordinator.clearBuffers(grant.token), hasCode('unavailable'));
  await assert.rejects(coordinator.pendingBytes(grant.token), hasCode('unavailable'));
  await assert.rejects(
    coordinator.setOutputLines(grant.token, { dtr: true, rts: false, breakActive: false }),
    hasCode('unavailable'),
  );
  await assert.rejects(coordinator.readInputLines(grant.token), hasCode('unavailable'));
  await assert.rejects(
    coordinator.clearBuffers(grant.token, 'invalid' as 'all'),
    hasCode('invalid-input'),
  );
});

test('control lines are lease- and generation-bound and validate adapter results', async () => {
  let snapshot = { generation: 12, connected: true };
  const outputs: unknown[] = [];
  let input = { cts: true, dsr: false, ri: true, cd: false };
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => snapshot,
      async waitForWriteDrain() {},
      async write() {},
      async setOutputLines(lines, context) {
        outputs.push({ lines, generation: context.generation, token: context.leaseToken });
      },
      snapshotOutputLines() {
        return { dtr: false, rts: false, breakActive: false };
      },
      async restoreOutputLines() {},
      async readInputLines() {
        return input;
      },
    },
    tokenFactory: () => 'control-lines',
  });
  const grant = await coordinator.acquire('plugin');
  const lines = { dtr: true, rts: false, breakActive: true };
  await coordinator.setOutputLines(grant.token, lines);
  assert.deepEqual(outputs, [{ lines, generation: 12, token: grant.token }]);
  assert.deepEqual(await coordinator.readInputLines(grant.token), input);

  input = { cts: true, dsr: false, ri: true, cd: undefined as unknown as boolean };
  await assert.rejects(coordinator.readInputLines(grant.token), hasCode('protocol-error'));
  snapshot = { generation: 13, connected: true };
  await assert.rejects(coordinator.setOutputLines(grant.token, lines), hasCode('stale-handle'));
});

test('cancel restores control-line baseline before resuming automation', async () => {
  const events: string[] = [];
  let physical = { dtr: true, rts: false, breakActive: false };
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 5, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
      snapshotOutputLines: () => physical,
      async setOutputLines(lines) {
        physical = { ...lines };
        events.push(`set:${String(lines.breakActive)}`);
      },
      async restoreOutputLines(lines) {
        physical = { ...lines };
        events.push(`restore-lines:${String(lines.breakActive)}`);
      },
    },
    tokenFactory: () => 'control-cleanup',
  });
  coordinator.registerAutomation(automation('macro', events));
  const grant = await coordinator.acquire('plugin');
  await coordinator.setOutputLines(grant.token, {
    dtr: false,
    rts: true,
    breakActive: true,
  });

  const released = await coordinator.cancel(grant.token);
  assert.deepEqual(physical, { dtr: true, rts: false, breakActive: false });
  assert.ok(events.indexOf('restore-lines:false') < events.indexOf('restore:macro:cancelled'));
  assert.deepEqual(released.restoreFailures, []);
  assert.equal(coordinator.snapshot().phase, 'idle');
});

test('failed control-line cleanup keeps automations stopped and faults the generation', async () => {
  const events: string[] = [];
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 6, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
      snapshotOutputLines: () => ({ dtr: false, rts: false, breakActive: false }),
      async setOutputLines() {},
      async restoreOutputLines() {
        throw new Error('driver refused clearBreak');
      },
    },
    tokenFactory: () => 'control-cleanup-failure',
  });
  coordinator.registerAutomation(automation('macro', events));
  const grant = await coordinator.acquire('plugin');
  await coordinator.setOutputLines(grant.token, { dtr: true, rts: true, breakActive: true });

  const released = await coordinator.cancel(grant.token);
  assert.deepEqual(released.restoreFailures, ['serial.control-lines']);
  assert.equal(released.restoreSkipped, true);
  assert.equal(events.includes('restore:macro:cancelled'), false);
  assert.equal(coordinator.snapshot().phase, 'faulted');
});

test('each lease uses the requested RX capacity within the host maximum', async () => {
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 1, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'bounded-rx',
    limits: { rxBytes: 8 },
  });
  await assert.rejects(
    coordinator.acquire('plugin', { rxBufferBytes: 0 }),
    hasCode('invalid-input'),
  );
  await assert.rejects(
    coordinator.acquire('plugin', { rxBufferBytes: 9 }),
    hasCode('limit-exceeded'),
  );
  const grant = await coordinator.acquire('plugin', { rxBufferBytes: 2 });
  assert.deepEqual(coordinator.offerRx(1, Uint8Array.of(1, 2, 3)), {
    status: 'backpressure',
    bufferedBytes: 0,
    capacityBytes: 2,
  });
  await assert.rejects(coordinator.read(grant.token, { maxBytes: 1 }), hasCode('limit-exceeded'));
  assert.deepEqual(coordinator.offerRx(1, Uint8Array.of(1, 2)), {
    status: 'ignored',
    bufferedBytes: 0,
  });
  await Promise.resolve();
  assert.equal(coordinator.snapshot().faultCode, 'limit-exceeded');
});

test('a manual write already in flight drains before acquisition while later manual writes are rejected', async () => {
  const manualDone = deferred<void>();
  let drainCompleted = false;
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 1, connected: true }),
      async waitForWriteDrain() {
        await manualDone.promise;
        drainCompleted = true;
      },
      async write() {
        return undefined;
      },
    },
    tokenFactory: () => 'nonce',
  });
  const manual = coordinator.runManualWrite(async () => {
    await manualDone.promise;
    return 'complete';
  });
  assert.equal(coordinator.snapshot().manualWritesInFlight, 1);

  const acquisition = coordinator.acquire('plugin');
  assert.equal(coordinator.snapshot().phase, 'acquiring');
  await assert.rejects(
    coordinator.runManualWrite(async () => undefined),
    hasCode('busy'),
  );
  manualDone.resolve();

  assert.equal(await manual, 'complete');
  const grant = await acquisition;
  assert.equal(drainCompleted, true);
  await coordinator.release(grant.token);
});

test('partial automation pause failure rolls back prior pauses but a generation change stays fail-closed', async () => {
  const events: string[] = [];
  let snapshot = { generation: 3, connected: true };
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => snapshot,
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'nonce',
  });
  coordinator.registerAutomation(automation('one', events));
  coordinator.registerAutomation(automation('two', events));
  coordinator.registerAutomation({
    id: 'broken',
    async pause() {
      events.push('pause:broken');
      throw new Error('private failure');
    },
  });

  await assert.rejects(coordinator.acquire('plugin'), hasCode('unavailable'));
  assert.deepEqual(events, [
    'pause:one:3',
    'pause:two:3',
    'pause:broken',
    'restore:two:acquire-failed',
    'restore:one:acquire-failed',
  ]);
  assert.equal(coordinator.snapshot().phase, 'idle');

  const changedEvents: string[] = [];
  const changed = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => snapshot,
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'nonce',
  });
  changed.registerAutomation({
    id: 'changes-generation',
    async pause() {
      changedEvents.push('pause');
      snapshot = { generation: 4, connected: true };
      return {
        async restore() {
          changedEvents.push('restore');
        },
      };
    },
  });
  await assert.rejects(changed.acquire('plugin'), hasCode('stale-handle'));
  assert.deepEqual(changedEvents, ['pause']);
});

test('release continues after restore failures and a drain failure keeps automations paused', async () => {
  const events: string[] = [];
  let failDrain = false;
  let generation = 6;
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation, connected: true }),
      async waitForWriteDrain() {
        if (failDrain) throw new Error('private drain failure');
      },
      async write() {},
    },
    tokenFactory: () => 'nonce',
  });
  coordinator.registerAutomation(automation('first', events));
  coordinator.registerAutomation({
    id: 'broken-restore',
    async pause() {
      events.push('pause:broken-restore');
      return {
        async restore() {
          events.push('restore:broken-restore');
          throw new Error('private restore failure');
        },
      };
    },
  });
  coordinator.registerAutomation(automation('last', events));

  const first = await coordinator.acquire('plugin');
  const firstRelease = await coordinator.release(first.token);
  assert.deepEqual(firstRelease.restoreFailures, ['broken-restore']);
  assert.equal(firstRelease.restoredAutomations, 2);
  assert.deepEqual(events.slice(-3), [
    'restore:last:released',
    'restore:broken-restore',
    'restore:first:released',
  ]);

  const restoredBeforeDrainFailure = events.filter((event) => event.startsWith('restore:')).length;
  const second = await coordinator.acquire('plugin');
  failDrain = true;
  const secondRelease = await coordinator.release(second.token);
  assert.equal(secondRelease.drainFailed, true);
  assert.equal(secondRelease.restoreSkipped, true);
  assert.equal(coordinator.snapshot().phase, 'faulted');
  await assert.rejects(coordinator.acquire('plugin'), hasCode('unavailable'));
  assert.equal(
    events.filter((event) => event.startsWith('restore:')).length,
    restoredBeforeDrainFailure,
  );
  generation = 7;
  assert.equal(await coordinator.synchronizeConnection(), true);
  assert.equal(coordinator.snapshot().phase, 'idle');
});

test('acquisition cancellation is abortable and stale tokens never alias a later grant', async () => {
  let holdDrain = true;
  const io: SerialTransactionIoPort = {
    snapshot: () => ({ generation: 2, connected: true }),
    waitForWriteDrain: ({ signal }) =>
      holdDrain
        ? new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('stop')), { once: true });
          })
        : Promise.resolve(),
    async write() {},
  };
  const coordinator = new SerialTransactionLeaseCoordinator({ io, tokenFactory: () => 'same' });
  const cancellation = new AbortController();
  const cancelled = coordinator.acquire('plugin', { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(cancelled, hasCode('cancelled'));
  assert.equal(coordinator.snapshot().phase, 'idle');

  holdDrain = false;
  const first = await coordinator.acquire('plugin');
  await coordinator.release(first.token);
  const second = await coordinator.acquire('plugin');
  assert.notEqual(first.token, second.token);
  await assert.rejects(coordinator.write(first.token, Uint8Array.of(1)), hasCode('stale-handle'));
  await coordinator.release(second.token);
});

test('disconnect during acquisition aborts the drain and never enters the active phase', async () => {
  const io: SerialTransactionIoPort = {
    snapshot: () => ({ generation: 14, connected: true }),
    waitForWriteDrain: ({ signal }) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('stop')), { once: true });
      }),
    async write() {},
  };
  const coordinator = new SerialTransactionLeaseCoordinator({ io, tokenFactory: () => 'nonce' });
  const acquisition = coordinator.acquire('plugin');
  const rejected = assert.rejects(acquisition, hasCode('disconnected'));

  assert.equal(await coordinator.notifyDisconnected(14), true);
  await rejected;
  assert.equal(coordinator.snapshot().phase, 'idle');
});

test('public boundaries validate configuration, identifiers, generations, signals, and tokens', async () => {
  const connected = { generation: 1, connected: true };
  const io: SerialTransactionIoPort = {
    snapshot: () => connected,
    async waitForWriteDrain() {},
    async write() {},
  };
  assert.throws(
    () => new SerialTransactionLeaseCoordinator({ io, limits: { rxBytes: 0 } }),
    RangeError,
  );

  const coordinator = new SerialTransactionLeaseCoordinator({ io, tokenFactory: () => 'nonce' });
  assert.throws(
    () => coordinator.registerAutomation(automation('bad\u0000id', [])),
    hasCode('invalid-input'),
  );
  coordinator.registerAutomation(automation('unique', []));
  assert.throws(
    () => coordinator.registerAutomation(automation('unique', [])),
    hasCode('invalid-input'),
  );
  const preCancelled = new AbortController();
  preCancelled.abort();
  await assert.rejects(
    coordinator.acquire('plugin', { signal: preCancelled.signal }),
    hasCode('cancelled'),
  );

  const grant = await coordinator.acquire('plugin');
  assert.deepEqual(coordinator.offerRx(1, new Uint8Array()), {
    status: 'ignored',
    bufferedBytes: 0,
  });
  assert.throws(() => coordinator.release(fakeToken('forged')), hasCode('stale-handle'));
  await assert.rejects(coordinator.write(grant.token, new Uint8Array()), hasCode('invalid-input'));
  const writeAbort = new AbortController();
  writeAbort.abort();
  await assert.rejects(
    coordinator.write(grant.token, Uint8Array.of(1), writeAbort.signal),
    hasCode('cancelled'),
  );
  const readAbort = new AbortController();
  readAbort.abort();
  await assert.rejects(
    coordinator.read(grant.token, { maxBytes: 1, signal: readAbort.signal }),
    hasCode('cancelled'),
  );
  assert.equal(await coordinator.notifyDisconnected(99), false);
  await assert.rejects(coordinator.notifyDisconnected(-1), hasCode('invalid-input'));
  assert.equal(await coordinator.synchronizeConnection(), false);
  await coordinator.release(grant.token);

  const invalidGeneration = new SerialTransactionLeaseCoordinator({
    io: { ...io, snapshot: () => ({ generation: -1, connected: true }) },
  });
  await assert.rejects(invalidGeneration.acquire('plugin'), hasCode('protocol-error'));
  const disconnected = new SerialTransactionLeaseCoordinator({
    io: { ...io, snapshot: () => ({ generation: 2, connected: false }) },
  });
  await assert.rejects(disconnected.acquire('plugin'), hasCode('disconnected'));
});

test('RX mirroring is copied, ordered, bounded, and applies explicit backpressure', async () => {
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 5, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'nonce',
    limits: { rxBytes: 4, rxChunks: 2, readBytes: 4 },
  });
  assert.deepEqual(coordinator.offerRx(5, Uint8Array.of(9)), {
    status: 'ignored',
    bufferedBytes: 0,
  });
  const grant = await coordinator.acquire('plugin');
  assert.throws(() => coordinator.read(grant.token, { maxBytes: 0 }), hasCode('invalid-input'));
  assert.throws(() => coordinator.read(grant.token, { maxBytes: 5 }), hasCode('limit-exceeded'));
  assert.throws(
    () => coordinator.read(grant.token, { maxBytes: 1, timeoutMs: 10_001 }),
    hasCode('limit-exceeded'),
  );

  const first = Uint8Array.of(1, 2, 3);
  assert.deepEqual(coordinator.offerRx(5, first), { status: 'mirrored', bufferedBytes: 3 });
  first.fill(0xff);
  assert.deepEqual(coordinator.offerRx(5, Uint8Array.of(4)), {
    status: 'mirrored',
    bufferedBytes: 4,
  });
  assert.deepEqual(Array.from(await coordinator.read(grant.token, { maxBytes: 3 })), [1, 2, 3]);
  assert.deepEqual(coordinator.snapshot().bufferedRxBytes, 1);

  assert.deepEqual(Array.from(await coordinator.read(grant.token, { maxBytes: 4 })), [4]);
  assert.deepEqual(coordinator.offerRx(5, Uint8Array.of(5, 6, 7, 8)), {
    status: 'mirrored',
    bufferedBytes: 4,
  });
  assert.deepEqual(Array.from(await coordinator.read(grant.token, { maxBytes: 4 })), [5, 6, 7, 8]);

  const pending = coordinator.read(grant.token, { maxBytes: 2 });
  await assert.rejects(coordinator.read(grant.token, { maxBytes: 1 }), hasCode('busy'));
  assert.deepEqual(coordinator.offerRx(5, Uint8Array.of(9, 10, 11)), {
    status: 'mirrored',
    bufferedBytes: 1,
  });
  assert.deepEqual(Array.from(await pending), [9, 10]);
  assert.deepEqual(Array.from(await coordinator.read(grant.token, { maxBytes: 1 })), [11]);

  assert.deepEqual(coordinator.offerRx(5, Uint8Array.of(12, 13, 14, 15, 16)), {
    status: 'backpressure',
    bufferedBytes: 0,
    capacityBytes: 4,
  });
  await assert.rejects(coordinator.read(grant.token, { maxBytes: 1 }), hasCode('limit-exceeded'));
});

test('RX reads time out, honor caller cancellation, and close on disconnect', async () => {
  const timer = new ManualTimer();
  let snapshot = { generation: 8, connected: true };
  const events: string[] = [];
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => snapshot,
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'nonce',
    timer,
  });
  coordinator.registerAutomation(automation('macro', events));
  const grant = await coordinator.acquire('plugin');

  const timedOut = coordinator.read(grant.token, { maxBytes: 4, timeoutMs: 25 });
  assert.deepEqual(timer.delays, [25]);
  timer.runNext();
  await assert.rejects(timedOut, hasCode('timeout'));

  const abort = new AbortController();
  const cancelled = coordinator.read(grant.token, { maxBytes: 4, signal: abort.signal });
  assert.equal(timer.pending, 1);
  abort.abort();
  await assert.rejects(cancelled, hasCode('cancelled'));
  assert.equal(timer.pending, 0);

  const disconnectedRead = coordinator.read(grant.token, { maxBytes: 4 });
  snapshot = { generation: 8, connected: false };
  assert.equal(await coordinator.notifyDisconnected(8), true);
  await assert.rejects(disconnectedRead, hasCode('disconnected'));
  assert.equal(events.includes('restore:macro:disconnected'), false);
  assert.equal(coordinator.snapshot().phase, 'idle');
  await assert.rejects(coordinator.read(grant.token, { maxBytes: 1 }), hasCode('stale-handle'));
});

test('lease writes are single-flight, bounded, classified, and become unknown after revocation', async () => {
  let snapshot = { generation: 11, connected: true };
  const physical = deferred<{ ok: true }>();
  let physicalActive = false;
  let failWrite = false;
  const written: number[][] = [];
  const io: SerialTransactionIoPort<{ ok: true }> = {
    snapshot: () => snapshot,
    async waitForWriteDrain() {
      if (physicalActive) await physical.promise;
    },
    async write(payload) {
      written.push(Array.from(payload));
      if (failWrite) throw new Error('private driver error');
      physicalActive = true;
      return physical.promise;
    },
  };
  const coordinator = new SerialTransactionLeaseCoordinator({
    io,
    tokenFactory: () => 'nonce',
    limits: { writeBytes: 4 },
  });
  const grant = await coordinator.acquire('plugin');
  const source = Uint8Array.of(1, 2);
  const first = coordinator.write(grant.token, source);
  source.fill(9);
  await assert.rejects(coordinator.write(grant.token, Uint8Array.of(3)), hasCode('busy'));
  await assert.rejects(
    coordinator.write(grant.token, new Uint8Array(5)),
    hasCode('limit-exceeded'),
  );
  assert.deepEqual(written, [[1, 2]]);

  snapshot = { generation: 12, connected: true };
  const synchronized = coordinator.synchronizeConnection();
  physical.resolve({ ok: true });
  await assert.rejects(first, hasCode('unknown-outcome'));
  assert.equal(await synchronized, true);
  assert.equal(coordinator.snapshot().phase, 'idle');

  physicalActive = false;
  snapshot = { generation: 12, connected: true };
  const next = await coordinator.acquire('plugin');
  failWrite = true;
  await assert.rejects(coordinator.write(next.token, Uint8Array.of(1)), hasCode('io-error'));
  await coordinator.release(next.token);
});

test('caller write cancellation is distinct from lease revocation', async () => {
  const io: SerialTransactionIoPort = {
    snapshot: () => ({ generation: 13, connected: true }),
    async waitForWriteDrain() {},
    write(_payload, context) {
      return new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    },
  };
  const coordinator = new SerialTransactionLeaseCoordinator({ io, tokenFactory: () => 'nonce' });
  const grant = await coordinator.acquire('plugin');
  const abort = new AbortController();
  const write = coordinator.write(grant.token, Uint8Array.of(1), abort.signal);
  abort.abort();
  await assert.rejects(write, hasCode('cancelled'));
  assert.equal(coordinator.snapshot().phase, 'active');
  await coordinator.cancel(grant.token);
});

test('dispose revokes pending work, restores stable automations, and permanently closes the gate', async () => {
  const events: string[] = [];
  const timer = new ManualTimer();
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 21, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'nonce',
    timer,
  });
  coordinator.registerAutomation(automation('one', events));
  coordinator.registerAutomation(automation('two', events));
  const grant = await coordinator.acquire('plugin');
  const pending = coordinator.read(grant.token, { maxBytes: 1 });

  await coordinator.dispose();
  await assert.rejects(pending, hasCode('cancelled'));
  assert.deepEqual(events.slice(-2), ['restore:two:disposed', 'restore:one:disposed']);
  assert.equal(coordinator.snapshot().phase, 'disposed');
  await assert.rejects(coordinator.acquire('plugin'), hasCode('unavailable'));
  await assert.rejects(
    coordinator.runManualWrite(async () => undefined),
    hasCode('unavailable'),
  );
  assert.throws(
    () => coordinator.registerAutomation(automation('late', events)),
    hasCode('unavailable'),
  );
  await coordinator.dispose();
});

test('listeners are isolated and automation registration cannot change during a lease', async () => {
  const phases: string[] = [];
  const coordinator = new SerialTransactionLeaseCoordinator({
    io: {
      snapshot: () => ({ generation: 1, connected: true }),
      async waitForWriteDrain() {},
      async write() {},
    },
    tokenFactory: () => 'nonce',
  });
  coordinator.subscribe(() => {
    throw new Error('observer failure');
  });
  const detach = coordinator.subscribe((snapshot) => phases.push(snapshot.phase));
  const unregister = coordinator.registerAutomation(automation('macro', []));
  const grant = await coordinator.acquire('plugin');
  assert.throws(unregister, hasCode('busy'));
  assert.throws(() => coordinator.registerAutomation(automation('other', [])), hasCode('busy'));
  await coordinator.release(grant.token);
  unregister();
  detach();
  assert.deepEqual(
    phases.filter((phase) => phase === 'acquiring'),
    ['acquiring'],
  );
  assert.equal(coordinator.snapshot().registeredAutomations, 0);
  await assert.rejects(
    coordinator.write(fakeToken('forged'), Uint8Array.of(1)),
    hasCode('stale-handle'),
  );
});
