import { useSessionCapture } from '@/features/sessions/ports/session-ports';
import type { DataFrame } from '@/types';

export function useSessionFrames(sessionId: string) {
  const capture = useSessionCapture(sessionId);

  function addFrame(
    frame: Omit<DataFrame, 'id' | 'timestamp' | 'captureSeq'> &
      Partial<Pick<DataFrame, 'timestamp' | 'captureSeq' | 'origin'>>,
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
