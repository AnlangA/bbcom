import { safeDisplayText } from './display-text-validation';
import {
  createPluginSurfaceEvent,
  freezeSurface,
  validatePluginSurface,
} from './domain/plugin-surface-v2';
import {
  normalizePluginAuthorizationRequests,
  normalizePluginCommandContributions,
  normalizePluginTasks,
} from './domain/plugin-runtime-v2';
import { PluginSurfaceRegistry } from './application/plugin-surface-registry';
import type { PluginSurfaceUpdateV2, RuntimeInstanceKey } from '../../generated/ipc-contracts';
import { logger } from '../../lib/logger';
import { listenNativeEvent } from '../native';
import {
  PLUGIN_CAPABILITIES_V2,
  type InstalledPluginView,
  type PluginCatalogItem,
  type PluginAuthorizationRequestV2,
  type PluginCenterActionKind,
  type PluginCenterData,
  type PluginCenterListener,
  type PluginCenterPort,
  type PluginCenterSnapshot,
  type PluginCommandContributionV2,
  type PluginFailure,
  type PluginPortOutcome,
  type PluginRuntimeStatus,
  type PluginSourceView,
  type PluginSurfaceEventV2,
  type PluginSurfaceSnapshot,
  type PluginTaskViewV2,
} from './types';

const CAPABILITIES_V2 = new Set<string>(PLUGIN_CAPABILITIES_V2);
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;

const EMPTY_DATA: PluginCenterData = Object.freeze({
  revision: 0,
  catalog: Object.freeze([]),
  installed: Object.freeze([]),
  sources: Object.freeze([]),
  surfaces: Object.freeze([]),
  tasks: Object.freeze([]),
  authorizationRequests: Object.freeze([]),
  commandContributions: Object.freeze([]),
});

interface NormalizedData {
  readonly data: PluginCenterData;
  readonly surfaceRejected: boolean;
}

/**
 * Application-owned renderer service. Its port speaks trusted domain values,
 * never raw IPC payloads. UI unmount only detaches listeners; it does not abort
 * native plugin work or tear down the application-level subscription.
 */
export class PluginCenterService {
  private readonly listeners = new Set<PluginCenterListener>();
  private readonly surfaceRegistry = new PluginSurfaceRegistry();
  private data = EMPTY_DATA;
  private started = false;
  private action: PluginCenterSnapshot['action'] = null;
  private failure: PluginFailure | null = null;
  private runtimeStatus: PluginCenterSnapshot['runtimeStatus'] = null;
  private actionAbort: AbortController | null = null;
  private detachPort: (() => void) | null = null;
  private detachRuntimeStatus: (() => void) | null = null;
  private detachSnapshotChanged: (() => void) | null = null;
  private detachSurfaceUpdates: (() => void) | null = null;

  constructor(private readonly port: PluginCenterPort) {}

  snapshot(): PluginCenterSnapshot {
    return Object.freeze({
      ...this.data,
      started: this.started,
      action: this.action ? Object.freeze({ ...this.action }) : null,
      failure: this.failure ? Object.freeze({ ...this.failure }) : null,
      runtimeStatus: this.runtimeStatus,
    });
  }

