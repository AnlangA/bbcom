import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  AddPluginSourceRequest,
  CancelPluginTaskRequestV2,
  CancelPluginOperationRequest,
  EmitPluginSurfaceEventRequestV2,
  InstallLocalPluginRequest,
  InstallPluginRequest,
  PluginCenterData as GeneratedPluginCenterData,
  PluginCommandResponse,
  PluginFailureCode,
  PluginSnapshotRequest,
  PluginLocalSourceGrantResponse,
  ResolvePluginAuthorizationRequestV2,
  RequestPluginLocalSourceGrantRequest,
  RefreshPluginSourceRequest,
  RemovePluginSourceRequest,
  RunPluginCommandRequestV2,
  SetPluginSurfacePlacementRequestV2,
  SetPluginEnabledRequest,
  SetPluginWatchEnabledRequest,
  UninstallPluginRequest,
  UpdatePluginSourceRequest,
} from '../../generated/ipc-contracts';
import type {
  PluginCenterData,
  PluginCenterPort,
  PluginAuthorizationRequestV2,
  PluginCommandContributionV2,
  PluginContributionDisposition,
  PluginPortOutcome,
  PluginSurfaceEventV2,
  PluginSurfaceSnapshot,
  PluginTaskViewV2,
} from './types';

export const PLUGIN_CENTER_SNAPSHOT_COMMAND = 'plugin_center_snapshot';
export const PLUGIN_REQUEST_LOCAL_SOURCE_GRANT_COMMAND = 'plugin_request_local_source_grant';
export const PLUGIN_INSTALL_COMMAND = 'plugin_install';
export const PLUGIN_INSTALL_LOCAL_COMMAND = 'plugin_install_local';
export const PLUGIN_UNINSTALL_COMMAND = 'plugin_uninstall';
export const PLUGIN_SET_ENABLED_COMMAND = 'plugin_set_enabled';
export const PLUGIN_SOURCE_ADD_COMMAND = 'plugin_source_add';
export const PLUGIN_SOURCE_UPDATE_COMMAND = 'plugin_source_update';
export const PLUGIN_SOURCE_REMOVE_COMMAND = 'plugin_source_remove';
export const PLUGIN_SOURCE_REFRESH_COMMAND = 'plugin_source_refresh';
export const PLUGIN_SET_WATCH_ENABLED_COMMAND = 'plugin_set_watch_enabled';
export const PLUGIN_EMIT_SURFACE_EVENT_V2_COMMAND = 'plugin_emit_surface_event_v2';
export const PLUGIN_RESOLVE_AUTHORIZATION_V2_COMMAND = 'plugin_resolve_authorization_v2';
export const PLUGIN_CANCEL_TASK_V2_COMMAND = 'plugin_cancel_task_v2';
export const PLUGIN_RUN_COMMAND_V2_COMMAND = 'plugin_run_command_v2';
export const PLUGIN_SET_SURFACE_PLACEMENT_V2_COMMAND = 'plugin_set_surface_placement_v2';
export const PLUGIN_CANCEL_OPERATION_COMMAND = 'plugin_cancel_operation';

