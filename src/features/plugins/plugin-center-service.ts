import {
  safeDisplayText,
  validateDeclarativePanel,
  validPanelEventValue,
} from './panel-validation';
import { logger } from '../../lib/logger';
import { listenNativeEvent } from '../native';
import {
  PLUGIN_PERMISSIONS,
  type InstalledPluginView,
  type PluginCatalogItem,
  type PluginCenterActionKind,
  type PluginCenterData,
  type PluginCenterListener,
  type PluginCenterPort,
  type PluginCenterSnapshot,
  type PluginDeclarativePanel,
  type PluginFailure,
  type PluginPanelEvent,
  type PluginPermission,
  type PluginPortOutcome,
  type PluginRuntimeStatus,
  type PluginSerialProposal,
  type PluginSourceView,
} from './types';

const PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;

const EMPTY_DATA: PluginCenterData = Object.freeze({
  revision: 0,
  catalog: Object.freeze([]),
  installed: Object.freeze([]),
  serialProposals: Object.freeze([]),
  panels: Object.freeze([]),
  sources: Object.freeze([]),
});

interface NormalizedData {
  readonly data: PluginCenterData;
  readonly panelRejected: boolean;
}

/**
 * Application-owned renderer service. Its port speaks trusted domain values,
 * never raw IPC payloads. UI unmount only detaches listeners; it does not abort
 * native plugin work or tear down the application-level subscription.
 */
export class PluginCenterService {
  private readonly listeners = new Set<PluginCenterListener>();
  private data = EMPTY_DATA;
  private started = false;
  private action: PluginCenterSnapshot['action'] = null;
  private failure: PluginFailure | null = null;
  private runtimeStatus: PluginCenterSnapshot['runtimeStatus'] = null;
  private actionAbort: AbortController | null = null;
  private detachPort: (() => void) | null = null;
  private detachRuntimeStatus: (() => void) | null = null;
  private detachSnapshotChanged: (() => void) | null = null;

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
    // Host-side proposals arrive between renderer commands; nudge a refresh
    // so the confirmation prompt appears without a user action.
    void listenNativeEvent('plugin-snapshot-changed', () => {
      if (!this.action) void this.refresh();
    })
      .then((unlisten) => {
        this.detachSnapshotChanged = unlisten;
      })
      .catch(() => {
        // Browser-only shells provide no native event API.
      });
    this.notify();
    return this.refresh();
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

  uninstall(pluginId: string): Promise<void> {
    const installed = this.data.installed.some((candidate) => candidate.pluginId === pluginId);
    if (!installed) return this.rejectInvalidResponse();
    return this.run('uninstall', (signal) => this.port.uninstall(pluginId, signal));
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

  resolveSerialProposal(proposalId: string, decision: 'approve' | 'reject'): Promise<void> {
    const proposal = this.data.serialProposals.find((item) => item.proposalId === proposalId);
    if (!proposal) return this.rejectInvalidResponse();
    return this.run('serial-proposal', (signal) =>
      this.port.resolveSerialProposal(proposal, decision, signal),
    );
  }

  emitPanelEvent(event: PluginPanelEvent): Promise<void> {
    const panel = this.data.panels.find((candidate) =>
      runtimeEquals(candidate.runtime, event.runtime),
    );
    const field = panel?.fields.find((candidate) => candidate.id === event.fieldId);
    if (!field || !validPanelEventValue(field, event.value)) return this.rejectInvalidResponse();
    return this.run('panel-event', (signal) => this.port.emitPanelEvent(event, signal));
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
    if (normalized.panelRejected) this.failure = Object.freeze({ code: 'invalid-panel' });
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
  const proposals = normalizeList(candidate.serialProposals, normalizeProposal);
  const sources = normalizeList(candidate.sources, normalizeSource);
  if (!catalog || !installed || !proposals || !sources) return null;
  const panels: PluginDeclarativePanel[] = [];
  let panelRejected = false;
  for (const panel of candidate.panels) {
    if (!validateDeclarativePanel(panel)) {
      panelRejected = true;
      continue;
    }
    panels.push(clonePanel(panel));
  }
  return {
    data: Object.freeze({
      revision: candidate.revision,
      catalog: Object.freeze(catalog),
      installed: Object.freeze(installed),
      serialProposals: Object.freeze(proposals),
      panels: Object.freeze(panels),
      sources: Object.freeze(sources),
    }),
    panelRejected,
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
    !plugin.declaredCapabilities.every(isPermission) ||
    !plugin.effectiveCapabilities.every(isPermission) ||
    !plugin.unavailableCapabilities.every(
      (capability) => capability === 'network' || isPermission(capability),
    ) ||
    (plugin.runtime !== null && !validRuntime(plugin.runtime, plugin.pluginId))
  ) {
    return null;
  }
  return Object.freeze({
    ...plugin,
    runtime: plugin.runtime ? Object.freeze({ ...plugin.runtime }) : null,
    declaredCapabilities: Object.freeze([...new Set(plugin.declaredCapabilities)]),
    effectiveCapabilities: Object.freeze([...new Set(plugin.effectiveCapabilities)]),
    unavailableCapabilities: Object.freeze([...new Set(plugin.unavailableCapabilities)]),
  });
}

function normalizeProposal(proposal: PluginSerialProposal): PluginSerialProposal | null {
  if (
    !validIdentity(proposal.proposalId) ||
    !validIdentity(proposal.pluginId) ||
    !validRuntime(proposal.runtime, proposal.pluginId) ||
    !safeDisplayText(proposal.pluginName, 128) ||
    !safeDisplayText(proposal.sessionLabel, 128) ||
    !safeDisplayText(proposal.displayLabel, 128) ||
    !Number.isSafeInteger(proposal.byteCount) ||
    proposal.byteCount <= 0 ||
    proposal.byteCount > 2 * 1024 * 1024 ||
    !/^[0-9A-F ]+(?: … \(\+\d+ bytes\))?$/u.test(proposal.hexPreview) ||
    !Number.isSafeInteger(proposal.expiresAtMs) ||
    proposal.expiresAtMs < 0
  ) {
    return null;
  }
  return Object.freeze({ ...proposal, runtime: Object.freeze({ ...proposal.runtime }) });
}

function clonePanel(panel: PluginDeclarativePanel): PluginDeclarativePanel {
  return Object.freeze({
    runtime: Object.freeze({ ...panel.runtime }),
    title: panel.title,
    fields: Object.freeze(
      panel.fields.map((field) =>
        Object.freeze({ ...field, options: Object.freeze([...field.options]) }),
      ),
    ),
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
  for (const key of ['catalogId', 'pluginId', 'proposalId', 'sourceId']) {
    if (typeof record[key] === 'string') return `${key}:${record[key]}`;
  }
  return null;
}

function validSourceId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value) && value.length >= 2;
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

function validRuntime(
  runtime: PluginSerialProposal['runtime'],
  expectedPluginId?: string,
): boolean {
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

function runtimeEquals(
  left: PluginSerialProposal['runtime'],
  right: PluginSerialProposal['runtime'],
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.pluginId === right.pluginId &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}

function isPermission(value: string): value is PluginPermission {
  return PERMISSIONS.has(value);
}
