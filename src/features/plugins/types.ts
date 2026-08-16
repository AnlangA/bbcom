import type {
  InstalledPluginView as GeneratedInstalledPluginView,
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
  PluginSerialProposal as GeneratedPluginSerialProposal,
  PluginSourceHealth as GeneratedPluginSourceHealth,
  PluginSourceKind as GeneratedPluginSourceKind,
  PluginSourceView as GeneratedPluginSourceView,
  PluginStatusReason as GeneratedPluginStatusReason,
  PluginUnavailableCapability as GeneratedPluginUnavailableCapability,
} from '../../generated/ipc-contracts';

// Renderer domain names alias the generated Rust contract. This file adds
// only application-service ports and view state, never a second wire schema.
export type PluginPermission = GeneratedPluginPermission;
export type PluginLifecycleStatus = GeneratedPluginLifecycleStatus;
export type PluginStatusReason = GeneratedPluginStatusReason;
export type PluginUnavailableCapability = GeneratedPluginUnavailableCapability;
export type PluginFailureCode = GeneratedPluginFailureCode;
export type PluginPanelFieldKind = GeneratedPluginPanelFieldKind;
export type PluginSourceKind = GeneratedPluginSourceKind;
export type PluginSourceHealth = GeneratedPluginSourceHealth;

export type PluginCatalogItem = Readonly<GeneratedPluginCatalogItem>;
export type PluginSerialProposal = Readonly<GeneratedPluginSerialProposal>;
export type PluginPanelEvent = Readonly<GeneratedPluginPanelEvent>;
export type PluginFailure = Readonly<GeneratedPluginFailure>;
export type PluginSourceView = Readonly<GeneratedPluginSourceView>;
export type InstalledPluginView = Readonly<
  Omit<
    GeneratedInstalledPluginView,
    'declaredCapabilities' | 'effectiveCapabilities' | 'unavailableCapabilities'
  > & {
    declaredCapabilities: readonly PluginPermission[];
    effectiveCapabilities: readonly PluginPermission[];
    unavailableCapabilities: readonly PluginUnavailableCapability[];
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
    'catalog' | 'installed' | 'serialProposals' | 'panels' | 'sources'
  > & {
    catalog: readonly PluginCatalogItem[];
    installed: readonly InstalledPluginView[];
    serialProposals: readonly PluginSerialProposal[];
    panels: readonly PluginDeclarativePanel[];
    sources: readonly PluginSourceView[];
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

export type PluginPortOutcome =
  | { readonly outcome: 'completed'; readonly data: PluginCenterData }
  | { readonly outcome: 'cancelled'; readonly data?: PluginCenterData }
  | {
      readonly outcome: 'failed';
      readonly failure: PluginFailure;
      readonly data?: PluginCenterData;
    };

export interface PluginCenterPort {
  requestLocalSourceGrant(
    sourceKind: 'local-package' | 'dev-directory',
    signal: AbortSignal,
  ): Promise<string | null>;
  snapshot(signal: AbortSignal): Promise<PluginPortOutcome>;
  install(catalogId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  installLocal(grantId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  uninstall(pluginId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  setEnabled(pluginId: string, enabled: boolean, signal: AbortSignal): Promise<PluginPortOutcome>;
  addSource(
    sourceId: string,
    url: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  updateSource(
    sourceId: string,
    url: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  removeSource(sourceId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  refreshSource(sourceId: string, signal: AbortSignal): Promise<PluginPortOutcome>;
  setWatchEnabled(
    sourceId: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  resolveSerialProposal(
    proposal: PluginSerialProposal,
    decision: 'approve' | 'reject',
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  emitPanelEvent(event: PluginPanelEvent, signal: AbortSignal): Promise<PluginPortOutcome>;
  subscribe(listener: (data: PluginCenterData) => void): () => void;
}

export type PluginCenterActionKind =
  | 'refresh'
  | 'install'
  | 'update'
  | 'install-local'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'source-add'
  | 'source-update'
  | 'source-remove'
  | 'source-refresh'
  | 'source-watch'
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
