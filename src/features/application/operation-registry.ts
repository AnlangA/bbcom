import type {
  IpcError,
  OperationKind,
  OperationRecord,
  OperationStatus,
} from '../../generated/ipc-contracts';

export type OperationCancelHandler = () => void | Promise<void>;

export interface CreateOperationInput {
  operationId: string;
  kind: OperationKind;
  workspaceId: string;
  sessionId?: string;
  messageKey?: string;
  progress?: {
    completedUnits?: number;
    totalUnits: number;
  };
  cancel?: OperationCancelHandler;
}

export interface OperationProgressUpdate {
  completedUnits: number;
  totalUnits?: number;
  messageKey?: string;
}

export type OperationRegistryListener = (operations: readonly OperationRecord[]) => void;

export class OperationRegistryShutdownError extends Error {
  constructor() {
    super('operation registry is shut down');
    this.name = 'OperationRegistryShutdownError';
  }
}

export class DuplicateOperationIdError extends Error {
  constructor(operationId: string) {
    super(`operation id is already registered: ${operationId}`);
    this.name = 'DuplicateOperationIdError';
  }
}

export class InvalidOperationTransitionError extends Error {
  constructor(operationId: string, from: OperationStatus, to: OperationStatus) {
    super(`illegal operation transition for ${operationId}: ${from} -> ${to}`);
    this.name = 'InvalidOperationTransitionError';
  }
}

interface StoredOperation extends OperationRecord {
  sequence: number;
}

