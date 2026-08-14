import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ApplicationRuntimeCreationSupersededError,
  ApplicationRuntimeRegistry,
  ApplicationRuntimeRegistryShutdownError,
  type RuntimeDisposalContext,
} from '../../src/features/application/application-runtime-registry.ts';

interface TestSession {
  id: string;
  label: string;
}

interface TestRuntime {
  id: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test('concurrent ensure shares creation and observer detach leaves the runtime resident', async () => {
  const creation = deferred<TestRuntime>();
  const disposals: RuntimeDisposalContext<TestSession>[] = [];
  let factoryCalls = 0;
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => {
      factoryCalls += 1;
      return creation.promise;
    },
    disposeRuntime: (_runtime, context) => {
      disposals.push(context);
    },
  });
  const observedSizes: number[] = [];
  const detach = registry.subscribe((entries) => observedSizes.push(entries.length));
  const first = registry.ensure({ id: 'session-1', label: 'first' });
  const second = registry.ensure({ id: 'session-1', label: 'first' });

  assert.strictEqual(second, first);
  await Promise.resolve();
  assert.equal(factoryCalls, 1);
  creation.resolve({ id: 'runtime-1' });
  assert.strictEqual(await first, await second);
  assert.deepEqual(observedSizes, [0, 1]);

  detach();
  const resident = await registry.ensure({ id: 'session-1', label: 'renamed' });
  assert.strictEqual(resident, registry.get('session-1'));
  assert.equal(factoryCalls, 1);
  assert.equal(disposals.length, 0);

  await registry.disposeSession('session-1');
  assert.equal(disposals.length, 1);
  assert.equal(disposals[0]?.reason, 'session-removed');
  assert.equal(disposals[0]?.session.label, 'renamed');
});

test('failed creation is retryable and pending removal treats non-residency as cleaned', async () => {
  const firstCreation = deferred<TestRuntime>();
  const factoryError = new Error('factory failed');
  let attempts = 0;
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => {
      attempts += 1;
      return attempts === 1 ? firstCreation.promise : { id: 'runtime-after-retry' };
    },
    disposeRuntime: () => undefined,
  });
  const creationOutcome = registry
    .ensure({ id: 'session-retry', label: 'retry' })
    .catch((error: unknown) => error);
  await Promise.resolve();
  const removal = registry.disposeSession('session-retry');
  firstCreation.reject(factoryError);

  assert.strictEqual(await creationOutcome, factoryError);
  await removal;
  assert.equal(registry.get('session-retry'), undefined);

  const runtime = await registry.ensure({ id: 'session-retry', label: 'retry' });
  assert.equal(runtime.id, 'runtime-after-retry');
  assert.equal(attempts, 2);
});

test('reconcile disposes a pending successful runtime with the reconciliation reason', async () => {
  const creation = deferred<TestRuntime>();
  const disposals: RuntimeDisposalContext<TestSession>[] = [];
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => creation.promise,
    disposeRuntime: (_runtime, context) => {
      disposals.push(context);
    },
  });
  const creationOutcome = registry
    .ensure({ id: 'session-stale', label: 'stale' })
    .catch((error: unknown) => error);
  await Promise.resolve();
  const reconciliation = registry.reconcile([]);
  creation.resolve({ id: 'runtime-stale' });

  assert.ok((await creationOutcome) instanceof ApplicationRuntimeCreationSupersededError);
  await reconciliation;
  assert.equal(registry.size, 0);
  assert.equal(disposals.length, 1);
  assert.equal(disposals[0]?.reason, 'reconcile');
});

test('shutdown interrupts pending residency, disposes it once, and closes the registry', async () => {
  const creation = deferred<TestRuntime>();
  const disposalReasons: string[] = [];
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => creation.promise,
    disposeRuntime: (_runtime, context) => {
      disposalReasons.push(context.reason);
    },
  });
  const creationOutcome = registry
    .ensure({ id: 'session-shutdown', label: 'active' })
    .catch((error: unknown) => error);
  await Promise.resolve();
  const firstShutdown = registry.shutdown();
  assert.strictEqual(registry.shutdown(), firstShutdown);
  creation.resolve({ id: 'runtime-shutdown' });

  assert.ok((await creationOutcome) instanceof ApplicationRuntimeCreationSupersededError);
  await firstShutdown;
  assert.deepEqual(disposalReasons, ['application-shutdown']);
  assert.throws(
    () => registry.ensure({ id: 'session-new', label: 'new' }),
    ApplicationRuntimeRegistryShutdownError,
  );
});
