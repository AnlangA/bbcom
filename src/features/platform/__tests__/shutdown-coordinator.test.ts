import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  SHUTDOWN_WAIT_LIMIT_MS,
  ShutdownCoordinator,
  ShutdownProtocolAdapter,
  type ShutdownConfirmation,
  type ShutdownDrainResult,
} from '@/features/platform/shutdown/index.ts';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function useClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(0);
}

afterEach(() => {
  vi.useRealTimers();
});

test('same-priority participants run concurrently and higher priority groups finish first', async () => {
  useClock();
  const highA = deferred();
  const highB = deferred();
  const low = deferred();
  const calls: string[] = [];
  const coordinator = new ShutdownCoordinator();
  coordinator.register({
    name: 'operations',
    priority: 20,
    timeoutMs: 1_000,
    drain: () => {
      calls.push('operations');
      return highA.promise;
    },
  });
  coordinator.register({
    name: 'runtime',
    priority: 20,
    timeoutMs: 1_000,
    drain: () => {
      calls.push('runtime');
      return highB.promise;
    },
  });
  coordinator.register({
    name: 'workspace-flush',
    priority: 10,
    timeoutMs: 1_000,
    drain: () => {
      calls.push('workspace-flush');
      return low.promise;
    },
  });

  const first = coordinator.requestClose({ attemptId: 'close-1' });
  const duplicate = coordinator.requestClose({ attemptId: 'close-1' });
  assert.strictEqual(duplicate, first);
  assert.throws(() => coordinator.requestClose({ attemptId: 'different-close-2' }));
  assert.equal(coordinator.currentState, 'requested');
  assert.equal(coordinator.acceptsNewWork, false);

  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(calls, ['operations', 'runtime']);
  highA.resolve();
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(calls, ['operations', 'runtime']);
  highB.resolve();
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(calls, ['operations', 'runtime', 'workspace-flush']);
  low.resolve();
  await vi.advanceTimersByTimeAsync(0);

  const result = await first;
  assert.equal(result.attemptId, 'close-1');
  assert.equal(result.state, 'ready');
  assert.equal(result.needsDecision, false);
  assert.equal(result.requiresConfirmExit, true);
  assert.deepEqual(
    result.report.participants.map(({ name, status }) => ({ name, status })),
    [
      { name: 'operations', status: 'completed' },
      { name: 'runtime', status: 'completed' },
      { name: 'workspace-flush', status: 'completed' },
    ],
  );
  assert.equal(Object.isFrozen(result.report), true);
  assert.equal(Object.isFrozen(result.report.participants), true);
});

test('the hard eight-second boundary asks for a decision and never forces exit', async () => {
  useClock();
  const never = deferred();
  let lowPriorityCalls = 0;
  let aborted = false;
  const coordinator = new ShutdownCoordinator();
  coordinator.register({
    name: 'operations',
    priority: 20,
    timeoutMs: SHUTDOWN_WAIT_LIMIT_MS,
    drain: ({ signal }) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return never.promise;
    },
  });
  coordinator.register({
    name: 'settings-flush',
    priority: 10,
    timeoutMs: 1_000,
    drain: () => {
      lowPriorityCalls += 1;
    },
  });

  const closing = coordinator.requestClose({ attemptId: 'deadline-close' });
  await vi.advanceTimersByTimeAsync(SHUTDOWN_WAIT_LIMIT_MS - 1);
  assert.equal(coordinator.currentState, 'draining');
  assert.equal(lowPriorityCalls, 0);
  await vi.advanceTimersByTimeAsync(1);
  const result = await closing;

  assert.equal(result.state, 'timed-out');
  assert.equal(result.needsDecision, true);
  assert.equal(coordinator.currentState, 'timed-out');
  assert.equal(lowPriorityCalls, 0);
  assert.deepEqual(
    result.report.participants.map(({ status, elapsedMs, messageKey }) => ({
      status,
      elapsedMs,
      messageKey,
    })),
    [
      {
        status: 'timed-out',
        elapsedMs: SHUTDOWN_WAIT_LIMIT_MS,
        messageKey: 'shutdown.participant.timed_out',
      },
      { status: 'pending', elapsedMs: 0, messageKey: 'shutdown.participant.pending' },
    ],
  );
  assert.throws(() => coordinator.confirmExit('deadline-close'));
  assert.equal(aborted, false);

  const confirmation = coordinator.force('deadline-close');
  assert.equal(confirmation.forced, true);
  assert.equal(confirmation.report.state, 'confirmed');
  assert.equal(coordinator.currentState, 'confirming');
  coordinator.acknowledgeConfirmation('deadline-close');
  assert.equal(coordinator.currentState, 'confirmed');
  assert.equal(aborted, true);
  assert.equal(lowPriorityCalls, 0);
});

