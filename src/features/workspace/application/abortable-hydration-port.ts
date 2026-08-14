import type { WorkspaceHydrationPort } from '../adapters';

/**
 * G22's renderer adapter is transport-neutral. This guard adds application
 * cancellation at every async boundary, so an obsolete response can be
 * validated locally but can never reach the live facade.
 */
export function abortableWorkspaceHydrationPort(
  port: WorkspaceHydrationPort,
  signal: AbortSignal,
): WorkspaceHydrationPort {
  const guarded = async <T>(invoke: () => Promise<T>): Promise<T> => {
    throwIfAborted(signal);
    const response = await invoke();
    throwIfAborted(signal);
    return response;
  };
  return {
    hydrateSessions: (request) => guarded(() => port.hydrateSessions(request)),
    hydrateFrames: (request) => guarded(() => port.hydrateFrames(request)),
    hydrateCollections: (request) => guarded(() => port.hydrateCollections(request)),
    hydrateAiMessages: (request) => guarded(() => port.hydrateAiMessages(request)),
    hydrateWaveform: (request) => guarded(() => port.hydrateWaveform(request)),
  };
}

/** Preserve the database sequence high-water mark that the session adapter
 * intentionally omits from its renderer-facing `DataFrame` projection. */
export function observeWorkspaceFrameSequences(
  port: WorkspaceHydrationPort,
  nextSequenceBySession: Map<string, number>,
): WorkspaceHydrationPort {
  return {
    hydrateSessions: (request) => port.hydrateSessions(request),
    hydrateFrames: async (request) => {
      const response = await port.hydrateFrames(request);
      for (const frame of response.frames) {
        if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) continue;
        const nextSequence = frame.seq + 1;
        if (!Number.isSafeInteger(nextSequence)) {
          nextSequenceBySession.set(request.sessionId, Number.POSITIVE_INFINITY);
          continue;
        }
        nextSequenceBySession.set(
          request.sessionId,
          Math.max(nextSequenceBySession.get(request.sessionId) ?? 0, nextSequence),
        );
      }
      return response;
    },
    hydrateCollections: (request) => port.hydrateCollections(request),
    hydrateAiMessages: (request) => port.hydrateAiMessages(request),
    hydrateWaveform: (request) => port.hydrateWaveform(request),
  };
}

export function isWorkspaceHydrationAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('workspace hydration aborted');
  error.name = 'AbortError';
  throw error;
}
