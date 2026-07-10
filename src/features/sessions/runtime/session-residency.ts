/**
 * Reconcile the set of headless session runtimes that must remain mounted.
 *
 * A session becomes resident only after it is activated. Existing residents
 * stay resident across tab switches so their connections and background tasks
 * do not get torn down. IDs that no longer exist in the session catalog are
 * removed immediately, which lets Vue unmount the corresponding runtime and
 * run its cleanup hooks.
 */
export function reconcileResidentSessionIds(
  residentSessionIds: readonly string[],
  availableSessionIds: readonly string[],
  activeSessionId: string | null,
): string[] {
  const available = new Set(availableSessionIds);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const sessionId of residentSessionIds) {
    if (!available.has(sessionId) || seen.has(sessionId)) continue;
    seen.add(sessionId);
    next.push(sessionId);
  }

  if (activeSessionId && available.has(activeSessionId) && !seen.has(activeSessionId)) {
    next.push(activeSessionId);
  }

  return next;
}

export interface ActiveSessionRuntime<TSession, TRuntime> {
  session: TSession;
  runtime: TRuntime;
}

/** Resolve the sole heavy UI binding. A missing controller yields no view. */
export function resolveActiveSessionRuntime<TSession extends { id: string }, TRuntime>(
  sessions: readonly TSession[],
  runtimes: ReadonlyMap<string, TRuntime>,
  activeSessionId: string | null,
): ActiveSessionRuntime<TSession, TRuntime> | null {
  if (!activeSessionId) return null;
  const session = sessions.find((item) => item.id === activeSessionId);
  const runtime = runtimes.get(activeSessionId);
  return session && runtime ? { session, runtime } : null;
}
