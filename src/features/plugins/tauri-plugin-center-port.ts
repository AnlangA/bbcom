import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  CancelPluginOperationRequest,
  DismissPluginAuthorizationRequest,
  EmitPluginPanelEventRequest,
  InstallPluginRequest,
  PluginCenterData as GeneratedPluginCenterData,
  PluginCommandResponse,
  PluginFailureCode,
  PluginSerialProposalDecision,
  PluginSnapshotRequest,
  ResolvePluginSerialProposalRequest,
  SetPluginEnabledRequest,
  SubmitPluginAuthorizationRequest,
} from '../../generated/ipc-contracts';
import type {
  PluginCenterData,
  PluginCenterPort,
  PluginPanelEvent,
  PluginPortOutcome,
  SubmitPluginAuthorization,
} from './types';

export const PLUGIN_CENTER_SNAPSHOT_COMMAND = 'plugin_center_snapshot';
export const PLUGIN_INSTALL_COMMAND = 'plugin_install';
export const PLUGIN_SET_ENABLED_COMMAND = 'plugin_set_enabled';
export const PLUGIN_SUBMIT_AUTHORIZATION_COMMAND = 'plugin_submit_authorization';
export const PLUGIN_DISMISS_AUTHORIZATION_COMMAND = 'plugin_dismiss_authorization';
export const PLUGIN_RESOLVE_SERIAL_PROPOSAL_COMMAND = 'plugin_resolve_serial_proposal';
export const PLUGIN_EMIT_PANEL_EVENT_COMMAND = 'plugin_emit_panel_event';
export const PLUGIN_CANCEL_OPERATION_COMMAND = 'plugin_cancel_operation';

const FAILURE_CODES = new Set<PluginFailureCode>([
  'unavailable',
  'invalid-response',
  'invalid-panel',
  'operation-conflict',
  'installation-failed',
  'authorization-failed',
  'host-failed',
  'proposal-expired',
  'proposal-context-changed',
  'proposal-consumed',
  'panel-event-rejected',
  'cancel-failed',
]);

interface PluginRequestCorrelation {
  readonly requestId: string;
  readonly revision: number;
  readonly operationId: string;
}

interface ValidatedPluginResponse {
  readonly response: PluginCommandResponse;
  readonly data?: PluginCenterData;
}

/**
 * Generated-contract-only transport for the main-window plugin center.
 *
 * Aborting after invocation only requests native cancellation. The original
 * invoke remains authoritative and is always awaited to its real terminal
 * response, including a commit that won a race with cancellation.
 */
export class TauriPluginCenterPort implements PluginCenterPort {
  private readonly listeners = new Set<(data: PluginCenterData) => void>();
  private revision = 0;
  private data: PluginCenterData | undefined;

  snapshot(signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: PluginSnapshotRequest = this.correlation();
    return this.execute(PLUGIN_CENTER_SNAPSHOT_COMMAND, request, signal);
  }

  install(catalogId: string, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: InstallPluginRequest = { ...this.correlation(), catalogId };
    return this.execute(PLUGIN_INSTALL_COMMAND, request, signal);
  }

  setEnabled(pluginId: string, enabled: boolean, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: SetPluginEnabledRequest = { ...this.correlation(), pluginId, enabled };
    return this.execute(PLUGIN_SET_ENABLED_COMMAND, request, signal);
  }

  submitAuthorization(
    input: SubmitPluginAuthorization,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: SubmitPluginAuthorizationRequest = {
      ...this.correlation(),
      reviewId: input.reviewId,
      decisions: input.decisions.map((decision) => ({ ...decision })),
      perRequestCapabilitiesAcknowledged: [...input.perRequestCapabilitiesAcknowledged],
      extraConfirmationAcknowledged: input.extraConfirmationAcknowledged,
    };
    return this.execute(PLUGIN_SUBMIT_AUTHORIZATION_COMMAND, request, signal);
  }

  dismissAuthorization(reviewId: string, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: DismissPluginAuthorizationRequest = { ...this.correlation(), reviewId };
    return this.execute(PLUGIN_DISMISS_AUTHORIZATION_COMMAND, request, signal);
  }

  resolveSerialProposal(
    proposalId: string,
    decision: PluginSerialProposalDecision,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: ResolvePluginSerialProposalRequest = {
      ...this.correlation(),
      proposalId,
      decision,
    };
    return this.execute(PLUGIN_RESOLVE_SERIAL_PROPOSAL_COMMAND, request, signal);
  }

  emitPanelEvent(event: PluginPanelEvent, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: EmitPluginPanelEventRequest = {
      ...this.correlation(),
      event: { ...event },
    };
    return this.execute(PLUGIN_EMIT_PANEL_EVENT_COMMAND, request, signal);
  }

  subscribe(listener: (data: PluginCenterData) => void): () => void {
    this.listeners.add(listener);
    if (this.data) this.notifyOne(listener, this.data);
    return () => this.listeners.delete(listener);
  }

