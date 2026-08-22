import type { Direction } from '@/types/display';

/**
 * Where a captured frame entered the session buffer. Distinct from UI
 * `DisplayMode` (formatting) and `SessionRuntimeViewMode` (panel layout).
 */
export type CaptureOrigin = 'serial-rx' | 'serial-tx' | 'mcumgr-trace';

/** Monotonic append-order identity for one frame within a session capture stream. */
export type CaptureSequence = number;

export interface CaptureFrameIdentity {
  readonly captureSeq: CaptureSequence;
  readonly frameId: string;
  readonly direction: Direction;
  readonly origin: CaptureOrigin;
  readonly timestamp: number;
}
