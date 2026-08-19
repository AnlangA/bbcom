export const SERIAL_TRANSACTION_LEASE_LIMITS = Object.freeze({
  ownerIdCharacters: 256,
  automationIdCharacters: 128,
  tokenCharacters: 256,
  writeBytes: 1024 * 1024,
  rxBytes: 1024 * 1024,
  rxChunks: 512,
  readBytes: 256 * 1024,
  readTimeoutMs: 10_000,
});

declare const SERIAL_TRANSACTION_LEASE_TOKEN_BRAND: unique symbol;

/** An opaque capability. Its connection generation is validated by the coordinator. */
export type SerialTransactionLeaseToken = string & {
  readonly [SERIAL_TRANSACTION_LEASE_TOKEN_BRAND]: true;
};

export type SerialTransactionLeaseErrorCode =
  | 'invalid-input'
  | 'permission-denied'
  | 'unavailable'
  | 'busy'
  | 'not-found'
  | 'stale-handle'
  | 'disconnected'
  | 'timeout'
  | 'cancelled'
  | 'limit-exceeded'
  | 'partial-write'
  | 'unknown-outcome'
  | 'protocol-error'
  | 'io-error';

export class SerialTransactionLeaseError extends Error {
  constructor(
    readonly code: SerialTransactionLeaseErrorCode,
    message = `serial transaction lease failed: ${code}`,
  ) {
    super(message);
    this.name = 'SerialTransactionLeaseError';
  }
}

export interface SerialTransactionConnectionSnapshot {
  readonly generation: number;
  readonly connected: boolean;
}

export interface SerialTransactionWriteContext {
  readonly ownerId: string;
  readonly generation: number;
  readonly leaseToken: SerialTransactionLeaseToken;
  readonly signal: AbortSignal;
}

export type SerialTransactionBufferSelection = 'input' | 'output' | 'all';

export interface SerialTransactionPendingBytes {
  readonly rx: number;
  readonly tx: number;
}

export interface SerialTransactionOutputLines {
  readonly dtr: boolean;
  readonly rts: boolean;
  readonly breakActive: boolean;
}

export interface SerialTransactionInputLines {
  readonly cts: boolean;
  readonly dsr: boolean;
  readonly ri: boolean;
  readonly cd: boolean;
}

/**
 * Adapter implemented by the serial runtime. `waitForWriteDrain` must not
 * resolve until both its queued and physically active writes have settled.
 */
export interface SerialTransactionIoPort<WriteResult = unknown> {
  snapshot(): SerialTransactionConnectionSnapshot;
  waitForWriteDrain(context: {
    readonly generation: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  write(payload: Uint8Array, context: SerialTransactionWriteContext): Promise<WriteResult>;
  clearBuffers?(
    selection: SerialTransactionBufferSelection,
    context: SerialTransactionWriteContext,
  ): Promise<void>;
  pendingBytes?(context: SerialTransactionWriteContext): Promise<SerialTransactionPendingBytes>;
  setOutputLines?(
    lines: SerialTransactionOutputLines,
    context: SerialTransactionWriteContext,
  ): Promise<void>;
  /** Synchronous best-known physical output state captured before guest access. */
  snapshotOutputLines?(generation: number): SerialTransactionOutputLines;
  /** Restores the pre-lease state without using the guest's aborted signal. */
  restoreOutputLines?(
    lines: SerialTransactionOutputLines,
    context: SerialAutomationRestoreContext,
  ): Promise<void>;
  readInputLines?(context: SerialTransactionWriteContext): Promise<SerialTransactionInputLines>;
}

export interface SerialAutomationPauseContext {
  readonly ownerId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export type SerialTransactionLeaseReleaseReason =
  'released' | 'cancelled' | 'disconnected' | 'connection-changed' | 'disposed' | 'acquire-failed';

export interface SerialAutomationRestoreContext {
  readonly ownerId: string;
  readonly generation: number;
  readonly reason: SerialTransactionLeaseReleaseReason;
}

/** Returned only when an automation was active and must later be restored. */
export interface SerialAutomationSuspension {
  restore(context: SerialAutomationRestoreContext): Promise<void>;
}

export interface SerialAutomationPausePort {
  readonly id: string;
  pause(context: SerialAutomationPauseContext): Promise<SerialAutomationSuspension | null>;
}

export interface SerialTransactionLeaseTimerPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface SerialTransactionLeaseCoordinatorOptions<WriteResult = unknown> {
  readonly io: SerialTransactionIoPort<WriteResult>;
  readonly tokenFactory?: () => string;
  readonly timer?: SerialTransactionLeaseTimerPort;
  readonly limits?: Partial<
    Pick<
      typeof SERIAL_TRANSACTION_LEASE_LIMITS,
      'writeBytes' | 'rxBytes' | 'rxChunks' | 'readBytes' | 'readTimeoutMs'
    >
  >;
}

interface ResolvedSerialTransactionLeaseLimits {
  readonly writeBytes: number;
  readonly rxBytes: number;
  readonly rxChunks: number;
  readonly readBytes: number;
  readonly readTimeoutMs: number;
}

export interface SerialTransactionLeaseGrant {
  readonly token: SerialTransactionLeaseToken;
  readonly ownerId: string;
  readonly generation: number;
}

export interface SerialTransactionLeaseAcquireOptions {
  readonly signal?: AbortSignal;
  /** Per-lease RX mirror capacity, bounded by the coordinator's host limit. */
  readonly rxBufferBytes?: number;
}

export interface SerialTransactionReadOptions {
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type SerialTransactionRxOfferResult =
  | { readonly status: 'ignored'; readonly bufferedBytes: number }
  | { readonly status: 'mirrored'; readonly bufferedBytes: number }
  | {
      readonly status: 'backpressure';
      readonly bufferedBytes: number;
      readonly capacityBytes: number;
    };

export interface SerialTransactionLeaseReleaseResult {
  readonly reason: SerialTransactionLeaseReleaseReason;
  readonly generation: number;
  readonly restoredAutomations: number;
  readonly restoreFailures: readonly string[];
  readonly restoreSkipped: boolean;
  readonly drainFailed: boolean;
}

export type SerialTransactionLeasePhase =
  'idle' | 'acquiring' | 'active' | 'releasing' | 'faulted' | 'disposed';

export interface SerialTransactionLeaseSnapshot {
  readonly phase: SerialTransactionLeasePhase;
  readonly ownerId: string | null;
  readonly generation: number | null;
  readonly bufferedRxBytes: number;
  readonly bufferedRxChunks: number;
  readonly manualWritesInFlight: number;
  readonly manualWriteAllowed: boolean;
  readonly registeredAutomations: number;
  /** Terminal reason retained long enough for the bound guest handle to observe it. */
  readonly faultCode?: SerialTransactionLeaseErrorCode;
}

export type SerialTransactionLeaseListener = (snapshot: SerialTransactionLeaseSnapshot) => void;

interface PausedAutomation {
  readonly id: string;
  readonly suspension: SerialAutomationSuspension;
}

interface Acquisition {
  readonly ownerId: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
  reason: SerialTransactionLeaseReleaseReason;
  restoreAllowed: boolean;
}

interface ActiveLease {
  readonly grant: SerialTransactionLeaseGrant;
  readonly suspensions: readonly PausedAutomation[];
  readonly controller: AbortController;
  readonly rx: BoundedRxMirror;
  readonly outputLinesBaseline: SerialTransactionOutputLines | null;
  outputLinesTouched: boolean;
  detachOwnerAbort: () => void;
  writeInFlight: boolean;
  operationSettled: Promise<void> | null;
  settleOperation: () => void;
  restoreAllowed: boolean;
  releasePromise: Promise<SerialTransactionLeaseReleaseResult> | null;
}

interface PendingRxRead {
  readonly maxBytes: number;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: SerialTransactionLeaseError) => void;
  timer: unknown | null;
  detachAbort: () => void;
}

const DEFAULT_TIMER: SerialTransactionLeaseTimerPort = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultTokenFactory(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new SerialTransactionLeaseError('unavailable', 'secure token generation is unavailable');
  }
  return globalThis.crypto.randomUUID();
}

function validateBoundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function validateRequestInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SerialTransactionLeaseError('invalid-input', `invalid ${name}`);
  }
  if (value > maximum) {
    throw new SerialTransactionLeaseError('limit-exceeded', `${name} exceeds lease limit`);
  }
  return value;
}

