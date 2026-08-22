/**
 * Shared capture-accounting primitive for per-session frame sequences, frame
 * counts, and capture bytes plus the workspace-level aggregates.
 *
 * Two consumers previously re-implemented the same Map bookkeeping over the
 * same captured bytes: the workspace application service (durable projection
 * sequences/counts/bytes against the IPC workspace limits) and the session
 * capture controller (retained in-memory buffer bytes against the renderer
 * buffer limits). Each consumer owns one store instance; numbers are never
 * shared across the two domains, only the accounting mechanics.
 *
 * Aggregate semantics (preserved from the previous inline implementations):
 * additions are exact, removals clamp the workspace aggregates at zero, and
 * per-session rows are always written exactly (callers validate limits before
 * recording).
 */
export interface CaptureAccountingRegistration {
  readonly nextSequence: number;
  readonly frameCount: number;
  readonly captureBytes: number;
}

export interface CaptureSessionTotals extends CaptureAccountingRegistration {
  readonly sessionId: string;
}

export interface CaptureWorkspaceTotals {
  readonly frameCount: number;
  readonly captureBytes: number;
}

interface CaptureAccountingRow {
  nextSequence: number;
  frameCount: number;
  captureBytes: number;
}

export class CaptureAccountingStore {
  private readonly sessions = new Map<string, CaptureAccountingRow>();
  private workspaceFrameCount = 0;
  private workspaceCaptureBytes = 0;

  /** Number of registered sessions (workspace session-limit preflight input). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Register (or re-baseline) one session row and add its totals to the
   * workspace aggregates. Callers register each session exactly once per
   * workspace lifetime; restored rows pass their pre-remove totals. */
  registerSession(sessionId: string, registration: CaptureAccountingRegistration): void {
    this.sessions.set(sessionId, { ...registration });
    this.workspaceFrameCount += registration.frameCount;
    this.workspaceCaptureBytes += registration.captureBytes;
  }

  /**
   * Adjust one session's frame count and capture bytes by a delta. Positive
   * deltas add exactly; negative deltas write the row exactly while clamping
   * the workspace aggregates at zero (mirroring the previous clamped
   * subtract of the aggregate counters).
   */
  recordFrames(sessionId: string, count: number, bytes: number): void {
    const row = this.sessionRow(sessionId);
    row.frameCount += count;
    row.captureBytes += bytes;
    this.addWorkspaceFrames(count, bytes);
  }

  /**
   * Bytes-only variant of {@link recordFrames} for accounting domains that
   * track retained buffer bytes without frame counts or sequences.
   */
  recordBytes(sessionId: string, bytes: number): void {
    this.recordFrames(sessionId, 0, bytes);
  }

  /**
   * Absolute retained-bytes write for one session (capture-controller
   * semantics after a buffer trim): the workspace aggregate is adjusted by
   * the unclamped row delta.
   */
  setSessionBytes(sessionId: string, captureBytes: number): void {
    const row = this.sessionRow(sessionId);
    const previous = row.captureBytes;
    row.captureBytes = captureBytes;
    this.workspaceCaptureBytes += captureBytes - previous;
  }

  /**
   * Authoritative aggregate re-baseline after an external global trim that
   * reports the retained total directly. Per-session rows are adjusted
   * separately through {@link setSessionBytes}.
   */
  setWorkspaceBytes(captureBytes: number): void {
    this.workspaceCaptureBytes = captureBytes;
  }

  /**
   * Zero one session's row (sequence, frames, and bytes) while keeping it
   * registered, subtracting its previous totals from the aggregates. Returns
   * the previous row, or null when the session is not registered.
   */
  resetSession(sessionId: string): CaptureSessionTotals | null {
    const row = this.sessions.get(sessionId);
    if (!row) return null;
    const previous = this.snapshotRow(sessionId, row);
    row.nextSequence = 0;
    row.frameCount = 0;
    row.captureBytes = 0;
    this.addWorkspaceFrames(-previous.frameCount, -previous.captureBytes);
    return previous;
  }

  /**
   * Remove one session row and release its totals from the aggregates.
   * Returns the removed row, or null when the session is not registered.
   */
  removeSession(sessionId: string): CaptureSessionTotals | null {
    const row = this.sessions.get(sessionId);
    if (!row) return null;
    const removed = this.snapshotRow(sessionId, row);
    this.sessions.delete(sessionId);
    this.addWorkspaceFrames(-removed.frameCount, -removed.captureBytes);
    return removed;
  }

  /**
   * Replace every row and both aggregates from a freshly hydrated workspace
   * (or a freshly replaced session list). Aggregates are recomputed as the
   * exact sum of the entries.
   */
  replaceWorkspace(entries: readonly CaptureSessionTotals[]): void {
    this.sessions.clear();
    this.workspaceFrameCount = 0;
    this.workspaceCaptureBytes = 0;
    for (const entry of entries) this.registerSession(entry.sessionId, entry);
  }

  sessionTotals(sessionId: string): CaptureSessionTotals | null {
    const row = this.sessions.get(sessionId);
    return row ? this.snapshotRow(sessionId, row) : null;
  }

  workspaceTotals(): CaptureWorkspaceTotals {
    return Object.freeze({
      frameCount: this.workspaceFrameCount,
      captureBytes: this.workspaceCaptureBytes,
    });
  }

  /**
   * Current append sequence for one session. Undefined marks an unregistered
   * session (the previous `nextFrameSequence.has` gate).
   */
  nextFrameSequence(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.nextSequence;
  }

  /**
   * Reserve the next monotonic capture sequence for one session and advance
   * the counter. Pair with {@link recordFrames} when persisting counts/bytes.
   */
  allocateNextFrameSequence(sessionId: string): number {
    const row = this.sessionRow(sessionId);
    const sequence = row.nextSequence;
    row.nextSequence = sequence + 1;
    return sequence;
  }

  /** Reset only the append sequence (for example after clearing capture). */
  resetFrameSequence(sessionId: string): void {
    this.sessionRow(sessionId).nextSequence = 0;
  }

  /**
   * Overwrite one session's append sequence after reserving a frame. Does not
   * touch counts or bytes; pair with {@link recordFrames}.
   */
  setNextFrameSequence(sessionId: string, nextSequence: number): void {
    this.sessionRow(sessionId).nextSequence = nextSequence;
  }

  private sessionRow(sessionId: string): CaptureAccountingRow {
    let row = this.sessions.get(sessionId);
    if (!row) {
      row = { nextSequence: 0, frameCount: 0, captureBytes: 0 };
      this.sessions.set(sessionId, row);
    }
    return row;
  }

  private snapshotRow(sessionId: string, row: CaptureAccountingRow): CaptureSessionTotals {
    return Object.freeze({
      sessionId,
      nextSequence: row.nextSequence,
      frameCount: row.frameCount,
      captureBytes: row.captureBytes,
    });
  }

  private addWorkspaceFrames(count: number, bytes: number): void {
    this.workspaceFrameCount = Math.max(0, this.workspaceFrameCount + count);
    this.workspaceCaptureBytes = Math.max(0, this.workspaceCaptureBytes + bytes);
  }
}
