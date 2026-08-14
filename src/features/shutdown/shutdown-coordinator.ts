import {
  SHUTDOWN_WAIT_LIMIT_MS,
  type ShutdownCancellation,
  type ShutdownCloseRequest,
  type ShutdownConfirmation,
  type ShutdownCoordinatorListener,
  type ShutdownCoordinatorSnapshot,
  type ShutdownDrainParticipant,
  type ShutdownDrainResult,
  type ShutdownParticipantMessageKey,
  type ShutdownParticipantReport,
  type ShutdownParticipantStatus,
  type ShutdownReport,
  type ShutdownState,
} from './types';

const MAX_PARTICIPANTS = 64;
const PARTICIPANT_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface RegisteredParticipant {
  readonly definition: ShutdownDrainParticipant;
  readonly sequence: number;
}

interface AttemptParticipant {
  readonly definition: ShutdownDrainParticipant;
  readonly sequence: number;
  readonly controller: AbortController;
  status: ShutdownParticipantStatus;
  elapsedMs: number;
  startedAt: number | null;
  invocation: Promise<'completed' | 'failed'> | null;
  invocationRound: number;
  settled: boolean;
}

interface ShutdownAttempt {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly participants: AttemptParticipant[];
  round: number;
  closed: boolean;
  forced: boolean;
  latestDrain: Promise<ShutdownDrainResult>;
  lastDrainResult: ShutdownDrainResult | null;
  confirmation: ShutdownConfirmation | null;
  cancellation: ShutdownCancellation | null;
}

const LEGAL_TRANSITIONS: Readonly<Record<ShutdownState, ReadonlySet<ShutdownState>>> = {
  idle: new Set(['requested']),
  requested: new Set(['draining']),
  draining: new Set(['ready', 'timed-out', 'failed']),
  ready: new Set(['confirming']),
  'timed-out': new Set(['draining', 'confirming']),
  failed: new Set(['draining', 'confirming']),
  confirming: new Set(['confirmed', 'cancelled']),
  confirmed: new Set(),
  cancelled: new Set(['idle']),
};

/**
 * Renderer-side shutdown state machine.
 *
 * It never closes a window and never waits in `beforeunload`. Native close
 * prevention and the final `confirm_exit` command are connected by the
 * protocol adapter at the application boundary.
 */
export class ShutdownCoordinator {
  private readonly registrations = new Map<string, RegisteredParticipant>();
  private readonly listeners = new Set<ShutdownCoordinatorListener>();
  private registrationSequence = 0;
  private state: ShutdownState = 'idle';
  private attempt: ShutdownAttempt | null = null;
  private previousReport: ShutdownReport | null = null;

  get currentState(): ShutdownState {
    return this.state;
  }

  get acceptsNewWork(): boolean {
    return this.state === 'idle';
  }

  get lastReport(): ShutdownReport | null {
    return this.previousReport;
  }

