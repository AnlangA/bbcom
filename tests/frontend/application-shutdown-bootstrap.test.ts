import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ApplicationRuntimeRegistry } from '../../src/features/application/application-runtime-registry.ts';
import { OperationRegistry } from '../../src/features/application/operation-registry.ts';
import {
  createApplicationShutdownController,
  TauriShutdownPort,
  type ShutdownCloseRequest,
  type ShutdownProtocolPort,
} from '../../src/features/shutdown/index.ts';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test('ready close drains fixed participants, submits a report, and explicitly confirms exit', async () => {
  const calls: string[] = [];
  let onClose: ((request: ShutdownCloseRequest) => void) | null = null;
  const reports: unknown[] = [];
  const confirmations: unknown[] = [];
  let resolveConfirmed: (() => void) | null = null;
  const confirmed = new Promise<void>((resolve) => {
    resolveConfirmed = resolve;
  });
  const controller = createApplicationShutdownController({
    application: {
      prepareShutdown: async () => {
        calls.push('application-quiesce');
      },
    },
    sessionPersistence: {
      flushFinalPersistence: async () => {
        calls.push('session-persistence');
        return 'completed';
      },
    },
    appSettings: {
      flushSettings: () => {
        calls.push('app-settings');
        return true;
      },
    },
    serialSettings: {
      flushSettings: () => {
        calls.push('serial-settings');
        return true;
      },
    },
    protocol: {
      submitShutdownReport: (result) => {
        reports.push(result);
      },
      confirmExit: (confirmation) => {
        confirmations.push(confirmation);
        resolveConfirmed?.();
      },
      cancelExit: () => undefined,
    },
    closeRequests: {
      listen: async (handler) => {
        onClose = handler;
        return () => {
          onClose = null;
        };
      },
    },
  });

  await controller.start();
  assert.ok(onClose);
  (onClose as (request: ShutdownCloseRequest) => void)({ attemptId: 'attempt-ready' });
  await confirmed;
  await flushMicrotasks();

  assert.deepEqual(calls, [
    'application-quiesce',
    'session-persistence',
    'app-settings',
    'serial-settings',
  ]);
  assert.equal(reports.length, 1);
  assert.equal(confirmations.length, 1, 'ready never exits without explicit confirm_exit');
  assert.equal(controller.snapshot().coordinator.state, 'confirmed');
  controller.stop();
  assert.equal(onClose, null);
});

test('failed drain stays in UI decision state and cancel leaves registries reusable', async () => {
  const cancellations: unknown[] = [];
  let resolveFailedReport: (() => void) | null = null;
  const failedReport = new Promise<void>((resolve) => {
    resolveFailedReport = resolve;
  });
  const operationRegistry = new OperationRegistry();
  let operationCancellations = 0;
  operationRegistry.create({
    operationId: 'macro-before-close',
    kind: 'serial-send',
    workspaceId: 'workspace-main',
    cancel: () => {
      operationCancellations += 1;
    },
  });

  let preparations = 0;
  const runtimeRegistry = new ApplicationRuntimeRegistry({
    createRuntime: ({ id }: { id: string }) => ({ id }),
    prepareRuntime: () => {
      preparations += 1;
    },
    disposeRuntime: () => undefined,
  });
  await runtimeRegistry.ensure({ id: 'session-main' });

  const protocol: ShutdownProtocolPort = {
    submitShutdownReport: (result) => {
      if (result.state === 'failed') resolveFailedReport?.();
    },
    confirmExit: () => assert.fail('failed drain must not auto-confirm'),
    cancelExit: (cancellation) => {
      cancellations.push(cancellation);
    },
  };
  const eventController = createApplicationShutdownController({
    application: {
      prepareShutdown: async () => {
        await Promise.all([operationRegistry.interruptActive(), runtimeRegistry.prepareShutdown()]);
      },
    },
    sessionPersistence: { flushFinalPersistence: async () => 'timeout' },
    appSettings: { flushSettings: () => true },
    serialSettings: { flushSettings: () => true },
    protocol,
    closeRequests: {
      listen: async (handler) => {
        handler({ attemptId: 'attempt-cancel' });
        return () => undefined;
      },
    },
  });
  const snapshots: string[] = [];
  eventController.subscribe((snapshot) => snapshots.push(snapshot.coordinator.state));
  await eventController.start();
  await failedReport;
  assert.equal(eventController.snapshot().coordinator.state, 'failed');
  assert.equal(operationCancellations, 1);
  assert.equal(preparations, 1);

  await eventController.cancel('attempt-cancel');
  assert.equal(cancellations.length, 1);
  assert.equal(eventController.snapshot().coordinator.state, 'idle');

  operationRegistry.create({
    operationId: 'macro-after-cancel',
    kind: 'serial-send',
    workspaceId: 'workspace-main',
  });
  assert.equal(operationRegistry.get('macro-after-cancel')?.status, 'queued');
  assert.equal((await runtimeRegistry.ensure({ id: 'session-main' })).id, 'session-main');
  await runtimeRegistry.prepareShutdown();
  assert.equal(preparations, 2, 'a later close attempt can prepare the same runtime again');
  assert.ok(snapshots.includes('idle'));
});

