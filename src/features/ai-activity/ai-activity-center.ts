import type {
  AiRequestResult,
  IpcError,
  OperationRecord,
  RunAiRequest,
} from '../../generated/ipc-contracts';
import { cancelAiRequest, runAiRequest } from '../native';
import { OperationRegistry } from '../application';

export interface AiActivityBinding {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly requestId: string;
}

export interface RunAiActivityInput extends AiActivityBinding {
  readonly request: RunAiRequest;
}

export interface AiActivityResult extends AiActivityBinding {
  readonly result: AiRequestResult;
}

export interface AiActivityCenterDependencies {
  /** The application registry is mandatory: AI must never create renderer-local ownership. */
  readonly operations: OperationRegistry;
  readonly run?: (request: RunAiRequest) => Promise<AiRequestResult>;
  readonly cancel?: (requestId: string) => Promise<void>;
}

export class AiActivityCancelledError extends Error {
  constructor(readonly requestId: string) {
    super(`AI request cancelled: ${requestId}`);
    this.name = 'AiActivityCancelledError';
  }
}

/**
 * Application-owned AI request lifecycle. The immutable binding is captured
 * before native work starts, so later session selection can never retarget a
 * response. Cancellation always reaches Rust's `cancel_ai_request` command.
 */
export class AiActivityCenter {
  readonly operations: OperationRegistry;
  private readonly runNative: (request: RunAiRequest) => Promise<AiRequestResult>;
  private readonly cancelNative: (requestId: string) => Promise<void>;
  private readonly inFlight = new Map<
    string,
    { readonly binding: AiActivityBinding; readonly task: Promise<AiActivityResult> }
  >();

  constructor(dependencies: AiActivityCenterDependencies) {
    this.operations = dependencies.operations;
    this.runNative = dependencies.run ?? runAiRequest;
    this.cancelNative = dependencies.cancel ?? cancelAiRequest;
  }

  run(input: RunAiActivityInput): Promise<AiActivityResult> {
    const binding = validateBinding(input);
    if (input.request.requestId !== binding.requestId) {
      throw new Error('AI native requestId must equal the activity requestId');
    }
    const existing = this.inFlight.get(binding.requestId);
    if (existing) {
      if (!sameBinding(existing.binding, binding)) {
        throw new Error('AI requestId is already bound to another workspace or session');
      }
      return existing.task;
    }

    this.operations.create({
      operationId: binding.requestId,
      kind: 'ai-request',
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      messageKey: 'activity.ai.request',
      cancel: () => this.cancelNative(binding.requestId),
    });
    this.operations.start(binding.requestId);

    const task = this.perform(binding, Object.freeze({ ...input.request })).finally(() => {
      this.inFlight.delete(binding.requestId);
    });
    this.inFlight.set(binding.requestId, { binding, task });
    return task;
  }

  cancel(requestId: string): Promise<OperationRecord> {
    return this.operations.cancel(requestId);
  }

  snapshot(): readonly OperationRecord[] {
    return this.operations.snapshot();
  }

  subscribe(listener: (records: readonly OperationRecord[]) => void): () => void {
    return this.operations.subscribe(listener);
  }

  private async perform(
    binding: AiActivityBinding,
    request: RunAiRequest,
  ): Promise<AiActivityResult> {
    try {
      const result = await this.runNative(request);
      const record = this.operations.get(binding.requestId);
      if (
        !record ||
        record.status === 'cancelling' ||
        record.status === 'cancelled' ||
        record.status === 'interrupted'
      ) {
        throw new AiActivityCancelledError(binding.requestId);
      }
      this.operations.complete(binding.requestId);
      return Object.freeze({ ...binding, result });
    } catch (error) {
      const record = this.operations.get(binding.requestId);
      if (
        record?.status === 'cancelling' ||
        record?.status === 'cancelled' ||
        record?.status === 'interrupted'
      ) {
        throw new AiActivityCancelledError(binding.requestId);
      }
      if (record?.status === 'running' || record?.status === 'queued') {
        this.operations.fail(binding.requestId, toIpcError(error, binding.requestId));
      }
      throw error;
    }
  }
}

function sameBinding(left: AiActivityBinding, right: AiActivityBinding): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.revision === right.revision &&
    left.requestId === right.requestId
  );
}

function validateBinding(input: RunAiActivityInput): AiActivityBinding {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error('AI activity revision must be a non-negative integer');
  }
  for (const [field, value] of Object.entries({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    requestId: input.requestId,
  })) {
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
      value.length > 256
    ) {
      throw new Error(`${field} must be a path-free opaque identifier`);
    }
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    revision: input.revision,
    requestId: input.requestId,
  });
}

function toIpcError(error: unknown, requestId: string): IpcError {
  if (isIpcError(error)) return error;
  return {
    code: 'INVALID_INPUT',
    messageKey: 'error.ai_request_failed',
    retryable: false,
    operation: 'run_ai_request',
    requestId,
  };
}

function isIpcError(value: unknown): value is IpcError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<IpcError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.messageKey === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.operation === 'string'
  );
}