function validateGeneration(snapshot: SerialTransactionConnectionSnapshot): number {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) {
    throw new SerialTransactionLeaseError('protocol-error', 'invalid connection generation');
  }
  return snapshot.generation;
}

function validPendingByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validOutputLines(value: unknown): value is SerialTransactionOutputLines {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SerialTransactionOutputLines).dtr === 'boolean' &&
    typeof (value as SerialTransactionOutputLines).rts === 'boolean' &&
    typeof (value as SerialTransactionOutputLines).breakActive === 'boolean'
  );
}

function validInputLines(value: unknown): value is SerialTransactionInputLines {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SerialTransactionInputLines).cts === 'boolean' &&
    typeof (value as SerialTransactionInputLines).dsr === 'boolean' &&
    typeof (value as SerialTransactionInputLines).ri === 'boolean' &&
    typeof (value as SerialTransactionInputLines).cd === 'boolean'
  );
}

function validateIdentifier(value: string, name: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new SerialTransactionLeaseError('invalid-input', `invalid ${name}`);
  }
  let containsControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      containsControlCharacter = true;
      break;
    }
  }
  if (value.length === 0 || value.length > maximum || containsControlCharacter) {
    throw new SerialTransactionLeaseError('invalid-input', `invalid ${name}`);
  }
  return value;
}

function abortError(): SerialTransactionLeaseError {
  return new SerialTransactionLeaseError('cancelled');
}

function listenForAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    callback();
    return () => undefined;
  }
  signal.addEventListener('abort', callback, { once: true });
  return () => signal.removeEventListener('abort', callback);
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const detach: Array<() => void> = [];
  for (const signal of signals) {
    detach.push(listenForAbort(signal, () => controller.abort()));
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const remove of detach) remove();
    },
  };
}

