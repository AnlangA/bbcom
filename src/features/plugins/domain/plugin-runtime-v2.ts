import type {
  PluginCommandContributionV2,
  PluginFailureV2,
  PluginTaskViewV2,
  RuntimeInstanceKey,
} from '../../../generated/ipc-contracts';

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_KEY = /^[a-z0-9][a-z0-9._-]{0,255}$/u;
const TEXT_ENCODER = new TextEncoder();

const TASK_STATUSES = new Set<PluginTaskViewV2['status']>([
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'unknown-outcome',
]);

const ERROR_CODES = new Set<PluginFailureV2['code']>([
  'invalid-input',
  'permission-denied',
  'unavailable',
  'busy',
  'not-found',
  'stale-handle',
  'disconnected',
  'timeout',
  'cancelled',
  'limit-exceeded',
  'partial-write',
  'unknown-outcome',
  'protocol-error',
  'io-error',
]);

export function normalizePluginTasks(
  input: readonly PluginTaskViewV2[],
): readonly PluginTaskViewV2[] | null {
  if (input.length > 128) return null;
  const identities = new Set<string>();
  const result: PluginTaskViewV2[] = [];
  for (const task of input) {
    const identity = `${runtimeIdentity(task.runtime)}:${task.taskId}`;
    if (
      !validRuntime(task.runtime) ||
      !validIdentity(task.taskId) ||
      !validIdentity(task.commandId) ||
      !safeText(task.title, 256, false) ||
      !TASK_STATUSES.has(task.status) ||
      !nonNegativeSafeInteger(task.completed) ||
      !nonNegativeSafeInteger(task.total) ||
      (task.total === 0 ? task.completed !== 0 : task.completed > task.total) ||
      !safeText(task.statusText, 1024, true) ||
      !validFailure(task.failure) ||
      (task.cancellable && !['running', 'cancelling'].includes(task.status)) ||
      identities.has(identity)
    ) {
      return null;
    }
    identities.add(identity);
    result.push(
      Object.freeze({
        ...task,
        runtime: Object.freeze({ ...task.runtime }),
        ...(task.failure ? { failure: Object.freeze({ ...task.failure }) } : {}),
      }),
    );
  }
  return Object.freeze(result);
}

export function normalizePluginCommandContributions(
  input: readonly PluginCommandContributionV2[],
): readonly PluginCommandContributionV2[] | null {
  if (input.length > 256) return null;
  const identities = new Set<string>();
  const result: PluginCommandContributionV2[] = [];
  for (const command of input) {
    const identity = `${runtimeIdentity(command.runtime)}:${command.commandId}`;
    if (
      !validRuntime(command.runtime) ||
      !validIdentity(command.commandId) ||
      !safeText(command.title, 256, false) ||
      !safeText(command.description, 1024, true) ||
      command.dangerous !== (command.confirmation !== undefined) ||
      (command.confirmation !== undefined && !safeText(command.confirmation, 1024, false)) ||
      identities.has(identity)
    ) {
      return null;
    }
    identities.add(identity);
    result.push(Object.freeze({ ...command, runtime: Object.freeze({ ...command.runtime }) }));
  }
  return Object.freeze(result);
}

export function sameRuntime(left: RuntimeInstanceKey, right: RuntimeInstanceKey): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.pluginId === right.pluginId &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}

function validRuntime(runtime: RuntimeInstanceKey): boolean {
  return (
    validIdentity(runtime.workspaceId) &&
    validIdentity(runtime.pluginId) &&
    nonNegativeSafeInteger(runtime.instanceId) &&
    nonNegativeSafeInteger(runtime.generation)
  );
}

function runtimeIdentity(runtime: RuntimeInstanceKey): string {
  return `${runtime.workspaceId}:${runtime.pluginId}:${runtime.instanceId}:${runtime.generation}`;
}

function validIdentity(value: string): boolean {
  return typeof value === 'string' && IDENTITY.test(value);
}

function validFailure(failure: PluginFailureV2 | undefined): boolean {
  return (
    failure === undefined ||
    (ERROR_CODES.has(failure.code) &&
      MESSAGE_KEY.test(failure.messageKey) &&
      (failure.detail === undefined || safeText(failure.detail, 4096, true)))
  );
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeText(value: string, maxBytes: number, multiline: boolean): boolean {
  if (typeof value !== 'string' || TEXT_ENCODER.encode(value).byteLength > maxBytes) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 0x7f || (!multiline && (code === 10 || code === 13))) return false;
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}
