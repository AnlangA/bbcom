import type {
  WorkspaceSaveHealth,
  WorkspaceWaveformChannel,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import type { DataFrame } from '../../../types/serial';
import type { HydratedWorkspaceSession } from '../adapters';
import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionFailure,
  WorkspaceActionOutcome,
  WorkspaceMutationCommand,
  WorkspaceLayoutV1,
} from '../types';

export const WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS = 300;
export const WORKSPACE_FRAME_AUTOSAVE_DELAY_MS = 250;
export const WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES = 256;
export const WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES = 512 * 1024;

export const WORKSPACE_STOPPED_ACTIVITY_POLICY = Object.freeze({
  connections: 'disconnected',
  automation: 'stopped',
  ai: 'stopped',
  plugins: 'stopped',
} as const);

export type WorkspaceStoppedActivityPolicy = typeof WORKSPACE_STOPPED_ACTIVITY_POLICY;

/**
 * Safe domain snapshot handed to the compatibility facade after every page and
 * every session adapter has succeeded. It deliberately contains no path,
 * capability grant, runtime handle, token, or authorization state.
 */
export interface WorkspaceFacadeSnapshot {
  readonly workspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly activeSessionId: string | null;
  readonly sessions: readonly HydratedWorkspaceSession[];
  readonly layout: WorkspaceLayoutV1;
  readonly activityPolicy: WorkspaceStoppedActivityPolicy;
}

/**
 * The implementation must synchronously replace the entire session document,
 * or throw without changing it. Async partial replacement is intentionally not
 * representable because a later activation must never be overwritten.
 */
export interface WorkspaceSessionFacade {
  replaceWorkspace(snapshot: WorkspaceFacadeSnapshot): void;
  clearWorkspace(): void;
}

export type WorkspaceApplicationStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface WorkspaceApplicationViewModel {
  readonly status: WorkspaceApplicationStatus;
  readonly currentWorkspace: ActiveWorkspaceViewModel | null;
  readonly saveHealth: WorkspaceSaveHealth;
  readonly acceptsSaves: boolean;
  /** Runtime-originated final events may be accepted only inside the scoped
   * quiesce drain, even while user mutations are closed. */
  readonly acceptsPersistenceEvents: boolean;
  /** No renderer writes are allowed (revision conflict or recovery lockout). */
  readonly readOnly: boolean;
  /** True when activation rollback failed; renderer state is display-only. */
  readonly recoveryRequired: boolean;
  readonly hydrating: boolean;
  /** True from the first export click through save barrier and native copy. */
  readonly exporting: boolean;
  readonly messageKey: string | null;
  readonly unsavedMutationCount: number;
}

export type WorkspaceApplicationListener = (snapshot: WorkspaceApplicationViewModel) => void;

/**
 * Short-lived persistence capability available only while the old workspace
 * runtime is being quiesced. User-facing queue methods remain closed for the
 * whole transition; this capability lets already-observed runtime events
 * enqueue their final durable state before the save gate is drained.
 *
 * Every method rejects after `quiesce` settles. Implementations must not retain
 * this object or use it for new user work.
 */
