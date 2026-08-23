import type {
  IpcError,
  WorkspaceCatalogResponse,
  WorkspaceDocumentHeader,
  WorkspaceMutation,
  WorkspaceSaveHealth,
  WorkspaceSummary,
} from '@/generated/ipc-contracts';
import type {
  ActiveWorkspaceViewModel,
  WorkspaceActionFailure,
  WorkspaceGrantId,
  WorkspaceMutationCommand,
  WorkspaceProjectViewModel,
} from './types';
import { WORKSPACE_PROJECT_EXTENSION } from './types';
import { clampSidebarWidth } from '@/lib/sidebar-layout';
import type { WorkspaceLayoutV1 } from './types';
import { DEFAULT_WORKSPACE_LAYOUT } from './workspace-ui-store';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/i;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

const SAVE_HEALTHS: ReadonlySet<WorkspaceSaveHealth> = new Set([
  'clean',
  'pending',
  'saving',
  'degraded',
  'readOnly',
]);

const ERROR_CODES = new Set([
  'BUSY',
  'RATE_LIMITED',
  'CANCELLED',
  'TIMEOUT',
  'INVALID_INPUT',
  'LIMIT_EXCEEDED',
  'SECURITY_DENIED',
  'SERIAL_DISCONNECTED',
  'SERIAL_QUEUE_FULL',
  'SERIAL_PARTIAL_WRITE',
  'IO_PERMISSION_DENIED',
  'IO_DISK_FULL',
  'EXPORT_REPLACE_FAILED',
  'REVISION_CONFLICT',
  'WORKSPACE_READ_ONLY',
  'WORKSPACE_CORRUPT',
  'PORT_IN_USE',
]);

export class InvalidWorkspaceResponseError extends Error {
  constructor(readonly stableField: string) {
    super(`invalid workspace response field: ${stableField}`);
    this.name = 'InvalidWorkspaceResponseError';
  }
}

export function workspaceGrantId(value: string): WorkspaceGrantId {
  const grantId = validateOpaqueId(value, 'grantId');
  if (/^file:/i.test(grantId)) throw new Error('grantId must not be a file identifier');
  return grantId as WorkspaceGrantId;
}

export function validateWorkspaceId(value: string): string {
  return validateOpaqueId(value, 'workspaceId');
}

export function validateRequestId(value: string): string {
  return validateOpaqueId(value, 'requestId');
}

export function validateProjectName(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 256 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    /^file:/i.test(normalized) ||
    WINDOWS_DRIVE_PATTERN.test(normalized)
  ) {
    throw new Error('project name must be a path-free display name of 1-256 characters');
  }
  return normalized;
}

export function sanitizeCatalog(
  response: WorkspaceCatalogResponse,
  expectedRequestId: string,
): {
  readonly projects: readonly WorkspaceProjectViewModel[];
  readonly activeWorkspaceId: string | null;
} {
  if (!response || typeof response !== 'object' || !Array.isArray(response.workspaces)) {
    throw new InvalidWorkspaceResponseError('catalog');
  }
  requireMatchingRequestId(response.requestId, expectedRequestId);
  const seen = new Set<string>();
  const projects = response.workspaces.map((summary) => {
    const project = sanitizeSummary(summary);
    if (seen.has(project.workspaceId)) throw new InvalidWorkspaceResponseError('workspaceId');
    seen.add(project.workspaceId);
    return project;
  });
  const activeWorkspaceId =
    response.activeWorkspaceId === undefined
      ? null
      : validateResponseId(response.activeWorkspaceId, 'activeWorkspaceId');
  if (activeWorkspaceId && !seen.has(activeWorkspaceId)) {
    throw new InvalidWorkspaceResponseError('activeWorkspaceId');
  }
  return Object.freeze({ projects: Object.freeze(projects), activeWorkspaceId });
}