const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const LEGAL_TRANSITIONS: Readonly<Record<OperationStatus, ReadonlySet<OperationStatus>>> = {
  queued: new Set(['running', 'cancelling', 'failed', 'interrupted']),
  running: new Set(['cancelling', 'completed', 'failed', 'interrupted']),
  // Completion can legitimately win a cancellation race after the native
  // operation has crossed its atomic commit boundary. Preserve that real
  // terminal outcome instead of misreporting a successful commit as cancelled.
  cancelling: new Set(['cancelled', 'completed', 'failed', 'interrupted']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

/** Application-owned, bounded operation state independent from UI lifetimes. */
export class OperationRegistry {
  private readonly records = new Map<string, StoredOperation>();
  private readonly cancelHandlers = new Map<string, OperationCancelHandler>();
  private readonly cancelInvocations = new Map<string, Promise<void>>();
  private readonly cancelTransitions = new Map<string, Promise<OperationRecord>>();
  private readonly interruptTransitions = new Map<string, Promise<OperationRecord>>();
  private readonly listeners = new Set<OperationRegistryListener>();
  private sequence = 0;
  private shuttingDown = false;
  private shutdownTask: Promise<void> | null = null;

  get isShutdown(): boolean {
    return this.shuttingDown;
  }

  create(input: CreateOperationInput): OperationRecord {
    this.assertOpen();
    const operationId = validIdentity('operationId', input.operationId);
    if (this.records.has(operationId)) throw new DuplicateOperationIdError(operationId);

    const progress = input.progress
      ? validateInitialProgress(input.progress.completedUnits ?? 0, input.progress.totalUnits)
      : null;
    const record: StoredOperation = {
      sequence: this.sequence++,
      operationId,
      kind: input.kind,
      status: 'queued',
      workspaceId: validIdentity('workspaceId', input.workspaceId),
      ...(input.sessionId !== undefined
        ? { sessionId: validIdentity('sessionId', input.sessionId) }
        : {}),
      ...(input.messageKey !== undefined ? { messageKey: validMessageKey(input.messageKey) } : {}),
      ...(progress ?? {}),
    };
    this.records.set(operationId, record);
    if (input.cancel) this.cancelHandlers.set(operationId, input.cancel);
    this.notify();
    return cloneRecord(record);
  }

  start(operationId: string): OperationRecord {
    return this.transition(operationId, 'running');
  }

  complete(operationId: string): OperationRecord {
    return this.transition(operationId, 'completed');
  }

  fail(operationId: string, error: IpcError): OperationRecord {
    const record = this.requireRecord(operationId);
    this.assertTransition(record, 'failed');
    record.status = 'failed';
    record.error = normalizeError(error);
    this.releaseHandlerIfTerminal(record);
    this.notify();
    return cloneRecord(record);
  }

  updateProgress(operationId: string, update: OperationProgressUpdate): OperationRecord {
    this.assertOpen();
    const record = this.requireRecord(operationId);
    if (TERMINAL_STATUSES.has(record.status)) {
      throw new Error(`cannot update terminal operation progress: ${operationId}`);
    }

    const existingTotal = record.totalUnits;
    const totalUnits = update.totalUnits ?? existingTotal;
    if (totalUnits === undefined) {
      throw new Error('totalUnits is required for the first progress update');
    }
    validUnit('totalUnits', totalUnits, false);
    if (existingTotal !== undefined && totalUnits !== existingTotal) {
      throw new Error('totalUnits is immutable after progress begins');
    }
    validUnit('completedUnits', update.completedUnits, true);
    if (update.completedUnits > totalUnits) {
      throw new Error('completedUnits must not exceed totalUnits');
    }
    if (record.completedUnits !== undefined && update.completedUnits < record.completedUnits) {
      throw new Error('completedUnits must be monotonic');
    }

    record.completedUnits = update.completedUnits;
    record.totalUnits = totalUnits;
    if (update.messageKey !== undefined) record.messageKey = validMessageKey(update.messageKey);
    this.notify();
    return cloneRecord(record);
  }

  get(operationId: string): OperationRecord | undefined {
    const record = this.records.get(operationId);
    return record ? cloneRecord(record) : undefined;
  }

  snapshot(): readonly OperationRecord[] {
    return Object.freeze(
      Array.from(this.records.values())
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneRecord),
    );
  }

  subscribe(listener: OperationRegistryListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // Observers must not be able to alter operation lifecycle semantics.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancel(operationId: string): Promise<OperationRecord> {
    const record = this.requireRecord(operationId);
    if (TERMINAL_STATUSES.has(record.status)) return Promise.resolve(cloneRecord(record));
    const existing = this.cancelTransitions.get(operationId);
    if (existing) return existing;
    const interrupting = this.interruptTransitions.get(operationId);
    if (interrupting) return interrupting;

    this.assertOpen();
    const previousStatus = record.status;
    this.assertTransition(record, 'cancelling');
    record.status = 'cancelling';
    this.notify();

    const transition = this.invokeCancelHandler(operationId)
      .then(() => {
        const current = this.requireRecord(operationId);
        if (current.status === 'cancelling') {
          current.status = 'cancelled';
          this.releaseHandlerIfTerminal(current);
          this.notify();
        }
        return cloneRecord(current);
      })
      .catch(() => {
        const current = this.requireRecord(operationId);
        if (current.status === 'cancelling') {
          // A rejected native cancellation means the operation may still be
          // active. Restore its prior non-terminal state so a later close or
          // explicit retry can attempt cancellation again.
          current.status = previousStatus;
          this.notify();
        }
        throw new Error(`operation cancellation failed: ${operationId}`);
      })
      .finally(() => {
        this.cancelTransitions.delete(operationId);
      });
    this.cancelTransitions.set(operationId, transition);
    return transition;
  }

  async interrupt(operationId: string): Promise<OperationRecord> {
    const record = this.requireRecord(operationId);
    if (TERMINAL_STATUSES.has(record.status)) return cloneRecord(record);
    const cancelling = this.cancelTransitions.get(operationId);
    if (cancelling) return cancelling;
    const existing = this.interruptTransitions.get(operationId);
    if (existing) return existing;

    const previousStatus = record.status;
    this.assertTransition(record, 'cancelling');
    record.status = 'cancelling';
    this.notify();
    const transition = this.invokeCancelHandler(operationId)
      .then(() => {
        const current = this.requireRecord(operationId);
        if (current.status === 'cancelling') {
          current.status = 'interrupted';
          this.releaseHandlerIfTerminal(current);
          this.notify();
        }
        return cloneRecord(current);
      })
      .catch(() => {
        const current = this.requireRecord(operationId);
        if (current.status === 'cancelling') {
          current.status = previousStatus;
          this.notify();
        }
        throw new Error(`operation interruption failed: ${operationId}`);
      })
      .finally(() => {
        this.interruptTransitions.delete(operationId);
      });
    this.interruptTransitions.set(operationId, transition);
    return transition;
  }

  /**
   * Interrupt the operations that are active at the start of this call without
   * sealing the registry. This is the renderer close-handshake primitive: a
   * cancelled close attempt may enqueue fresh work afterwards.
   *
   * Concurrent cancellation paths still share `invokeCancelHandler`, so each
   * operation's cancellation callback is invoked at most once.
   */
  async interruptActive(): Promise<readonly OperationRecord[]> {
    const activeOperationIds = Array.from(this.records.values())
      .filter((record) => !TERMINAL_STATUSES.has(record.status))
      .map((record) => record.operationId);
    const interrupted = await Promise.all(
      activeOperationIds.map((operationId) => this.interrupt(operationId)),
    );
    return Object.freeze(interrupted);
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shuttingDown = true;
    this.shutdownTask = this.performShutdown();
    return this.shutdownTask;
  }

  private transition(operationId: string, status: OperationStatus): OperationRecord {
    this.assertOpen();
    const record = this.requireRecord(operationId);
    this.assertTransition(record, status);
    record.status = status;
    this.releaseHandlerIfTerminal(record);
    this.notify();
    return cloneRecord(record);
  }

  private assertTransition(record: StoredOperation, status: OperationStatus): void {
    if (!LEGAL_TRANSITIONS[record.status].has(status)) {
      throw new InvalidOperationTransitionError(record.operationId, record.status, status);
    }
  }

  private requireRecord(operationId: string): StoredOperation {
    const record = this.records.get(operationId);
    if (!record) throw new Error(`unknown operation id: ${operationId}`);
    return record;
  }

  private invokeCancelHandler(operationId: string): Promise<void> {
    const existing = this.cancelInvocations.get(operationId);
    if (existing) return existing;
    const handler = this.cancelHandlers.get(operationId);
    const invocation = (handler ? Promise.resolve().then(handler) : Promise.resolve()).finally(
      () => {
        this.cancelInvocations.delete(operationId);
      },
    );
    this.cancelInvocations.set(operationId, invocation);
    return invocation;
  }

  private releaseHandlerIfTerminal(record: StoredOperation): void {
    if (!TERMINAL_STATUSES.has(record.status)) return;
    this.cancelHandlers.delete(record.operationId);
  }

  private async performShutdown(): Promise<void> {
    await this.interruptActive();
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new OperationRegistryShutdownError();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI observers cannot make an operation transition fail.
      }
    }
  }
}

