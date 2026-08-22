export { WorkspaceApplicationService } from './workspace-application-service';
export { WorkspaceActivationEngine } from './activation';
export { WorkspaceSaveCoordinator } from './workspace-save-coordinator';
export {
  CaptureAccountingStore,
  type CaptureAccountingRegistration,
  type CaptureSessionTotals,
  type CaptureWorkspaceTotals,
} from '@/features/platform/application';
export {
  WorkspaceOperationRegistryLifecycle,
  workspaceOperationLifecycleFor,
} from './workspace-operation-lifecycle';
export {
  SessionRuntimeWorkspaceParticipant,
  WorkspaceTransitionCoordinator,
  type SessionRuntimeWorkspaceParticipantOptions,
  type SessionRuntimeStatusTransitionPort,
  type WorkspaceTransitionParticipant,
} from './workspace-transition-coordinator';
export {
  WORKSPACE_APPLICATION_KEY,
  useOptionalWorkspaceApplication,
  useWorkspaceApplication,
  type WorkspaceApplicationContext,
} from './workspace-application-context';
export {
  WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES,
  WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES,
  WORKSPACE_STOPPED_ACTIVITY_POLICY,
  type WorkspaceApplicationActivation,
  type WorkspaceApplicationListener,
  type WorkspaceApplicationOptions,
  type WorkspaceApplicationOutcome,
  type WorkspaceProjectExportOutcome,
  type WorkspaceApplicationStatus,
  type WorkspaceApplicationViewModel,
  type WorkspaceConfigMutationCommand,
  type WorkspaceFacadeSnapshot,
  type WorkspaceFrameCapture,
  type WorkspaceQueueOutcome,
  type WorkspaceRuntimeDisposeContext,
  type WorkspaceRuntimeCommitContext,
  type WorkspaceRuntimeLifecycle,
  type WorkspaceRuntimePersistenceDrain,
  type WorkspaceRuntimeQuiesceContext,
  type WorkspaceRuntimeRestoreContext,
  type WorkspaceSessionFacade,
  type WorkspaceStoppedRuntimeActivationContext,
  type WorkspaceStoppedActivityPolicy,
  type WorkspaceWaveformFrameIngest,
} from './types';