export function sanitizeHeader(header: WorkspaceDocumentHeader): ActiveWorkspaceViewModel {
  if (!header || typeof header !== 'object' || !Array.isArray(header.sessionIds)) {
    throw new InvalidWorkspaceResponseError('header');
  }
  const workspaceId = validateResponseId(header.workspaceId, 'workspaceId');
  const name = validateResponseName(header.name);
  const revision = validateRevision(header.revision, 'revision');
  const sessionIds = header.sessionIds.map((sessionId) =>
    validateResponseId(sessionId, 'sessionId'),
  );
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new InvalidWorkspaceResponseError('sessionIds');
  }
  const activeSessionId =
    header.activeSessionId === undefined
      ? null
      : validateResponseId(header.activeSessionId, 'activeSessionId');
  if (activeSessionId && !sessionIds.includes(activeSessionId)) {
    throw new InvalidWorkspaceResponseError('activeSessionId');
  }
  return Object.freeze({
    workspaceId,
    name,
    revision,
    activeSessionId,
    sessionIds: Object.freeze(sessionIds),
    saveHealth: 'clean',
    layout: sanitizeWorkspaceLayout(header.layout),
  });
}

export function sanitizeWorkspaceLayout(value: unknown): WorkspaceLayoutV1 {
  const fallback = DEFAULT_WORKSPACE_LAYOUT;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  if (Object.keys(value).length === 0) return fallback;
  const candidate = value as Record<string, unknown>;
  const sidebar = candidate.sidebar;
  if (
    candidate.version !== 1 ||
    !sidebar ||
    typeof sidebar !== 'object' ||
    Array.isArray(sidebar) ||
    typeof (sidebar as Record<string, unknown>).width !== 'number' ||
    !Number.isFinite((sidebar as Record<string, unknown>).width) ||
    typeof (sidebar as Record<string, unknown>).collapsed !== 'boolean'
  ) {
    throw new InvalidWorkspaceResponseError('layout');
  }
  return Object.freeze({
    version: 1,
    sidebar: Object.freeze({
      width: clampSidebarWidth((sidebar as Record<string, number>).width),
      collapsed: (sidebar as Record<string, boolean>).collapsed,
    }),
  });
}

export function createSequencedMutation(
  command: Readonly<WorkspaceMutationCommand>,
  sequence: number,
): WorkspaceMutation {
  if (!command || typeof command !== 'object' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('workspace mutation command is invalid');
  }
  switch (command.kind) {
    case 'set-metadata': {
      const payload = cloneJsonValue(command.payload);
      if (payload.name !== undefined) validateProjectName(payload.name);
      rejectFilesystemData(payload);
      return deepFreeze({ kind: command.kind, sequence, payload });
    }
    case 'set-active-session':
      if (command.sessionId !== null) validateOpaqueId(command.sessionId, 'sessionId');
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId });
    case 'upsert-session': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      rejectFilesystemData(payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'remove-session':
      validateOpaqueId(command.sessionId, 'sessionId');
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId });
    case 'append-frames': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      rejectFilesystemData(payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'replace-capture': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      rejectFilesystemData(payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'trim-capture': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      if (
        !Number.isSafeInteger(payload.frameCount) ||
        payload.frameCount < 1 ||
        payload.frameCount > 0xffff_ffff
      ) {
        throw new Error('workspace capture trim count is invalid');
      }
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'upsert-feature-state': {
      validateOpaqueId(command.entityId, 'entityId');
      const payload = cloneJsonValue(command.payload);
      rejectFilesystemData(payload);
      return deepFreeze({ kind: command.kind, sequence, entityId: command.entityId, payload });
    }
    case 'replace-session-collections': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'append-ai-messages': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'clear-ai-messages':
      validateOpaqueId(command.sessionId, 'sessionId');
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId });
    case 'replace-waveform-channels': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      rejectFilesystemData(payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    case 'append-waveform-samples': {
      validateOpaqueId(command.sessionId, 'sessionId');
      const payload = cloneJsonValue(command.payload);
      return deepFreeze({ kind: command.kind, sequence, sessionId: command.sessionId, payload });
    }
    default:
      command satisfies never;
      throw new Error('unsupported workspace mutation command');
  }
}

export function validateCommittedRevision(value: number, field = 'committedRevision'): number {
  return validateRevision(value, field);
}

export function requireMatchingRequestId(actual: unknown, expected: string): void {
  if (typeof actual !== 'string' || actual !== expected) {
    throw new InvalidWorkspaceResponseError('requestId');
  }
}