function deferredVoid(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class BoundedRxMirror {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private pending: PendingRxRead | null = null;
  private closedError: SerialTransactionLeaseError | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly maxChunks: number,
    private readonly timerPort: SerialTransactionLeaseTimerPort,
    private readonly changed: () => void,
  ) {}

  get bufferedBytes(): number {
    return this.bytes;
  }

  get bufferedChunks(): number {
    return this.chunks.length;
  }

  offer(input: Uint8Array): SerialTransactionRxOfferResult {
    if (this.closedError || input.length === 0) {
      return { status: 'ignored', bufferedBytes: this.bytes };
    }

    const pendingBytes = this.pending ? Math.min(this.pending.maxBytes, input.length) : 0;
    const remainderBytes = input.length - pendingBytes;
    const additionalChunks = remainderBytes > 0 ? 1 : 0;
    if (
      this.bytes + remainderBytes > this.maxBytes ||
      this.chunks.length + additionalChunks > this.maxChunks
    ) {
      return {
        status: 'backpressure',
        bufferedBytes: this.bytes,
        capacityBytes: Math.max(0, this.maxBytes - this.bytes),
      };
    }

    const copy = input.slice();
    if (this.pending) {
      const pending = this.pending;
      const delivered = copy.slice(0, pendingBytes);
      if (remainderBytes > 0) this.append(copy.slice(pendingBytes));
      this.settlePending(pending, delivered);
    } else {
      this.append(copy);
    }
    this.changed();
    return { status: 'mirrored', bufferedBytes: this.bytes };
  }

  read(maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal.aborted) return Promise.reject(abortError());
    if (this.bytes > 0) {
      const result = this.take(maxBytes);
      this.changed();
      return Promise.resolve(result);
    }
    if (this.pending) {
      return Promise.reject(
        new SerialTransactionLeaseError('busy', 'an RX read is already pending'),
      );
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingRxRead = {
        maxBytes,
        resolve,
        reject,
        timer: null,
        detachAbort: () => undefined,
      };
      pending.detachAbort = listenForAbort(signal, () => {
        this.rejectPending(pending, abortError());
      });
      pending.timer = this.timerPort.schedule(() => {
        this.rejectPending(pending, new SerialTransactionLeaseError('timeout'));
      }, timeoutMs);
      this.pending = pending;
    });
  }

  close(error: SerialTransactionLeaseError): void {
    if (this.closedError) return;
    this.closedError = error;
    this.chunks.length = 0;
    this.bytes = 0;
    if (this.pending) this.rejectPending(this.pending, error);
    this.changed();
  }

  clearBuffered(): void {
    if (this.closedError || this.bytes === 0) return;
    this.chunks.length = 0;
    this.bytes = 0;
    this.changed();
  }

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  private take(maxBytes: number): Uint8Array {
    const byteLength = Math.min(maxBytes, this.bytes);
    const result = new Uint8Array(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const chunk = this.chunks[0];
      if (!chunk) break;
      const amount = Math.min(chunk.length, byteLength - offset);
      result.set(chunk.subarray(0, amount), offset);
      offset += amount;
      this.bytes -= amount;
      if (amount === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.slice(amount);
    }
    return result;
  }

  private settlePending(pending: PendingRxRead, bytes: Uint8Array): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.cleanupPending(pending);
    pending.resolve(bytes);
  }

  private rejectPending(pending: PendingRxRead, error: SerialTransactionLeaseError): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private cleanupPending(pending: PendingRxRead): void {
    if (pending.timer !== null) this.timerPort.cancel(pending.timer);
    pending.timer = null;
    pending.detachAbort();
  }
}

/**
 * Coordinates an exclusive protocol transaction over one connected session.
 * The class is framework-free; every operation that touches the device or an
 * automation is supplied through an application port.
 */
export class SerialTransactionLeaseCoordinator<WriteResult = unknown> {
  private readonly io: SerialTransactionIoPort<WriteResult>;
  private readonly tokenFactory: () => string;
  private readonly timer: SerialTransactionLeaseTimerPort;
  private readonly limits: ResolvedSerialTransactionLeaseLimits;
  private readonly automations = new Map<string, SerialAutomationPausePort>();
  private readonly listeners = new Set<SerialTransactionLeaseListener>();
  private phase: SerialTransactionLeasePhase = 'idle';
  private acquisition: Acquisition | null = null;
  private active: ActiveLease | null = null;
  private tokenSequence = 0;
  private manualWritesInFlight = 0;
  private readonly manualDrainWaiters = new Set<() => void>();
  private faultedGeneration: number | null = null;
  private terminalFaultCode: SerialTransactionLeaseErrorCode | null = null;
  private terminalFaultToken: SerialTransactionLeaseToken | null = null;
  private disposed = false;

  constructor(options: SerialTransactionLeaseCoordinatorOptions<WriteResult>) {
    this.io = options.io;
    this.tokenFactory = options.tokenFactory ?? defaultTokenFactory;
    this.timer = options.timer ?? DEFAULT_TIMER;
    const requested = { ...SERIAL_TRANSACTION_LEASE_LIMITS, ...options.limits };
    this.limits = {
      writeBytes: validateBoundedInteger(requested.writeBytes, 'writeBytes', 16 * 1024 * 1024),
      rxBytes: validateBoundedInteger(requested.rxBytes, 'rxBytes', 16 * 1024 * 1024),
      rxChunks: validateBoundedInteger(requested.rxChunks, 'rxChunks', 16_384),
      readBytes: validateBoundedInteger(requested.readBytes, 'readBytes', 1024 * 1024),
      readTimeoutMs: validateBoundedInteger(requested.readTimeoutMs, 'readTimeoutMs', 60_000),
    };
  }

  snapshot(): SerialTransactionLeaseSnapshot {
    const rx = this.active?.rx;
    const context = this.active?.grant ?? this.acquisition;
    return Object.freeze({
      phase: this.phase,
      ownerId: context?.ownerId ?? null,
      generation: context?.generation ?? null,
      bufferedRxBytes: rx?.bufferedBytes ?? 0,
      bufferedRxChunks: rx?.bufferedChunks ?? 0,
      manualWritesInFlight: this.manualWritesInFlight,
      manualWriteAllowed: this.phase === 'idle' && !this.disposed,
      registeredAutomations: this.automations.size,
      ...(this.terminalFaultCode === null ? {} : { faultCode: this.terminalFaultCode }),
    });
  }