test('runtime preparation waits for factories already pending when close starts', async () => {
  let resolveFactory: ((runtime: { id: string }) => void) | null = null;
  const prepared: string[] = [];
  const registry = new ApplicationRuntimeRegistry({
    createRuntime: (_session: { id: string }) =>
      new Promise<{ id: string }>((resolve) => {
        resolveFactory = resolve;
      }),
    prepareRuntime: (runtime) => {
      prepared.push(runtime.id);
    },
    disposeRuntime: () => undefined,
  });
  const creation = registry.ensure({ id: 'pending-at-close' });
  await flushMicrotasks();
  const preparation = registry.prepareShutdown();
  let settled = false;
  void preparation.then(() => {
    settled = true;
  });
  await flushMicrotasks();
  assert.equal(settled, false);
  assert.ok(resolveFactory);
  (resolveFactory as (runtime: { id: string }) => void)({ id: 'runtime-pending' });
  await Promise.all([creation, preparation]);
  assert.deepEqual(prepared, ['runtime-pending']);
  assert.equal(registry.isShutdown, false);

  let rejectFactory: ((error: Error) => void) | null = null;
  const failingRegistry = new ApplicationRuntimeRegistry({
    createRuntime: (_session: { id: string }) =>
      new Promise<{ id: string }>((_resolve, reject) => {
        rejectFactory = reject;
      }),
    prepareRuntime: () => assert.fail('a failed factory never becomes resident'),
    disposeRuntime: () => undefined,
  });
  const failure = failingRegistry.ensure({ id: 'failed-at-close' });
  void failure.catch(() => undefined);
  await flushMicrotasks();
  const failedPreparation = failingRegistry.prepareShutdown();
  assert.ok(rejectFactory);
  (rejectFactory as (error: Error) => void)(new Error('factory failed'));
  await assert.rejects(failure, /factory failed/);
  await failedPreparation;
  assert.equal(failingRegistry.isShutdown, false);
});

test('force is exposed only for a failed decision and publishes the forced confirmation', async () => {
  let onClose: ((request: ShutdownCloseRequest) => void) | null = null;
  const confirmations: boolean[] = [];
  let resolveFailedReport: (() => void) | null = null;
  const failedReport = new Promise<void>((resolve) => {
    resolveFailedReport = resolve;
  });
  const controller = createApplicationShutdownController({
    application: { prepareShutdown: async () => undefined },
    sessionPersistence: { flushFinalPersistence: async () => 'timeout' },
    appSettings: { flushSettings: () => true },
    serialSettings: { flushSettings: () => true },
    protocol: {
      submitShutdownReport: (result) => {
        if (result.state === 'failed') resolveFailedReport?.();
      },
      confirmExit: (confirmation) => confirmations.push(confirmation.forced),
      cancelExit: () => undefined,
    },
    closeRequests: {
      listen: async (handler) => {
        onClose = handler;
        return () => undefined;
      },
    },
  });
  await controller.start();
  assert.ok(onClose);
  (onClose as (request: ShutdownCloseRequest) => void)({ attemptId: 'attempt-force' });
  await failedReport;
  await controller.force('attempt-force');
  assert.deepEqual(confirmations, [true]);
  assert.equal(controller.snapshot().coordinator.state, 'confirmed');
});

test('a rejected ready report remains visible and retryPublication completes the native handshake', async () => {
  let onClose: ((request: ShutdownCloseRequest) => void) | null = null;
  let reportAttempts = 0;
  let confirmations = 0;
  let resolveBoundaryFailure: (() => void) | null = null;
  const boundaryFailure = new Promise<void>((resolve) => {
    resolveBoundaryFailure = resolve;
  });
  const controller = createApplicationShutdownController({
    application: { prepareShutdown: async () => undefined },
    sessionPersistence: { flushFinalPersistence: async () => 'completed' },
    appSettings: { flushSettings: () => true },
    serialSettings: { flushSettings: () => true },
    protocol: {
      submitShutdownReport: () => {
        reportAttempts += 1;
        if (reportAttempts === 1) throw new Error('transient report rejection');
      },
      confirmExit: () => {
        confirmations += 1;
      },
      cancelExit: () => undefined,
    },
    closeRequests: {
      listen: async (handler) => {
        onClose = handler;
        return () => undefined;
      },
    },
  });
  controller.subscribe((value) => {
    if (value.boundaryError === 'close-request') resolveBoundaryFailure?.();
  });

  await controller.start();
  assert.ok(onClose);
  (onClose as (request: ShutdownCloseRequest) => void)({ attemptId: 'retry-ready-report' });
  await boundaryFailure;
  assert.equal(controller.snapshot().coordinator.state, 'ready');
  assert.equal(controller.snapshot().boundaryError, 'close-request');
  assert.equal(confirmations, 0);

  await controller.retryPublication('retry-ready-report');
  assert.equal(reportAttempts, 2);
  assert.equal(confirmations, 1);
  assert.equal(controller.snapshot().boundaryError, null);
  assert.equal(controller.snapshot().coordinator.state, 'confirmed');
});

test('Tauri close listener is a no-op in the browser renderer', async () => {
  const handler = () => assert.fail('browser mode has no native close event');
  const detach = await new TauriShutdownPort().listen(handler);
  detach();
});
