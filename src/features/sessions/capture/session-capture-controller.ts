import {
  appendFrameToSession,
  frameBuffersByteLength,
  flushPausedFramesToLive,
  MAX_GLOBAL_FRAME_BYTES,
  MAX_SESSION_FRAME_BYTES,
  resetSessionFrames,
  trimSessionsToGlobalByteLimit,
} from '../../../lib/session-store-helpers';
import { defaultCaptureOrigin } from '../../../lib/capture-stream';
import { CaptureAccountingStore } from '../../application';
import type { DataFrame } from '../../../types/serial';
import type { SerialSession } from '../../../types/session';

export interface SessionCaptureControllerDependencies {
  getSessions(): readonly SerialSession[];
  findSession(sessionId: string): SerialSession | undefined;
  /** User actions such as clear/pause use the normal workspace save gate. */
  canMutateUserState?: () => boolean;
  /** RX may remain open briefly while a runtime persistence drain is active. */
  canCaptureRuntimeEvents?: (
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ) => boolean;
  frameVersions: Record<string, number>;
  getMaxBufferFrames(): number;
  scheduleFramesPersist(): void;
  createId?: () => string;
  now?: () => number;
  decorateFrame?: (frame: DataFrame) => DataFrame;
  unwrapSession?: (session: SerialSession) => SerialSession;
  onListenerError?: (error: unknown) => void;
  onFrameAdded?: (sessionId: string, frame: DataFrame) => void;
  onCaptureCleared?: (sessionId: string) => void;
  onCaptureTrimmed?: (sessionId: string, droppedFrames: number, droppedBytes: number) => void;
}

/**
 * Owns capture-buffer accounting and invalidation independently of Pinia.
 * The facade supplies a reactive version record and Vue-specific decorators.
 */