  subscribe(listener: PluginCenterListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // A renderer observer cannot affect plugin lifecycle state.
    }
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.detachPort = this.port.subscribe((data) => this.acceptPush(data));
    // Bootstrap composition outcomes (setup + every workspace-switch retry)
    // arrive as a native broadcast; a browser-only shell stays null.
    void listenNativeEvent<PluginRuntimeStatus>('plugin-runtime-status', (event) => {
      const status = event.payload;
      if (
        typeof status?.available === 'boolean' &&
        (status.code === null || typeof status.code === 'string')
      ) {
        this.runtimeStatus = Object.freeze({ ...status });
        this.notify();
      }
    })
      .then((unlisten) => {
        this.detachRuntimeStatus = unlisten;
      })
      .catch(() => {
        // Browser-only shells provide no native event API.
      });
    // Host-side lifecycle changes can arrive between renderer commands; nudge
    // a refresh so the task and authorization views stay current.
    void listenNativeEvent('plugin-snapshot-changed', () => {
      if (!this.action) void this.refresh();
    })
      .then((unlisten) => {
        this.detachSnapshotChanged = unlisten;
      })
      .catch(() => {
        // Browser-only shells provide no native event API.
      });
    void listenNativeEvent<PluginSurfaceUpdateV2>('plugin-surface-update-v2', (event) => {
      const result = this.surfaceRegistry.apply(event.payload);
      if (!result.ok) {
        this.failure = Object.freeze({ code: 'invalid-surface' });
      } else if (result.changed) {
        this.data = Object.freeze({
          ...this.data,
          surfaces: this.surfaceRegistry.snapshot(),
        });
      }
      this.notify();
    })
      .then((unlisten) => {
        this.detachSurfaceUpdates = unlisten;
      })
      .catch(() => {
        // Browser-only shells provide no native event API.
      });
    this.notify();
    return this.refreshAndRecoverExpectedPlugins();
  }

  refresh(): Promise<void> {
    return this.run('refresh', (signal) => this.port.snapshot(signal));
  }

  install(catalogId: string): Promise<void> {
    const item = this.data.catalog.find((candidate) => candidate.catalogId === catalogId);
    if (
      !item ||
      (item.installedVersion !== null && compareSemver(item.version, item.installedVersion) <= 0)
    ) {
      return this.rejectInvalidResponse();
    }
    return this.run(item.installedVersion === null ? 'install' : 'update', (signal) =>
      this.port.install(catalogId, signal),
    );
  }

  installLocal(sourceKind: 'local-package' | 'dev-directory' = 'local-package'): Promise<void> {
    if (sourceKind !== 'local-package' && sourceKind !== 'dev-directory') {
      return this.rejectInvalidResponse();
    }
    return this.run('install-local', async (signal) => {
      const grantId = await this.port.requestLocalSourceGrant(sourceKind, signal);
      if (!grantId) return failedPortOutcome('unavailable');
      return this.port.installLocal(grantId, signal);
    });
  }

  uninstall(
    pluginId: string,
    contributionDisposition: import('./types').PluginContributionDisposition = 'delete',
  ): Promise<void> {
    const installed = this.data.installed.some((candidate) => candidate.pluginId === pluginId);
    if (!installed) return this.rejectInvalidResponse();
    return this.run('uninstall', (signal) =>
      contributionDisposition === 'delete'
        ? this.port.uninstall(pluginId, signal)
        : this.port.uninstall(pluginId, signal, contributionDisposition),
    );
  }

  setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const plugin = this.data.installed.find((candidate) => candidate.pluginId === pluginId);
    if (!plugin || plugin.enabled === enabled) return this.rejectInvalidResponse();
    return this.run(enabled ? 'enable' : 'disable', (signal) =>
      this.port.setEnabled(pluginId, enabled, signal),
    );
  }

  addSource(sourceId: string, url: string, enabled = true): Promise<void> {
    if (!validSourceId(sourceId) || !validHttpsSourceUrl(url)) return this.rejectInvalidResponse();
    if (this.data.sources.some((source) => source.sourceId === sourceId)) {
      return this.rejectInvalidResponse();
    }
    return this.run('source-add', (signal) => this.port.addSource(sourceId, url, enabled, signal));
  }

  updateSource(sourceId: string, url: string, enabled: boolean): Promise<void> {
    const source = this.data.sources.find((item) => item.sourceId === sourceId);
    if (!source || source.kind !== 'https' || !validHttpsSourceUrl(url)) {
      return this.rejectInvalidResponse();
    }
    return this.run('source-update', (signal) =>
      this.port.updateSource(sourceId, url, enabled, signal),
    );
  }

  removeSource(sourceId: string): Promise<void> {
    if (!this.data.sources.some((source) => source.sourceId === sourceId)) {
      return this.rejectInvalidResponse();
    }
    return this.run('source-remove', (signal) => this.port.removeSource(sourceId, signal));
  }

  refreshSource(sourceId: string): Promise<void> {
    const source = this.data.sources.find((item) => item.sourceId === sourceId);
    if (!source || source.kind !== 'https') return this.rejectInvalidResponse();
    return this.run('source-refresh', (signal) => this.port.refreshSource(sourceId, signal));
  }

  setWatchEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const source = this.data.sources.find((item) => item.sourceId === sourceId);
    if (!source || source.kind !== 'dev-directory' || source.watchEnabled === enabled) {
      return this.rejectInvalidResponse();
    }
    return this.run('source-watch', (signal) =>
      this.port.setWatchEnabled(sourceId, enabled, signal),
    );
  }

  emitSurfaceEvent(event: PluginSurfaceEventV2): Promise<void> {
    const surface = this.data.surfaces?.find(
      (candidate) =>
        runtimeEquals(candidate.runtime, event.runtime) &&
        candidate.surfaceId === event.surfaceId &&
        candidate.revision === event.revision,
    );
    const validated = surface
      ? createPluginSurfaceEvent(surface, event.nodeId, event.event, event.value)
      : null;
    if (!validated || !surfaceEventEquals(validated, event)) return this.rejectInvalidResponse();
    return this.run(
      'surface-event',
      (signal) =>
        this.port.emitSurfaceEvent?.(validated, signal) ??
        Promise.resolve(failedPortOutcome('unavailable')),
    );
  }

  resolveAuthorization(
    request: PluginAuthorizationRequestV2,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    const pending = this.data.authorizationRequests?.find(
      (candidate) =>
        candidate.pluginId === request.pluginId &&
        candidate.version === request.version &&
        candidate.digestSha256 === request.digestSha256,
    );
    if (!pending || (decision !== 'approve' && decision !== 'reject')) {
      return this.rejectInvalidResponse();
    }
    return this.run(
      'authorization',
      (signal) =>
        this.port.resolveAuthorization?.(pending, decision, signal) ??
        Promise.resolve(failedPortOutcome('unavailable')),
    );
  }

  cancelTask(task: PluginTaskViewV2): Promise<void> {
    const current = this.data.tasks?.find(
      (candidate) =>
        runtimeEquals(candidate.runtime, task.runtime) && candidate.taskId === task.taskId,
    );
    if (!current?.cancellable || !['running', 'cancelling'].includes(current.status)) {
      return this.rejectInvalidResponse();
    }
    return this.run(
      'task-cancel',
      (signal) =>
        this.port.cancelTask?.(current, signal) ??
        Promise.resolve(failedPortOutcome('unavailable')),
    );
  }

  runCommand(command: PluginCommandContributionV2): Promise<void> {
    const current = this.data.commandContributions?.find(
      (candidate) =>
        runtimeEquals(candidate.runtime, command.runtime) &&
        candidate.commandId === command.commandId,
    );
    if (!current) return this.rejectInvalidResponse();
    return this.run(
      'command-run',
      (signal) =>
        this.port.runCommand?.(current, signal) ??
        Promise.resolve(failedPortOutcome('unavailable')),
    );
  }

  setSurfacePlacement(
    surface: PluginSurfaceSnapshot,
    placement: 'workspace' | 'detached-window',
  ): Promise<void> {
    const current = this.data.surfaces?.find(
      (candidate) =>
        runtimeEquals(candidate.runtime, surface.runtime) &&
        candidate.surfaceId === surface.surfaceId,
    );
    if (
      !current ||
      current.placement === placement ||
      (placement === 'detached-window' && !current.detachedAllowed)
    ) {
      return this.rejectInvalidResponse();
    }
    return this.run(
      'surface-placement',
      (signal) =>
        this.port.setSurfacePlacement?.(current, placement, signal) ??
        Promise.resolve(failedPortOutcome('unavailable')),
    );
  }

  cancelAction(): void {
    if (!this.actionAbort || !this.action || this.action.status === 'cancelling') return;
    this.action = Object.freeze({ ...this.action, status: 'cancelling' });
    this.actionAbort.abort();
    this.notify();
  }

  clearFailure(): void {
    if (!this.failure) return;
    this.failure = null;
    this.notify();
  }

  /** Explicit application shutdown hook; never call this from a panel unmount. */
  shutdown(): void {
    this.actionAbort?.abort();
    this.detachPort?.();
    this.detachPort = null;
    this.detachRuntimeStatus?.();
    this.detachRuntimeStatus = null;
    this.detachSnapshotChanged?.();
    this.detachSnapshotChanged = null;
    this.detachSurfaceUpdates?.();
    this.detachSurfaceUpdates = null;
    this.started = false;
    this.notify();
  }

  private async run(
    kind: PluginCenterActionKind,
    call: (signal: AbortSignal) => Promise<PluginPortOutcome>,
  ): Promise<void> {
    if (this.action) {
      this.failure = Object.freeze({ code: 'operation-conflict' });
      this.notify();
      return;
    }
    const abort = new AbortController();
    this.actionAbort = abort;
    this.action = Object.freeze({ kind, status: 'running' });
    this.failure = null;
    this.notify();
    try {
      const outcome = await call(abort.signal);
      this.acceptOutcome(outcome);
    } catch (error) {
      // Port exceptions are folded into the failure state; keep the cause in
      // the log so transport issues stay diagnosable.
      logger.warn('plugin-center action failed:', kind, error);
      this.failure = Object.freeze({
        code: abort.signal.aborted ? 'cancel-failed' : 'unavailable',
      });
    } finally {
      if (this.actionAbort === abort) {
        this.actionAbort = null;
        this.action = null;
      }
      this.notify();
    }
  }

  private async refreshAndRecoverExpectedPlugins(): Promise<void> {
    await this.refresh();
    // Native composition runs before the renderer session-query bridge is
    // listening. A plugin that reads session metadata during initialize can
    // therefore retain the user's enabled expectation while its first host
    // start fails. Once this application service starts, the bridge is ready;
    // retry each such plugin exactly once without changing that expectation.
    const recoverable = this.data.installed.filter(
      (plugin) => plugin.enabled && plugin.status === 'failed',
    );
    for (const plugin of recoverable) {
      await this.run('enable', (signal) => this.port.setEnabled(plugin.pluginId, true, signal));
    }
  }

  private acceptOutcome(outcome: PluginPortOutcome): void {
    if (outcome.data) this.acceptData(outcome.data);
    if (outcome.outcome === 'failed') this.failure = Object.freeze({ ...outcome.failure });
    if (outcome.outcome === 'cancelled') this.failure = null;
  }

  private acceptPush(data: PluginCenterData): void {
    this.acceptData(data);
    this.notify();
  }

  private acceptData(candidate: PluginCenterData): void {
    const normalized = normalizeData(candidate);
    if (!normalized || normalized.data.revision < this.data.revision) {
      this.failure = Object.freeze({ code: 'invalid-response' });
      return;
    }
    this.data = normalized.data;
    const surfaces = this.surfaceRegistry.replaceAll(normalized.data.surfaces ?? []);
    if (!surfaces.ok) {
      this.failure = Object.freeze({ code: 'invalid-surface' });
      return;
    }
    this.data = Object.freeze({ ...this.data, surfaces: this.surfaceRegistry.snapshot() });
    if (normalized.surfaceRejected) this.failure = Object.freeze({ code: 'invalid-surface' });
  }

  private rejectInvalidResponse(): Promise<void> {
    this.failure = Object.freeze({ code: 'invalid-response' });
    this.notify();
    return Promise.resolve();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers are isolated from the application service.
      }
    }
  }
}

