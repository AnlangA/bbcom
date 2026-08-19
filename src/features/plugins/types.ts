import type {
  InstalledPluginView as GeneratedInstalledPluginView,
  PluginCatalogItem as GeneratedPluginCatalogItem,
  PluginCenterData as GeneratedPluginCenterData,
  PluginFailure as GeneratedPluginFailure,
  PluginFailureCode as GeneratedPluginFailureCode,
  PluginLifecycleStatus as GeneratedPluginLifecycleStatus,
  PluginSourceHealth as GeneratedPluginSourceHealth,
  PluginSourceKind as GeneratedPluginSourceKind,
  PluginSourceView as GeneratedPluginSourceView,
  PluginStatusReason as GeneratedPluginStatusReason,
  PluginAuthorizationRequestV2 as GeneratedPluginAuthorizationRequestV2,
  PluginCapabilityV2 as GeneratedPluginCapabilityV2,
  PluginCommandContributionV2 as GeneratedPluginCommandContributionV2,
  PluginContributionDisposition as GeneratedPluginContributionDisposition,
  PluginSurfaceEventV2 as GeneratedPluginSurfaceEventV2,
  PluginSurfacePatch as GeneratedPluginSurfacePatch,
  PluginSurfaceSnapshot as GeneratedPluginSurfaceSnapshot,
  PluginTaskViewV2 as GeneratedPluginTaskViewV2,
  PluginUiNode as GeneratedPluginUiNode,
} from '../../generated/ipc-contracts';

// Renderer domain names alias the generated Rust contract. This file adds
// only application-service ports and view state, never a second wire schema.
export type PluginLifecycleStatus = GeneratedPluginLifecycleStatus;
export type PluginStatusReason = GeneratedPluginStatusReason;
export type PluginFailureCode = GeneratedPluginFailureCode;
export type PluginSourceKind = GeneratedPluginSourceKind;
export type PluginSourceHealth = GeneratedPluginSourceHealth;
export type PluginCapabilityV2 = GeneratedPluginCapabilityV2;
export type PluginUiNode = GeneratedPluginUiNode;
export type PluginSurfaceSnapshot = Readonly<GeneratedPluginSurfaceSnapshot>;
export type PluginSurfacePatch = Readonly<GeneratedPluginSurfacePatch>;
export type PluginSurfaceEventV2 = Readonly<GeneratedPluginSurfaceEventV2>;
export type PluginTaskViewV2 = Readonly<GeneratedPluginTaskViewV2>;
export type PluginAuthorizationRequestV2 = Readonly<GeneratedPluginAuthorizationRequestV2>;
export type PluginCommandContributionV2 = Readonly<GeneratedPluginCommandContributionV2>;
export type PluginContributionDisposition = GeneratedPluginContributionDisposition;

export type PluginCatalogItem = Readonly<GeneratedPluginCatalogItem>;
export type PluginFailure = Readonly<GeneratedPluginFailure>;
export type PluginSourceView = Readonly<GeneratedPluginSourceView>;
export type InstalledPluginView = Readonly<
  Omit<GeneratedInstalledPluginView, 'requestedCapabilities' | 'effectiveCapabilities'> & {
    requestedCapabilities: readonly PluginCapabilityV2[];
    effectiveCapabilities: readonly PluginCapabilityV2[];
  }
>;
export type PluginCenterData = Readonly<
  Omit<
    GeneratedPluginCenterData,
    | 'catalog'
    | 'installed'
    | 'sources'
    | 'surfaces'
    | 'tasks'
    | 'authorizationRequests'
    | 'commandContributions'
  > & {
    catalog: readonly PluginCatalogItem[];
    installed: readonly InstalledPluginView[];
    sources: readonly PluginSourceView[];
    surfaces?: readonly PluginSurfaceSnapshot[];
    tasks?: readonly PluginTaskViewV2[];
    authorizationRequests?: readonly PluginAuthorizationRequestV2[];
    commandContributions?: readonly PluginCommandContributionV2[];
  }
>;

export const PLUGIN_CAPABILITIES_V2 = [
  'ui.workspace',
  'ui.detached-window',
  'serial.ports.read',
  'serial.sessions.manage',
  'serial.io',
  'serial.control-lines',
  'session.capture.read',
  'session.commands.read-write',
  'file.open-read',
  'file.save-write',
  'plugin.storage',
  'project.state.read-write',
] as const satisfies readonly PluginCapabilityV2[];

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
  uninstall(
    pluginId: string,
    signal: AbortSignal,
    contributionDisposition?: PluginContributionDisposition,
  ): Promise<PluginPortOutcome>;
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
  emitSurfaceEvent?(event: PluginSurfaceEventV2, signal: AbortSignal): Promise<PluginPortOutcome>;
  resolveAuthorization?(
    request: PluginAuthorizationRequestV2,
    decision: 'approve' | 'reject',
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  cancelTask?(task: PluginTaskViewV2, signal: AbortSignal): Promise<PluginPortOutcome>;
  runCommand?(
    command: PluginCommandContributionV2,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
  setSurfacePlacement?(
    surface: PluginSurfaceSnapshot,
    placement: 'workspace' | 'detached-window',
    signal: AbortSignal,
  ): Promise<PluginPortOutcome>;
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
  | 'surface-event'
  | 'authorization'
  | 'task-cancel'
  | 'command-run'
  | 'surface-placement';

export interface PluginCenterAction {
  readonly kind: PluginCenterActionKind;
  readonly status: 'running' | 'cancelling';
}

/** Bootstrap composition status emitted by Rust (`plugin-runtime-status`). */
export type PluginRuntimeStatus = Readonly<{
  available: boolean;
  code: string | null;
}>;

export type PluginCenterSnapshot = PluginCenterData &
  Readonly<{
    started: boolean;
    action: PluginCenterAction | null;
    failure: PluginFailure | null;
    runtimeStatus: PluginRuntimeStatus | null;
  }>;

export type PluginCenterListener = (snapshot: PluginCenterSnapshot) => void;
