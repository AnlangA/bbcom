export {
  WorkspaceActivationEngine,
  WorkspaceActivationCoordinator,
  type ActivationAttempt,
  type ActivationPhase,
  type RuntimeTransition,
  type ActivationCoordinatorDeps,
  type ActivationState,
  abortAndRecoverActivation,
  markRecoveryRequired,
  type ActivationRecoveryHost,
} from './activation-coordinator';
export {
  recoverActivationOwner,
  rollbackFailedActivation,
  staleOrCancelled,
} from './recovery-handler';
