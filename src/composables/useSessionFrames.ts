import { useSessionStore } from '../stores/sessions';
import type { DataFrame } from '../types';

export function useSessionFrames(sessionId: string) {
  const sessionStore = useSessionStore();

  function addFrame(
    frame: Omit<DataFrame, 'id' | 'timestamp'>,
    options?: { publish?: boolean },
  ): DataFrame | undefined {
    return sessionStore.addFrame(sessionId, frame, options);
  }

  function publishFrames() {
    sessionStore.publishSessionFrames(sessionId);
  }

  function clearFrames() {
    sessionStore.clearFrames(sessionId);
  }

  return {
    addFrame,
    publishFrames,
    clearFrames,
  };
}
