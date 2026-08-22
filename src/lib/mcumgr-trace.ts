import type { McumgrTraceFrame } from '../generated/ipc-contracts';
import type { DataFrame, Direction } from '../types';

export function mcumgrTraceFramesToDataFrames(
  frames: readonly McumgrTraceFrame[],
): Array<Omit<DataFrame, 'id'>> {
  return frames.map((frame) => ({
    direction: frame.direction as Direction,
    timestamp: frame.timestampMs,
    data: new Uint8Array(frame.data),
  }));
}
