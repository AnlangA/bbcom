import type { AppErrorCode, IpcError } from '../../../generated/ipc-contracts';
import type { OperationRegistry } from '@/features/platform/application';
import type { WorkspaceActionFailure, WorkspaceOperationLifecyclePort } from '@/features/workspace/types';

const adapters = new WeakMap<OperationRegistry, WorkspaceOperationRegistryLifecycle>();

/**
 * Bridge workspace container work into the application-owned registry. The
 * registry retains the native cancellation callback independently of any Vue
 * component lifetime.
 */
export class WorkspaceOperationRegistryLifecycle implements WorkspaceOperationLifecyclePort {
  constructor(private readonly registry: OperationRegistry) {}

  begin(input: Parameters<WorkspaceOperationLifecyclePort['begin']>[0]): void {
    this.registry.create({
      operationId: input.operationId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      cancel: input.cancel,
    });
    this.registry.start(input.operationId);
  }

  complete(operationId: string): void {
    if (this.isActive(operationId)) this.registry.complete(operationId);
  }

  fail(operationId: string, failure: WorkspaceActionFailure): void {
    if (!this.isActive(operationId)) return;
    this.registry.fail(operationId, workspaceOperationError(operationId, failure));
  }

  async cancel(operationId: string): Promise<void> {
    await this.registry.cancel(operationId);
  }

  private isActive(operationId: string): boolean {
    const status = this.registry.get(operationId)?.status;
    return status === 'queued' || status === 'running' || status === 'cancelling';
  }
}

export function workspaceOperationLifecycleFor(
  registry: OperationRegistry,
): WorkspaceOperationRegistryLifecycle {
  const existing = adapters.get(registry);
  if (existing) return existing;
  const adapter = new WorkspaceOperationRegistryLifecycle(registry);
  adapters.set(registry, adapter);
  return adapter;
}

function workspaceOperationError(operationId: string, failure: WorkspaceActionFailure): IpcError {
  return Object.freeze({
    code: operationErrorCode(failure.code),
    messageKey: failure.messageKey,
    retryable: false,
    operation: 'workspace-operation',
    requestId: operationId,
  });
}

function operationErrorCode(code: string | undefined): AppErrorCode {
  if (code === undefined) return 'INVALID_INPUT';
  switch (code) {
    case 'BUSY':
    case 'RATE_LIMITED':
    case 'CANCELLED':
    case 'TIMEOUT':
    case 'AI_PROVIDER_FAILED':
    case 'INVALID_INPUT':
    case 'LIMIT_EXCEEDED':
    case 'SECURITY_DENIED':
    case 'SERIAL_DISCONNECTED':
    case 'SERIAL_QUEUE_FULL':
    case 'SERIAL_PARTIAL_WRITE':
    case 'IO_PERMISSION_DENIED':
    case 'IO_DISK_FULL':
    case 'EXPORT_REPLACE_FAILED':
    case 'REVISION_CONFLICT':
    case 'WORKSPACE_READ_ONLY':
    case 'WORKSPACE_CORRUPT':
    case 'PORT_IN_USE':
      return code;
  }
  return 'INVALID_INPUT';
}
