import { useSessionCapture } from '../features/sessions/session-ports';
import type { DataFrame } from '../types';

export function useSessionFrames(sessionId: string) {
  const capture = useSessionCapture(sessionId);

  function addFrame(
    frame: Omit<DataFrame, 'id' | 'timestamp'> & Partial<Pick<DataFrame, 'timestamp'>>,
    options?: { publish?: boolean },
  ): DataFrame | undefined {
    return capture.add(frame, options);
  }

  function publishFrames() {
    capture.publish();
  }

  function clearFrames() {
    capture.clear();
  }

  return {
    addFrame,
    publishFrames,
    clearFrames,
  };
}