  /** Current physical connection identity used by session summaries and stale-handle checks. */
  connectionSnapshot(): SerialTransactionConnectionSnapshot {
    const snapshot = this.io.snapshot();
    const generation = validateGeneration(snapshot);
    if (typeof snapshot.connected !== 'boolean') {
      throw new SerialTransactionLeaseError('protocol-error', 'invalid connection state');
    }
    return Object.freeze({ generation, connected: snapshot.connected });
  }

  /** Revalidates scheduler provenance immediately before physical I/O. */
  authorizesSchedulerWrite(
    admission: Readonly<{
      source: 'host' | 'plugin';
      ownerId: string;
      generation?: number;
      leaseToken?: string;
    }>,
  ): boolean {
    if (admission.source === 'host') {
      return (
        !this.disposed &&
        // An acquisition first closes the public manual-write gate, then
        // drains writes that were already admitted. Those writes must remain
        // authorized through their final chunk; no later host write can enter
        // because runManualWrite() rejects while the phase is `acquiring`.
        (this.phase === 'idle' || this.phase === 'acquiring') &&
        this.manualWritesInFlight > 0 &&
        admission.ownerId.length > 0
      );
    }
    const lease = this.active;
    return (
      !this.disposed &&
      this.phase === 'active' &&
      lease !== null &&
      admission.ownerId === lease.grant.ownerId &&
      admission.generation === lease.grant.generation &&
      admission.leaseToken === lease.grant.token &&
      this.isGenerationCurrent(lease.grant)
    );
  }

  subscribe(listener: SerialTransactionLeaseListener): () => void {
    this.listeners.add(listener);
    this.callListener(listener);
    return () => this.listeners.delete(listener);
  }

  registerAutomation(port: SerialAutomationPausePort): () => void {
    this.assertIdle();
    const id = validateIdentifier(
      port.id,
      'automation id',
      SERIAL_TRANSACTION_LEASE_LIMITS.automationIdCharacters,
    );
    if (this.automations.has(id)) {
      throw new SerialTransactionLeaseError('invalid-input', 'duplicate automation id');
    }
    this.automations.set(id, port);
    this.notify();
    return () => {
      if (this.phase !== 'idle' || this.disposed) {
        throw new SerialTransactionLeaseError('busy', 'cannot unregister automation while leased');
      }
      if (this.automations.get(id) === port) {
        this.automations.delete(id);
        this.notify();
      }
    };
  }

  async acquire(
    ownerIdInput: string,
    options: SerialTransactionLeaseAcquireOptions = {},
  ): Promise<SerialTransactionLeaseGrant> {
    this.assertIdle();
    this.terminalFaultCode = null;
    this.terminalFaultToken = null;
    const ownerId = validateIdentifier(
      ownerIdInput,
      'owner id',
      SERIAL_TRANSACTION_LEASE_LIMITS.ownerIdCharacters,
    );
    const rxBufferBytes =
      options.rxBufferBytes === undefined
        ? this.limits.rxBytes
        : validateRequestInteger(options.rxBufferBytes, 'rxBufferBytes', this.limits.rxBytes);
    const initial = this.readConnectedSnapshot();
    const settled = deferredVoid();
    const acquisition: Acquisition = {
      ownerId,
      generation: initial.generation,
      controller: new AbortController(),
      settled: settled.promise,
      settle: settled.resolve,
      reason: 'acquire-failed',
      restoreAllowed: true,
    };
    this.acquisition = acquisition;
    this.phase = 'acquiring';
    this.notify();
    const detachAbort = listenForAbort(options.signal, () => {
      acquisition.reason = 'cancelled';
      acquisition.controller.abort();
    });
    const paused: PausedAutomation[] = [];
    let drainCompleted = false;

    try {
      this.throwIfAcquisitionCancelled(acquisition);
      await this.io.waitForWriteDrain({
        generation: acquisition.generation,
        signal: acquisition.controller.signal,
      });
      await this.waitForManualWriteDrain(acquisition.controller.signal);
      drainCompleted = true;
      this.assertAcquisitionGeneration(acquisition);

      const outputLinesBaseline = this.snapshotOutputLines(acquisition.generation);

      for (const automation of this.automations.values()) {
        const suspension = await automation.pause({
          ownerId,
          generation: acquisition.generation,
          signal: acquisition.controller.signal,
        });
        if (suspension) paused.push({ id: automation.id, suspension });
        this.assertAcquisitionGeneration(acquisition);
      }

      const grant = Object.freeze({
        token: this.issueToken(),
        ownerId,
        generation: acquisition.generation,
      });
      const lease: ActiveLease = {
        grant,
        suspensions: paused,
        controller: new AbortController(),
        rx: new BoundedRxMirror(rxBufferBytes, this.limits.rxChunks, this.timer, () =>
          this.notify(),
        ),
        outputLinesBaseline,
        outputLinesTouched: false,
        detachOwnerAbort: () => undefined,
        writeInFlight: false,
        operationSettled: null,
        settleOperation: () => undefined,
        restoreAllowed: true,
        releasePromise: null,
      };
      this.active = lease;
      this.acquisition = null;
      this.phase = 'active';
      detachAbort();
      lease.detachOwnerAbort = listenForAbort(options.signal, () => {
        void this.cancel(grant.token).catch(() => undefined);
      });
      this.notify();
      return grant;
    } catch (error) {
      const restoreAllowed = acquisition.restoreAllowed && this.isGenerationCurrent(initial);
      if (restoreAllowed) {
        await this.restoreAutomations(paused, {
          ownerId,
          generation: acquisition.generation,
          reason: acquisition.reason,
        });
      }
      if (this.acquisition === acquisition) this.acquisition = null;
      const classified = this.classifyAcquisitionError(error, acquisition);
      const faulted = !drainCompleted && classified.code === 'unavailable';
      this.phase = this.disposed ? 'disposed' : faulted ? 'faulted' : 'idle';
      this.faultedGeneration = faulted ? acquisition.generation : null;
      this.notify();
      throw classified;
    } finally {
      detachAbort();
      acquisition.settle();
    }
  }