export function createSessionCaptureController({
  getSessions,
  findSession,
  canMutateUserState = () => true,
  canCaptureRuntimeEvents = () => true,
  frameVersions,
  getMaxBufferFrames,
  scheduleFramesPersist,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  decorateFrame = (frame) => frame,
  unwrapSession = (session) => session,
  onListenerError = () => undefined,
  onFrameAdded = () => undefined,
  onCaptureCleared = () => undefined,
  onCaptureTrimmed = () => undefined,
}: SessionCaptureControllerDependencies) {
  /**
   * Retained in-memory capture-buffer bytes per session plus the global
   * aggregate, accounted through the shared workspace capture-accounting
   * store (this instance tracks only the bytes fields).
   */
  const accounting = new CaptureAccountingStore();
  const rxQueueDroppedBytes = new Map<string, number>();
  const frameBufferDroppedBytes = new Map<string, number>();
  const frameClearListeners = new Map<string, Set<() => void>>();

  function retainedSessionBytes(sessionId: string, session?: SerialSession): number {
    return (
      accounting.sessionTotals(sessionId)?.captureBytes ??
      (session ? frameBuffersByteLength(session) : 0)
    );
  }

  function getSessionFramesVersion(sessionId: string): number {
    return frameVersions[sessionId] ?? 0;
  }

  function notifyFramesChanged(sessionId: string): void {
    frameVersions[sessionId] = getSessionFramesVersion(sessionId) + 1;
  }

  function maxCaptureSeq(session: SerialSession): number {
    let max = -1;
    for (const frame of session.frames) {
      if (frame.captureSeq !== undefined && frame.captureSeq > max) max = frame.captureSeq;
    }
    for (const frame of session.pausedFrames) {
      if (frame.captureSeq !== undefined && frame.captureSeq > max) max = frame.captureSeq;
    }
    return max;
  }

  function initializeSession(session: SerialSession): void {
    const retainedBytes = frameBuffersByteLength(session);
    frameVersions[session.id] = 0;
    accounting.registerSession(session.id, {
      nextSequence: Math.max(0, maxCaptureSeq(session) + 1),
      frameCount: 0,
      captureBytes: retainedBytes,
    });
    rxQueueDroppedBytes.set(session.id, 0);
    frameBufferDroppedBytes.set(session.id, 0);
  }

  function replaceSessions(sessions: readonly SerialSession[]): void {
    accounting.replaceWorkspace([]);
    rxQueueDroppedBytes.clear();
    frameBufferDroppedBytes.clear();
    for (const id of Object.keys(frameVersions)) delete frameVersions[id];
    for (const session of sessions) initializeSession(session);
  }

  function removeSession(sessionId: string): void {
    accounting.removeSession(sessionId);
    rxQueueDroppedBytes.delete(sessionId);
    frameBufferDroppedBytes.delete(sessionId);
    frameClearListeners.delete(sessionId);
    delete frameVersions[sessionId];
  }

  function setRetainedFrameBytes(sessionId: string, retainedBytes: number): void {
    accounting.setSessionBytes(sessionId, retainedBytes);
  }

  function addFrameBufferDrop(sessionId: string, droppedBytes: number): void {
    if (droppedBytes <= 0) return;
    frameBufferDroppedBytes.set(
      sessionId,
      (frameBufferDroppedBytes.get(sessionId) ?? 0) + droppedBytes,
    );
    const session = findSession(sessionId);
    if (session) {
      session.droppedBytes =
        (rxQueueDroppedBytes.get(sessionId) ?? 0) + (frameBufferDroppedBytes.get(sessionId) ?? 0);
    }
  }

  function enforceGlobalFrameByteLimit():
    Map<string, { droppedFrames: number; droppedBytes: number }> | undefined {
    const totalFrameBytes = accounting.workspaceTotals().captureBytes;
    if (totalFrameBytes <= MAX_GLOBAL_FRAME_BYTES) return undefined;
    const affected = new Map<string, { droppedFrames: number; droppedBytes: number }>();
    const result = trimSessionsToGlobalByteLimit(
      getSessions(),
      totalFrameBytes,
      MAX_GLOBAL_FRAME_BYTES,
    );
    for (const [sessionId, droppedBytes] of result.droppedBytesBySession) {
      accounting.setSessionBytes(
        sessionId,
        Math.max(0, (accounting.sessionTotals(sessionId)?.captureBytes ?? 0) - droppedBytes),
      );
      addFrameBufferDrop(sessionId, droppedBytes);
      affected.set(sessionId, {
        droppedFrames: result.droppedFramesBySession.get(sessionId) ?? 0,
        droppedBytes,
      });
    }
    // The trim result reports the retained aggregate directly; re-baseline it
    // after the per-session row adjustments above.
    accounting.setWorkspaceBytes(result.retainedBytes);
    return affected;
  }

  function onFramesCleared(sessionId: string, listener: () => void): () => void {
    let listeners = frameClearListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      frameClearListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = frameClearListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) frameClearListeners.delete(sessionId);
    };
  }

  function notifyFramesCleared(sessionId: string): void {
    const listeners = frameClearListeners.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        onListenerError(error);
      }
    }
  }

  function addFrame(
    sessionId: string,
    frame: Omit<DataFrame, 'id' | 'timestamp' | 'captureSeq'> &
      Partial<Pick<DataFrame, 'timestamp' | 'captureSeq' | 'origin'>>,
    options: { publish?: boolean } = {},
  ): DataFrame | undefined {
    if (!canCaptureRuntimeEvents(sessionId, frame)) return undefined;
    const session = findSession(sessionId);
    if (!session) return undefined;
    const captureSeq = frame.captureSeq ?? accounting.allocateNextFrameSequence(sessionId);
    const origin = frame.origin ?? defaultCaptureOrigin(frame.direction);
    const fullFrame = decorateFrame({
      ...frame,
      captureSeq,
      origin,
      id: createId(),
      timestamp: frame.timestamp ?? now(),
    });
    const currentBytes = retainedSessionBytes(sessionId, session);
    const trim = appendFrameToSession(unwrapSession(session), fullFrame, getMaxBufferFrames(), {
      currentBytes,
      maxBytes: MAX_SESSION_FRAME_BYTES,
    });
    setRetainedFrameBytes(sessionId, trim.retainedBytes);
    addFrameBufferDrop(sessionId, trim.droppedBytes);
    const globallyTrimmed = enforceGlobalFrameByteLimit();

    if (options.publish !== false) notifyFramesChanged(sessionId);
    if (globallyTrimmed) {
      for (const affectedSessionId of globallyTrimmed.keys()) {
        if (affectedSessionId !== sessionId) notifyFramesChanged(affectedSessionId);
      }
    }
    scheduleFramesPersist();
    onFrameAdded(sessionId, fullFrame);
    const trimmedBySession =
      globallyTrimmed ?? new Map<string, { droppedFrames: number; droppedBytes: number }>();
    if (trim.droppedFrames > 0) {
      const global = trimmedBySession.get(sessionId);
      trimmedBySession.set(sessionId, {
        droppedFrames: trim.droppedFrames + (global?.droppedFrames ?? 0),
        droppedBytes: trim.droppedBytes + (global?.droppedBytes ?? 0),
      });
    }
    for (const [affectedSessionId, dropped] of trimmedBySession) {
      if (dropped.droppedFrames > 0) {
        onCaptureTrimmed(affectedSessionId, dropped.droppedFrames, dropped.droppedBytes);
      }
    }
    return fullFrame;
  }

  function publishSessionFrames(sessionId: string): void {
    if (!findSession(sessionId)) return;
    notifyFramesChanged(sessionId);
  }

  function updateDroppedBytes(sessionId: string, total: number): void {
    const session = findSession(sessionId);
    if (!session) return;
    const normalized = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    rxQueueDroppedBytes.set(sessionId, normalized);
    session.droppedBytes = normalized + (frameBufferDroppedBytes.get(sessionId) ?? 0);
  }

  function clearFrames(sessionId: string): void {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const hadFrames = session.frames.length > 0 || session.pausedFrames.length > 0;
    if (hadFrames) setRetainedFrameBytes(sessionId, 0);
    resetSessionFrames(session);
    accounting.resetFrameSequence(sessionId);
    if (hadFrames) notifyFramesChanged(sessionId);
    notifyFramesCleared(sessionId);
    scheduleFramesPersist();
    if (hadFrames) onCaptureCleared(sessionId);
  }

  function setCapturePaused(sessionId: string, paused: boolean): void {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session || session.capturePaused === paused) return;
    session.capturePaused = paused;
    if (!paused && session.pausedFrames.length > 0) {
      const trim = flushPausedFramesToLive(session, getMaxBufferFrames(), {
        currentBytes: retainedSessionBytes(sessionId, session),
        maxBytes: MAX_SESSION_FRAME_BYTES,
      });
      setRetainedFrameBytes(sessionId, trim.retainedBytes);
      addFrameBufferDrop(sessionId, trim.droppedBytes);
      notifyFramesChanged(sessionId);
      if (trim.droppedFrames > 0) {
        onCaptureTrimmed(sessionId, trim.droppedFrames, trim.droppedBytes);
      }
    }
    scheduleFramesPersist();
  }

  return {
    getSessionFramesVersion,
    initializeSession,
    replaceSessions,
    removeSession,
    onFramesCleared,
    addFrame,
    publishSessionFrames,
    updateDroppedBytes,
    clearFrames,
    setCapturePaused,
  };
}