function compareSemver(left: string, right: string): number {
  const leftCore = left.split(/[-+]/u, 1)[0]?.split('.').map(Number) ?? [];
  const rightCore = right.split(/[-+]/u, 1)[0]?.split('.').map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftCore[index] ?? 0) - (rightCore[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return left.localeCompare(right);
}

function failedPortOutcome(code: PluginFailure['code']): PluginPortOutcome {
  return { outcome: 'failed', failure: { code } };
}

function normalizeData(candidate: PluginCenterData): NormalizedData | null {
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) return null;
  const catalog = normalizeList(candidate.catalog, normalizeCatalogItem);
  const installed = normalizeList(candidate.installed, normalizeInstalledPlugin);
  const sources = normalizeList(candidate.sources, normalizeSource);
  if (!catalog || !installed || !sources) return null;
  const surfaces: PluginSurfaceSnapshot[] = [];
  let surfaceRejected = false;
  const surfaceIdentities = new Set<string>();
  for (const surface of candidate.surfaces ?? []) {
    const validated = validatePluginSurface(surface);
    const identity = `${surface.runtime.workspaceId}:${surface.runtime.pluginId}:${surface.runtime.instanceId}:${surface.runtime.generation}:${surface.surfaceId}`;
    if (!validated.ok || surfaceIdentities.has(identity)) {
      surfaceRejected = true;
      continue;
    }
    surfaceIdentities.add(identity);
    surfaces.push(freezeSurface(surface));
  }
  const tasks = normalizePluginTasks(candidate.tasks ?? []);
  const authorizationRequests = normalizePluginAuthorizationRequests(
    candidate.authorizationRequests ?? [],
  );
  const commandContributions = normalizePluginCommandContributions(
    candidate.commandContributions ?? [],
  );
  if (!tasks || !authorizationRequests || !commandContributions) return null;
  return {
    data: Object.freeze({
      revision: candidate.revision,
      catalog: Object.freeze(catalog),
      installed: Object.freeze(installed),
      sources: Object.freeze(sources),
      surfaces: Object.freeze(surfaces),
      tasks,
      authorizationRequests,
      commandContributions,
    }),
    surfaceRejected,
  };
}