  async write(
    token: SerialTransactionLeaseToken,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<WriteResult> {
    const lease = this.requireActiveLease(token);
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
      throw new SerialTransactionLeaseError('invalid-input', 'serial payload must not be empty');
    }
    if (payload.length > this.limits.writeBytes) {
      throw new SerialTransactionLeaseError('limit-exceeded', 'serial payload exceeds lease limit');
    }
    this.startLeaseOperation(lease);
    const linked = linkAbortSignals([lease.controller.signal, signal]);
    try {
      if (linked.signal.aborted) throw abortError();
      const result = await this.io.write(payload.slice(), {
        ownerId: lease.grant.ownerId,
        generation: lease.grant.generation,
        leaseToken: lease.grant.token,
        signal: linked.signal,
      });
      if (!this.isActiveAndCurrent(lease)) {
        throw new SerialTransactionLeaseError('unknown-outcome');
      }
      return result;
    } catch (error) {
      if (!this.isActiveAndCurrent(lease)) {
        throw new SerialTransactionLeaseError('unknown-outcome');
      }
      if (linked.signal.aborted) throw abortError();
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('io-error');
    } finally {
      linked.dispose();
      this.finishLeaseOperation(lease);
    }
  }

  async clearBuffers(
    token: SerialTransactionLeaseToken,
    selection: SerialTransactionBufferSelection = 'all',
    signal?: AbortSignal,
  ): Promise<void> {
    const lease = this.requireActiveLease(token);
    if (!['input', 'output', 'all'].includes(selection)) {
      throw new SerialTransactionLeaseError('invalid-input', 'invalid serial buffer selection');
    }
    if (!this.io.clearBuffers) {
      throw new SerialTransactionLeaseError('unavailable', 'serial buffer clearing is unavailable');
    }
    this.startLeaseOperation(lease);
    const linked = linkAbortSignals([lease.controller.signal, signal]);
    try {
      if (linked.signal.aborted) throw abortError();
      await this.io.clearBuffers(selection, this.ioContext(lease, linked.signal));
      if (!this.isActiveAndCurrent(lease)) {
        throw new SerialTransactionLeaseError('unknown-outcome');
      }
      if (selection === 'input' || selection === 'all') lease.rx.clearBuffered();
    } catch (error) {
      if (!this.isActiveAndCurrent(lease)) {
        throw new SerialTransactionLeaseError('unknown-outcome');
      }
      if (linked.signal.aborted) throw abortError();
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('io-error');
    } finally {
      linked.dispose();
      this.finishLeaseOperation(lease);
    }
  }

  async pendingBytes(
    token: SerialTransactionLeaseToken,
    signal?: AbortSignal,
  ): Promise<SerialTransactionPendingBytes> {
    const lease = this.requireActiveLease(token);
    if (!this.io.pendingBytes) {
      throw new SerialTransactionLeaseError('unavailable', 'serial byte counts are unavailable');
    }
    this.startLeaseOperation(lease);
    const linked = linkAbortSignals([lease.controller.signal, signal]);
    try {
      if (linked.signal.aborted) throw abortError();
      const pending = await this.io.pendingBytes(this.ioContext(lease, linked.signal));
      if (!this.isActiveAndCurrent(lease)) throw new SerialTransactionLeaseError('stale-handle');
      if (!validPendingByteCount(pending.rx) || !validPendingByteCount(pending.tx)) {
        throw new SerialTransactionLeaseError('protocol-error');
      }
      const rx = pending.rx + lease.rx.bufferedBytes;
      if (!Number.isSafeInteger(rx)) throw new SerialTransactionLeaseError('limit-exceeded');
      return Object.freeze({ rx, tx: pending.tx });
    } catch (error) {
      if (linked.signal.aborted) throw abortError();
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('io-error');
    } finally {
      linked.dispose();
      this.finishLeaseOperation(lease);
    }
  }