test('wait continues the original invocation without replaying its side effects', async () => {
  useClock();
  const pending = deferred();
  let calls = 0;
  const coordinator = new ShutdownCoordinator();
  coordinator.register({
    name: 'session-final-flush',
    priority: 10,
    timeoutMs: 100,
    drain: () => {
      calls += 1;
      return pending.promise;
    },
  });

  const first = coordinator.requestClose({ attemptId: 'wait-close' });
  await vi.advanceTimersByTimeAsync(100);
  assert.equal((await first).state, 'timed-out');
  assert.equal(calls, 1);

  const continued = coordinator.wait('wait-close');
  assert.equal(coordinator.currentState, 'draining');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(calls, 1);
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  const result = await continued;

  assert.equal(result.round, 1);
  assert.equal(result.state, 'ready');
  assert.equal(calls, 1);
  const confirmation = coordinator.confirmExit('wait-close');
  assert.equal(confirmation.forced, false);
  assert.equal(coordinator.currentState, 'confirming');
  coordinator.acknowledgeConfirmation('wait-close');
  assert.equal(coordinator.currentState, 'confirmed');
  assert.strictEqual(coordinator.confirmExit('wait-close'), confirmation);
});

test('failure reports discard exception prose and cancel starts the next attempt from scratch', async () => {
  useClock();
  let completedCalls = 0;
  let failingCalls = 0;
  const states: string[] = [];
  const coordinator = new ShutdownCoordinator();
  coordinator.subscribe((snapshot) => states.push(snapshot.state));
  coordinator.register({
    name: 'workspace-flush',
    priority: 10,
    timeoutMs: 1_000,
    drain: () => {
      completedCalls += 1;
    },
  });
  coordinator.register({
    name: 'settings-flush',
    priority: 10,
    timeoutMs: 1_000,
    drain: () => {
      failingCalls += 1;
      if (failingCalls === 1) {
        throw new Error('secret=/private/project.bbcom apiKey=do-not-report');
      }
    },
  });

  const failedTask = coordinator.requestClose({ attemptId: 'failure-close' });
  await vi.advanceTimersByTimeAsync(0);
  const failed = await failedTask;
  assert.equal(failed.state, 'failed');
  assert.equal(JSON.stringify(failed.report).includes('/private/project.bbcom'), false);
  assert.equal(JSON.stringify(failed.report).includes('do-not-report'), false);
  assert.deepEqual(
    failed.report.participants.map(({ status, messageKey }) => ({ status, messageKey })),
    [
      { status: 'completed', messageKey: 'shutdown.participant.completed' },
      { status: 'failed', messageKey: 'shutdown.participant.failed' },
    ],
  );

  const cancellation = coordinator.cancel('failure-close');
  assert.equal(cancellation.report.state, 'cancelled');
  assert.equal(cancellation.report.participants[0]?.status, 'completed');
  assert.equal(coordinator.currentState, 'confirming');
  coordinator.acknowledgeCancellation('failure-close');
  assert.strictEqual(coordinator.lastReport, cancellation.report);
  assert.equal(coordinator.currentState, 'idle');
  assert.equal(coordinator.acceptsNewWork, true);
  assert.deepEqual(states.slice(-3), ['confirming', 'cancelled', 'idle']);

  const nextTask = coordinator.requestClose({ attemptId: 'fresh-close' });
  const requested = coordinator.snapshot();
  assert.equal(requested.state, 'requested');
  assert.deepEqual(
    requested.report?.participants.map((participant) => participant.status),
    ['pending', 'pending'],
  );
  await vi.advanceTimersByTimeAsync(0);
  const next = await nextTask;
  assert.equal(next.state, 'ready');
  assert.equal(completedCalls, 2);
  assert.equal(failingCalls, 2);
});

test('registration and attempt identifiers reject ambiguous or path-bearing values', () => {
  const coordinator = new ShutdownCoordinator();
  assert.throws(() =>
    coordinator.register({ name: '../settings', priority: 1, timeoutMs: 1, drain: () => {} }),
  );
  assert.throws(() =>
    coordinator.register({ name: 'settings', priority: 1.5, timeoutMs: 1, drain: () => {} }),
  );
  assert.throws(() =>
    coordinator.register({ name: 'settings', priority: 1, timeoutMs: 0, drain: () => {} }),
  );
  assert.throws(() =>
    coordinator.register({
      name: 'invalid-barrier',
      priority: 1,
      timeoutMs: 1,
      repeatableBarrier: 'yes' as unknown as boolean,
      drain: () => {},
    }),
  );
  coordinator.register({ name: 'settings', priority: 1, timeoutMs: 1, drain: () => {} });
  assert.throws(() =>
    coordinator.register({ name: 'settings', priority: 2, timeoutMs: 1, drain: () => {} }),
  );
  assert.throws(() => coordinator.requestClose({ attemptId: '/private/close' }));
});

