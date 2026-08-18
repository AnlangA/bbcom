import {
  LEGACY_RESET_MARKER_KEY,
  LEGACY_RESET_MARKER_VALUE,
  LEGACY_SOURCE_VERSION,
  type Legacy073Snapshot,
  type LegacyBackupContent,
  type LegacyBackupPort,
  type LegacyDiscardRequestOutcome,
  type LegacyJsonObject,
  type LegacyJsonValue,
  type LegacyReadOnlySource,
  type LegacyResetActionOutcome,
  type LegacyResetListener,
  type LegacyResetJournalSnapshot,
  type LegacyResetMarkerStore,
  type LegacyResetNativePort,
  type LegacyResetStatus,
  type LegacyResetViewModel,
  type LegacyWorkspaceResetOptions,
  type WorkspaceResetTarget,
} from './types';
import { logger } from '../../lib/logger';

type ActiveOperationKind = 'checking' | 'backup' | 'reset';
type ResetAuthorization = LegacyResetViewModel['resetAuthorizedBy'];

interface ActiveOperation {
  readonly kind: ActiveOperationKind;
  readonly controller: AbortController;
  cancellable: boolean;
}

const BACKUP_UNSAFE_KEYS = new Set([
  'accessgrant',
  'apikey',
  'authorization',
  'credential',
  'directory',
  'grant',
  'keyring',
  'keyringentry',
  'nativehandle',
  'password',
  'path',
  'portname',
  'permissiontoken',
  'selectedport',
  'secret',
  'sourcegrant',
  'sourcegrantid',
  'targetgrant',
  'targetgrantid',
  'token',
]);

/**
 * Coordinates the one-time 0.7.3 reset. It never mutates the legacy source;
 * only the injected schema-v1 target and the fixed completion marker are
 * writable.
 */
export class LegacyWorkspaceResetCoordinator {
  private readonly listeners = new Set<LegacyResetListener>();
  private readonly now: () => number;
  private readonly challengeFactory: () => string;
  private status: LegacyResetStatus = 'checking';
  private messageKey: string | null = null;
  private activeOperation: ActiveOperation | null = null;
  private startPromise: Promise<LegacyResetActionOutcome> | null = null;
  private backupContent: LegacyBackupContent | null = null;
  private verifiedBackupId: string | null = null;
  private authorization: ResetAuthorization = null;
  private discardChallenge: string | null = null;
  private nativeRecoveryPending = false;
  private readonly nativePort: LegacyResetNativePort;

  constructor(
    private readonly source: LegacyReadOnlySource,
    private readonly backupPort: LegacyBackupPort,
    private readonly target: WorkspaceResetTarget,
    private readonly markerStore: LegacyResetMarkerStore,
    options: LegacyWorkspaceResetOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.challengeFactory = options.challengeFactory ?? defaultChallenge;
    this.nativePort = options.nativePort ?? unavailableNativeResetPort;
  }

  snapshot(): LegacyResetViewModel {
    return Object.freeze({
      status: this.status,
      messageKey: this.messageKey,
      canCancel: this.activeOperation?.cancellable === true,
      discardChallengePending: this.discardChallenge !== null,
      resetAuthorizedBy: this.authorization,
    });
  }

