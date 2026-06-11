import { useSessionStore } from '../stores/sessions';
import type { DataFrame } from '../types';

export function useSessionFrames(sessionId: string) {
  const sessionStore = useSessionStore();

  function addFrame(frame: Omit<DataFrame, 'id' | 'timestamp'>) {
    sessionStore.addFrame(sessionId, frame);
  }

  function clearFrames() {
    sessionStore.clearFrames(sessionId);
  }

  return {
    addFrame,
    clearFrames,
  };
}
