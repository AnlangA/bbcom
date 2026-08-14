import {
  safeDisplayText,
  validateDeclarativePanel,
  validPanelEventValue,
} from './panel-validation';
import {
  PLUGIN_PERMISSIONS,
  type InstalledPluginView,
  type PluginAuthorizationReview,
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
  type PluginPermissionDecision,
  type PluginPortOutcome,
  type PluginSerialProposal,
  type SubmitPluginAuthorization,
} from './types';

const PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;

const EMPTY_DATA: PluginCenterData = Object.freeze({
  revision: 0,
  catalog: Object.freeze([]),
  installed: Object.freeze([]),
  authorizationReview: null,
  serialProposals: Object.freeze([]),
  panels: Object.freeze([]),
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
  private actionAbort: AbortController | null = null;
  private detachPort: (() => void) | null = null;

  constructor(private readonly port: PluginCenterPort) {}

  snapshot(): PluginCenterSnapshot {
    return Object.freeze({
      ...this.data,
      started: this.started,
      action: this.action ? Object.freeze({ ...this.action }) : null,
      failure: this.failure ? Object.freeze({ ...this.failure }) : null,
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
    this.notify();
    return this.refresh();
  }

  refresh(): Promise<void> {
    return this.run('refresh', (signal) => this.port.snapshot(signal));
  }

  install(catalogId: string): Promise<void> {
    const item = this.data.catalog.find((candidate) => candidate.catalogId === catalogId);
    if (!item || item.installedVersion !== null) return this.rejectInvalidResponse();
    return this.run('install', (signal) => this.port.install(catalogId, signal));
  }

  setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const plugin = this.data.installed.find((candidate) => candidate.pluginId === pluginId);
    if (!plugin || plugin.enabled === enabled) return this.rejectInvalidResponse();
    return this.run(enabled ? 'enable' : 'disable', (signal) =>
      this.port.setEnabled(pluginId, enabled, signal),
    );
  }

  submitAuthorization(input: SubmitPluginAuthorization): Promise<void> {
    if (!this.validAuthorization(input)) return this.rejectInvalidResponse();
    return this.run('authorize', (signal) => this.port.submitAuthorization(input, signal));
  }

  dismissAuthorization(reviewId: string): Promise<void> {
    if (this.data.authorizationReview?.reviewId !== reviewId) return this.rejectInvalidResponse();
    return this.run('dismiss-authorization', (signal) =>
      this.port.dismissAuthorization(reviewId, signal),
    );
  }

  resolveSerialProposal(proposalId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (!this.data.serialProposals.some((proposal) => proposal.proposalId === proposalId)) {
      return this.rejectInvalidResponse();
    }
    return this.run('serial-proposal', (signal) =>
      this.port.resolveSerialProposal(proposalId, decision, signal),
    );
  }

  emitPanelEvent(event: PluginPanelEvent): Promise<void> {
    const panel = this.data.panels.find((candidate) => candidate.pluginId === event.pluginId);
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
    } catch {
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

  private validAuthorization(input: SubmitPluginAuthorization): boolean {
    const review = this.data.authorizationReview;
    if (!review || input.reviewId !== review.reviewId) return false;
    if (!samePermissionSet(input.decisions, review.persistentPermissions)) return false;
    if (!sameStringSet(input.perRequestCapabilitiesAcknowledged, review.perRequestPermissions)) {
      return false;
    }
    const grantsCapability =
      input.decisions.some((decision) => decision.state === 'granted') ||
      input.perRequestCapabilitiesAcknowledged.length > 0;
    return !(
      grantsCapability &&
      review.extraConfirmationReasons.length > 0 &&
      !input.extraConfirmationAcknowledged
    );
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

function normalizeData(candidate: PluginCenterData): NormalizedData | null {
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) return null;
  const catalog = normalizeList(candidate.catalog, normalizeCatalogItem);
  const installed = normalizeList(candidate.installed, normalizeInstalledPlugin);
  const review = candidate.authorizationReview
    ? normalizeAuthorizationReview(candidate.authorizationReview)
    : null;
  const proposals = normalizeList(candidate.serialProposals, normalizeProposal);
  if (!catalog || !installed || (candidate.authorizationReview && !review) || !proposals)
    return null;
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
      authorizationReview: review,
      serialProposals: Object.freeze(proposals),
      panels: Object.freeze(panels),
    }),
    panelRejected,
  };
}

function normalizeCatalogItem(item: PluginCatalogItem): PluginCatalogItem | null {
  if (
    !validIdentity(item.catalogId) ||
    !validIdentity(item.pluginId) ||
    !safeDisplayText(item.displayName, 128) ||
    !safeDisplayText(item.description, 1024, true) ||
    !validVersion(item.version) ||
    !safeDisplayText(item.publisherName, 128) ||
    typeof item.publisherVerified !== 'boolean' ||
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
    !plugin.requestedPermissions.every(isPermission)
  ) {
    return null;
  }
  return Object.freeze({
    ...plugin,
    requestedPermissions: Object.freeze([...new Set(plugin.requestedPermissions)]),
  });
}

function normalizeAuthorizationReview(
  review: PluginAuthorizationReview,
): PluginAuthorizationReview | null {
  if (
    !validIdentity(review.reviewId) ||
    !validIdentity(review.pluginId) ||
    !safeDisplayText(review.displayName, 128) ||
    !validVersion(review.version) ||
    !review.persistentPermissions.every(isPermission) ||
    !review.perRequestPermissions.every(isPermission) ||
    review.persistentPermissions.includes('serial.write-proposal') ||
    !review.unavailableCapabilities.every(
      (capability) => capability === 'network' || isPermission(capability),
    )
  ) {
    return null;
  }
  return Object.freeze({
    ...review,
    persistentPermissions: Object.freeze([...new Set(review.persistentPermissions)]),
    perRequestPermissions: Object.freeze([...new Set(review.perRequestPermissions)]),
    unavailableCapabilities: Object.freeze([...new Set(review.unavailableCapabilities)]),
    extraConfirmationReasons: Object.freeze([...new Set(review.extraConfirmationReasons)]),
  });
}

function normalizeProposal(proposal: PluginSerialProposal): PluginSerialProposal | null {
  if (
    !validIdentity(proposal.proposalId) ||
    !validIdentity(proposal.pluginId) ||
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
  return Object.freeze({ ...proposal });
}

function clonePanel(panel: PluginDeclarativePanel): PluginDeclarativePanel {
  return Object.freeze({
    pluginId: panel.pluginId,
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
  for (const key of ['catalogId', 'pluginId', 'proposalId']) {
    if (typeof record[key] === 'string') return `${key}:${record[key]}`;
  }
  return null;
}

function samePermissionSet(
  decisions: readonly PluginPermissionDecision[],
  expected: readonly PluginPermission[],
): boolean {
  const permissions = decisions.map((decision) => decision.permission);
  return (
    decisions.every(
      (decision) =>
        isPermission(decision.permission) &&
        (decision.state === 'granted' || decision.state === 'denied'),
    ) && sameStringSet(permissions, expected)
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function validIdentity(value: string): boolean {
  return IDENTITY_PATTERN.test(value);
}

function validVersion(value: string): boolean {
  return VERSION_PATTERN.test(value) && safeDisplayText(value, 128);
}

function isPermission(value: string): value is PluginPermission {
  return PERMISSIONS.has(value);
}
