import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  MIGRATION_STEPS,
  SESSION_STORAGE_VERSION,
  UnsupportedSessionStorageVersionError,
  migratePersistedFile,
  type PersistedSessionsFile,
} from '../../src/lib/session-persistence.ts';

function minimalFile(
  version: number,
  overrides: Partial<PersistedSessionsFile> = {},
): PersistedSessionsFile {
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
  assert.notEqual(out, file, 'migration never mutates the caller-owned blob');
});

test('migratePersistedFile: malformed top-level fields normalize safely', () => {
  assert.deepEqual(migratePersistedFile({ version: 'bad', activeSessionId: 42, sessions: null }), {
    version: SESSION_STORAGE_VERSION,
    activeSessionId: null,
    mruSessionIds: [],
    sessions: [],
  });
  assert.deepEqual(migratePersistedFile(null), {
    version: SESSION_STORAGE_VERSION,
    activeSessionId: null,
    mruSessionIds: [],
    sessions: [],
  });
});

test('migratePersistedFile: future schemas are rejected without mutation', () => {
  const future = minimalFile(SESSION_STORAGE_VERSION + 1, { activeSessionId: 'future' });
  assert.throws(
    () => migratePersistedFile(future),
    (error) =>
      error instanceof UnsupportedSessionStorageVersionError &&
      error.storedVersion === SESSION_STORAGE_VERSION + 1,
  );
  assert.equal(future.version, SESSION_STORAGE_VERSION + 1);
  assert.equal(future.activeSessionId, 'future');
});

test('migratePersistedFile: legacy blobs are discarded on startup', () => {
  const legacy = minimalFile(1, {
    activeSessionId: 'abc',
    sessions: [{ id: 's1' } as PersistedSessionsFile['sessions'][number]],
  });
  const out = migratePersistedFile(legacy);

  assert.equal(out.version, SESSION_STORAGE_VERSION);
  assert.equal(out.activeSessionId, null);
  assert.deepEqual(out.sessions, []);
});

test('MIGRATION_STEPS: registry is empty for the v2-only persistence gate', () => {
  assert.equal(MIGRATION_STEPS.length, 0);
  assert.equal(SESSION_STORAGE_VERSION, 2);
});
