import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ApplicationRuntimeCreationSupersededError,
  ApplicationRuntimeRegistry,
  ApplicationRuntimeRegistryShutdownError,
  DuplicateApplicationRuntimeError,
  type RuntimeDisposalContext,
} from '../../src/features/platform/application/application-runtime-registry.ts';

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

test('create, ensure, and reconcile validate identities and refresh resident metadata', async () => {
  const updates: string[] = [];
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: (session) => ({ id: `runtime-${session.id}` }),
    updateRuntime: (_runtime, session) => updates.push(session.label),
    disposeRuntime: () => undefined,
  });
  const detach = registry.subscribe(() => {
    throw new Error('observer failure is isolated');
  });

  const runtime = await registry.create({ id: 'session-create', label: 'first' });
  assert.equal(runtime.id, 'runtime-session-create');
  assert.deepEqual(
    registry.list().map((entry) => entry.sessionId),
    ['session-create'],
  );
  await assert.rejects(
    registry.create({ id: 'session-create', label: 'duplicate' }),
    DuplicateApplicationRuntimeError,
  );
  assert.strictEqual(await registry.ensure({ id: 'session-create', label: 'ensured' }), runtime);
  await registry.reconcile([{ id: 'session-create', label: 'reconciled' }]);
  assert.deepEqual(updates, ['ensured', 'reconciled']);
  await assert.rejects(
    registry.reconcile([
      { id: 'duplicate', label: 'one' },
      { id: 'duplicate', label: 'two' },
    ]),
    /duplicate session identity/,
  );
  assert.throws(() => registry.ensure({ id: '   ', label: 'invalid' }), /must not be empty/);
  await registry.disposeSession('not-resident');
  detach();
});

test('prepareShutdown shares in-flight preparation and aggregates failures', async () => {
  const preparation = deferred<void>();
  let preparationCalls = 0;
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: (session) => ({ id: `runtime-${session.id}` }),
    prepareRuntime: () => {
      preparationCalls += 1;
      return preparation.promise;
    },
    disposeRuntime: () => undefined,
  });
  await registry.ensure({ id: 'session-prepare', label: 'prepare' });

  const first = registry.prepareShutdown();
  const second = registry.prepareShutdown();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(preparationCalls, 1);
  preparation.reject(new Error('prepare failed'));
  await assert.rejects(first, AggregateError);
  await assert.rejects(second, AggregateError);

  const noPrepare = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => ({ id: 'unused' }),
    disposeRuntime: () => undefined,
  });
  await noPrepare.ensure({ id: 'without-prepare-hook', label: 'resident' });
  await noPrepare.prepareShutdown();
});

test('resident shutdown publishes removal and aggregates disposal errors', async () => {
  const sizes: number[] = [];
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: (session) => ({ id: `runtime-${session.id}` }),
    disposeRuntime: async () => {
      throw new Error('dispose failed');
    },
  });
  registry.subscribe((entries) => sizes.push(entries.length));
  await registry.ensure({ id: 'session-resident', label: 'resident' });
  await assert.rejects(registry.shutdown(), AggregateError);
  assert.deepEqual(sizes, [0, 1, 0]);
  assert.equal(registry.isShutdown, true);
});

test('pending duplicate creation rejects and pending disposal propagates a real cleanup failure', async () => {
  const creation = deferred<TestRuntime>();
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => creation.promise,
    disposeRuntime: async () => {
      throw new Error('pending cleanup failed');
    },
  });
  const pending = registry.create({ id: 'session-pending', label: 'pending' });
  await assert.rejects(
    registry.create({ id: 'session-pending', label: 'duplicate pending' }),
    DuplicateApplicationRuntimeError,
  );
  const disposal = registry.disposeSession('session-pending');
  creation.resolve({ id: 'runtime-pending' });
  await assert.rejects(pending, /pending cleanup failed/);
  await assert.rejects(disposal, /pending cleanup failed/);

  const resident = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => ({ id: 'runtime-resident' }),
    disposeRuntime: () => undefined,
  });
  await resident.ensure({ id: 'session-removed-by-reconcile', label: 'resident' });
  await resident.reconcile([]);
  assert.equal(resident.size, 0);
});

test('a new runtime can replace one whose shutdown preparation is still settling', async () => {
  const firstPreparation = deferred<void>();
  const secondPreparation = deferred<void>();
  let runtimeSequence = 0;
  const prepared: string[] = [];
  const registry = new ApplicationRuntimeRegistry<TestSession, TestRuntime>({
    createRuntime: () => ({ id: `runtime-${++runtimeSequence}` }),
    prepareRuntime: (runtime) => {
      prepared.push(runtime.id);
      return runtime.id === 'runtime-1' ? firstPreparation.promise : secondPreparation.promise;
    },
    disposeRuntime: () => undefined,
  });
  await registry.ensure({ id: 'session-reused', label: 'first' });
  const first = registry.prepareShutdown();
  await Promise.resolve();
  await registry.disposeSession('session-reused');
  await registry.ensure({ id: 'session-reused', label: 'second' });
  const second = registry.prepareShutdown();
  await Promise.resolve();
  assert.deepEqual(prepared, ['runtime-1', 'runtime-2']);

  firstPreparation.resolve();
  secondPreparation.resolve();
  await Promise.all([first, second]);
});
