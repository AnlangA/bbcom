import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  reconcileResidentSessionIds,
  resolveActiveSessionRuntime,
} from '../../src/features/sessions/runtime/session-residency.ts';
import { SessionRuntimeManager } from '../../src/features/sessions/runtime/session-runtime-manager.ts';

test('restored sessions stay lazy until they are first activated', () => {
  assert.deepEqual(reconcileResidentSessionIds([], ['a', 'b', 'c'], 'b'), ['b']);
});

test('switching tabs keeps previously visited sessions resident', () => {
  const afterFirstVisit = reconcileResidentSessionIds([], ['a', 'b', 'c'], 'a');
  const afterSecondVisit = reconcileResidentSessionIds(afterFirstVisit, ['a', 'b', 'c'], 'b');

  assert.deepEqual(afterSecondVisit, ['a', 'b']);
});

test('removing an inactive session evicts it from the resident set', () => {
  assert.deepEqual(reconcileResidentSessionIds(['a', 'b'], ['b', 'c'], 'b'), ['b']);
});

test('removing the active session prunes it and mounts only the replacement active session', () => {
  assert.deepEqual(reconcileResidentSessionIds(['a', 'b'], ['a', 'c'], 'c'), ['a', 'c']);
});

test('a null or unknown active id never creates a resident view', () => {
  assert.deepEqual(reconcileResidentSessionIds(['a'], ['a', 'b'], null), ['a']);
  assert.deepEqual(reconcileResidentSessionIds(['a'], ['a', 'b'], 'missing'), ['a']);
});

test('reconciliation is deterministic, de-duplicates ids, and does not mutate its inputs', () => {
  const residents = ['b', 'a', 'b'];
  const available = ['a', 'b', 'c'];

  assert.deepEqual(reconcileResidentSessionIds(residents, available, 'c'), ['b', 'a', 'c']);
  assert.deepEqual(residents, ['b', 'a', 'b']);
  assert.deepEqual(available, ['a', 'b', 'c']);
});

test('only the active session resolves to a heavy UI binding', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };
  const runtimes = new Map([
    ['a', runtimeA],
    ['b', runtimeB],
  ]);

  assert.deepEqual(resolveActiveSessionRuntime(sessions, runtimes, 'a'), {
    session: sessions[0],
    runtime: runtimeA,
  });
  assert.deepEqual(resolveActiveSessionRuntime(sessions, runtimes, 'b'), {
    session: sessions[1],
    runtime: runtimeB,
  });
  assert.equal(resolveActiveSessionRuntime(sessions, runtimes, 'c'), null);
  assert.equal(resolveActiveSessionRuntime(sessions, runtimes, null), null);
  assert.equal(runtimes.size, 2, 'switching the sole UI binding retains both headless runtimes');
});

test('SessionRuntimeManager retains per-session runtimes while the active binding changes', () => {
  const manager = new SessionRuntimeManager<{ id: string }, { sessionId: string; label: string }>();
  const first = { sessionId: 'first', label: 'first-runtime' };
  const second = { sessionId: 'second', label: 'second-runtime' };
  const sessions = [{ id: 'first' }, { id: 'second' }];

  manager.reconcile(sessions, 'first');
  manager.register(first);
  manager.register(second);
  assert.deepEqual(manager.residentSessionIds, ['first']);
  assert.equal(manager.resolveActive(sessions, 'first')?.runtime, first);

  manager.reconcile(sessions, 'second');
  assert.deepEqual(manager.residentSessionIds, ['first', 'second']);
  assert.equal(manager.resolveActive(sessions, 'second')?.runtime, second);
  assert.equal(manager.size, 2);

  manager.unregister(first);
  assert.equal(manager.resolveActive(sessions, 'first'), null);
  assert.equal(manager.size, 1);
});

test('SessionRuntimeManager ignores a stale cleanup from a replaced runtime', () => {
  const manager = new SessionRuntimeManager<
    { id: string },
    { sessionId: string; generation: number }
  >();
  const stale = { sessionId: 'same-session', generation: 1 };
  const replacement = { sessionId: 'same-session', generation: 2 };
  const sessions = [{ id: 'same-session' }];

  manager.register(stale);
  manager.register(replacement);
  manager.unregister(stale);

  assert.equal(manager.size, 1);
  assert.equal(manager.resolveActive(sessions, 'same-session')?.runtime, replacement);
  manager.unregister(replacement);
  assert.equal(manager.size, 0);
});
