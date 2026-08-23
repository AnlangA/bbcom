import type { CaptureFrameIdentity, CaptureOrigin, CaptureSequence } from '@/types/capture';
import type { DataFrame } from '@/types/serial';
import type { SerialSession } from '@/types/session';

export type SessionCaptureSlice = Pick<SerialSession, 'frames' | 'pausedFrames' | 'capturePaused'>;

/**
 * Unified read model over `frames` and `pausedFrames`. Live rows are always
 * first; paused rows append while capture is paused.
 */
export interface SessionCaptureTimeline {
  readonly live: readonly DataFrame[];
  readonly paused: readonly DataFrame[];
  readonly all: readonly DataFrame[];
  readonly totalCount: number;
  readonly liveCount: number;
  readonly pausedCount: number;
  readonly capturePaused: boolean;
}

export const CAPTURE_ORIGIN_I18N: Record<CaptureOrigin, string> = {
  'serial-rx': 'capture.origin.serialRx',
  'serial-tx': 'capture.origin.serialTx',
  'mcumgr-trace': 'capture.origin.mcumgrTrace',
};

export function defaultCaptureOrigin(direction: DataFrame['direction']): CaptureOrigin {
  return direction === 'TX' ? 'serial-tx' : 'serial-rx';
}

export function sessionCaptureTimeline(session: SessionCaptureSlice): SessionCaptureTimeline {
  const live = session.frames;
  const paused = session.pausedFrames;
  const all = paused.length === 0 ? live : [...live, ...paused];
  return Object.freeze({
    live,
    paused,
    all,
    totalCount: live.length + paused.length,
    liveCount: live.length,
    pausedCount: paused.length,
    capturePaused: session.capturePaused,
  });
}

export function captureFrameIdentity(frame: DataFrame): CaptureFrameIdentity | null {
  if (frame.captureSeq === undefined) return null;
  return Object.freeze({
    captureSeq: frame.captureSeq,
    frameId: frame.id,
    direction: frame.direction,
    origin: frame.origin ?? defaultCaptureOrigin(frame.direction),
    timestamp: frame.timestamp,
  });
}

export function findCaptureFrameBySeq(
  timeline: SessionCaptureTimeline,
  captureSeq: CaptureSequence,
): DataFrame | undefined {
  return timeline.all.find((frame) => frame.captureSeq === captureSeq);
}

export function findCaptureFrameById(
  timeline: SessionCaptureTimeline,
  frameId: string,
): DataFrame | undefined {
  return timeline.all.find((frame) => frame.id === frameId);
}

export function compareCaptureSeq(
  left: CaptureSequence | undefined,
  right: CaptureSequence | undefined,
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left - right;
}

/**
 * Incremental display cursor over the live capture window. Length alone is
 * not enough: the store mutates the array in place and can trim a prefix
 * while the visible length stays unchanged.
 */
export interface CaptureDisplayCursor {
  readonly consumed: number;
  readonly lastFrameId: string | null;
}

export interface CaptureDisplayIngestPlan {
  readonly startIndex: number;
  readonly reset: boolean;
  readonly nextCursor: CaptureDisplayCursor;
}

export const EMPTY_CAPTURE_DISPLAY_CURSOR: CaptureDisplayCursor = Object.freeze({
  consumed: 0,
  lastFrameId: null,
});

export function captureDisplayCursorAtEnd(
  frames: readonly Pick<DataFrame, 'id'>[],
): CaptureDisplayCursor {
  const last = frames[frames.length - 1];
  return {
    consumed: frames.length,
    lastFrameId: typeof last?.id === 'string' ? last.id : null,
  };
}

/**
 * Plan how a display projection should consume the live capture window.
 * `reset` means the previous overlap is gone (clear, trim, or replace) and
 * the consumer must rebuild from `startIndex`.
 */
export function planCaptureDisplayIngest(
  frames: readonly Pick<DataFrame, 'id'>[],
  cursor: CaptureDisplayCursor,
): CaptureDisplayIngestPlan {
  const nextCursor = captureDisplayCursorAtEnd(frames);
  if (frames.length === 0) {
    return {
      startIndex: 0,
      reset: cursor.consumed > 0 || cursor.lastFrameId !== null,
      nextCursor,
    };
  }

  if (cursor.lastFrameId) {
    const previousIndex = frames.findIndex((frame) => frame.id === cursor.lastFrameId);
    if (previousIndex !== -1) {
      return {
        startIndex: previousIndex + 1,
        reset: false,
        nextCursor,
      };
    }
    return {
      startIndex: 0,
      reset: true,
      nextCursor,
    };
  }

  if (cursor.consumed > frames.length) {
    return {
      startIndex: 0,
      reset: true,
      nextCursor,
    };
  }

  return {
    startIndex: Math.max(0, cursor.consumed),
    reset: false,
    nextCursor,
  };
}
