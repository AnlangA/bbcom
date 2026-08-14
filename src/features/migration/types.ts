export const LEGACY_RESET_MARKER_KEY = 'bbcom-v1:legacy-reset-complete' as const;
export const LEGACY_RESET_MARKER_VALUE = '1' as const;
export const LEGACY_SOURCE_VERSION = '0.7.3' as const;

export type LegacyResetStatus =
  | 'checking'
  | 'backup-required'
  | 'backing-up'
  | 'verifying'
  | 'ready-to-reset'
  | 'resetting'
  | 'completed'
  | 'failed';

export type LegacyJsonPrimitive = string | number | boolean | null;
export type LegacyJsonValue = LegacyJsonPrimitive | readonly LegacyJsonValue[] | LegacyJsonObject;
export interface LegacyJsonObject {
  readonly [key: string]: LegacyJsonValue;
}

/**
 * The application adapter wraps the legacy session persistence representation
 * in this versioned value. Runtime handles and native-only data must not be
 * added to this interface.
 */
export interface Legacy073Snapshot {
  readonly applicationVersion: typeof LEGACY_SOURCE_VERSION;
  readonly payload: LegacyJsonObject;
}

export interface LegacyReadContext {
  readonly signal: AbortSignal;
}

/** Read-only access to 0.7.3 state. Deliberately has no write/delete methods. */
export interface LegacyReadOnlySource {
  readSnapshot(context: LegacyReadContext): Promise<Legacy073Snapshot>;
  readSettings(context: LegacyReadContext): Promise<LegacyJsonObject>;
  readPresets(context: LegacyReadContext): Promise<LegacyJsonObject>;
}

/**
 * Immutable, portable backup body. Unsafe native fields are removed by the
 * coordinator even if a legacy adapter accidentally returns them.
 */
export interface LegacyBackupContent {
  readonly format: 'bbcom-legacy-readonly-backup-v1';
  readonly sourceVersion: typeof LEGACY_SOURCE_VERSION;
  readonly createdAtMs: number;
  readonly snapshot: LegacyJsonObject;
  readonly settings: LegacyJsonObject;
  readonly presets: LegacyJsonObject;
}

/** Opaque identity only; it must never contain or expose a native path. */
export interface LegacyBackupReceipt {
  readonly backupId: string;
}

export interface LegacyBackupVerification {
  readonly verified: boolean;
}

export type LegacyResetJournalPhase = 'required' | 'intent' | 'workspaceReady' | 'completed';

export interface LegacyResetJournalSnapshot {
  readonly phase: LegacyResetJournalPhase;
  readonly workspaceId?: string;
  readonly expectedRevision?: number;
}

export type LegacyResetAuthorization =
  | {
      readonly verifiedBackupId: string;
      readonly discardToken?: never;
      readonly emptyLegacyState?: never;
    }
  | {
      readonly verifiedBackupId?: never;
      readonly discardToken: string;
      readonly emptyLegacyState?: never;
    }
  | {
      readonly verifiedBackupId?: never;
      readonly discardToken?: never;
      readonly emptyLegacyState: true;
    }
  | {
      readonly verifiedBackupId?: never;
      readonly discardToken?: never;
      readonly emptyLegacyState?: never;
    };

/** Native-only authority and crash-recovery boundary. */
export interface LegacyResetNativePort {
  getJournal(context: LegacyReadContext): Promise<LegacyResetJournalSnapshot>;
  beginDiscard(context: LegacyReadContext): Promise<string>;
  prepare(
    authorization: LegacyResetAuthorization,
    context: LegacyReadContext,
  ): Promise<LegacyResetJournalSnapshot>;
  complete(
    workspaceId: string,
    expectedRevision: number,
    context: LegacyReadContext,
  ): Promise<LegacyResetJournalSnapshot>;
}

export interface LegacyBackupPort {
  /** Native implementation owns passphrase prompting and file selection. */
  beginEncryptedBackup(
    content: LegacyBackupContent,
    context: LegacyReadContext,
  ): Promise<LegacyBackupReceipt>;

  /**
   * Must reopen the encrypted artifact and compare its decoded body with
   * expectedContent. Verifying an in-memory write buffer is not sufficient.
   */
  verifyEncryptedBackup(
    receipt: LegacyBackupReceipt,
    expectedContent: LegacyBackupContent,
    context: LegacyReadContext,
  ): Promise<LegacyBackupVerification>;
}

export interface WorkspaceResetTarget {
  /** Opens the native journal's fixed empty schema-v1 workspace. */
  activateEmptyV1(
    workspaceId: string,
    expectedRevision: number,
    context: LegacyReadContext,
  ): Promise<void>;
  /** Reopens a previously completed reset workspace. It may now contain the
   * user's post-reset data, so only identity and successful hydration apply. */
  activateCompletedV1(workspaceId: string, context: LegacyReadContext): Promise<void>;
}

export interface LegacyResetMarkerStore {
  isSet(key: typeof LEGACY_RESET_MARKER_KEY): Promise<boolean> | boolean;
  write(
    key: typeof LEGACY_RESET_MARKER_KEY,
    value: typeof LEGACY_RESET_MARKER_VALUE,
  ): Promise<void> | void;
  remove(key: typeof LEGACY_RESET_MARKER_KEY): Promise<void> | void;
}

export interface LegacyResetViewModel {
  readonly status: LegacyResetStatus;
  readonly messageKey: string | null;
  readonly canCancel: boolean;
  readonly discardChallengePending: boolean;
  readonly resetAuthorizedBy: 'verified-backup' | 'confirmed-discard' | null;
}

export type LegacyResetListener = (snapshot: LegacyResetViewModel) => void;

export type LegacyResetActionOutcome =
  | { readonly outcome: 'completed'; readonly snapshot: LegacyResetViewModel }
  | { readonly outcome: 'cancelled'; readonly snapshot: LegacyResetViewModel }
  | {
      readonly outcome: 'rejected';
      readonly messageKey: string;
      readonly snapshot: LegacyResetViewModel;
    }
  | {
      readonly outcome: 'failed';
      readonly messageKey: string;
      readonly snapshot: LegacyResetViewModel;
    };

export type LegacyDiscardRequestOutcome =
  | { readonly outcome: 'challenge'; readonly challenge: string }
  | {
      readonly outcome: 'rejected';
      readonly messageKey: string;
      readonly snapshot: LegacyResetViewModel;
    };

export interface LegacyWorkspaceResetOptions {
  readonly now?: () => number;
  readonly challengeFactory?: () => string;
  readonly nativePort?: LegacyResetNativePort;
}
