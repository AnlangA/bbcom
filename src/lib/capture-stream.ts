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