test('the protocol adapter publishes each close once and forwards explicit confirmation', async () => {
  useClock();
  const reports: ShutdownDrainResult[] = [];
  const confirmations: ShutdownConfirmation[] = [];
  const coordinator = new ShutdownCoordinator();
  const adapter = new ShutdownProtocolAdapter(coordinator, {
    submitShutdownReport: (result) => {
      reports.push(result);
    },
    confirmExit: (confirmation) => {
      confirmations.push(confirmation);
    },
    cancelExit: () => {},
  });

  const first = adapter.handleCloseRequest({ attemptId: 'native-close' });
  const duplicate = adapter.handleCloseRequest({ attemptId: 'native-close' });
  assert.strictEqual(duplicate, first);
  assert.throws(() => adapter.handleCloseRequest({ attemptId: 'different-native-close' }));
  await vi.advanceTimersByTimeAsync(0);
  const result = await first;
  assert.equal(result.state, 'ready');
  assert.equal(reports.length, 1);
  assert.equal(confirmations.length, 0);

  const confirmation = adapter.confirmExit('native-close');
  const duplicateConfirmation = adapter.confirmExit('native-close');
  assert.strictEqual(duplicateConfirmation, confirmation);
  assert.equal((await confirmation).forced, false);
  assert.equal(confirmations.length, 1);
});

test('wait reruns only repeatable lower-priority barriers after a timed-out participant settles late', async () => {
  useClock();
  const lateHighPriority = deferred();
  const calls: string[] = [];
  const coordinator = new ShutdownCoordinator();
  coordinator.register({
    name: 'ordinary-side-effect',
    priority: 20,
    timeoutMs: 100,
    drain: async () => {
      calls.push('ordinary-start');
      await lateHighPriority.promise;
      calls.push('ordinary-finished');
    },
  });
  coordinator.register({
    name: 'workspace-flush',
    priority: 10,
    timeoutMs: 100,
    repeatableBarrier: true,
    drain: () => {
      calls.push('workspace-flush');
    },
  });

  const first = coordinator.requestClose({ attemptId: 'late-side-effect' });
  await vi.advanceTimersByTimeAsync(100);
  assert.equal((await first).state, 'timed-out');
  assert.deepEqual(calls, ['ordinary-start', 'workspace-flush']);

  lateHighPriority.resolve();
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(calls, ['ordinary-start', 'workspace-flush', 'ordinary-finished']);

  const second = coordinator.wait('late-side-effect');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal((await second).state, 'ready');
  assert.deepEqual(calls, [
    'ordinary-start',
    'workspace-flush',
    'ordinary-finished',
    'workspace-flush',
  ]);
});

test('rejected report, confirmation, and cancellation publications are explicitly retryable', async () => {
  let reportAttempts = 0;
  let confirmationAttempts = 0;
  const confirmingCoordinator = new ShutdownCoordinator();
  const confirmingAdapter = new ShutdownProtocolAdapter(confirmingCoordinator, {
    submitShutdownReport: () => {
      reportAttempts += 1;
      if (reportAttempts === 1) throw new Error('transient report failure');
    },
    confirmExit: () => {
      confirmationAttempts += 1;
      if (confirmationAttempts === 1) throw new Error('transient confirm failure');
    },
    cancelExit: () => assert.fail('confirmation attempt does not cancel'),
  });

  await assert.rejects(
    confirmingAdapter.handleCloseRequest({ attemptId: 'retry-confirmation' }),
    /transient report failure/,
  );
  await confirmingAdapter.retryReport('retry-confirmation');
  assert.equal(reportAttempts, 2);
  await assert.rejects(
    confirmingAdapter.confirmExit('retry-confirmation'),
    /transient confirm failure/,
  );
  assert.equal(confirmingCoordinator.currentState, 'confirming');
  await confirmingAdapter.confirmExit('retry-confirmation');
  assert.equal(confirmationAttempts, 2);
  assert.equal(confirmingCoordinator.currentState, 'confirmed');

  let cancellationAttempts = 0;
  const cancellingCoordinator = new ShutdownCoordinator();
  const cancellingAdapter = new ShutdownProtocolAdapter(cancellingCoordinator, {
    submitShutdownReport: () => undefined,
    confirmExit: () => assert.fail('cancellation attempt does not confirm'),
    cancelExit: () => {
      cancellationAttempts += 1;
      if (cancellationAttempts === 1) throw new Error('transient cancel failure');
    },
  });
  await cancellingAdapter.handleCloseRequest({ attemptId: 'retry-cancellation' });
  await assert.rejects(cancellingAdapter.cancel('retry-cancellation'), /transient cancel failure/);
  assert.equal(cancellingCoordinator.currentState, 'confirming');
  await cancellingAdapter.cancel('retry-cancellation');
  assert.equal(cancellationAttempts, 2);
  assert.equal(cancellingCoordinator.currentState, 'idle');
});
