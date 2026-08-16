import { IPC_LIMITS, type IpcError } from '../../generated/ipc-contracts';
import type { AiResponseBinding, AiResponseBindingPhase } from './ai-session-projection';

/**
 * Response-binding state machine for the AI session bridge.
 *
 * Tracks, per request id, which workspace/session/revision an AI request was
 * issued against and how far it has progressed (`context-issued` →
 * `user-committed` → `running`, with `rejected` as the terminal refusal).
 * Lookups always match the full envelope, so a replayed or mismatched request
 * can never adopt another request's binding.
 */

export interface StoredAiResponseBinding extends AiResponseBinding {
  readonly requestId: string;
  readonly phase: AiResponseBindingPhase;
  readonly error?: IpcError;
}

export function isAiResponseBindingTransitionAllowed(
  current: AiResponseBindingPhase | null,
  next: AiResponseBindingPhase,
): boolean {
  if (current === null) return next === 'context-issued';
  if (current === 'context-issued') return next === 'user-committed' || next === 'rejected';
  return current === 'user-committed' && next === 'running';
}

function sameResponseBinding(
  left: AiResponseBinding,
  right: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly revision: number;
    readonly requestId: string;
  },
): boolean {
  return (
    left.requestId === right.requestId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.revision === right.revision
  );
}

export class AiResponseBindingRegistry {
  private readonly bindings = new Map<string, StoredAiResponseBinding>();

  remember(
    requestId: string,
    workspaceId: string,
    sessionId: string,
    sourceRevision: number,
    phase: AiResponseBindingPhase = 'context-issued',
    error?: IpcError,
  ): boolean {
    const existing = this.bindings.get(requestId);
    if (
      existing &&
      !sameResponseBinding(existing, {
        requestId,
        workspaceId,
        sessionId,
        revision: sourceRevision,
      })
    ) {
      return false;
    }
    if (!isAiResponseBindingTransitionAllowed(existing?.phase ?? null, phase)) return false;
    if (!this.bindings.has(requestId) && this.bindings.size >= 32) return false;
    this.bindings.delete(requestId);
    this.bindings.set(requestId, {
      requestId,
      workspaceId,
      sessionId,
      revision: sourceRevision,
      phase,
      ...(error ? { error } : {}),
    });
    return true;
  }

  responseBindingFor(envelope: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly revision: number;
    readonly requestId: string;
  }): StoredAiResponseBinding | undefined {
    const binding = this.bindings.get(envelope.requestId);
    return binding && sameResponseBinding(binding, envelope) ? binding : undefined;
  }

  forgetResponseBinding(envelope: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly revision: number;
    readonly requestId: string;
  }): void {
    if (this.responseBindingFor(envelope)) this.bindings.delete(envelope.requestId);
  }

  has(requestId: string): boolean {
    return this.bindings.has(requestId);
  }

  delete(requestId: string): void {
    this.bindings.delete(requestId);
  }

  clear(): void {
    this.bindings.clear();
  }

  /** Request ids bound to a workspace/session pair, in insertion order. */
  requestIdsFor(workspaceId: string, sessionId: string): string[] {
    return [...this.bindings.values()]
      .filter((binding) => binding.workspaceId === workspaceId && binding.sessionId === sessionId)
      .map((binding) => binding.requestId);
  }

  /** Byte/message head-room still reserved by in-flight user AI requests. */
  pendingAiResponseReservation(excludeRequestId?: string): {
    readonly messages: number;
    readonly bytes: number;
  } {
    const requests = [...this.bindings.values()].filter(
      (binding) =>
        binding.requestId !== excludeRequestId &&
        (binding.phase === 'user-committed' || binding.phase === 'running'),
    ).length;
    return {
      messages: requests,
      bytes: requests * IPC_LIMITS.MAX_AI_RESPONSE_BYTES,
    };
  }
}
