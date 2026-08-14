export interface ApplicationSessionIdentity {
  readonly id: string;
}

export type RuntimeDisposalReason = 'session-removed' | 'reconcile' | 'application-shutdown';

export interface RuntimeDisposalContext<TSession> {
  readonly sessionId: string;
  readonly session: TSession;
  readonly reason: RuntimeDisposalReason;
}

export interface RuntimePreparationContext<TSession> {
  readonly sessionId: string;
  readonly session: TSession;
}

export interface ApplicationRuntimeRegistryOptions<TSession, TRuntime> {
  createRuntime(session: TSession): TRuntime | Promise<TRuntime>;
  updateRuntime?(runtime: TRuntime, session: TSession): void;
  /** Safely quiet a resident runtime without disposing or permanently sealing it. */
  prepareRuntime?(
    runtime: TRuntime,
    context: RuntimePreparationContext<TSession>,
  ): void | Promise<void>;
  disposeRuntime(
    runtime: TRuntime,
    context: RuntimeDisposalContext<TSession>,
  ): void | Promise<void>;
}

export interface ApplicationRuntimeEntry<TSession, TRuntime> {
  readonly sessionId: string;
  readonly session: TSession;
  readonly runtime: TRuntime;
}

export type ApplicationRuntimeListener<TSession, TRuntime> = (
  entries: readonly ApplicationRuntimeEntry<TSession, TRuntime>[],
) => void;

export class ApplicationRuntimeRegistryShutdownError extends Error {
  constructor() {
    super('application runtime registry is shut down');
    this.name = 'ApplicationRuntimeRegistryShutdownError';
  }
}

export class DuplicateApplicationRuntimeError extends Error {
  constructor(sessionId: string) {
    super(`runtime already exists or is being created for session ${sessionId}`);
    this.name = 'DuplicateApplicationRuntimeError';
  }
}

export class ApplicationRuntimeCreationSupersededError extends Error {
  constructor(sessionId: string) {
    super(`runtime creation was superseded for session ${sessionId}`);
    this.name = 'ApplicationRuntimeCreationSupersededError';
  }
}

interface MutableRuntimeEntry<TSession, TRuntime> {
  sessionId: string;
  session: TSession;
  runtime: TRuntime;
}

interface PendingRuntime<TRuntime> {
  readonly promise: Promise<TRuntime>;
  readonly state: PendingRuntimeState;
}

interface PendingRuntimeState {
  disposalReason?: RuntimeDisposalReason;
  runtimeCreated: boolean;
}

interface RuntimePreparation<TRuntime> {
  readonly runtime: TRuntime;
  readonly promise: Promise<void>;
}

/**
 * Application-owned session runtimes, independent from Vue component scopes.
 *
 * Calling a subscription's detach function only removes that observer. A
 * runtime is disposed exclusively by `disposeSession`, `reconcile` detecting
 * a deleted session, or application `shutdown`.
 */
export class ApplicationRuntimeRegistry<TSession extends ApplicationSessionIdentity, TRuntime> {
  private readonly entries = new Map<string, MutableRuntimeEntry<TSession, TRuntime>>();
  private readonly pending = new Map<string, PendingRuntime<TRuntime>>();
  private readonly generations = new Map<string, number>();
  private readonly preparations = new Map<string, RuntimePreparation<TRuntime>>();
  private readonly listeners = new Set<ApplicationRuntimeListener<TSession, TRuntime>>();
  private shuttingDown = false;
  private shutdownTask: Promise<void> | null = null;

  constructor(private readonly options: ApplicationRuntimeRegistryOptions<TSession, TRuntime>) {}

