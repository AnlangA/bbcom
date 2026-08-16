/**
 * Monotonic revision counter for session mutations plus the per-session dirty
 * generation map. The workspace save barrier is the only durability owner:
 * `markDurable` is called exclusively after a successful workspace save, which
 * is what clears dirty generations. Legacy snapshot writing no longer exists;
 * the historical on-disk format stays readable through the migration reader in
 * `features/migration/legacy-session-snapshot-reader.ts`.
 */
export class SessionMutationRevisionTracker {
  private revision = 0;
  private readonly dirtySessions = new Map<string, number>();

  /** Record a mutation; optionally tag one session's configuration dirty. */
  markDirty(sessionId?: string): number {
    this.revision += 1;
    if (sessionId !== undefined) this.dirtySessions.set(sessionId, this.revision);
    return this.revision;
  }

  /**
   * Clear every dirty generation recorded so far. Only a successful workspace
   * save barrier may call this — a failed save keeps all dirty state so the
   * next barrier retries the unsaved mutations.
   */
  markDurable(): void {
    this.dirtySessions.clear();
  }

  isDirty(sessionId?: string): boolean {
    return sessionId === undefined
      ? this.dirtySessions.size > 0
      : this.dirtySessions.has(sessionId);
  }

  /** Forget one session's dirty tracking after that session was removed. */
  clearDirty(sessionId: string): void {
    this.dirtySessions.delete(sessionId);
  }

  currentRevision(): number {
    return this.revision;
  }

  /** Forget all dirty tracking after the session set was replaced wholesale. */
  reset(): void {
    this.dirtySessions.clear();
  }
}
