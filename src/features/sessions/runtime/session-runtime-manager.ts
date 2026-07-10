import {
  reconcileResidentSessionIds,
  resolveActiveSessionRuntime,
  type ActiveSessionRuntime,
} from './session-residency';

/** The minimum identity exposed by a resident session runtime. */
export interface ManagedSessionRuntime {
  readonly sessionId: string;
}

/** The minimum identity exposed by a persisted session. */
export interface ManagedSession {
  readonly id: string;
}

/**
 * Application-level ownership registry for long-lived session runtimes.
 *
 * Vue mounts the small headless runtime hosts, but this manager owns the
 * residency decision and the session-id → runtime association. Consequently a
 * tab change can replace the sole heavy view without removing the port,
 * watcher, Modbus controller, trigger stream, or write scheduler behind it.
 */
export class SessionRuntimeManager<
  TSession extends ManagedSession,
  TRuntime extends ManagedSessionRuntime,
> {
  private residentIds: string[] = [];
  private readonly runtimes: Map<string, TRuntime>;

  constructor(runtimes: Map<string, TRuntime> = new Map()) {
    this.runtimes = runtimes;
  }

  get residentSessionIds(): readonly string[] {
    return this.residentIds;
  }

  get size(): number {
    return this.runtimes.size;
  }

  reconcile(sessions: readonly TSession[], activeSessionId: string | null): readonly string[] {
    this.residentIds = reconcileResidentSessionIds(
      this.residentIds,
      sessions.map((session) => session.id),
      activeSessionId,
    );
    return this.residentIds;
  }

  register(runtime: TRuntime): void {
    this.runtimes.set(runtime.sessionId, runtime);
  }

  unregister(runtime: TRuntime): void {
    if (this.runtimes.get(runtime.sessionId) === runtime) {
      this.runtimes.delete(runtime.sessionId);
    }
  }

  resolveActive(
    sessions: readonly TSession[],
    activeSessionId: string | null,
  ): ActiveSessionRuntime<TSession, TRuntime> | null {
    return resolveActiveSessionRuntime(sessions, this.runtimes, activeSessionId);
  }
}