  subscribe(listener: LegacyResetListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // A presentation observer cannot influence the reset transaction.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Concurrent calls share the exact same check/read operation. */
  start(): Promise<LegacyResetActionOutcome> {
    if (this.startPromise) return this.startPromise;
    if (
      this.status === 'completed' ||
      this.status === 'backup-required' ||
      this.status === 'ready-to-reset'
    ) {
      return Promise.resolve(completed(this.snapshot()));
    }
    if (this.activeOperation) return Promise.resolve(this.rejected('migration.reset.busy'));

    const operation = this.beginOperation('checking', 'checking');
    const pending = this.runStart(operation);
    this.startPromise = pending;
    void pending.then(
      () => this.clearStartPromise(pending),
      () => this.clearStartPromise(pending),
    );
    return pending;
  }

  /** Creates an encrypted backup and verifies it through an independent readback. */
  createVerifiedBackup(
    attemptPort: LegacyBackupPort = this.backupPort,
  ): Promise<LegacyResetActionOutcome> {
    if (this.activeOperation) return Promise.resolve(this.rejected('migration.reset.busy'));
    if (!this.backupContent || this.authorization !== null) {
      return Promise.resolve(this.rejected('migration.reset.backup_not_available'));
    }
    if (this.status !== 'backup-required' && this.status !== 'failed') {
      return Promise.resolve(this.rejected('migration.reset.invalid_state'));
    }

    this.discardChallenge = null;
    const operation = this.beginOperation('backup', 'backing-up');
    return this.runBackup(operation, attemptPort);
  }

  /** First explicit acknowledgement for resetting without a backup. */
  requestDiscard(): LegacyDiscardRequestOutcome {
    if (
      this.activeOperation ||
      this.status !== 'backup-required' ||
      !this.backupContent ||
      this.authorization !== null ||
      this.discardChallenge !== null
    ) {
      return {
        outcome: 'rejected',
        messageKey: 'migration.reset.discard_not_available',
        snapshot: this.snapshot(),
      };
    }

    const challenge = this.challengeFactory();
    if (typeof challenge !== 'string' || challenge.length < 8 || challenge.length > 256) {
      return {
        outcome: 'rejected',
        messageKey: 'migration.reset.challenge_unavailable',
        snapshot: this.snapshot(),
      };
    }
    this.discardChallenge = challenge;
    this.messageKey = 'migration.reset.discard_confirmation_required';
    this.notify();
    return { outcome: 'challenge', challenge };
  }

  /** Second acknowledgement. The one-time challenge is consumed on success. */
  confirmDiscard(challenge: string): LegacyResetActionOutcome {
    if (
      this.activeOperation ||
      this.status !== 'backup-required' ||
      !this.discardChallenge ||
      challenge !== this.discardChallenge
    ) {
      return this.rejected('migration.reset.challenge_rejected');
    }

    this.discardChallenge = null;
    this.authorization = 'confirmed-discard';
    this.transition('ready-to-reset', null);
    return completed(this.snapshot());
  }

  /** Activates and verifies the empty target before writing completion. */
  activateEmptyV1(): Promise<LegacyResetActionOutcome> {
    if (this.activeOperation) return Promise.resolve(this.rejected('migration.reset.busy'));
    if (
      (this.status !== 'ready-to-reset' && this.status !== 'failed') ||
      (this.authorization === null && !this.nativeRecoveryPending)
    ) {
      return Promise.resolve(this.rejected('migration.reset.not_authorized'));
    }
    const operation = this.beginOperation('reset', 'resetting');
    return this.runReset(operation);
  }

  cancel(): boolean {
    if (!this.activeOperation?.cancellable) return false;
    this.activeOperation.controller.abort();
    return true;
  }

  private async runStart(operation: ActiveOperation): Promise<LegacyResetActionOutcome> {
    let recoveringWorkspace = false;
    try {
      const context = { signal: operation.controller.signal };
      let journal = await this.nativePort.getJournal(context);
      this.ensureCurrent(operation);
      if (journal.phase === 'intent') {
        this.nativeRecoveryPending = true;
        recoveringWorkspace = true;
        journal = await this.nativePort.prepare({}, context);
        this.ensureCurrent(operation);
      }
      if (journal.phase === 'workspaceReady' || journal.phase === 'completed') {
        this.nativeRecoveryPending = true;
        recoveringWorkspace = true;
        if (journal.phase === 'completed') {
          await this.openCompletedJournalWorkspace(journal, context);
        } else {
          try {
            await this.openJournalWorkspace(journal, context);
          } catch (recoveryError) {
            if (isAbort(recoveryError)) throw recoveryError;
            // Crash-recovery drift: the prepared workspace was used meanwhile
            // (revision advanced / no longer empty), so the empty-workspace
            // contract can never validate again. Degrade to opening it as-is
            // instead of looping target_failed on every boot; native complete
            // still runs below and its own failure keeps the retry UI.
            logger.warn(
              'legacy reset workspace recovery degraded to completed-restore',
              recoveryError,
            );
            await this.openCompletedJournalWorkspace(journal, context);
          }
        }
        this.ensureCurrent(operation);
        if (journal.phase === 'workspaceReady') {
          const { workspaceId, expectedRevision } = journalCoordinates(journal);
          this.beginNativeCommit(operation);
          journal = await this.nativePort.complete(workspaceId, expectedRevision, context);
          if (journal.phase !== 'completed') throw new Error('native reset did not complete');
        } else {
          this.beginNativeCommit(operation);
        }
        await this.writeMarkerMirror();
        this.finishOperation(operation);
        this.backupContent = null;
        this.verifiedBackupId = null;
        this.authorization = null;
        this.discardChallenge = null;
        this.nativeRecoveryPending = false;
        this.transition('completed', null);
        return completed(this.snapshot());
      }
      if (journal.phase !== 'required') throw new Error('invalid native reset journal phase');
      this.nativeRecoveryPending = false;

      // A renderer marker cannot authorize skipping a native `required`
      // journal. Remove a stale mirror best-effort before reading legacy data.
      await this.removeMarkerMirror();

      this.ensureCurrent(operation);
      const [snapshot, settings, presets] = await Promise.all([
        this.source.readSnapshot(context),
        this.source.readSettings(context),
        this.source.readPresets(context),
      ]);
      this.ensureCurrent(operation);
      if (!hasLegacyContent(snapshot, settings, presets)) {
        journal = await this.nativePort.prepare({ emptyLegacyState: true }, context);
        this.ensureCurrent(operation);
        if (journal.phase !== 'workspaceReady') {
          throw new Error('fresh install workspace was not prepared');
        }
        await this.openJournalWorkspace(journal, context);
        this.ensureCurrent(operation);
        const { workspaceId, expectedRevision } = journalCoordinates(journal);
        this.beginNativeCommit(operation);
        journal = await this.nativePort.complete(workspaceId, expectedRevision, context);
        if (journal.phase !== 'completed') throw new Error('fresh install reset did not complete');
        await this.writeMarkerMirror();
        this.finishOperation(operation);
        this.backupContent = null;
        this.verifiedBackupId = null;
        this.authorization = null;
        this.discardChallenge = null;
        this.nativeRecoveryPending = false;
        this.transition('completed', null);
        return completed(this.snapshot());
      }
      this.backupContent = buildBackupContent(snapshot, settings, presets, this.now());
      this.verifiedBackupId = null;
      this.authorization = null;
      this.discardChallenge = null;
      this.nativeRecoveryPending = false;
      this.finishOperation(operation);
      this.transition('backup-required', 'migration.reset.backup_required');
      return completed(this.snapshot());
    } catch (error) {
      return this.failOperation(operation, error, recoveringWorkspace ? 'reset' : 'checking');
    }
  }

  private async runBackup(
    operation: ActiveOperation,
    attemptPort: LegacyBackupPort,
  ): Promise<LegacyResetActionOutcome> {
    const content = this.backupContent;
    if (!content) {
      this.finishOperation(operation);
      return this.rejected('migration.reset.backup_not_available');
    }
    try {
      const context = { signal: operation.controller.signal };
      const receipt = await attemptPort.beginEncryptedBackup(content, context);
      this.ensureCurrent(operation);
      if (!receipt.backupId || receipt.backupId.length > 256) {
        throw new Error('invalid backup receipt');
      }
      this.transition('verifying', null);
      const verification = await attemptPort.verifyEncryptedBackup(receipt, content, context);
      this.ensureCurrent(operation);
      if (!verification.verified) throw new BackupVerificationError();

      this.verifiedBackupId = receipt.backupId;
      this.authorization = 'verified-backup';
      this.finishOperation(operation);
      this.transition('ready-to-reset', null);
      return completed(this.snapshot());
    } catch (error) {
      return this.failOperation(operation, error, 'backup');
    }
  }

  private async runReset(operation: ActiveOperation): Promise<LegacyResetActionOutcome> {
    try {
      const context = { signal: operation.controller.signal };
      this.ensureCurrent(operation);
      let journal = await this.nativePort.getJournal(context);
      this.ensureCurrent(operation);
      if (journal.phase === 'required') {
        if (this.authorization === 'verified-backup') {
          if (!this.verifiedBackupId) throw new Error('verified backup authority is missing');
          journal = await this.nativePort.prepare(
            { verifiedBackupId: this.verifiedBackupId },
            context,
          );
        } else if (this.authorization === 'confirmed-discard') {
          const discardToken = await this.nativePort.beginDiscard(context);
          this.ensureCurrent(operation);
          journal = await this.nativePort.prepare({ discardToken }, context);
        } else {
          throw new Error('native reset is not authorized');
        }
        this.ensureCurrent(operation);
      } else if (journal.phase === 'intent') {
        journal = await this.nativePort.prepare({}, context);
        this.ensureCurrent(operation);
      }
      if (journal.phase === 'workspaceReady') {
        await this.openJournalWorkspace(journal, context);
        this.ensureCurrent(operation);
        const { workspaceId, expectedRevision } = journalCoordinates(journal);
        this.beginNativeCommit(operation);
        journal = await this.nativePort.complete(workspaceId, expectedRevision, context);
      } else if (journal.phase === 'completed') {
        // A lost response after native completion is recovered by reopening
        // the same workspace before the renderer gate can be released.
        await this.openCompletedJournalWorkspace(journal, context);
        this.ensureCurrent(operation);
        this.beginNativeCommit(operation);
      } else {
        throw new Error('native reset workspace is not ready');
      }
      if (journal.phase !== 'completed') throw new Error('native reset did not complete');
      await this.writeMarkerMirror();
      this.finishOperation(operation);
      this.backupContent = null;
      this.verifiedBackupId = null;
      this.authorization = null;
      this.discardChallenge = null;
      this.nativeRecoveryPending = false;
      this.transition('completed', null);
      return completed(this.snapshot());
    } catch (error) {
      return this.failOperation(operation, error, 'reset');
    }
  }

  private async openJournalWorkspace(
    journal: LegacyResetJournalSnapshot,
    context: { readonly signal: AbortSignal },
  ): Promise<void> {
    const { workspaceId, expectedRevision } = journalCoordinates(journal);
    await this.target.activateEmptyV1(workspaceId, expectedRevision, context);
  }

  private async openCompletedJournalWorkspace(
    journal: LegacyResetJournalSnapshot,
    context: { readonly signal: AbortSignal },
  ): Promise<void> {
    const { workspaceId } = journalCoordinates(journal);
    await this.target.activateCompletedV1(workspaceId, context);
  }

  private async writeMarkerMirror(): Promise<void> {
    try {
      await this.markerStore.write(LEGACY_RESET_MARKER_KEY, LEGACY_RESET_MARKER_VALUE);
    } catch (error) {
      // The native completed journal is authoritative. A quota/privacy error
      // in this optional cache must not re-block a verified native reset —
      // but it stays diagnosable because the marker also suppresses the
      // gate's startup flash on the next launch.
      logger.warn('legacy reset completion marker could not be written:', error);
    }
  }

  private async removeMarkerMirror(): Promise<void> {
    try {
      if (await this.markerStore.isSet(LEGACY_RESET_MARKER_KEY)) {
        await this.markerStore.remove(LEGACY_RESET_MARKER_KEY);
      }
    } catch (error) {
      // A renderer cache cannot influence native-required state.
      logger.warn('legacy reset completion marker could not be removed:', error);
    }
  }

  private failOperation(
    operation: ActiveOperation,
    error: unknown,
    phase: ActiveOperationKind,
  ): LegacyResetActionOutcome {
    if (this.activeOperation === operation) this.finishOperation(operation);
    if (isAbort(error) || operation.controller.signal.aborted) {
      if (phase === 'backup') this.transition('backup-required', 'migration.reset.cancelled');
      else if (phase === 'reset') this.transition('ready-to-reset', 'migration.reset.cancelled');
      else this.transition('failed', 'migration.reset.cancelled');
      return { outcome: 'cancelled', snapshot: this.snapshot() };
    }

    const messageKey =
      error instanceof BackupVerificationError
        ? 'migration.reset.backup_verification_failed'
        : phase === 'backup'
          ? 'migration.reset.backup_failed'
          : phase === 'reset'
            ? 'migration.reset.target_failed'
            : 'migration.reset.legacy_read_failed';
    this.transition('failed', messageKey);
    return { outcome: 'failed', messageKey, snapshot: this.snapshot() };
  }

  private rejected(messageKey: string): LegacyResetActionOutcome {
    return { outcome: 'rejected', messageKey, snapshot: this.snapshot() };
  }

  private beginOperation(kind: ActiveOperationKind, status: LegacyResetStatus): ActiveOperation {
    const operation: ActiveOperation = {
      kind,
      controller: new AbortController(),
      cancellable: true,
    };
    this.activeOperation = operation;
    this.transition(status, null);
    return operation;
  }

  private finishOperation(operation: ActiveOperation): void {
    if (this.activeOperation === operation) this.activeOperation = null;
  }

  private ensureCurrent(operation: ActiveOperation): void {
    if (this.activeOperation !== operation || operation.controller.signal.aborted) {
      throw abortError();
    }
  }

  /** Native completion and the renderer marker form one truthful commit phase.
   * Once entered, cancellation can no longer revoke or relabel the result. */
  private beginNativeCommit(operation: ActiveOperation): void {
    this.ensureCurrent(operation);
    operation.cancellable = false;
    this.notify();
  }

  private clearStartPromise(promise: Promise<LegacyResetActionOutcome>): void {
    if (this.startPromise === promise) this.startPromise = null;
  }

  private transition(status: LegacyResetStatus, messageKey: string | null): void {
    this.status = status;
    this.messageKey = messageKey;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A presentation observer cannot influence the reset transaction.
      }
    }
  }
}

