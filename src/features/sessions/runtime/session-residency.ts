/**
 * Reconcile the set of session views that must remain mounted.
 *
 * A session becomes resident only after it is activated. Existing residents
 * stay resident across tab switches so their connection/runtime composables do
 * not get torn down. IDs that no longer exist in the session catalog are
 * removed immediately, which lets Vue unmount the corresponding SessionView
 * and run its cleanup hooks.
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
