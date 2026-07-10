import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, effectScope, ref } from 'vue';
import { reconcileResidentSessionIds } from '../../src/features/sessions/runtime/session-residency.ts';
import { useActiveFrameVersion } from '../../src/features/sessions/runtime/active-frame-version.ts';

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

test('inactive resident views freeze their UI pulse and catch up once reactivated', () => {
  const scope = effectScope();
  scope.run(() => {
    const active = ref(false);
    const currentVersion = ref(0);
    let versionReads = 0;
    const trackedVersion = computed(() => {
      versionReads += 1;
      return currentVersion.value;
    });
    const visibleVersion = useActiveFrameVersion(active, trackedVersion);

    assert.equal(visibleVersion.value, 0);
    assert.equal(versionReads, 0, 'an initially hidden view does not subscribe to frame pulses');

    currentVersion.value = 1;
    assert.equal(visibleVersion.value, 0);
    assert.equal(versionReads, 0, 'background frames do not wake the hidden UI');

    active.value = true;
    assert.equal(visibleVersion.value, 1, 'activation catches the UI up to the latest frame');
    assert.equal(versionReads, 1);

    currentVersion.value = 2;
    assert.equal(visibleVersion.value, 2, 'active views continue receiving frame pulses');
    assert.equal(versionReads, 2);

    active.value = false;
    currentVersion.value = 3;
    assert.equal(visibleVersion.value, 2, 'deactivation freezes the last rendered version');
    assert.equal(versionReads, 2, 'the hidden view unsubscribes from further frame pulses');

    active.value = true;
    assert.equal(visibleVersion.value, 3);
    assert.equal(versionReads, 3);
  });
  scope.stop();
});
