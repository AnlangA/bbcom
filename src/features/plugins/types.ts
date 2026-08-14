import type {
  InstalledPluginView as GeneratedInstalledPluginView,
  PluginAuthorizationReview as GeneratedPluginAuthorizationReview,
  PluginCatalogItem as GeneratedPluginCatalogItem,
  PluginCenterData as GeneratedPluginCenterData,
  PluginDeclarativePanel as GeneratedPluginDeclarativePanel,
  PluginFailure as GeneratedPluginFailure,
  PluginFailureCode as GeneratedPluginFailureCode,
  PluginLifecycleStatus as GeneratedPluginLifecycleStatus,
  PluginPanelEvent as GeneratedPluginPanelEvent,
  PluginPanelField as GeneratedPluginPanelField,
  PluginPanelFieldKind as GeneratedPluginPanelFieldKind,
  PluginPermission as GeneratedPluginPermission,
  PluginPermissionDecision as GeneratedPluginPermissionDecision,
  PluginPermissionDecisionState as GeneratedPluginPermissionDecisionState,
  PluginRiskCombination as GeneratedPluginRiskCombination,
  PluginSerialProposal as GeneratedPluginSerialProposal,
  PluginStatusReason as GeneratedPluginStatusReason,
  PluginUnavailableCapability as GeneratedPluginUnavailableCapability,
  SubmitPluginAuthorizationRequest as GeneratedSubmitPluginAuthorizationRequest,
} from '../../generated/ipc-contracts';

// Renderer domain names alias the generated Rust contract. This file adds
// only application-service ports and view state, never a second wire schema.
export type PluginPermission = GeneratedPluginPermission;
export type PluginLifecycleStatus = GeneratedPluginLifecycleStatus;
export type PluginStatusReason = GeneratedPluginStatusReason;
export type PluginRiskCombination = GeneratedPluginRiskCombination;
export type PluginUnavailableCapability = GeneratedPluginUnavailableCapability;
export type PluginFailureCode = GeneratedPluginFailureCode;
export type PluginPanelFieldKind = GeneratedPluginPanelFieldKind;
export type PluginPermissionDecisionState = GeneratedPluginPermissionDecisionState;

export type PluginCatalogItem = Readonly<GeneratedPluginCatalogItem>;
export type PluginSerialProposal = Readonly<GeneratedPluginSerialProposal>;
export type PluginPanelEvent = Readonly<GeneratedPluginPanelEvent>;
export type PluginFailure = Readonly<GeneratedPluginFailure>;
export type PluginPermissionDecision = Readonly<GeneratedPluginPermissionDecision>;
export type InstalledPluginView = Readonly<
  Omit<GeneratedInstalledPluginView, 'requestedPermissions'> & {
    requestedPermissions: readonly PluginPermission[];
  }
>;
export type PluginAuthorizationReview = Readonly<
  Omit<
    GeneratedPluginAuthorizationReview,
    | 'persistentPermissions'
    | 'perRequestPermissions'
    | 'unavailableCapabilities'
    | 'extraConfirmationReasons'
  > & {
    persistentPermissions: readonly PluginPermission[];
    perRequestPermissions: readonly PluginPermission[];
    unavailableCapabilities: readonly PluginUnavailableCapability[];
    extraConfirmationReasons: readonly PluginRiskCombination[];
  }
>;
export type PluginPanelField = Readonly<
  Omit<GeneratedPluginPanelField, 'options'> & { options: readonly string[] }
>;
export type PluginDeclarativePanel = Readonly<
  Omit<GeneratedPluginDeclarativePanel, 'fields'> & { fields: readonly PluginPanelField[] }
>;
export type PluginCenterData = Readonly<
  Omit<
    GeneratedPluginCenterData,
    'catalog' | 'installed' | 'authorizationReview' | 'serialProposals' | 'panels'
  > & {
    catalog: readonly PluginCatalogItem[];
    installed: readonly InstalledPluginView[];
    authorizationReview: PluginAuthorizationReview | null;
    serialProposals: readonly PluginSerialProposal[];
    panels: readonly PluginDeclarativePanel[];
  }
>;

export const PLUGIN_PERMISSIONS = [
  'ui.panel',
  'plugin.storage',
  'session.metadata.read',
  'session.capture.read',
  'project.settings.read-write',
  'serial.ports.read',
  'serial.control',
  'serial.write-proposal',
  'ai.conversation.read',
  'ai.request',
  'file.open-save',
  'clipboard',
  'notification',
] as const satisfies readonly PluginPermission[];

export type SubmitPluginAuthorization = Omit<
  Readonly<GeneratedSubmitPluginAuthorizationRequest>,
  'requestId' | 'revision' | 'operationId' | 'decisions' | 'perRequestCapabilitiesAcknowledged'
> & {
  readonly decisions: readonly PluginPermissionDecision[];
  readonly perRequestCapabilitiesAcknowledged: readonly PluginPermission[];
};

export type PluginPortOutcome =
  | { readonly outcome: 'completed'; readonly data: PluginCenterData }
  | { readonly outcome: 'cancelled'; readonly data?: PluginCenterData }
  | {
      readonly outcome: 'failed';
      readonly failure: PluginFailure;
      readonly data?: PluginCenterData;
    };

export interface PluginCenterPort {
  snapshot(signal: AbortSignal): Promise<PluginPortOutcome>;
  install(catalogId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  setEnabled(pluginId: string, enabled: boolean, signal: AbortSignal): Promise<PluginPortOutcome>;
  submitAuthorization(
    input: SubmitPluginAuthorization,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  dismissAuthorization(reviewId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  resolveSerialProposal(
    proposalId: string,
    decision: 'approve' | 'reject',
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  emitPanelEvent(event: PluginPanelEvent, signal: AbortSignal): Promise<PluginPortOutcome>;
  subscribe(listener: (data: PluginCenterData) => void): () => void;
}

export type PluginCenterActionKind =
  | 'refresh'
  | 'install'
  | 'enable'
  | 'disable'
  | 'authorize'
  | 'dismiss-authorization'
  | 'serial-proposal'
  | 'panel-event';

export interface PluginCenterAction {
  readonly kind: PluginCenterActionKind;
  readonly status: 'running' | 'cancelling';
}

export type PluginCenterSnapshot = PluginCenterData &
  Readonly<{
    started: boolean;
    action: PluginCenterAction | null;
    failure: PluginFailure | null;
  }>;

export type PluginCenterListener = (snapshot: PluginCenterSnapshot) => void;
