import { ref } from 'vue';
import { MAX_FRAMES } from '../types';

/**
 * Live cap on the number of frames retained per session (visible + paused).
 *
 * Kept in a tiny standalone module (no Tauri / localStorage deps) so the
 * session store can read it without pulling the persisted app store — which
 * keeps the store unit-testable. The app store owns persistence and syncs the
 * persisted value into here on load.
 */
export const maxBufferFrames = ref(MAX_FRAMES);

const MIN_BUFFER_FRAMES = 1000;
const MAX_BUFFER_FRAMES = 100_000;

export function setMaxBufferFrames(value: number) {
  const clamped = Math.max(
    MIN_BUFFER_FRAMES,
    Math.min(MAX_BUFFER_FRAMES, Math.floor(Number.isFinite(value) ? value : MAX_FRAMES)),
  );
  maxBufferFrames.value = clamped;
  return clamped;
}