const FAILURE_CODES = new Set<PluginFailureCode>([
  'unavailable',
  'invalid-response',
  'invalid-surface',
  'invalid-input',
  'operation-conflict',
  'installation-failed',
  'host-failed',
  'cancel-failed',
  'workspace-missing',
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

  async requestLocalSourceGrant(
    sourceKind: 'local-package' | 'dev-directory',
    signal: AbortSignal,
  ): Promise<string | null> {
    if (signal.aborted || !isTauri()) return null;
    const request: RequestPluginLocalSourceGrantRequest = {
      requestId: createCorrelationId('plugin-grant-request'),
      sourceKind,
    };
    try {
      const response = await invoke<PluginLocalSourceGrantResponse>(
        PLUGIN_REQUEST_LOCAL_SOURCE_GRANT_COMMAND,
        { request },
      );
      if (
        signal.aborted ||
        response.requestId !== request.requestId ||
        response.sourceKind !== sourceKind ||
        !validIdentity(response.grantId)
      ) {
        return null;
      }
      return response.grantId;
    } catch {
      return null;
    }
  }

  snapshot(signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: PluginSnapshotRequest = this.correlation();
    return this.execute(PLUGIN_CENTER_SNAPSHOT_COMMAND, request, signal);
  }

  install(catalogId: string, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: InstallPluginRequest = { ...this.correlation(), catalogId };
    return this.execute(PLUGIN_INSTALL_COMMAND, request, signal);
  }

  installLocal(grantId: string, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: InstallLocalPluginRequest = { ...this.correlation(), grantId };
    return this.execute(PLUGIN_INSTALL_LOCAL_COMMAND, request, signal);
  }

  uninstall(
    pluginId: string,
    signal: AbortSignal,
    contributionDisposition: PluginContributionDisposition = 'delete',
  ): Promise<PluginPortOutcome> {
    const request: UninstallPluginRequest = {
      ...this.correlation(),
      pluginId,
      contributionDisposition,
    };
    return this.execute(PLUGIN_UNINSTALL_COMMAND, request, signal);
  }

  setEnabled(pluginId: string, enabled: boolean, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: SetPluginEnabledRequest = { ...this.correlation(), pluginId, enabled };
    return this.execute(PLUGIN_SET_ENABLED_COMMAND, request, signal);
  }

  addSource(
    sourceId: string,
    url: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: AddPluginSourceRequest = {
      ...this.correlation(),
      sourceId,
      url,
      enabled,
    };
    return this.execute(PLUGIN_SOURCE_ADD_COMMAND, request, signal);
  }

  updateSource(
    sourceId: string,
    url: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: UpdatePluginSourceRequest = {
      ...this.correlation(),
      sourceId,
      url,
      enabled,
    };
    return this.execute(PLUGIN_SOURCE_UPDATE_COMMAND, request, signal);
  }

  removeSource(sourceId: string, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: RemovePluginSourceRequest = { ...this.correlation(), sourceId };
    return this.execute(PLUGIN_SOURCE_REMOVE_COMMAND, request, signal);
  }

  refreshSource(sourceId: string, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: RefreshPluginSourceRequest = { ...this.correlation(), sourceId };
    return this.execute(PLUGIN_SOURCE_REFRESH_COMMAND, request, signal);
  }

  setWatchEnabled(
    sourceId: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: SetPluginWatchEnabledRequest = {
      ...this.correlation(),
      sourceId,
      enabled,
    };
    return this.execute(PLUGIN_SET_WATCH_ENABLED_COMMAND, request, signal);
  }

  emitSurfaceEvent(event: PluginSurfaceEventV2, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: EmitPluginSurfaceEventRequestV2 = {
      ...this.correlation(),
      event: { ...event, runtime: { ...event.runtime } },
    };
    return this.execute(PLUGIN_EMIT_SURFACE_EVENT_V2_COMMAND, request, signal);
  }

  resolveAuthorization(
    authorization: PluginAuthorizationRequestV2,
    decision: 'approve' | 'reject',
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: ResolvePluginAuthorizationRequestV2 = {
      ...this.correlation(),
      pluginId: authorization.pluginId,
      version: authorization.version,
      digestSha256: authorization.digestSha256,
      requestedCapabilities: [...authorization.requestedCapabilities],
      decision,
    };
    return this.execute(PLUGIN_RESOLVE_AUTHORIZATION_V2_COMMAND, request, signal);
  }

  cancelTask(task: PluginTaskViewV2, signal: AbortSignal): Promise<PluginPortOutcome> {
    const request: CancelPluginTaskRequestV2 = {
      ...this.correlation(),
      runtime: { ...task.runtime },
      taskId: task.taskId,
    };
    return this.execute(PLUGIN_CANCEL_TASK_V2_COMMAND, request, signal);
  }

  runCommand(
    command: PluginCommandContributionV2,
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: RunPluginCommandRequestV2 = {
      ...this.correlation(),
      runtime: { ...command.runtime },
      commandId: command.commandId,
    };
    return this.execute(PLUGIN_RUN_COMMAND_V2_COMMAND, request, signal);
  }

  setSurfacePlacement(
    surface: PluginSurfaceSnapshot,
    placement: 'workspace' | 'detached-window',
    signal: AbortSignal,
  ): Promise<PluginPortOutcome> {
    const request: SetPluginSurfacePlacementRequestV2 = {
      ...this.correlation(),
      runtime: { ...surface.runtime },
      surfaceId: surface.surfaceId,
      placement,
    };
    return this.execute(PLUGIN_SET_SURFACE_PLACEMENT_V2_COMMAND, request, signal);
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
    } catch (error) {
      if (signal.aborted) return failedOutcome('cancel-failed');
      return failedOutcome(invokeFailureCode(error));
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

/**
 * Maps a Tauri invoke rejection to a PluginFailureCode the panel can render.
 * The backend's IpcError carries an AppErrorCode string; unknown shapes
 * fall back to 'unavailable'.
 */
function invokeFailureCode(error: unknown): PluginFailureCode {
  if (!isRecord(error)) return 'unavailable';
  const code = error.code;
  if (typeof code !== 'string') return 'unavailable';
  switch (code) {
    case 'INVALID_INPUT':
      return 'invalid-input';
    case 'SECURITY_DENIED':
      return 'unavailable';
    case 'REVISION_CONFLICT':
      return 'operation-conflict';
    case 'BUSY':
      return 'operation-conflict';
    default:
      return 'unavailable';
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
    !Array.isArray(value.sources)
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

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

let fallbackCorrelationSequence = 0;

function createCorrelationId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  fallbackCorrelationSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCorrelationSequence.toString(36)}`;
}