  get isShutdown(): boolean {
    return this.shuttingDown;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Create exactly one new runtime; duplicate or pending identities reject. */
  create(session: TSession): Promise<TRuntime> {
    this.assertOpen();
    const sessionId = validSessionId(session);
    if (this.entries.has(sessionId) || this.pending.has(sessionId)) {
      return Promise.reject(new DuplicateApplicationRuntimeError(sessionId));
    }
    return this.beginCreation(session, sessionId);
  }

  /** Return the resident runtime or share one in-flight factory invocation. */
  ensure(session: TSession): Promise<TRuntime> {
    this.assertOpen();
    const sessionId = validSessionId(session);
    const resident = this.entries.get(sessionId);
    if (resident) {
      resident.session = session;
      this.options.updateRuntime?.(resident.runtime, session);
      return Promise.resolve(resident.runtime);
    }
    const pending = this.pending.get(sessionId);
    return pending?.promise ?? this.beginCreation(session, sessionId);
  }

  get(sessionId: string): TRuntime | undefined {
    return this.entries.get(sessionId)?.runtime;
  }

  list(): readonly ApplicationRuntimeEntry<TSession, TRuntime>[] {
    return Object.freeze(Array.from(this.entries.values(), (entry) => Object.freeze({ ...entry })));
  }

  subscribe(listener: ApplicationRuntimeListener<TSession, TRuntime>): () => void {
    this.listeners.add(listener);
    try {
      listener(this.list());
    } catch {
      // Observers must not be able to alter registry lifecycle semantics.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Refresh resident session references and dispose identities deleted from
   * the authoritative catalog. This method intentionally does not eagerly
   * create runtimes for restored, never-activated sessions.
   */
  async reconcile(sessions: readonly TSession[]): Promise<void> {
    this.assertOpen();
    const byId = new Map<string, TSession>();
    for (const session of sessions) {
      const sessionId = validSessionId(session);
      if (byId.has(sessionId)) {
        throw new Error(`duplicate session identity in reconciliation: ${sessionId}`);
      }
      byId.set(sessionId, session);
    }

    for (const [sessionId, entry] of this.entries) {
      const session = byId.get(sessionId);
      if (session) {
        entry.session = session;
        this.options.updateRuntime?.(entry.runtime, session);
      }
    }

    const knownIds = new Set([...this.entries.keys(), ...this.pending.keys()]);
    const removals = Array.from(knownIds)
      .filter((sessionId) => !byId.has(sessionId))
      .map((sessionId) => this.disposeSession(sessionId, 'reconcile'));
    await Promise.all(removals);
  }

  async disposeSession(
    sessionId: string,
    reason: RuntimeDisposalReason = 'session-removed',
  ): Promise<void> {
    const nextGeneration = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, nextGeneration);
    const pending = this.pending.get(sessionId);
    if (pending) pending.state.disposalReason ??= reason;

    const entry = this.entries.get(sessionId);
    if (entry) {
      this.entries.delete(sessionId);
      this.notify();
      await this.options.disposeRuntime(entry.runtime, {
        sessionId,
        session: entry.session,
        reason,
      });
      return;
    }

    if (pending) {
      try {
        await pending.promise;
      } catch (error) {
        const creationFailedBeforeResidency = !pending.state.runtimeCreated;
        if (
          !(error instanceof ApplicationRuntimeCreationSupersededError) &&
          !creationFailedBeforeResidency
        ) {
          throw error;
        }
      }
    }
  }

  /**
   * Quiet all current runtimes, including creations already pending at call
   * time. A factory failure that never became resident does not make cleanup
   * fail; a long-running factory remains bounded by the shutdown coordinator.
   * The registry stays open so cancelling close restores normal operation.
   */
  async prepareShutdown(): Promise<void> {
    if (!this.options.prepareRuntime) return;
    const pendingAtStart = Array.from(this.pending.values(), (pending) => pending.promise);
    if (pendingAtStart.length > 0) await Promise.allSettled(pendingAtStart);
    const entries = Array.from(this.entries.values());
    const results = await Promise.allSettled(entries.map((entry) => this.prepareEntry(entry)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more application runtimes failed to prepare');
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shuttingDown = true;
    this.shutdownTask = this.performShutdown();
    return this.shutdownTask;
  }

  private beginCreation(session: TSession, sessionId: string): Promise<TRuntime> {
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);

    const pendingState: PendingRuntimeState = { runtimeCreated: false };
    const creation = Promise.resolve()
      .then(() => this.options.createRuntime(session))
      .then(async (runtime) => {
        pendingState.runtimeCreated = true;
        const disposalReason = this.shuttingDown
          ? 'application-shutdown'
          : pendingState.disposalReason;
        if (disposalReason || this.generations.get(sessionId) !== generation) {
          await this.options.disposeRuntime(runtime, {
            sessionId,
            session,
            reason: disposalReason ?? 'session-removed',
          });
          throw new ApplicationRuntimeCreationSupersededError(sessionId);
        }

        this.entries.set(sessionId, { sessionId, session, runtime });
        this.notify();
        return runtime;
      })
      .finally(() => {
        if (this.pending.get(sessionId)?.promise === creation) this.pending.delete(sessionId);
      });
    const pendingEntry = { promise: creation, state: pendingState };
    this.pending.set(sessionId, pendingEntry);
    return creation;
  }

  private prepareEntry(entry: MutableRuntimeEntry<TSession, TRuntime>): Promise<void> {
    const existing = this.preparations.get(entry.sessionId);
    if (existing?.runtime === entry.runtime) return existing.promise;

    const prepareRuntime = this.options.prepareRuntime;
    if (!prepareRuntime) return Promise.resolve();
    const preparation = Promise.resolve()
      .then(() =>
        prepareRuntime(entry.runtime, {
          sessionId: entry.sessionId,
          session: entry.session,
        }),
      )
      .then(() => undefined)
      .finally(() => {
        if (this.preparations.get(entry.sessionId)?.promise === preparation) {
          this.preparations.delete(entry.sessionId);
        }
      });
    this.preparations.set(entry.sessionId, { runtime: entry.runtime, promise: preparation });
    return preparation;
  }

  private async performShutdown(): Promise<void> {
    for (const sessionId of new Set([...this.entries.keys(), ...this.pending.keys()])) {
      this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    }

    const pendingResults = await Promise.allSettled(
      Array.from(this.pending.values(), (pending) => pending.promise),
    );
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    if (entries.length > 0) this.notify();
    const disposalResults = await Promise.allSettled(
      entries.map((entry) =>
        this.options.disposeRuntime(entry.runtime, {
          sessionId: entry.sessionId,
          session: entry.session,
          reason: 'application-shutdown',
        }),
      ),
    );

    const failures = [...pendingResults, ...disposalResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
      .filter((error) => !(error instanceof ApplicationRuntimeCreationSupersededError));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more application runtimes failed to shut down');
    }
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new ApplicationRuntimeRegistryShutdownError();
  }

  private notify(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A view observer cannot corrupt application-owned runtime state.
      }
    }
  }
}

function validSessionId(session: ApplicationSessionIdentity): string {
  const sessionId = session.id.trim();
  if (!sessionId) throw new Error('session id must not be empty');
  return sessionId;
}