export interface WorkspaceRuntimePersistenceDrain {
  readonly workspaceId: string;
  /** True only during the awaited `quiesce` callback. */
  readonly accepting: boolean;
  queueConfigMutation(command: Readonly<WorkspaceConfigMutationCommand>): WorkspaceQueueOutcome;
  queueConfigMutations(
    commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
  ): WorkspaceQueueOutcome;
  queueOrderedMutations(
    commands: readonly Readonly<WorkspaceConfigMutationCommand>[],
  ): WorkspaceQueueOutcome;
  queueCapturedFrame(capture: WorkspaceFrameCapture): WorkspaceQueueOutcome;
  queueCaptureTrim(
    sessionId: string,
    droppedFrames: number,
    droppedBytes: number,
  ): WorkspaceQueueOutcome;
  queueWaveformReplacement(
    sessionId: string,
    channels: readonly WorkspaceWaveformChannel[],
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome;
  queueWaveformSamples(
    sessionId: string,
    samples: readonly WorkspaceWaveformSample[],
  ): WorkspaceQueueOutcome;
  /** Persist one text-frame ingest as exactly one native SQLite batch. */
  queueWaveformFrameIngest(ingest: Readonly<WorkspaceWaveformFrameIngest>): WorkspaceQueueOutcome;
}

/**
 * Complete durable projection of one text-frame ingest. `replace` is used
 * after a trim-anchor reset or when parsing discovers new channels. The
 * feature state contains the matching frame cursor and must commit in the same
 * native transaction as the samples.
 */
export interface WorkspaceWaveformFrameIngest {
  readonly sessionId: string;
  readonly mode: 'append' | 'replace';
  readonly channels: readonly WorkspaceWaveformChannel[];
  readonly samples: readonly WorkspaceWaveformSample[];
  readonly featureState: Readonly<Record<string, unknown>>;
}

export interface WorkspaceRuntimeQuiesceContext {
  readonly transitionId: string;
  readonly previousWorkspaceId: string;
  readonly persistence: WorkspaceRuntimePersistenceDrain;
}

export interface WorkspaceRuntimeDisposeContext {
  readonly transitionId: string;
  readonly previousWorkspaceId: string;
  readonly nextWorkspaceId: string | null;
}

export interface WorkspaceRuntimeRestoreContext {
  readonly transitionId: string;
  readonly previousWorkspaceId: string | null;
  readonly failedWorkspaceId: string | null;
}

export interface WorkspaceStoppedRuntimeActivationContext {
  readonly transitionId: string;
  readonly workspace: WorkspaceFacadeSnapshot;
}

export interface WorkspaceRuntimeCommitContext {
  readonly transitionId: string;
  readonly workspaceId: string;
}

/**
 * Injected application-runtime transaction used by workspace replacement.
 *
 * `quiesce` must stop external producers but must not dispose resident
 * runtimes; its final events may use the supplied persistence drain. `dispose`
 * then permanently removes every old resident runtime before the facade swap,
 * including runtimes whose session id also exists in the next workspace.
 * `activateStopped` may stage/reconcile the next workspace but must not connect,
 * send, run automation, request AI, or start plugins. `restore` discards any
 * staged next-workspace state and recreates exactly the prior resident runtime
 * set after native rollback. All methods must be idempotent per transition id.
 */
export interface WorkspaceRuntimeLifecycle {
  quiesce(context: WorkspaceRuntimeQuiesceContext): Promise<void>;
  dispose(context: WorkspaceRuntimeDisposeContext): Promise<void>;
  restore(context: WorkspaceRuntimeRestoreContext): Promise<void>;
  activateStopped(context: WorkspaceStoppedRuntimeActivationContext): Promise<void>;
  /** Release rollback-only snapshots after the facade and application state
   * have both committed. This cleanup callback must not throw. */
  commit?(context: WorkspaceRuntimeCommitContext): void;
}

export interface WorkspaceApplicationOptions {
  readonly requestId?: () => string;
  readonly runtimeLifecycle?: WorkspaceRuntimeLifecycle;
  readonly onPersistenceFailure?: (failure: WorkspaceLatchedSaveFailure) => void | Promise<void>;
}

export type WorkspaceApplicationOutcome = WorkspaceActionOutcome<WorkspaceApplicationViewModel>;

export type WorkspaceProjectExportOutcome = WorkspaceActionOutcome<{
  readonly operationId: string;
  readonly displayName: string;
}>;

export type WorkspaceConfigMutationCommand = Exclude<
  WorkspaceMutationCommand,
  {
    readonly kind: 'append-frames' | 'append-waveform-samples';
  }
>;

export interface WorkspaceFrameCapture {
  readonly sessionId: string;
  readonly frame: DataFrame;
}

export type WorkspaceQueueOutcome =
  { readonly accepted: true } | { readonly accepted: false; readonly messageKey: string };

export interface WorkspaceApplicationActivation {
  openWorkspace(workspaceId: string): Promise<WorkspaceApplicationOutcome>;
  deleteWorkspace(workspaceId: string): Promise<WorkspaceApplicationOutcome>;
  /** Cancel the currently reversible native activation/hydration attempt. */
  cancelActivation(): boolean;
  /** Restore the native last-active project, then an existing reset fallback
   * or catalog project. An empty catalog completes in the idle state. */
  restoreLastActiveWorkspace?(
    fallbackWorkspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceApplicationOutcome>;
  createWorkspace(name: string): Promise<WorkspaceApplicationOutcome>;
  importWorkspace(): Promise<WorkspaceApplicationOutcome>;
  exportWorkspace(suggestedName: string): Promise<WorkspaceProjectExportOutcome>;
  /** Request cancellation and resolve only after the real export terminal state is known. */
  cancelExport(): Promise<WorkspaceProjectExportOutcome | null>;
}

export type WorkspaceSaveOutcome = WorkspaceActionOutcome<ActiveWorkspaceViewModel>;

export type WorkspaceLatchedSaveFailure = WorkspaceActionFailure;