class BackupVerificationError extends Error {}

function buildBackupContent(
  snapshot: Legacy073Snapshot,
  settings: LegacyJsonObject,
  presets: LegacyJsonObject,
  createdAtMs: number,
): LegacyBackupContent {
  if (snapshot.applicationVersion !== LEGACY_SOURCE_VERSION) {
    throw new Error('unsupported legacy source version');
  }
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new Error('invalid backup timestamp');
  }
  const seen = new WeakSet<object>();
  return Object.freeze({
    format: 'bbcom-legacy-readonly-backup-v1',
    sourceVersion: LEGACY_SOURCE_VERSION,
    createdAtMs,
    snapshot: sanitizeObject(snapshot.payload, seen),
    settings: sanitizeObject(settings, seen),
    presets: sanitizeObject(presets, seen),
  });
}

/** Distinguish a clean install from a 0.7.3 profile before presenting a
 * destructive-migration gate. Wrapper objects containing only null/empty
 * values do not count; malformed text and every concrete setting/frame do. */
function hasLegacyContent(
  snapshot: Legacy073Snapshot,
  settings: LegacyJsonObject,
  presets: LegacyJsonObject,
): boolean {
  return (
    hasMeaningfulLegacyValue(snapshot.payload) ||
    hasMeaningfulLegacyValue(settings) ||
    hasMeaningfulLegacyValue(presets)
  );
}