  async setOutputLines(
    token: SerialTransactionLeaseToken,
    lines: SerialTransactionOutputLines,
    signal?: AbortSignal,
  ): Promise<void> {
    const lease = this.requireActiveLease(token);
    if (!this.io.setOutputLines) {
      throw new SerialTransactionLeaseError('unavailable', 'serial output lines are unavailable');
    }
    if (!this.io.restoreOutputLines || lease.outputLinesBaseline === null) {
      throw new SerialTransactionLeaseError(
        'unavailable',
        'serial output line restoration is unavailable',
      );
    }
    if (!validOutputLines(lines)) {
      throw new SerialTransactionLeaseError('invalid-input', 'invalid serial output lines');
    }
    this.startLeaseOperation(lease);
    const linked = linkAbortSignals([lease.controller.signal, signal]);
    try {
      if (linked.signal.aborted) throw abortError();
      // Mark before the first physical line operation: an adapter may apply a
      // prefix and then reject, so cleanup must still restore the baseline.
      lease.outputLinesTouched = true;
      await this.io.setOutputLines(lines, this.ioContext(lease, linked.signal));
      if (!this.isActiveAndCurrent(lease)) {
        throw new SerialTransactionLeaseError('unknown-outcome');
      }
    } catch (error) {
      if (!this.isActiveAndCurrent(lease)) {
        throw new SerialTransactionLeaseError('unknown-outcome');
      }
      if (linked.signal.aborted) throw abortError();
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('io-error');
    } finally {
      linked.dispose();
      this.finishLeaseOperation(lease);
    }
  }

  async readInputLines(
    token: SerialTransactionLeaseToken,
    signal?: AbortSignal,
  ): Promise<SerialTransactionInputLines> {
    const lease = this.requireActiveLease(token);
    if (!this.io.readInputLines) {
      throw new SerialTransactionLeaseError('unavailable', 'serial input lines are unavailable');
    }
    this.startLeaseOperation(lease);
    const linked = linkAbortSignals([lease.controller.signal, signal]);
    try {
      if (linked.signal.aborted) throw abortError();
      const lines = await this.io.readInputLines(this.ioContext(lease, linked.signal));
      if (!this.isActiveAndCurrent(lease)) throw new SerialTransactionLeaseError('stale-handle');
      if (!validInputLines(lines)) {
        throw new SerialTransactionLeaseError('protocol-error', 'invalid serial input lines');
      }
      return Object.freeze({ ...lines });
    } catch (error) {
      if (linked.signal.aborted) throw abortError();
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('io-error');
    } finally {
      linked.dispose();
      this.finishLeaseOperation(lease);
    }
  }

