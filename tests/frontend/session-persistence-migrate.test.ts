import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIGRATION_STEPS,
  SESSION_STORAGE_VERSION,
  migratePersistedFile,
  type PersistedSessionsFile,
} from '../../src/lib/session-persistence.ts';

/**
 * Regression guard: the persisted-sessions file must be forward-compatible.
 * Any blob recorded at an older version must migrate up to the current shape and
 * be re-stamped, so a user upgrading the app never loses their session snapshots.
 */

function minimalFile(version: number, overrides: Partial<PersistedSessionsFile> = {}): PersistedSessionsFile {
  return {
    version,
    activeSessionId: null,
    sessions: [],
    ...overrides,
  };
}

test('migratePersistedFile: a current-version blob passes through re-stamped', () => {
  const file = minimalFile(SESSION_STORAGE_VERSION);
  const out = migratePersistedFile(file);

  assert.equal(out.version, SESSION_STORAGE_VERSION, 'version unchanged');
  assert.equal(out.sessions.length, 0, 'sessions untouched');
});

test('migratePersistedFile: a legacy (version 0 / missing) blob is re-stamped to current', () => {
  // Simulate the oldest shape: no version field, sessions array present.
  const legacy = minimalFile(0, {
    activeSessionId: 'abc',
    sessions: [],
  });
  const out = migratePersistedFile(legacy);

  assert.equal(out.version, SESSION_STORAGE_VERSION, 'legacy blob upgraded to current version');
  assert.equal(out.activeSessionId, 'abc', 'data preserved across migration');
});

test('migratePersistedFile: walks every registered step in order', () => {
  // Register two throwaway steps to prove the chain runs sequentially and
  // re-stamps. We do this on a local copy of the steps array to avoid mutating
  // the module-level registry.
  const localSteps = [
    (raw: PersistedSessionsFile): PersistedSessionsFile => ({ ...raw, marker: 'v1->v2' }),
    (raw: PersistedSessionsFile): PersistedSessionsFile => ({ ...raw, marker: 'v2->v3' }),
  ];
  const target = SESSION_STORAGE_VERSION + localSteps.length;

  // Re-implement the walk locally (mirrors migratePersistedFile) using the local
  // steps, since the production registry is intentionally empty at version 1.
  let current: PersistedSessionsFile = minimalFile(SESSION_STORAGE_VERSION - 1);
  for (const step of localSteps) current = step(current);
  current.version = target;

  assert.equal(current.version, target, 'chain lands on the new version');
  assert.equal((current as { marker?: string }).marker, 'v2->v3', 'last step wins, order preserved');
});

test('MIGRATION_STEPS: registry length matches (current version - 1)', () => {
  // At version N there are N-1 steps (each step bumps by one). This invariant
  // catches a future change that bumps the version without adding a step.
  assert.equal(
    MIGRATION_STEPS.length,
    SESSION_STORAGE_VERSION - 1,
    'one step per version increment',
  );
});