function hasMeaningfulLegacyValue(value: LegacyJsonValue): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.some(hasMeaningfulLegacyValue);
  if (typeof value !== 'object') return true;
  return Object.values(value).some(hasMeaningfulLegacyValue);
}

function sanitizeObject(value: LegacyJsonObject, seen: WeakSet<object>): LegacyJsonObject {
  if (!isPlainObject(value)) throw new Error('legacy backup data must be a plain JSON object');
  if (seen.has(value)) throw new Error('legacy backup data must not be cyclic');
  seen.add(value);
  const result: Record<string, LegacyJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isUnsafeBackupKey(key)) continue;
    result[key] = sanitizeValue(child, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function sanitizeValue(value: LegacyJsonValue, seen: WeakSet<object>): LegacyJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('legacy backup number must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('legacy backup data must not be cyclic');
    seen.add(value);
    const result = value.map((child) => sanitizeValue(child, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  return sanitizeObject(value as LegacyJsonObject, seen);
}

function isPlainObject(value: unknown): value is LegacyJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnsafeBackupKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return (
    BACKUP_UNSAFE_KEYS.has(normalized) ||
    normalized.includes('apikey') ||
    normalized.includes('credential') ||
    normalized.includes('keyring') ||
    normalized.includes('password') ||
    normalized === 'portname' ||
    normalized === 'selectedport' ||
    normalized.includes('secret') ||
    normalized.includes('grant') ||
    normalized.endsWith('token') ||
    normalized.endsWith('path') ||
    normalized.endsWith('paths') ||
    normalized.endsWith('directory') ||
    normalized.endsWith('directories')
  );
}

function completed(snapshot: LegacyResetViewModel): LegacyResetActionOutcome {
  return { outcome: 'completed', snapshot };
}

function defaultChallenge(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `discard-${Date.now().toString(36)}-${random}`;
}

function abortError(): Error {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function journalCoordinates(journal: LegacyResetJournalSnapshot): {
  readonly workspaceId: string;
  readonly expectedRevision: number;
} {
  if (
    journal.phase === 'required' ||
    typeof journal.workspaceId !== 'string' ||
    journal.workspaceId.length === 0 ||
    !Number.isSafeInteger(journal.expectedRevision) ||
    journal.expectedRevision !== 0
  ) {
    throw new Error('invalid native reset journal');
  }
  return { workspaceId: journal.workspaceId, expectedRevision: journal.expectedRevision };
}

const unavailableNativeResetPort: LegacyResetNativePort = Object.freeze({
  getJournal: () => Promise.reject(new Error('native reset journal is unavailable')),
  beginDiscard: () => Promise.reject(new Error('native reset journal is unavailable')),
  prepare: () => Promise.reject(new Error('native reset journal is unavailable')),
  complete: () => Promise.reject(new Error('native reset journal is unavailable')),
});