export function sanitizeWorkspaceSummary(summary: WorkspaceSummary): WorkspaceProjectViewModel {
  return sanitizeSummary(summary);
}

export function validateProjectFileDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidWorkspaceResponseError('displayName');
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 256 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    !normalized.toLowerCase().endsWith(WORKSPACE_PROJECT_EXTENSION)
  ) {
    throw new InvalidWorkspaceResponseError('displayName');
  }
  return normalized;
}

export function validateSuggestedProjectFileName(value: string): string {
  try {
    return validateProjectFileDisplayName(value);
  } catch {
    throw new Error('project export name must be a path-free .bbcom filename');
  }
}

export function validateResponseOpaqueId(value: unknown, field: string): string {
  return validateResponseId(value, field);
}

export function isWorkspaceReadOnlyError(error: unknown): boolean {
  const code = stableIpcError(error)?.code;
  return code === 'REVISION_CONFLICT' || code === 'WORKSPACE_READ_ONLY';
}

export function safeFailure(error: unknown, fallbackMessageKey: string): WorkspaceActionFailure {
  const ipcError = stableIpcError(error);
  return Object.freeze({
    outcome: 'failed',
    messageKey: ipcError?.messageKey ?? fallbackMessageKey,
    ...(ipcError ? { code: ipcError.code } : {}),
  });
}

function sanitizeSummary(summary: WorkspaceSummary): WorkspaceProjectViewModel {
  if (!summary || typeof summary !== 'object') {
    throw new InvalidWorkspaceResponseError('workspace');
  }
  const saveHealth = summary.saveHealth;
  if (!SAVE_HEALTHS.has(saveHealth)) throw new InvalidWorkspaceResponseError('saveHealth');
  return Object.freeze({
    workspaceId: validateResponseId(summary.workspaceId, 'workspaceId'),
    name: validateResponseName(summary.name),
    revision: validateRevision(summary.revision, 'revision'),
    updatedAtMs: validateTimestamp(summary.updatedAtMs),
    saveHealth,
    active: false,
  });
}

function validateOpaqueId(value: string, field: string): string {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a stable path-free opaque identifier`);
  }
  return normalized;
}

function validateResponseId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new InvalidWorkspaceResponseError(field);
  try {
    return validateOpaqueId(value, field);
  } catch {
    throw new InvalidWorkspaceResponseError(field);
  }
}

function validateResponseName(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidWorkspaceResponseError('name');
  try {
    return validateProjectName(value);
  } catch {
    throw new InvalidWorkspaceResponseError('name');
  }
}

function validateRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidWorkspaceResponseError(field);
  }
  return value;
}

function validateTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidWorkspaceResponseError('updatedAtMs');
  }
  return value;
}

function stableIpcError(error: unknown): Pick<IpcError, 'code' | 'messageKey'> | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Partial<IpcError>;
  if (
    typeof value.code !== 'string' ||
    !ERROR_CODES.has(value.code) ||
    typeof value.messageKey !== 'string' ||
    !MESSAGE_KEY_PATTERN.test(value.messageKey)
  ) {
    return null;
  }
  return Object.freeze({ code: value.code, messageKey: value.messageKey });
}

function rejectFilesystemData(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    if (
      value.startsWith('/') ||
      value.startsWith('\\') ||
      /^file:/i.test(value) ||
      WINDOWS_DRIVE_PATTERN.test(value)
    ) {
      throw new Error('workspace mutation must not contain a filesystem location');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('workspace mutation payload must be acyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) rejectFilesystemData(child, seen);
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes('path') ||
      normalized === 'portname' ||
      normalized.includes('handle') ||
      normalized.includes('token') ||
      normalized.includes('grant') ||
      normalized === 'key' ||
      normalized.endsWith('apikey') ||
      normalized.includes('secret')
    ) {
      throw new Error('workspace mutation contains a forbidden capability field');
    }
    rejectFilesystemData(child, seen);
  }
  seen.delete(value);
}

function cloneJsonValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('workspace mutation payload must be acyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    const clone = value.map((child) => cloneJsonValue(child, seen));
    seen.delete(value);
    return clone as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneJsonValue(child, seen);
  seen.delete(value);
  return clone as T;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
