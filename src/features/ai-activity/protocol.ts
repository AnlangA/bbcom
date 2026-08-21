import {
  IPC_LIMITS,
  type AiKeyStatus,
  type AiRequestResult,
  type IpcError,
  type OperationRecord,
  type RunAiRequest,
  type StateEnvelope,
  type StateOrigin,
} from '../../generated/ipc-contracts';

export const AI_BRIDGE_SCHEMA_VERSION = 1;
/** Reserved only for bootstrap/control messages before a project is active. */
export const AI_BRIDGE_WORKSPACE_ID = 'application';
export const NO_AI_WORKSPACE_ID = 'no-workspace';
export const NO_AI_SESSION_ID = 'no-session';

export const AI_BRIDGE_EVENTS = Object.freeze({
  authorityRequest: 'ai-authority-request',
  authoritySnapshot: 'ai-authority-snapshot',
  sessionRequest: 'ai-session-snapshot-request',
  sessionSnapshot: 'ai-session-snapshot',
  chatSnapshot: 'ai-chat-snapshot',
  logContextRequest: 'ai-log-context-request',
  logContext: 'ai-log-context',
  commandApply: 'ai-command-apply',
  commandResult: 'ai-command-result',
  sessionUpdate: 'ai-session-update',
  activityRun: 'ai-activity-run',
  activityCancel: 'ai-activity-cancel',
  activityResult: 'ai-activity-result',
  activitySnapshotRequest: 'ai-activity-snapshot-request',
  activitySnapshot: 'ai-activity-snapshot',
});

export interface AiAuthorityPayload {
  readonly kind: 'authority-snapshot';
  readonly theme: 'dark' | 'light';
  readonly locale: 'en' | 'zh';
  readonly aiKeyStatus: AiKeyStatus;
}

export interface AiAuthorityRequestPayload {
  readonly kind: 'authority-request';
}

export interface AiSessionRequestPayload {
  readonly kind: 'session-snapshot-request';
}

export interface AiActivityRunPayload {
  readonly kind: 'activity-run';
  readonly request: RunAiRequest;
}

export interface AiActivityCancelPayload {
  readonly kind: 'activity-cancel';
}

export type AiActivityResultPayload =
  | {
      readonly kind: 'activity-result';
      readonly outcome: 'completed';
      readonly result: AiRequestResult;
    }
  | { readonly kind: 'activity-result'; readonly outcome: 'failed'; readonly error: IpcError };

export interface AiActivitySnapshotRequestPayload {
  readonly kind: 'activity-snapshot-request';
}

/** Receipt for a command-apply envelope: the main window either applied the
 *  command or dropped it (with why), so the AI renderer can surface a retry
 *  instead of a silent no-op. */
export type AiCommandResultPayload =
  | { readonly kind: 'command-result'; readonly outcome: 'applied' }
  | {
      readonly kind: 'command-result';
      readonly outcome: 'rejected';
      readonly reason:
        'revision-mismatch' | 'session-mismatch' | 'workspace-mismatch' | 'invalid-payload';
    };

export function isAiCommandResultPayload(value: unknown): value is AiCommandResultPayload {
  if (!isRecord(value) || value.kind !== 'command-result') return false;
  if (value.outcome === 'applied') return true;
  if (value.outcome !== 'rejected') return false;
  return (
    value.reason === 'revision-mismatch' ||
    value.reason === 'session-mismatch' ||
    value.reason === 'workspace-mismatch' ||
    value.reason === 'invalid-payload'
  );
}

export interface AiActivitySnapshotPayload {
  readonly kind: 'activity-snapshot';
  readonly operations: readonly OperationRecord[];
}

export interface AiBridgeEnvelope<T> extends StateEnvelope<T> {
  readonly requestId: string;
  readonly sessionId: string;
}