function normalizeSource(source: PluginSourceView): PluginSourceView | null {
  if (
    !validSourceId(source.sourceId) ||
    !safeDisplayText(source.displayName, 128) ||
    !['https', 'local-package', 'dev-directory'].includes(source.kind) ||
    !['idle', 'healthy', 'error', 'disconnected'].includes(source.health) ||
    (source.kind === 'https'
      ? !source.url || !validHttpsSourceUrl(source.url)
      : source.url !== null) ||
    (source.kind !== 'dev-directory' && source.watchEnabled) ||
    !validOptionalTimestamp(source.lastAttemptMs) ||
    !validOptionalTimestamp(source.lastSuccessMs)
  ) {
    return null;
  }
  return Object.freeze({ ...source });
}

function normalizeCatalogItem(item: PluginCatalogItem): PluginCatalogItem | null {
  if (
    !validIdentity(item.catalogId) ||
    !validIdentity(item.pluginId) ||
    !safeDisplayText(item.displayName, 128) ||
    !safeDisplayText(item.description, 1024, true) ||
    !validVersion(item.version) ||
    !safeDisplayText(item.publisherName, 128) ||
    (item.installedVersion !== null && !validVersion(item.installedVersion))
  ) {
    return null;
  }
  return Object.freeze({ ...item });
}

