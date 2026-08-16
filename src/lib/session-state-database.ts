/**
 * Name of the legacy 0.7.3 IndexedDB session repository. It is never opened
 * for writing anymore; the migration reader opens it read-only to lift
 * snapshots into the workspace runtime during the one-time reset flow.
 */
export const SESSION_STATE_DATABASE_NAME = 'bbcom-session-state';