  private correlation(): PluginRequestCorrelation {
    return {
      requestId: createCorrelationId('plugin-request'),
      revision: this.revision,
      operationId: createCorrelationId('plugin-operation'),
    };
  }

  private async execute(
    command: string,
    request: PluginRequestCorrelation,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    if (signal.aborted) return this.cancelledOutcome();
    if (!isTauri()) return failedOutcome('unavailable');

    let invoked = false;
    let cancellationRequested = false;
    const requestCancellation = (): void => {
      if (!invoked || cancellationRequested) return;
      cancellationRequested = true;
      void this.cancelNativeOperation(request);
    };
    signal.addEventListener('abort', requestCancellation);
    if (signal.aborted) {
      signal.removeEventListener('abort', requestCancellation);
      return this.cancelledOutcome();
    }

    try {
      invoked = true;
      const raw = await invoke<unknown>(command, { request });
      const validated = this.validateResponse(raw, request);
      if (!validated) return failedOutcome('invalid-response');
      if (validated.data) this.acceptData(validated.data);
      else {
        this.revision = validated.response.revision;
        if (this.data && this.data.revision < this.revision) this.data = undefined;
      }
      return toPortOutcome(validated.response);
    } catch {
      return failedOutcome(signal.aborted ? 'cancel-failed' : 'unavailable');
    } finally {
      signal.removeEventListener('abort', requestCancellation);
    }
  }

  private async cancelNativeOperation(request: PluginRequestCorrelation): Promise<void> {
    const cancellation: CancelPluginOperationRequest = {
      requestId: createCorrelationId('plugin-cancel'),
      revision: request.revision,
      operationId: request.operationId,
    };
    try {
      // This response is intentionally not used to settle the original call.
      // Its operationId identifies the target, while the original invoke owns
      // the authoritative terminal response consumed by `execute`.
      await invoke<unknown>(PLUGIN_CANCEL_OPERATION_COMMAND, { request: cancellation });
    } catch {
      // The original invoke still determines completed/failed/cancelled.
    }
  }

  private validateResponse(
    raw: unknown,
    request: PluginRequestCorrelation,
  ): ValidatedPluginResponse | null {
    if (!isRecord(raw)) return null;
    if (raw.requestId !== request.requestId || raw.operationId !== request.operationId) return null;
    if (!validRevision(raw.revision) || raw.revision < request.revision) return null;
    if (raw.revision < this.revision) return null;

    const data = raw.data === undefined ? undefined : validCenterData(raw.data, raw.revision);
    if (raw.data !== undefined && !data) return null;
    switch (raw.outcome) {
      case 'completed':
        if (!data || 'failure' in raw) return null;
        break;
      case 'cancelled':
        if ('failure' in raw) return null;
        break;
      case 'failed':
        if (!validFailure(raw.failure)) return null;
        break;
      default:
        return null;
    }
    return { response: raw as PluginCommandResponse, ...(data ? { data } : {}) };
  }

  private acceptData(data: PluginCenterData): void {
    this.revision = data.revision;
    this.data = data;
    for (const listener of this.listeners) this.notifyOne(listener, data);
  }

  private notifyOne(listener: (data: PluginCenterData) => void, data: PluginCenterData): void {
    try {
      listener(data);
    } catch {
      // Renderer observers cannot alter transport or native plugin state.
    }
  }

  private cancelledOutcome(): PluginPortOutcome {
    return this.data ? { outcome: 'cancelled', data: this.data } : { outcome: 'cancelled' };
  }
}

function toPortOutcome(response: PluginCommandResponse): PluginPortOutcome {
  switch (response.outcome) {
    case 'completed':
      return { outcome: 'completed', data: response.data };
    case 'cancelled':
      return response.data
        ? { outcome: 'cancelled', data: response.data }
        : { outcome: 'cancelled' };
    case 'failed':
      return response.data
        ? { outcome: 'failed', failure: response.failure, data: response.data }
        : { outcome: 'failed', failure: response.failure };
  }
}

function failedOutcome(code: PluginFailureCode): PluginPortOutcome {
  return { outcome: 'failed', failure: { code } };
}

function validCenterData(value: unknown, revision: number): PluginCenterData | null {
  if (
    !isRecord(value) ||
    value.revision !== revision ||
    !validRevision(value.revision) ||
    !Array.isArray(value.catalog) ||
    !Array.isArray(value.installed) ||
    !(value.authorizationReview === null || isRecord(value.authorizationReview)) ||
    !Array.isArray(value.serialProposals) ||
    !Array.isArray(value.panels)
  )
    return null;
  return value as unknown as GeneratedPluginCenterData;
}

function validFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    FAILURE_CODES.has(value.code as PluginFailureCode)
  );
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let fallbackCorrelationSequence = 0;

function createCorrelationId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  fallbackCorrelationSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCorrelationSequence.toString(36)}`;
}