  async runManualWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertIdle();
    this.manualWritesInFlight += 1;
    this.notify();
    try {
      return await operation();
    } finally {
      this.manualWritesInFlight = Math.max(0, this.manualWritesInFlight - 1);
      if (this.manualWritesInFlight === 0) {
        const waiters = [...this.manualDrainWaiters];
        this.manualDrainWaiters.clear();
        for (const resolve of waiters) resolve();
      }
      this.notify();
    }
  }

  offerRx(generation: number, bytes: Uint8Array): SerialTransactionRxOfferResult {
    const lease = this.active;
    if (!lease || this.phase !== 'active') return { status: 'ignored', bufferedBytes: 0 };
    if (generation !== lease.grant.generation || !this.isGenerationCurrent(lease.grant)) {
      void this.beginRelease(lease, 'connection-changed', false, true);
      return { status: 'ignored', bufferedBytes: lease.rx.bufferedBytes };
    }
    const offered = lease.rx.offer(bytes);
    if (offered.status === 'backpressure') {
      const error = new SerialTransactionLeaseError(
        'limit-exceeded',
        'serial transaction RX mirror capacity exceeded',
      );
      this.terminalFaultCode = error.code;
      this.terminalFaultToken = lease.grant.token;
      // Reject a pending read with the causal error before beginRelease closes
      // the mirror with its generic cancellation reason.
      lease.rx.close(error);
      void this.beginRelease(lease, 'cancelled', true, true);
    }
    return offered;
  }

  read(
    token: SerialTransactionLeaseToken,
    options: SerialTransactionReadOptions,
  ): Promise<Uint8Array> {
    let lease: ActiveLease;
    try {
      lease = this.requireActiveLease(token);
    } catch (error) {
      return Promise.reject(error);
    }
    const maxBytes = validateRequestInteger(options.maxBytes, 'maxBytes', this.limits.readBytes);
    const timeoutMs =
      options.timeoutMs === undefined
        ? this.limits.readTimeoutMs
        : validateRequestInteger(options.timeoutMs, 'timeoutMs', this.limits.readTimeoutMs);
    const linked = linkAbortSignals([lease.controller.signal, options.signal]);
    return lease.rx.read(maxBytes, timeoutMs, linked.signal).finally(() => linked.dispose());
  }

  release(token: SerialTransactionLeaseToken): Promise<SerialTransactionLeaseReleaseResult> {
    return this.beginRelease(this.requireLeaseForRelease(token), 'released', true, false);
  }

  cancel(token: SerialTransactionLeaseToken): Promise<SerialTransactionLeaseReleaseResult> {
    return this.beginRelease(this.requireLeaseForRelease(token), 'cancelled', true, true);
  }

  async notifyDisconnected(generation: number): Promise<boolean> {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new SerialTransactionLeaseError('invalid-input', 'invalid disconnected generation');
    }
    const acquisition = this.acquisition;
    if (acquisition?.generation === generation) {
      acquisition.reason = 'disconnected';
      acquisition.restoreAllowed = false;
      acquisition.controller.abort();
      await acquisition.settled;
      return true;
    }
    const lease = this.active;
    if (lease?.grant.generation !== generation) return false;
    await this.beginRelease(lease, 'disconnected', false, true);
    return true;
  }

  async synchronizeConnection(): Promise<boolean> {
    if (this.phase === 'faulted') {
      let current: SerialTransactionConnectionSnapshot;
      try {
        current = this.io.snapshot();
        validateGeneration(current);
      } catch {
        return false;
      }
      if (!current.connected || current.generation === this.faultedGeneration) return false;
      this.faultedGeneration = null;
      this.phase = 'idle';
      this.notify();
      return true;
    }
    const acquisition = this.acquisition;
    if (acquisition && !this.isGenerationCurrent(acquisition)) {
      acquisition.reason = 'connection-changed';
      acquisition.restoreAllowed = false;
      acquisition.controller.abort();
      await acquisition.settled;
      return true;
    }
    const lease = this.active;
    if (lease && !this.isGenerationCurrent(lease.grant)) {
      await this.beginRelease(lease, 'connection-changed', false, true);
      return true;
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      if (this.acquisition) await this.acquisition.settled;
      if (this.active?.releasePromise) await this.active.releasePromise;
      return;
    }
    this.disposed = true;
    const acquisition = this.acquisition;
    if (acquisition) {
      acquisition.reason = 'disposed';
      acquisition.controller.abort();
      await acquisition.settled;
    }
    const lease = this.active;
    if (lease) await this.beginRelease(lease, 'disposed', true, true);
    this.phase = 'disposed';
    this.faultedGeneration = null;
    this.notify();
    this.automations.clear();
    this.listeners.clear();
  }

  private assertIdle(): void {
    if (this.disposed || this.phase === 'disposed' || this.phase === 'faulted') {
      throw new SerialTransactionLeaseError('unavailable', 'lease coordinator is unavailable');
    }
    if (this.phase !== 'idle') throw new SerialTransactionLeaseError('busy');
  }

  private readConnectedSnapshot(): SerialTransactionConnectionSnapshot {
    let snapshot: SerialTransactionConnectionSnapshot;
    try {
      snapshot = this.io.snapshot();
    } catch {
      throw new SerialTransactionLeaseError('unavailable', 'connection snapshot is unavailable');
    }
    validateGeneration(snapshot);
    if (!snapshot.connected) throw new SerialTransactionLeaseError('disconnected');
    return snapshot;
  }

  private assertAcquisitionGeneration(acquisition: Acquisition): void {
    this.throwIfAcquisitionCancelled(acquisition);
    if (!this.isGenerationCurrent(acquisition)) {
      acquisition.restoreAllowed = false;
      throw new SerialTransactionLeaseError(this.isConnected() ? 'stale-handle' : 'disconnected');
    }
  }

  private throwIfAcquisitionCancelled(acquisition: Acquisition): void {
    if (acquisition.controller.signal.aborted || this.acquisition !== acquisition) {
      throw abortError();
    }
  }

  private classifyAcquisitionError(
    error: unknown,
    acquisition: Acquisition,
  ): SerialTransactionLeaseError {
    if (error instanceof SerialTransactionLeaseError) return error;
    if (acquisition.controller.signal.aborted) {
      if (acquisition.reason === 'disconnected') {
        return new SerialTransactionLeaseError('disconnected');
      }
      if (acquisition.reason === 'connection-changed') {
        return new SerialTransactionLeaseError('stale-handle');
      }
      return abortError();
    }
    return new SerialTransactionLeaseError('unavailable', 'failed to acquire serial transaction');
  }

  private issueToken(): SerialTransactionLeaseToken {
    let nonce: string;
    try {
      nonce = validateIdentifier(
        this.tokenFactory(),
        'lease token nonce',
        SERIAL_TRANSACTION_LEASE_LIMITS.tokenCharacters - 32,
      );
    } catch (error) {
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('unavailable', 'lease token generation failed');
    }
    this.tokenSequence += 1;
    if (!Number.isSafeInteger(this.tokenSequence)) {
      throw new SerialTransactionLeaseError('limit-exceeded', 'lease token sequence exhausted');
    }
    return `${nonce}.${this.tokenSequence.toString(36)}` as SerialTransactionLeaseToken;
  }

  private requireActiveLease(token: SerialTransactionLeaseToken): ActiveLease {
    if (this.terminalFaultToken === token && this.terminalFaultCode !== null) {
      throw new SerialTransactionLeaseError(this.terminalFaultCode);
    }
    const lease = this.active;
    if (this.phase !== 'active' || !lease || lease.grant.token !== token) {
      throw new SerialTransactionLeaseError('stale-handle');
    }
    if (!this.isGenerationCurrent(lease.grant)) {
      void this.beginRelease(lease, 'connection-changed', false, true);
      throw new SerialTransactionLeaseError(this.isConnected() ? 'stale-handle' : 'disconnected');
    }
    return lease;
  }

  private requireLeaseForRelease(token: SerialTransactionLeaseToken): ActiveLease {
    const lease = this.active;
    if (!lease || lease.grant.token !== token) {
      throw new SerialTransactionLeaseError('stale-handle');
    }
    return lease;
  }

  private ioContext(lease: ActiveLease, signal: AbortSignal): SerialTransactionWriteContext {
    return {
      ownerId: lease.grant.ownerId,
      generation: lease.grant.generation,
      leaseToken: lease.grant.token,
      signal,
    };
  }

  private startLeaseOperation(lease: ActiveLease): void {
    if (lease.writeInFlight) {
      throw new SerialTransactionLeaseError('busy', 'a lease operation is already in flight');
    }
    const settled = deferredVoid();
    lease.writeInFlight = true;
    lease.operationSettled = settled.promise;
    lease.settleOperation = settled.resolve;
  }

  private finishLeaseOperation(lease: ActiveLease): void {
    lease.writeInFlight = false;
    lease.settleOperation();
    lease.operationSettled = null;
    lease.settleOperation = () => undefined;
  }

  private snapshotOutputLines(generation: number): SerialTransactionOutputLines | null {
    if (!this.io.snapshotOutputLines || !this.io.restoreOutputLines) return null;
    let lines: SerialTransactionOutputLines;
    try {
      lines = this.io.snapshotOutputLines(generation);
    } catch (error) {
      if (error instanceof SerialTransactionLeaseError) throw error;
      throw new SerialTransactionLeaseError('unavailable', 'output line snapshot failed');
    }
    if (!validOutputLines(lines)) {
      throw new SerialTransactionLeaseError('protocol-error', 'invalid output line snapshot');
    }
    return Object.freeze({ ...lines });
  }

  private waitForManualWriteDrain(signal: AbortSignal): Promise<void> {
    if (this.manualWritesInFlight === 0) return Promise.resolve();
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.manualDrainWaiters.delete(finish);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.manualDrainWaiters.delete(finish);
        reject(abortError());
      };
      this.manualDrainWaiters.add(finish);
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.manualWritesInFlight === 0) finish();
    });
  }

  private beginRelease(
    lease: ActiveLease,
    reason: SerialTransactionLeaseReleaseReason,
    restoreAllowed: boolean,
    abortWrites: boolean,
  ): Promise<SerialTransactionLeaseReleaseResult> {
    lease.restoreAllowed &&= restoreAllowed;
    if (lease.releasePromise) {
      if (abortWrites) lease.controller.abort();
      return lease.releasePromise;
    }
    this.phase = 'releasing';
    lease.detachOwnerAbort();
    lease.rx.close(
      new SerialTransactionLeaseError(reason === 'disconnected' ? 'disconnected' : 'cancelled'),
    );
    if (abortWrites) lease.controller.abort();
    this.notify();
    lease.releasePromise = this.performRelease(lease, reason);
    return lease.releasePromise;
  }

  private async performRelease(
    lease: ActiveLease,
    reason: SerialTransactionLeaseReleaseReason,
  ): Promise<SerialTransactionLeaseReleaseResult> {
    let drainFailed = false;
    if (lease.operationSettled) await lease.operationSettled;
    if (lease.restoreAllowed) {
      try {
        await this.io.waitForWriteDrain({ generation: lease.grant.generation });
      } catch {
        drainFailed = true;
        lease.restoreAllowed = false;
      }
    }

    const stable = lease.restoreAllowed && this.isGenerationCurrent(lease.grant);
    let controlLinesRestored = true;
    const controlFailures: string[] = [];
    if (stable && lease.outputLinesTouched) {
      try {
        if (!this.io.restoreOutputLines || lease.outputLinesBaseline === null) {
          throw new SerialTransactionLeaseError('unavailable');
        }
        await this.io.restoreOutputLines(lease.outputLinesBaseline, {
          ownerId: lease.grant.ownerId,
          generation: lease.grant.generation,
          reason,
        });
        controlLinesRestored = this.isGenerationCurrent(lease.grant);
      } catch {
        controlLinesRestored = false;
      }
      if (!controlLinesRestored) controlFailures.push('serial.control-lines');
    }
    const restoration =
      stable && controlLinesRestored
        ? await this.restoreAutomations(lease.suspensions, {
            ownerId: lease.grant.ownerId,
            generation: lease.grant.generation,
            reason,
          })
        : { restored: 0, failures: [] as string[] };
    if (this.active === lease) this.active = null;
    const releaseFaulted = drainFailed || !controlLinesRestored;
    this.phase = this.disposed ? 'disposed' : releaseFaulted ? 'faulted' : 'idle';
    this.faultedGeneration = releaseFaulted ? lease.grant.generation : null;
    this.notify();
    return Object.freeze({
      reason,
      generation: lease.grant.generation,
      restoredAutomations: restoration.restored,
      restoreFailures: Object.freeze([...controlFailures, ...restoration.failures]),
      restoreSkipped: !stable || !controlLinesRestored,
      drainFailed,
    });
  }

  private async restoreAutomations(
    suspensions: readonly PausedAutomation[],
    context: SerialAutomationRestoreContext,
  ): Promise<{ restored: number; failures: string[] }> {
    let restored = 0;
    const failures: string[] = [];
    for (let index = suspensions.length - 1; index >= 0; index -= 1) {
      const paused = suspensions[index];
      if (!paused) continue;
      try {
        await paused.suspension.restore(context);
        restored += 1;
      } catch {
        failures.push(paused.id);
      }
    }
    return { restored, failures };
  }

  private isGenerationCurrent(expected: { readonly generation: number }): boolean {
    try {
      const current = this.io.snapshot();
      return current.connected && validateGeneration(current) === expected.generation;
    } catch {
      return false;
    }
  }

  private isConnected(): boolean {
    try {
      return this.io.snapshot().connected;
    } catch {
      return false;
    }
  }

  private isActiveAndCurrent(lease: ActiveLease): boolean {
    return (
      this.active === lease && this.phase === 'active' && this.isGenerationCurrent(lease.grant)
    );
  }

  private notify(): void {
    for (const listener of this.listeners) this.callListener(listener);
  }

  private callListener(listener: SerialTransactionLeaseListener): void {
    try {
      listener(this.snapshot());
    } catch {
      // Observers cannot affect ownership or transaction restoration.
    }
  }
}