export interface CreateAiBridgeEnvelope<T> {
  /** The real project id, or a reserved bootstrap id before a project is active. */
  readonly workspaceId?: string;
  readonly revision: number;
  readonly origin: Extract<StateOrigin, 'main' | 'ai-assistant'>;
  readonly requestId: string;
  readonly sessionId: string;
  readonly payload: T;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function createAiBridgeEnvelope<T>(input: CreateAiBridgeEnvelope<T>): AiBridgeEnvelope<T> {
  return Object.freeze({
    schemaVersion: AI_BRIDGE_SCHEMA_VERSION,
    workspaceId: validId(input.workspaceId ?? AI_BRIDGE_WORKSPACE_ID),
    revision: validRevision(input.revision),
    origin: input.origin,
    requestId: validId(input.requestId),
    sessionId: validId(input.sessionId),
    payload: input.payload,
  });
}

/**
 * Treat every cross-window event as untrusted. Old envelopes with an omitted
 * correlation field are deliberately rejected; there is no legacy fallback.
 */
export function parseAiBridgeEnvelope(
  value: unknown,
  expectedOrigin: Extract<StateOrigin, 'main' | 'ai-assistant'>,
): AiBridgeEnvelope<unknown> | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== AI_BRIDGE_SCHEMA_VERSION ||
    !isId(value.workspaceId) ||
    value.origin !== expectedOrigin ||
    !isRevision(value.revision) ||
    !isId(value.requestId) ||
    !isId(value.sessionId) ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return value as unknown as AiBridgeEnvelope<unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAiAuthorityPayload(value: unknown): value is AiAuthorityPayload {
  if (!isRecord(value) || value.kind !== 'authority-snapshot') return false;
  if (value.theme !== 'dark' && value.theme !== 'light') return false;
  if (value.locale !== 'en' && value.locale !== 'zh') return false;
  return isAiKeyStatus(value.aiKeyStatus);
}

export function isPayloadKind(value: unknown, kind: string): value is Record<string, unknown> {
  return isRecord(value) && value.kind === kind;
}

export function isAiActivityRunPayload(value: unknown): value is AiActivityRunPayload {
  if (!isRecord(value) || value.kind !== 'activity-run' || !isRecord(value.request)) return false;
  const request = value.request;
  if (!isId(request.requestId) || (request.kind !== 'terminal' && request.kind !== 'log')) {
    return false;
  }
  return (
    boundedText(request.prompt, IPC_LIMITS.MAX_AI_PROMPT_BYTES, false) &&
    optionalBoundedText(request.model, IPC_LIMITS.MAX_AI_MODEL_BYTES) &&
    optionalBoundedText(request.shell, IPC_LIMITS.MAX_AI_SHELL_BYTES) &&
    optionalBoundedText(request.sessionMeta, IPC_LIMITS.MAX_AI_SESSION_META_BYTES) &&
    optionalBoundedText(request.contextMode, IPC_LIMITS.MAX_AI_CONTEXT_MODE_BYTES) &&
    optionalBoundedText(request.context, IPC_LIMITS.MAX_AI_CONTEXT_BYTES)
  );
}

export function isAiActivityResultPayload(value: unknown): value is AiActivityResultPayload {
  if (!isRecord(value) || value.kind !== 'activity-result') return false;
  if (value.outcome === 'failed') return isIpcError(value.error);
  if (value.outcome !== 'completed' || !isRecord(value.result)) return false;
  if (
    new TextEncoder().encode(JSON.stringify(value.result)).byteLength >
    IPC_LIMITS.MAX_AI_RESPONSE_BYTES
  ) {
    return false;
  }
  if (value.result.kind === 'terminal') {
    return (
      typeof value.result.command === 'string' &&
      typeof value.result.explanation === 'string' &&
      (value.result.risk === 'safe' ||
        value.result.risk === 'caution' ||
        value.result.risk === 'dangerous')
    );
  }
  return (
    value.result.kind === 'log' &&
    typeof value.result.answer === 'string' &&
    Array.isArray(value.result.evidence) &&
    value.result.evidence.every((item) => typeof item === 'string') &&
    Array.isArray(value.result.suggestions) &&
    value.result.suggestions.every((item) => typeof item === 'string') &&
    typeof value.result.truncated === 'boolean'
  );
}

export function isAiActivitySnapshotPayload(value: unknown): value is AiActivitySnapshotPayload {
  return (
    isRecord(value) &&
    value.kind === 'activity-snapshot' &&
    Array.isArray(value.operations) &&
    value.operations.length <= 64 &&
    value.operations.every(isOperationRecord)
  );
}

function isAiKeyStatus(value: unknown): value is AiKeyStatus {
  return isRecord(value) && typeof value.configured === 'boolean';
}

function isIpcError(value: unknown): value is IpcError {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.messageKey === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.operation === 'string'
  );
}

function isOperationRecord(value: unknown): value is OperationRecord {
  return (
    isRecord(value) &&
    isId(value.operationId) &&
    value.kind === 'ai-request' &&
    (value.status === 'queued' ||
      value.status === 'running' ||
      value.status === 'cancelling' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'interrupted') &&
    isId(value.workspaceId) &&
    (value.sessionId === undefined || isId(value.sessionId))
  );
}

function boundedText(value: unknown, maxBytes: number, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function optionalBoundedText(value: unknown, maxBytes: number): boolean {
  return value === undefined || boundedText(value, maxBytes);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validRevision(value: number): number {
  if (!isRevision(value)) throw new Error('AI bridge revision must be a non-negative integer');
  return value;
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && OPAQUE_ID.test(value)
  );
}

function validId(value: string): string {
  if (!isId(value)) throw new Error('AI bridge identities must be path-free opaque identifiers');
  return value;
}