function validateInitialProgress(
  completedUnits: number,
  totalUnits: number,
): Pick<OperationRecord, 'completedUnits' | 'totalUnits'> {
  validUnit('completedUnits', completedUnits, true);
  validUnit('totalUnits', totalUnits, false);
  if (completedUnits > totalUnits) throw new Error('completedUnits must not exceed totalUnits');
  return { completedUnits, totalUnits };
}

function validUnit(field: string, value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function validIdentity(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || !IDENTITY_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a path-free opaque identifier of 1-256 characters`);
  }
  return normalized;
}

function validMessageKey(value: string): string {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/i.test(value)) {
    throw new Error('messageKey must be a stable translation key');
  }
  return value;
}

function normalizeError(error: IpcError): IpcError {
  const normalized = {
    code: error.code,
    messageKey: validMessageKey(error.messageKey),
    retryable: error.retryable,
    operation: validIdentity('error.operation', error.operation),
  } as IpcError;
  if (error.requestId !== undefined)
    normalized.requestId = validIdentity('error.requestId', error.requestId);
  if (error.field !== undefined) normalized.field = validIdentity('error.field', error.field);
  if (error.limit !== undefined) normalized.limit = boundedErrorNumber('error.limit', error.limit);
  if (error.actual !== undefined)
    normalized.actual = boundedErrorNumber('error.actual', error.actual);
  if (error.retryAfterMs !== undefined) {
    normalized.retryAfterMs = boundedErrorNumber('error.retryAfterMs', error.retryAfterMs);
  }
  return Object.freeze(normalized);
}

function boundedErrorNumber(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function cloneRecord(record: StoredOperation): OperationRecord {
  const clone: OperationRecord = {
    operationId: record.operationId,
    kind: record.kind,
    status: record.status,
    workspaceId: record.workspaceId,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.completedUnits !== undefined ? { completedUnits: record.completedUnits } : {}),
    ...(record.totalUnits !== undefined ? { totalUnits: record.totalUnits } : {}),
    ...(record.messageKey !== undefined ? { messageKey: record.messageKey } : {}),
    ...(record.error ? { error: Object.freeze({ ...record.error }) } : {}),
  };
  return Object.freeze(clone);
}