function normalizeInstalledPlugin(plugin: InstalledPluginView): InstalledPluginView | null {
  if (
    !validIdentity(plugin.pluginId) ||
    !safeDisplayText(plugin.displayName, 128) ||
    !validVersion(plugin.version) ||
    (plugin.pendingVersion !== null && !validVersion(plugin.pendingVersion)) ||
    !plugin.requestedCapabilities.every(isCapabilityV2) ||
    !plugin.effectiveCapabilities.every(isCapabilityV2) ||
    plugin.effectiveCapabilities.some(
      (capability) => !plugin.requestedCapabilities.includes(capability),
    ) ||
    (plugin.runtime === null && plugin.effectiveCapabilities.length > 0) ||
    (plugin.runtime !== null && !validRuntime(plugin.runtime, plugin.pluginId))
  ) {
    return null;
  }
  return Object.freeze({
    ...plugin,
    runtime: plugin.runtime ? Object.freeze({ ...plugin.runtime }) : null,
    requestedCapabilities: Object.freeze([...new Set(plugin.requestedCapabilities)]),
    effectiveCapabilities: Object.freeze([...new Set(plugin.effectiveCapabilities)]),
  });
}

function normalizeList<T>(input: readonly T[], normalize: (item: T) => T | null): T[] | null {
  const result: T[] = [];
  const identities = new Set<string>();
  for (const item of input) {
    const normalized = normalize(item);
    if (!normalized) return null;
    const identity = identityOf(normalized);
    if (identity && identities.has(identity)) return null;
    if (identity) identities.add(identity);
    result.push(normalized);
  }
  return result;
}

function identityOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const runtime = record.runtime as Record<string, unknown> | undefined;
  if (
    runtime &&
    typeof runtime.pluginId === 'string' &&
    typeof runtime.instanceId === 'number' &&
    typeof runtime.generation === 'number'
  ) {
    return `runtime:${runtime.pluginId}:${runtime.instanceId}:${runtime.generation}`;
  }
  for (const key of ['catalogId', 'pluginId', 'sourceId']) {
    if (typeof record[key] === 'string') return `${key}:${record[key]}`;
  }
  return null;
}

function validSourceId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u.test(value) && value.length >= 2;
}

function validHttpsSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.hostname !== '' &&
      !/^\[?[\d.:]+\]?$/u.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function validOptionalTimestamp(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validIdentity(value: string): boolean {
  return IDENTITY_PATTERN.test(value);
}

function validVersion(value: string): boolean {
  return VERSION_PATTERN.test(value) && safeDisplayText(value, 128);
}

function validRuntime(runtime: RuntimeInstanceKey, expectedPluginId?: string): boolean {
  return (
    validIdentity(runtime.workspaceId) &&
    validIdentity(runtime.pluginId) &&
    (!expectedPluginId || runtime.pluginId === expectedPluginId) &&
    Number.isSafeInteger(runtime.instanceId) &&
    runtime.instanceId > 0 &&
    Number.isSafeInteger(runtime.generation) &&
    runtime.generation > 0
  );
}

function runtimeEquals(left: RuntimeInstanceKey, right: RuntimeInstanceKey): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.pluginId === right.pluginId &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}

function surfaceEventEquals(left: PluginSurfaceEventV2, right: PluginSurfaceEventV2): boolean {
  return (
    runtimeEquals(left.runtime, right.runtime) &&
    left.surfaceId === right.surfaceId &&
    left.revision === right.revision &&
    left.nodeId === right.nodeId &&
    left.event === right.event &&
    left.value === right.value
  );
}

function isCapabilityV2(value: string): value is import('./types').PluginCapabilityV2 {
  return CAPABILITIES_V2.has(value);
}
