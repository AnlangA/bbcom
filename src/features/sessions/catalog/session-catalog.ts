import type { SerialSession } from '../../../types/session';

const MAX_MRU_SESSIONS = 8;

/**
 * Owns the non-reactive ordering metadata for the resident session catalog.
 * Vue refs remain in the Pinia facade; this controller only makes catalog
 * decisions and therefore stays usable outside component lifecycles.
 */
export class SessionCatalogController {
  private mruSessionIds: string[] = [];

  snapshotMruSessionIds(): string[] {
    return [...this.mruSessionIds];
  }

  replace(
    sessions: readonly SerialSession[],
    requestedActiveSessionId: string | null | undefined,
    savedMruSessionIds: readonly string[] = [],
  ): string | null {
    const validIds = new Set(sessions.map((session) => session.id));
    this.mruSessionIds = savedMruSessionIds
      .filter((id) => validIds.has(id))
      .slice(0, MAX_MRU_SESSIONS);
    const activeSessionId = resolveActiveSessionId(sessions, requestedActiveSessionId);
    if (activeSessionId) this.touch(activeSessionId);
    return activeSessionId;
  }

  merge(
    sessions: readonly SerialSession[],
    restoredSessionIds: readonly string[],
    requestedActiveSessionId: string | null | undefined,
    savedMruSessionIds: readonly string[] = [],
    currentActiveSessionId: string | null,
  ): string | null {
    this.mruSessionIds = uniqueSessionIds([
      ...this.mruSessionIds,
      ...savedMruSessionIds,
      ...restoredSessionIds,
    ]).slice(0, MAX_MRU_SESSIONS);
    const activeSessionId = currentActiveSessionId
      ? currentActiveSessionId
      : resolveActiveSessionId(sessions, requestedActiveSessionId);
    if (activeSessionId) this.touch(activeSessionId);
    return activeSessionId;
  }

  touch(sessionId: string): void {
    this.mruSessionIds = [sessionId, ...this.mruSessionIds.filter((id) => id !== sessionId)].slice(
      0,
      MAX_MRU_SESSIONS,
    );
  }

  remove(sessionId: string): void {
    this.mruSessionIds = this.mruSessionIds.filter((id) => id !== sessionId);
  }
}

export function resolveActiveSessionId(
  sessions: readonly SerialSession[],
  requestedActiveSessionId: string | null | undefined,
): string | null {
  if (
    requestedActiveSessionId &&
    sessions.some((session) => session.id === requestedActiveSessionId)
  ) {
    return requestedActiveSessionId;
  }
  return sessions[0]?.id ?? null;
}

export function reorderSessionCatalog(
  sessions: readonly SerialSession[],
  fromIndex: number,
  toIndex: number,
): SerialSession[] | null {
  if (fromIndex === toIndex) return null;
  if (fromIndex < 0 || fromIndex >= sessions.length) return null;
  if (toIndex < 0 || toIndex >= sessions.length) return null;
  const reordered = [...sessions];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  return reordered;
}

function uniqueSessionIds(ids: readonly string[]): string[] {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}