  register(participant: ShutdownDrainParticipant): () => void {
    validateParticipant(participant);
    if (this.state !== 'idle') {
      throw new Error('shutdown participants can only be registered while idle');
    }
    const name = participant.name;
    if (this.registrations.has(name)) {
      throw new Error(`shutdown participant is already registered: ${name}`);
    }
    if (this.registrations.size >= MAX_PARTICIPANTS) {
      throw new Error(`shutdown participant limit exceeded: ${MAX_PARTICIPANTS}`);
    }
    const registration: RegisteredParticipant = {
      definition: Object.freeze({
        name,
        priority: participant.priority,
        timeoutMs: participant.timeoutMs,
        repeatableBarrier: participant.repeatableBarrier === true,
        drain: participant.drain,
      }),
      sequence: this.registrationSequence++,
    };
    this.registrations.set(name, registration);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.registrations.delete(name);
    };
  }

  requestClose(request: ShutdownCloseRequest): Promise<ShutdownDrainResult> {
    const requestedAttemptId = validateAttemptId(request.attemptId);
    if (this.attempt) {
      if (this.attempt.attemptId !== requestedAttemptId) {
        throw new Error('shutdown attempt does not match the active close request');
      }
      return this.attempt.latestDrain;
    }
    if (this.state !== 'idle') throw new Error(`cannot request close while ${this.state}`);

    const participants = Array.from(this.registrations.values())
      .sort(compareRegistrations)
      .map<AttemptParticipant>((registration) => ({
        definition: registration.definition,
        sequence: registration.sequence,
        controller: new AbortController(),
        status: 'pending',
        elapsedMs: 0,
        startedAt: null,
        invocation: null,
        invocationRound: -1,
        settled: false,
      }));
    const attempt: ShutdownAttempt = {
      attemptId: requestedAttemptId,
      startedAt: now(),
      participants,
      round: 0,
      closed: false,
      forced: false,
      latestDrain: Promise.resolve(undefined as never),
      lastDrainResult: null,
      confirmation: null,
      cancellation: null,
    };
    this.attempt = attempt;
    attempt.latestDrain = Promise.resolve().then(() => this.runDrainWindow(attempt));
    this.transition('requested');
    return attempt.latestDrain;
  }

  /** Continue the same invocations for one more bounded eight-second window. */
  wait(attemptId: string): Promise<ShutdownDrainResult> {
    const attempt = this.requireAttempt(attemptId);
    if (this.state !== 'timed-out' && this.state !== 'failed') {
      throw new Error(`wait is not allowed while shutdown is ${this.state}`);
    }
    attempt.round += 1;
    this.transition('draining');
    attempt.latestDrain = this.runDrainWindow(attempt, true);
    return attempt.latestDrain;
  }

  /**
   * Prepare an immutable cancellation for native publication. The attempt is
   * retained in `confirming` until acknowledgeCancellation records native
   * success, so a rejected IPC call can publish the same decision again.
   */
  cancel(attemptId: string): ShutdownCancellation {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.cancellation) return attempt.cancellation;
    this.assertDecisionState('cancel');
    this.transition('confirming');
    this.closeAttempt(attempt);
    const report = this.makeReport(attempt, 'cancelled');
    const cancellation = freezeCancellation({ attemptId: attempt.attemptId, report });
    attempt.cancellation = cancellation;
    return cancellation;
  }

  /** Commit the renderer terminal state only after native cancel_exit succeeds. */
  acknowledgeCancellation(attemptId: string): ShutdownCancellation {
    const attempt = this.requireAttempt(attemptId);
    if (!attempt.cancellation || this.state !== 'confirming') {
      throw new Error(`cancel acknowledgement requires confirming state, found ${this.state}`);
    }
    const cancellation = attempt.cancellation;
    this.transition('cancelled');
    this.previousReport = cancellation.report;
    this.attempt = null;
    this.transition('idle');
    return cancellation;
  }

  /** Prepare a normal native confirmation without committing renderer state. */
  confirmExit(attemptId: string): ShutdownConfirmation {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.confirmation) return attempt.confirmation;
    if (this.state !== 'ready') {
      throw new Error(`confirmExit requires ready state, found ${this.state}`);
    }
    return this.confirm(attempt, false);
  }

  /** Prepare a forced native confirmation; no drain is invoked again. */
  force(attemptId: string): ShutdownConfirmation {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.confirmation) return attempt.confirmation;
    if (this.state !== 'timed-out' && this.state !== 'failed') {
      throw new Error(`force requires timed-out or failed state, found ${this.state}`);
    }
    return this.confirm(attempt, true);
  }

  snapshot(): ShutdownCoordinatorSnapshot {
    const attempt = this.attempt;
    return freezeSnapshot({
      state: this.state,
      attemptId: attempt?.attemptId ?? null,
      acceptsNewWork: this.acceptsNewWork,
      forced: attempt?.forced ?? false,
      report: attempt ? this.makeReport(attempt) : null,
    });
  }

  subscribe(listener: ShutdownCoordinatorListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // View observers cannot change shutdown semantics.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async runDrainWindow(
    attempt: ShutdownAttempt,
    alreadyDraining = false,
  ): Promise<ShutdownDrainResult> {
    if (!alreadyDraining) this.transition('draining');
    const windowDeadline = now() + SHUTDOWN_WAIT_LIMIT_MS;
    const priorities = Array.from(
      new Set(attempt.participants.map((participant) => participant.definition.priority)),
    ).sort((left, right) => right - left);

    for (const priority of priorities) {
      if (attempt.closed || now() >= windowDeadline) break;
      const group = attempt.participants.filter(
        (participant) =>
          participant.definition.priority === priority &&
          shouldRunInRound(participant, attempt.round),
      );
      if (group.length === 0) continue;
      await Promise.all(
        group.map((participant) =>
          this.runParticipantInRound(attempt, participant, windowDeadline),
        ),
      );
    }

    if (attempt.closed) {
      throw new Error('shutdown drain was closed while running');
    }
    for (const participant of attempt.participants) {
      if (participant.status === 'running') this.markTimedOut(participant);
      else if (
        participant.definition.repeatableBarrier &&
        participant.invocationRound < attempt.round
      ) {
        participant.status = 'timed-out';
        this.notify();
      }
    }

    const outcome = classifyAttempt(attempt.participants);
    this.transition(outcome);
    const report = this.makeReport(attempt);
    const result = freezeDrainResult({
      attemptId: attempt.attemptId,
      round: attempt.round,
      state: outcome,
      needsDecision: outcome !== 'ready',
      requiresConfirmExit: true,
      report,
    });
    attempt.lastDrainResult = result;
    this.previousReport = report;
    return result;
  }

  private startParticipant(
    attempt: ShutdownAttempt,
    participant: AttemptParticipant,
    round: number,
  ): void {
    if (participant.invocation) {
      if (!participant.settled) {
        participant.status = 'running';
        participant.elapsedMs = elapsedSince(participant.startedAt ?? now());
        this.notify();
        return;
      }
      if (!participant.definition.repeatableBarrier || participant.invocationRound >= round) return;
    }
    participant.status = 'running';
    participant.startedAt = now();
    participant.elapsedMs = 0;
    participant.settled = false;
    participant.invocationRound = round;
    const drain = participant.definition.drain;
    const invocation = Promise.resolve()
      .then(() =>
        drain({
          attemptId: attempt.attemptId,
          signal: participant.controller.signal,
        }),
      )
      .then(
        () => 'completed' as const,
        () => 'failed' as const,
      );
    participant.invocation = invocation.then((outcome) => {
      participant.settled = true;
      if (!attempt.closed) {
        participant.status = outcome;
        participant.elapsedMs = elapsedSince(participant.startedAt ?? now());
        this.notify();
      }
      return outcome;
    });
    this.notify();
  }

  private async runParticipantInRound(
    attempt: ShutdownAttempt,
    participant: AttemptParticipant,
    windowDeadline: number,
  ): Promise<void> {
    while (!attempt.closed && now() < windowDeadline) {
      this.startParticipant(attempt, participant, attempt.round);
      if (!participant.invocation) return;
      if (participant.settled) {
        if (!shouldRunInRound(participant, attempt.round)) return;
        continue;
      }
      const remainingWindow = Math.max(0, windowDeadline - now());
      const timeoutMs = Math.min(participant.definition.timeoutMs, remainingWindow);
      const settled = await settleWithin(participant.invocation, timeoutMs);
      if (!settled && !attempt.closed && !participant.settled) {
        this.markTimedOut(participant);
        return;
      }
      if (!shouldRunInRound(participant, attempt.round)) return;
    }
  }

  private markTimedOut(participant: AttemptParticipant): void {
    participant.status = 'timed-out';
    participant.elapsedMs = elapsedSince(participant.startedAt ?? now());
    this.notify();
  }

  private confirm(attempt: ShutdownAttempt, forced: boolean): ShutdownConfirmation {
    attempt.forced = forced;
    this.transition('confirming');
    this.closeAttempt(attempt);
    const report = this.makeReport(attempt, 'confirmed');
    const confirmation = freezeConfirmation({
      attemptId: attempt.attemptId,
      forced,
      report,
    });
    attempt.confirmation = confirmation;
    return confirmation;
  }

  /** Commit the renderer terminal state only after native confirm_exit succeeds. */
  acknowledgeConfirmation(attemptId: string): ShutdownConfirmation {
    const attempt = this.requireAttempt(attemptId);
    if (!attempt.confirmation || this.state !== 'confirming') {
      throw new Error(`confirm acknowledgement requires confirming state, found ${this.state}`);
    }
    this.transition('confirmed');
    this.previousReport = attempt.confirmation.report;
    return attempt.confirmation;
  }

  private closeAttempt(attempt: ShutdownAttempt): void {
    attempt.closed = true;
    for (const participant of attempt.participants) {
      if (!participant.settled) participant.controller.abort();
    }
  }

  private assertDecisionState(action: string): void {
    if (this.state !== 'ready' && this.state !== 'timed-out' && this.state !== 'failed') {
      throw new Error(`${action} is not allowed while shutdown is ${this.state}`);
    }
  }

  private requireAttempt(attemptId: string): ShutdownAttempt {
    const normalized = validateAttemptId(attemptId);
    if (!this.attempt || this.attempt.attemptId !== normalized) {
      throw new Error('shutdown attempt does not match the active close request');
    }
    return this.attempt;
  }

  private transition(next: ShutdownState): void {
    if (!LEGAL_TRANSITIONS[this.state].has(next)) {
      throw new Error(`illegal shutdown transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    this.notify();
  }

  private makeReport(attempt: ShutdownAttempt, state: ShutdownState = this.state): ShutdownReport {
    const participants = attempt.participants.map<ShutdownParticipantReport>((participant) =>
      Object.freeze({
        name: participant.definition.name,
        priority: participant.definition.priority,
        status: participant.status,
        elapsedMs:
          participant.status === 'running' && participant.startedAt !== null
            ? elapsedSince(participant.startedAt)
            : participant.elapsedMs,
        messageKey: messageKeyFor(participant.status),
      }),
    );
    Object.freeze(participants);
    return Object.freeze({
      attemptId: attempt.attemptId,
      state,
      elapsedMs: elapsedSince(attempt.startedAt),
      participants,
    });
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // View observers cannot change shutdown semantics.
      }
    }
  }
}

function classifyAttempt(
  participants: readonly AttemptParticipant[],
): 'ready' | 'timed-out' | 'failed' {
  if (
    participants.some(
      (participant) =>
        participant.status === 'pending' ||
        participant.status === 'running' ||
        participant.status === 'timed-out',
    )
  ) {
    return 'timed-out';
  }
  return participants.some((participant) => participant.status === 'failed') ? 'failed' : 'ready';
}

function shouldRunInRound(participant: AttemptParticipant, round: number): boolean {
  if (participant.definition.repeatableBarrier) {
    return participant.invocationRound < round || !participant.settled;
  }
  return participant.status !== 'completed' && participant.status !== 'failed';
}

function compareRegistrations(left: RegisteredParticipant, right: RegisteredParticipant): number {
  return right.definition.priority - left.definition.priority || left.sequence - right.sequence;
}

function validateParticipant(participant: ShutdownDrainParticipant): void {
  if (!PARTICIPANT_NAME_PATTERN.test(participant.name)) {
    throw new Error('shutdown participant name must be a stable path-free identifier');
  }
  if (!Number.isSafeInteger(participant.priority)) {
    throw new Error('shutdown participant priority must be a safe integer');
  }
  if (
    !Number.isSafeInteger(participant.timeoutMs) ||
    participant.timeoutMs < 1 ||
    participant.timeoutMs > SHUTDOWN_WAIT_LIMIT_MS
  ) {
    throw new Error(
      `shutdown participant timeoutMs must be between 1 and ${SHUTDOWN_WAIT_LIMIT_MS}`,
    );
  }
  if (
    participant.repeatableBarrier !== undefined &&
    typeof participant.repeatableBarrier !== 'boolean'
  ) {
    throw new Error('shutdown participant repeatableBarrier must be a boolean');
  }
  if (typeof participant.drain !== 'function') {
    throw new Error('shutdown participant drain must be a function');
  }
}

function validateAttemptId(attemptId: string): string {
  const normalized = attemptId.trim();
  if (!ATTEMPT_ID_PATTERN.test(normalized)) {
    throw new Error('shutdown attemptId must be a stable path-free opaque identifier');
  }
  return normalized;
}

function messageKeyFor(status: ShutdownParticipantStatus): ShutdownParticipantMessageKey {
  return status === 'timed-out'
    ? 'shutdown.participant.timed_out'
    : `shutdown.participant.${status}`;
}

function now(): number {
  return Date.now();
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.floor(now() - startedAt));
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    void promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function freezeDrainResult(result: ShutdownDrainResult): ShutdownDrainResult {
  return Object.freeze(result);
}

function freezeConfirmation(confirmation: ShutdownConfirmation): ShutdownConfirmation {
  return Object.freeze(confirmation);
}

function freezeCancellation(cancellation: ShutdownCancellation): ShutdownCancellation {
  return Object.freeze(cancellation);
}

function freezeSnapshot(snapshot: ShutdownCoordinatorSnapshot): ShutdownCoordinatorSnapshot {
  return Object.freeze(snapshot);
}
