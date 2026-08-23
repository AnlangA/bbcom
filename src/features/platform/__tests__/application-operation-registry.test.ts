import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { IpcError } from '@/generated/ipc-contracts.ts';
import {
  DuplicateOperationIdError,
  InvalidOperationTransitionError,
  OperationRegistry,
  OperationRegistryShutdownError,
} from '@/features/platform/application/operation-registry.ts';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

test('operations preserve ownership and enforce legal monotonic progress transitions', () => {
  const registry = new OperationRegistry();
  const queued = registry.create({
    operationId: 'operation-1',
    kind: 'workspace-export',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    progress: { completedUnits: 0, totalUnits: 4 },
  });

  assert.deepEqual(queued, {
    operationId: 'operation-1',
    kind: 'workspace-export',
    status: 'queued',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    completedUnits: 0,
    totalUnits: 4,
  });
  assert.throws(() => registry.create({ ...queued }), DuplicateOperationIdError);
  assert.equal(registry.start('operation-1').status, 'running');
  assert.equal(registry.updateProgress('operation-1', { completedUnits: 2 }).completedUnits, 2);
  assert.throws(() => registry.updateProgress('operation-1', { completedUnits: 1 }));
  assert.throws(() => registry.updateProgress('operation-1', { completedUnits: 3, totalUnits: 5 }));
  assert.equal(registry.complete('operation-1').status, 'completed');
  assert.throws(() => registry.fail('operation-1', stableError()), InvalidOperationTransitionError);
  assert.throws(() => registry.start('operation-1'), InvalidOperationTransitionError);
  assert.throws(() =>
    registry.create({
      operationId: '../operation-path',
      kind: 'ai-request',
      workspaceId: 'workspace-1',
    }),
  );
  assert.throws(() =>
    registry.create({
      operationId: 'operation-empty-session',
      kind: 'ai-request',
      workspaceId: 'workspace-1',
      sessionId: '',
    }),
  );
  assert.throws(() =>
    registry.create({
      operationId: 'operation-empty-message-key',
      kind: 'ai-request',
      workspaceId: 'workspace-1',
      messageKey: '',
    }),
  );
});

test('cancellation is single-shot across races and observer detach never cancels', async () => {
  const cancellation = deferred();
  let cancelCalls = 0;
  let observerCalls = 0;
  const registry = new OperationRegistry();
  const detach = registry.subscribe(() => {
    observerCalls += 1;
  });
  registry.create({
    operationId: 'operation-cancel',
    kind: 'serial-send',
    workspaceId: 'workspace-1',
    cancel: () => {
      cancelCalls += 1;
      return cancellation.promise;
    },
  });
  detach();
  const observedBeforeTransition = observerCalls;
  registry.start('operation-cancel');
  assert.equal(observerCalls, observedBeforeTransition);
  assert.equal(cancelCalls, 0);

  const firstCancel = registry.cancel('operation-cancel');
  const secondCancel = registry.cancel('operation-cancel');
  assert.strictEqual(secondCancel, firstCancel);
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
  assert.equal(registry.get('operation-cancel')?.status, 'cancelling');
  assert.throws(() => registry.start('operation-cancel'), InvalidOperationTransitionError);
  cancellation.resolve();
  assert.equal((await firstCancel).status, 'cancelled');
  assert.equal((await secondCancel).status, 'cancelled');
  assert.equal(cancelCalls, 1);
});

test('an interrupt shares an in-flight cancellation and waits for its real terminal state', async () => {
  const cancellation = deferred();
  let cancelCalls = 0;
  const registry = new OperationRegistry();
  registry.create({
    operationId: 'operation-race',
    kind: 'ai-request',
    workspaceId: 'workspace-1',
    cancel: () => {
      cancelCalls += 1;
      return cancellation.promise;
    },
  });
  registry.start('operation-race');
  const cancelling = registry.cancel('operation-race');
  const interruption = registry.interrupt('operation-race');
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
  assert.equal(registry.get('operation-race')?.status, 'cancelling');
  cancellation.resolve();

  assert.equal((await interruption).status, 'cancelled');
  assert.equal((await cancelling).status, 'cancelled');
  assert.throws(() => registry.complete('operation-race'), InvalidOperationTransitionError);
});

test('completion may win a cancellation race and a rejected cancel remains retryable', async () => {
  const completion = deferred();
  const registry = new OperationRegistry();
  registry.create({
    operationId: 'operation-commit-race',
    kind: 'workspace-export',
    workspaceId: 'workspace-1',
    cancel: () => completion.promise,
  });
  registry.start('operation-commit-race');
  const cancellation = registry.cancel('operation-commit-race');
  registry.complete('operation-commit-race');
  completion.resolve();
  assert.equal((await cancellation).status, 'completed');

  let attempts = 0;
  registry.create({
    operationId: 'operation-retry-cancel',
    kind: 'workspace-import',
    workspaceId: 'workspace-1',
    cancel: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient native cancellation failure');
    },
  });
  registry.start('operation-retry-cancel');
  await assert.rejects(registry.interrupt('operation-retry-cancel'));
  assert.equal(registry.get('operation-retry-cancel')?.status, 'running');
  assert.equal((await registry.interrupt('operation-retry-cancel')).status, 'interrupted');
  assert.equal(attempts, 2);
});

test('failed operations retain only the stable IPC error projection', () => {
  const registry = new OperationRegistry();
  registry.create({
    operationId: 'operation-failed',
    kind: 'workspace-import',
    workspaceId: 'workspace-1',
  });
  const untrusted = {
    ...stableError(),
    path: '/private/workspace.bbcom',
    payload: { secret: true },
  } as IpcError & { path: string; payload: object };
  const failed = registry.fail('operation-failed', untrusted);

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, stableError());
  assert.equal('path' in (failed.error as object), false);
  assert.equal('payload' in (failed.error as object), false);
  assert.equal(Object.isFrozen(failed.error), true);
  assert.equal(Object.isFrozen(registry.snapshot()), true);
});

test('shutdown interrupts all active operations and invokes cancellation once', async () => {
  let cancelCalls = 0;
  const registry = new OperationRegistry();
  registry.create({
    operationId: 'operation-active',
    kind: 'workspace-import',
    workspaceId: 'workspace-1',
    cancel: () => {
      cancelCalls += 1;
    },
  });
  registry.start('operation-active');
  registry.create({
    operationId: 'operation-complete',
    kind: 'workspace-export',
    workspaceId: 'workspace-1',
  });
  registry.start('operation-complete');
  registry.complete('operation-complete');

  const firstShutdown = registry.shutdown();
  assert.strictEqual(registry.shutdown(), firstShutdown);
  await firstShutdown;
  assert.equal(registry.get('operation-active')?.status, 'interrupted');
  assert.equal(registry.get('operation-complete')?.status, 'completed');
  assert.equal(cancelCalls, 1);
  assert.throws(
    () =>
      registry.create({
        operationId: 'operation-after-shutdown',
        kind: 'ai-request',
        workspaceId: 'workspace-1',
      }),
    OperationRegistryShutdownError,
  );
});

function stableError(): IpcError {
  return {
    code: 'INVALID_INPUT',
    messageKey: 'errors.invalid_input',
    retryable: false,
    operation: 'workspace_export',
    requestId: 'request-1',
    field: 'format',
    limit: 4,
    actual: 5,
  };
}
