export type SessionRuntimePhase =
  'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'closing' | 'failed';

export interface SessionRuntimeStatus {
  readonly phase: SessionRuntimePhase;
  readonly droppedBytes: number;
  readonly failure: string | null;
}

export type SessionRuntimeStatusListener = (status: SessionRuntimeStatus) => void;

const STOPPED_STATUS: SessionRuntimeStatus = Object.freeze({
  phase: 'stopped',
  droppedBytes: 0,
  failure: null,
});

/**
 * Process-owned authority for transient session connection state.
 *
 * Persisted session documents are deliberately not accepted here. Hydration
 * therefore always observes `stopped`, and only a resident serial runtime can
 * publish a later phase.
 */
export class SessionRuntimeStatusRegistry {
  private readonly statuses = new Map<string, SessionRuntimeStatus>();
  private readonly listeners = new Map<string, Set<SessionRuntimeStatusListener>>();
  private readonly allListeners = new Set<
    (sessionId: string, status: SessionRuntimeStatus) => void
  >();

  get(sessionId: string): SessionRuntimeStatus {
    return this.statuses.get(validSessionId(sessionId)) ?? STOPPED_STATUS;
  }

  publish(sessionId: string, status: SessionRuntimeStatus): SessionRuntimeStatus {
    const id = validSessionId(sessionId);
    const next = normalizeStatus(status);
    const previous = this.statuses.get(id) ?? STOPPED_STATUS;
    if (sameStatus(previous, next)) return previous;
    this.statuses.set(id, next);
    for (const listener of this.listeners.get(id) ?? []) listener(next);
    for (const listener of this.allListeners) listener(id, next);
    return next;
  }

  stop(sessionId: string): void {
    this.publish(sessionId, STOPPED_STATUS);
  }

  remove(sessionId: string): void {
    const id = validSessionId(sessionId);
    this.statuses.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener(STOPPED_STATUS);
    for (const listener of this.allListeners) listener(id, STOPPED_STATUS);
  }

  reconcile(sessionIds: readonly string[]): void {
    const retained = new Set(sessionIds.map(validSessionId));
    for (const sessionId of this.statuses.keys()) {
      if (!retained.has(sessionId)) this.remove(sessionId);
    }
    for (const sessionId of retained) this.stop(sessionId);
  }

  subscribe(sessionId: string, listener: SessionRuntimeStatusListener): () => void {
    const id = validSessionId(sessionId);
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    listener(this.get(id));
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(id);
    };
  }

  subscribeAll(listener: (sessionId: string, status: SessionRuntimeStatus) => void): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }
}

function normalizeStatus(status: SessionRuntimeStatus): SessionRuntimeStatus {
  if (!Number.isSafeInteger(status.droppedBytes) || status.droppedBytes < 0) {
    throw new Error('session runtime dropped bytes must be a non-negative safe integer');
  }
  if (
    !['stopped', 'connecting', 'connected', 'reconnecting', 'closing', 'failed'].includes(
      status.phase,
    )
  ) {
    throw new Error('invalid session runtime phase');
  }
  return Object.freeze({
    phase: status.phase,
    droppedBytes: status.droppedBytes,
    failure: status.failure?.trim() || null,
  });
}

function validSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) throw new Error('session runtime status requires an identity');
  return value;
}

function sameStatus(left: SessionRuntimeStatus, right: SessionRuntimeStatus): boolean {
  return (
    left.phase === right.phase &&
    left.droppedBytes === right.droppedBytes &&
    left.failure === right.failure
  );
}
